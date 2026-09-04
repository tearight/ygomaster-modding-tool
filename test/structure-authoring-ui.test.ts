import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createCardResolver } from '../src/core/card-resolver';
import { inspectCampaignContent, mutateCampaignStructureDocument } from '../src/core/content-operations';
import { createEmptyRegistry } from '../src/core/id-registry';
import { defaultContentManifest } from '../src/core/layers';
import type { CatalogCard } from '../src/core/types';

const editorRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/structure-content');
const fixture = (relativePath: string) => fs.readFile(path.join(fixtureRoot, relativePath), 'utf8');
const makeCard = (id: number, english: string, type?: number): CatalogCard => ({
  id,
  ydkId: id + 800000,
  names: { english, display: english },
  texts: {},
  original: {},
  stats: { ...(type === undefined ? {} : { type }) },
  autoTags: [],
});
const cards = [
  makeCard(1001, 'Blue-Eyes White Dragon'),
  makeCard(1002, 'Number 39: Utopia'),
  makeCard(1003, 'Ancient Fairy Dragon'),
  makeCard(1004, 'Chronicle Dragon — Revised'),
  makeCard(1005, '1000-Eyes Restrict'),
  ...Array.from({ length: 9 }, (_, index) => makeCard(1007 + index, `Main Card ${String(index + 7).padStart(2, '0')}`)),
  makeCard(1016, 'Extra Card Alpha', 0x41),
  makeCard(1017, 'Extra Card Beta'),
  makeCard(1018, 'Side Card'),
];

const makeFixture = async () => {
  const root = await fs.mkdtemp(path.join(editorRoot, '.structure-authoring-ui-'));
  const contentRoot = path.join(root, 'campaign', 'content');
  await Promise.all(['structures', 'decks', 'localization', 'assets'].map((entry) => fs.mkdir(path.join(contentRoot, entry), { recursive: true })));
  await fs.writeFile(path.join(contentRoot, 'manifest.json'), `${JSON.stringify({ ...defaultContentManifest(), authoring: { language: 'en' } }, null, 2)}\n`);
  await fs.writeFile(path.join(contentRoot, 'structures', 'starter.json'), await fixture('success/structure.json'));
  await fs.writeFile(path.join(contentRoot, 'decks', 'deck.decklist'), await fixture('success/deck.decklist'));
  await fs.writeFile(path.join(contentRoot, 'localization', 'catalog.json'), `${JSON.stringify({ en: { 'structure.demo.name': 'Chronicle Starter', 'structure.demo.description': 'A fixture structure deck.' } }, null, 2)}\n`);
  await fs.writeFile(path.join(contentRoot, 'assets', 'accessories.json'), `${JSON.stringify({ 'starter-accessory': { box: 0, sleeve: 0 } }, null, 2)}\n`);
  const resolver = createCardResolver(cards, { aliases: [{ name: 'Chronicle Dragon', runtimeId: 1004, reviewed: true, source: 'editor-013-fixture' }] });
  return { root, contentRoot, resolver, registry: createEmptyRegistry() };
};

const optionsFor = (value: Awaited<ReturnType<typeof makeFixture>>) => ({
  projectRoot: value.root,
  contentRoot: value.contentRoot,
  resolver: value.resolver,
  registry: value.registry,
});
const generationFor = async (value: Awaited<ReturnType<typeof makeFixture>>) =>
  ((await inspectCampaignContent(optionsFor(value))).data as { contentGeneration: string }).contentGeneration;

describe('EDITOR-013 Structure authoring UI boundary', () => {
  it('previews the shared compiler projection and labels the approved adapter as assumed', async () => {
    const value = await makeFixture();
    try {
      const content = await fs.readFile(path.join(value.contentRoot, 'structures', 'starter.json'), 'utf8');
      const preview = await mutateCampaignStructureDocument(optionsFor(value), {
        sourcePath: 'structures/starter.json', operation: 'update', content,
        expectedContentGeneration: await generationFor(value), confirmApply: false,
      });
      assert.equal(preview.ok, true, JSON.stringify(preview.problems));
      const data = preview.data as { requiresConfirmation: boolean; capability: { status: string; evidence: string }; projection: { path: string; document: Record<string, unknown> } };
      assert.equal(data.requiresConfirmation, true);
      assert.equal(data.capability.status, 'assumed');
      assert.match(data.capability.evidence, /CAMPAIGN-008.*v1\.77/u);
      assert.equal(data.projection.path, 'Data/StructureDecks/1129001.json');
      assert.deepEqual(data.projection.document, JSON.parse(await fixture('success/expected-structure.json')));
      assert.deepEqual((data.projection.document.focus as { ids: number[] }).ids, [1001, 1004, 1002]);
      assert.equal(await fs.stat(path.join(value.root, 'campaign', 'source')).then(() => true, () => false), false);

      const blocked = await mutateCampaignStructureDocument({ ...optionsFor(value), verifiedStructureAdapter: false }, {
        sourcePath: 'structures/starter.json', operation: 'update', content,
        expectedContentGeneration: await generationFor(value), confirmApply: false,
      });
      assert.equal(blocked.ok, false);
      assert.ok(blocked.problems.some((entry) => entry.code === 'STRUCTURE_TARGET_UNVERIFIED'));
      assert.equal((blocked.data as { projection: unknown }).projection, null);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('blocks deck, focus, and reward reference errors before confirmation without changing authored bytes', async () => {
    const value = await makeFixture();
    try {
      const file = path.join(value.contentRoot, 'structures', 'starter.json');
      const original = await fs.readFile(file, 'utf8');
      const base = JSON.parse(original) as { payload: Record<string, unknown> };
      const later = structuredClone(base);
      later.payload.key = 'later-valid-structure'; later.payload.targetId = 1129002;
      await fs.writeFile(path.join(value.contentRoot, 'structures', 'later.json'), `${JSON.stringify(later, null, 2)}\n`);
      const cases: Array<[string, (document: typeof base) => void]> = [
        ['STRUCTURE_DECK_MISSING', (document) => { document.payload.deck = 'missing.decklist'; }],
        ['CARD_NAME_UNRESOLVED', (document) => { document.payload.focus = ['No Such Structure Card']; }],
        ['STRUCTURE_REWARD_ORPHAN', (document) => { document.payload.reward = { structureKey: 'missing-structure', quantity: 1, oneCopy: true }; }],
      ];
      for (const [code, mutate] of cases) {
        const document = structuredClone(base); mutate(document);
        const preview = await mutateCampaignStructureDocument(optionsFor(value), {
          sourcePath: 'structures/starter.json', operation: 'update', content: `${JSON.stringify(document, null, 2)}\n`,
          expectedContentGeneration: await generationFor(value), confirmApply: false,
        });
        assert.equal(preview.ok, false, code);
        assert.equal((preview.data as { projection: unknown }).projection, null, 'a failed edit must not display another valid Structure projection');
        const problem = preview.problems.find((entry) => entry.code === code && Boolean(entry.sourcePath || entry.path))
          || preview.problems.find((entry) => entry.code === code);
        assert.equal(problem?.sourcePath || problem?.path, 'structures/starter.json');
        assert.ok(problem?.jsonPointer, JSON.stringify(problem));
        assert.equal(await fs.readFile(file, 'utf8'), original);
      }
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('creates, updates, and recoverably deletes only authored Structure metadata with generation guards', async () => {
    const value = await makeFixture();
    try {
      const protectedPaths = ['manifest.json', 'decks/deck.decklist', 'localization/catalog.json', 'assets/accessories.json'];
      const protectedBytes = new Map(await Promise.all(protectedPaths.map(async (entry) => [entry, await fs.readFile(path.join(value.contentRoot, entry), 'utf8')] as const)));
      const source = JSON.parse(await fixture('success/structure.json')) as { payload: Record<string, unknown> };
      source.payload.key = 'created'; source.payload.targetId = 1129002;
      const content = `${JSON.stringify(source, null, 2)}\n`;
      const initialGeneration = await generationFor(value);
      const request = { sourcePath: 'structures/created.json', operation: 'create' as const, content, expectedContentGeneration: initialGeneration, confirmApply: false };
      const preview = await mutateCampaignStructureDocument(optionsFor(value), request);
      assert.equal(preview.ok, true, JSON.stringify(preview.problems));
      assert.equal(await fs.stat(path.join(value.contentRoot, 'structures', 'created.json')).then(() => true, () => false), false);
      const created = await mutateCampaignStructureDocument(optionsFor(value), { ...request, confirmApply: true });
      assert.equal(created.ok, true, JSON.stringify(created.problems));
      assert.equal(await fs.readFile(path.join(value.contentRoot, 'structures', 'created.json'), 'utf8'), content);

      const stale = await mutateCampaignStructureDocument(optionsFor(value), request);
      assert.equal(stale.problems[0]?.code, 'CONTENT_GENERATION_STALE');
      const updatedContent = content.replace('opaque-structure-value', 'preserved-and-updated');
      const updated = await mutateCampaignStructureDocument(optionsFor(value), {
        sourcePath: 'structures/created.json', operation: 'update', content: updatedContent,
        expectedContentGeneration: await generationFor(value), confirmApply: true,
      });
      assert.equal(updated.ok, true, JSON.stringify(updated.problems));
      assert.equal(await fs.readFile(path.join(value.contentRoot, 'structures', 'created.json'), 'utf8'), updatedContent);

      const deleted = await mutateCampaignStructureDocument(optionsFor(value), {
        sourcePath: 'structures/created.json', operation: 'delete',
        expectedContentGeneration: await generationFor(value), confirmApply: true,
      });
      assert.equal(deleted.ok, true, JSON.stringify(deleted.problems));
      assert.equal(await fs.stat(path.join(value.contentRoot, 'structures', 'created.json')).then(() => true, () => false), false);
      assert.match(JSON.stringify(deleted.data), /\.trash.*structures[/\\]created\.json/u);
      for (const [entry, bytes] of protectedBytes) assert.equal(await fs.readFile(path.join(value.contentRoot, entry), 'utf8'), bytes);
      assert.equal(await fs.stat(path.join(value.root, 'campaign', 'source')).then(() => true, () => false), false);

      const escaped = await mutateCampaignStructureDocument(optionsFor(value), {
        sourcePath: 'structures/../outside.json', operation: 'create', content,
        expectedContentGeneration: await generationFor(value), confirmApply: false,
      });
      assert.equal(escaped.problems[0]?.code, 'CONTENT_STRUCTURE_PATH_UNAUTHORIZED');
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('renderer uses preload IPC and contains no filesystem, network, or legacy generated Structure CRUD', async () => {
    const source = await fs.readFile(path.join(editorRoot, 'src', 'renderer', 'components', 'structure-deck', 'StructureAuthoring.tsx'), 'utf8');
    assert.match(source, /contentDocumentList/u);
    assert.match(source, /contentDocumentRead/u);
    assert.match(source, /contentStructureMutate/u);
    assert.match(source, /fixture-backed and assumed/u);
    for (const forbidden of ['node:fs', 'fetch(', 'readStructureDecks', 'readStructureDeck(', 'createStructureDeck', 'updateStructureDeck', 'deleteStructureDeck']) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  });
});
