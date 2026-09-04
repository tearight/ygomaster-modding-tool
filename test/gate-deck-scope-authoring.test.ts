import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createCardResolver } from '../src/core/card-resolver';
import { compileCampaignContent } from '../src/core/campaign-pipeline';
import {
  bootstrapCampaignDeckFolders,
  inspectCampaignDeckWorkspace,
  mutateCampaignGateDeckScopeDocument,
  type CampaignDeckWorkspaceViewModel,
} from '../src/core/content-operations';
import { DECK_ORGANIZATION_CODES } from '../src/core/deck-organization';
import { createEmptyRegistry } from '../src/core/id-registry';
import { defaultContentManifest } from '../src/core/layers';
import type { CatalogCard } from '../src/core/types';

const writeJson = async (target: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const bootstrapCatalog = Array.from({ length: 40 }, (_, index): CatalogCard => ({
  id: 3001 + index,
  ydkId: 700001 + index,
  names: { english: `Bootstrap Card ${String(index + 1).padStart(2, '0')}`, display: `Bootstrap Card ${String(index + 1).padStart(2, '0')}` },
  texts: { english: 'Fixture', display: 'Fixture' },
  original: {},
  stats: {},
  autoTags: [],
}));

const bootstrapDeck = `${['[main]', ...bootstrapCatalog.map((card) => `1 ${card.names.english}`), '[extra]', '[side]', ''].join('\n')}`;

const contentTree = async (root: string): Promise<Record<string, string>> => {
  const output: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else output[path.relative(root, target).replace(/\\/gu, '/')] = (await fs.readFile(target)).toString('base64');
    }
  };
  await visit(root);
  return output;
};

describe('Gate-scoped Deck authoring core', () => {
  it('returns the shared recursive workspace VM and blocks an atomic out-of-scope Gate candidate', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-deck-scope-'));
    const contentRoot = path.join(root, 'campaign', 'content');
    try {
      await writeJson(path.join(contentRoot, 'manifest.json'), defaultContentManifest());
      await writeJson(path.join(contentRoot, 'decks', '_folders.json'), {
        formatVersion: 1,
        kind: 'deck-folders',
        payload: { folders: [
          { id: 'deck-folder:gate-a', name: 'Gate A' },
          { id: 'deck-folder:gate-a-child', name: 'Child', parent: 'deck-folder:gate-a' },
          { id: 'deck-folder:gate-b', name: 'Gate B' },
          { id: 'deck-folder:shared', name: 'Shared' },
        ] },
      });
      const decks = [
        ['cpu', { role: 'cpu', folder: 'deck-folder:gate-a', future: { preserved: true } }],
        ['rental', { role: 'rental', folder: 'deck-folder:gate-a-child' }],
        ['other', { role: 'cpu', folder: 'deck-folder:gate-b' }],
        ['unassigned', { role: 'cpu' }],
      ] as const;
      for (const [stem, metadata] of decks) {
        await fs.writeFile(path.join(contentRoot, 'decks', `${stem}.decklist`), '[main]\n1 Missing Card\n[extra]\n[side]\n', 'utf8');
        await writeJson(path.join(contentRoot, 'decks', `${stem}.json`), { metadata, unknownTopLevel: { preserved: true } });
      }
      const gatePath = 'gates/demo.json';
      const gate = {
        formatVersion: 1,
        kind: 'gate',
        payload: {
          id: 'gate:demo',
          nameKey: 'gate.demo.name',
          descriptionKey: 'gate.demo.description',
          priority: 1,
          deckFolder: 'deck-folder:gate-a',
          goal: 'chapter:demo',
          chapters: [{
            id: 'chapter:demo',
            kind: 'duel',
            entry: true,
            required: true,
            descriptionKey: 'chapter.demo.description',
            duel: { cpuDeck: 'deck:cpu', rentalDeck: 'deck:rental', playerMode: 'rental' },
          }],
        },
      };
      await writeJson(path.join(contentRoot, ...gatePath.split('/')), gate);

      const inspected = await inspectCampaignDeckWorkspace({ projectRoot: root, contentRoot });
      assert.equal(inspected.ok, true, JSON.stringify(inspected.problems));
      const workspace = inspected.data as CampaignDeckWorkspaceViewModel;
      assert.equal(workspace.catalog.exists, true);
      assert.equal(workspace.catalog.sourcePath, 'decks/_folders.json');
      assert.deepEqual(workspace.folders.find((entry) => entry.id === 'deck-folder:gate-a-child')?.breadcrumb, ['Gate A', 'Child']);
      assert.equal(workspace.folders.find((entry) => entry.id === 'deck-folder:gate-a')?.recursiveDeckCount, 2);
      assert.equal(workspace.decks.find((entry) => entry.reference === 'deck:cpu')?.metadata.future !== undefined, true);
      assert.equal(workspace.decks.find((entry) => entry.reference === 'deck:unassigned')?.folderStatus, 'unassigned');
      assert.deepEqual(workspace.gates[0]?.candidates, { cpu: ['deck:cpu'], rental: ['deck:rental'] });
      assert.equal(workspace.gates[0]?.scopedDeckCount, 2);

      const before = await fs.readFile(path.join(contentRoot, ...gatePath.split('/')), 'utf8');
      const candidate = JSON.parse(JSON.stringify(gate)) as typeof gate;
      candidate.payload.deckFolder = 'deck-folder:gate-b';
      const mutation = await mutateCampaignGateDeckScopeDocument({
        projectRoot: root,
        contentRoot,
        resolver: createCardResolver([], { catalogGeneration: 'empty' }),
        registry: createEmptyRegistry(),
      }, {
        sourcePath: gatePath,
        operation: 'update',
        content: `${JSON.stringify(candidate, null, 2)}\n`,
        expectedContentGeneration: workspace.contentGeneration,
        confirmApply: true,
      });
      assert.equal(mutation.ok, false);
      assert.equal(mutation.problems.some((entry) => entry.code === DECK_ORGANIZATION_CODES.GATE_DECK_OUT_OF_SCOPE), true);
      assert.equal(mutation.problems.find((entry) => entry.code === DECK_ORGANIZATION_CODES.GATE_DECK_OUT_OF_SCOPE)?.jsonPointer, '/payload/chapters/0/duel/cpuDeck');
      assert.equal(await fs.readFile(path.join(contentRoot, ...gatePath.split('/')), 'utf8'), before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('bootstraps active legacy content as one reviewed transaction and leaves failed candidates unchanged', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-deck-bootstrap-'));
    const contentRoot = path.join(root, 'campaign', 'content');
    try {
      await writeJson(path.join(contentRoot, 'manifest.json'), defaultContentManifest());
      await fs.mkdir(path.join(contentRoot, 'decks'), { recursive: true });
      await fs.writeFile(path.join(contentRoot, 'decks', 'cpu.decklist'), bootstrapDeck, 'utf8');
      await fs.writeFile(path.join(contentRoot, 'decks', 'rental.decklist'), bootstrapDeck, 'utf8');
      await writeJson(path.join(contentRoot, 'decks', 'cpu.json'), {
        metadata: { role: 'cpu', futureMetadata: { preserved: true } },
        futureTopLevel: { preserved: true },
      });
      await writeJson(path.join(contentRoot, 'decks', 'rental.json'), {
        role: 'rental',
        futureLegacyField: { preserved: true },
      });
      const gateSourcePath = 'gates/bootstrap.json';
      await writeJson(path.join(contentRoot, ...gateSourcePath.split('/')), {
        formatVersion: 1,
        kind: 'gate',
        payload: {
          id: 'gate:bootstrap',
          nameKey: 'gate.bootstrap.name',
          descriptionKey: 'gate.bootstrap.description',
          priority: 1,
          goal: 'chapter:bootstrap',
          chapters: [{
            id: 'chapter:bootstrap',
            kind: 'duel',
            entry: true,
            required: true,
            descriptionKey: 'chapter.bootstrap.description',
            duel: {
              cpuDeck: 'deck:cpu',
              rentalDeck: 'deck:rental',
              playerMode: 'rental',
              playerNameKey: 'duel.player.name',
              cpuNameKey: 'duel.cpu.name',
            },
          }],
          target: { ygomaster: { illust_id: 4027 } },
        },
      });
      await writeJson(path.join(contentRoot, 'localization', 'en.json'), {
        'gate.bootstrap.name': 'Bootstrap Gate',
        'gate.bootstrap.description': 'Bootstrap Description',
        'chapter.bootstrap.description': 'Bootstrap Duel',
        'duel.player.name': 'Player',
        'duel.cpu.name': 'CPU',
      });
      await writeJson(path.join(contentRoot, 'assets', 'manifest.json'), {
        formatVersion: 1,
        assets: [{
          key: 'gate.bootstrap.background',
          source: 'assets/background.png',
          role: 'solo-gate-background',
          gateRefs: ['gate:bootstrap'],
          provenance: 'test fixture',
          license: 'test fixture',
          confirmed: true,
        }],
      });
      await fs.writeFile(path.join(contentRoot, 'assets', 'background.png'), Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
      ]));
      const inspected = await inspectCampaignDeckWorkspace({ projectRoot: root, contentRoot });
      assert.equal(inspected.ok, true, JSON.stringify(inspected.problems));
      const generation = (inspected.data as CampaignDeckWorkspaceViewModel).contentGeneration;
      const catalog = {
        formatVersion: 1,
        kind: 'deck-folders',
        payload: { folders: [
          { id: 'deck-folder:bootstrap', name: 'Bootstrap' },
          { id: 'deck-folder:bootstrap-child', name: 'Child', parent: 'deck-folder:bootstrap' },
        ] },
      };
      const resolver = createCardResolver(bootstrapCatalog, { catalogGeneration: 'bootstrap-fixture' });
      const options = { projectRoot: root, contentRoot, resolver, registry: createEmptyRegistry() };
      const failedBefore = await contentTree(contentRoot);
      const partial = await bootstrapCampaignDeckFolders(options, {
        catalog,
        deckAssignments: [{ sourcePath: 'decks/cpu.decklist', sidecarSourcePath: 'decks/cpu.json', folderId: 'deck-folder:bootstrap' }],
        gateAssignments: [{ sourcePath: gateSourcePath, folderId: 'deck-folder:bootstrap' }],
        expectedContentGeneration: generation,
        confirmApply: false,
      });
      assert.equal(partial.ok, false);
      assert.equal(partial.problems.some((entry) => entry.code === 'CONTENT_DECK_FOLDER_BOOTSTRAP_MAPPING_MISSING'), true);
      assert.deepEqual(await contentTree(contentRoot), failedBefore);

      const request = {
        catalog,
        deckAssignments: [
          { sourcePath: 'decks/cpu.decklist', sidecarSourcePath: 'decks/cpu.json', folderId: 'deck-folder:bootstrap' },
          { sourcePath: 'decks/rental.decklist', sidecarSourcePath: 'decks/rental.json', folderId: 'deck-folder:bootstrap-child' },
        ],
        gateAssignments: [{ sourcePath: gateSourcePath, folderId: 'deck-folder:bootstrap' }],
        expectedContentGeneration: generation,
        confirmApply: false,
      } as const;
      const preview = await bootstrapCampaignDeckFolders(options, request);
      assert.equal(preview.ok, true, JSON.stringify(preview.problems));
      const previewData = preview.data as { previewSignature: string; requiresConfirmation: boolean; applied: boolean };
      assert.equal(previewData.requiresConfirmation, true);
      assert.equal(previewData.applied, false);
      assert.deepEqual(await contentTree(contentRoot), failedBefore);

      const unsigned = await bootstrapCampaignDeckFolders(options, { ...request, confirmApply: true });
      assert.equal(unsigned.ok, false);
      assert.equal(unsigned.problems.some((entry) => entry.code === 'CONTENT_DECK_FOLDER_BOOTSTRAP_SIGNATURE_INVALID'), true);
      assert.deepEqual(await contentTree(contentRoot), failedBefore);

      const applied = await bootstrapCampaignDeckFolders(options, {
        ...request,
        confirmApply: true,
        previewSignature: previewData.previewSignature,
      });
      assert.equal(applied.ok, true, JSON.stringify(applied.problems));
      assert.equal((applied.data as { applied: boolean }).applied, true);
      const cpuSidecar = JSON.parse(await fs.readFile(path.join(contentRoot, 'decks', 'cpu.json'), 'utf8')) as Record<string, unknown>;
      const rentalSidecar = JSON.parse(await fs.readFile(path.join(contentRoot, 'decks', 'rental.json'), 'utf8')) as Record<string, unknown>;
      const migratedGate = JSON.parse(await fs.readFile(path.join(contentRoot, ...gateSourcePath.split('/')), 'utf8')) as Record<string, unknown>;
      assert.deepEqual(cpuSidecar.futureTopLevel, { preserved: true });
      assert.deepEqual((cpuSidecar.metadata as Record<string, unknown>).futureMetadata, { preserved: true });
      assert.equal((cpuSidecar.metadata as Record<string, unknown>).folder, 'deck-folder:bootstrap');
      assert.deepEqual(rentalSidecar.futureLegacyField, { preserved: true });
      assert.equal((rentalSidecar.metadata as Record<string, unknown>).role, 'rental');
      assert.equal((rentalSidecar.metadata as Record<string, unknown>).folder, 'deck-folder:bootstrap-child');
      assert.equal((migratedGate.payload as Record<string, unknown>).deckFolder, 'deck-folder:bootstrap');

      const compiled = await compileCampaignContent({
        projectRoot: root,
        contentRoot,
        irRoot: path.join(root, 'campaign', 'source'),
        resolver,
        catalogGeneration: resolver.catalogGeneration,
        registry: createEmptyRegistry(),
        checkOnly: true,
      });
      assert.equal(compiled.ok, true, JSON.stringify(compiled.problems));
      assert.equal(JSON.stringify({ decks: compiled.deckProjections, gates: compiled.gateProjection }).includes('deck-folder:'), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
