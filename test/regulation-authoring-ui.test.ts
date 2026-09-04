import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createCardResolver } from '../src/core/card-resolver';
import {
  inspectCampaignContent,
  mutateCampaignRegulationDocuments,
  readCampaignRegulationDocuments,
} from '../src/core/content-operations';
import { createEmptyRegistry } from '../src/core/id-registry';
import { defaultContentManifest } from '../src/core/layers';
import type { CatalogCard } from '../src/core/types';

const editorRoot = path.resolve(__dirname, '..');
const makeCard = (id: number, english: string): CatalogCard => ({
  id,
  ydkId: id + 800000,
  names: { english, display: english },
  texts: {},
  original: {},
  stats: {},
  autoTags: [],
});
const cards = Array.from({ length: 40 }, (_, index) => makeCard(1001 + index, `Regulation Card ${String(index + 1).padStart(2, '0')}`));
const validRules = () => [
  '[allowed]',
  ...cards.map((card) => `3 ${card.names.english}`),
  '[forbidden]',
  '[limited]',
  '[semi-limited]',
  '',
].join('\n');
const metadata = (name = 'UI Test Regulation') => `${JSON.stringify({
  formatVersion: 1,
  kind: 'regulation',
  payload: {
    regulationId: 'regulation:ui-test',
    name,
    cutoffRef: 'release:ui-test',
    allowedRef: 'card-pool:ui-test',
    fixtureUnknown: { preserve: true },
  },
}, null, 2)}\n`;

const makeFixture = async () => {
  const root = await fs.mkdtemp(path.join(editorRoot, '.regulation-authoring-ui-'));
  const contentRoot = path.join(root, 'campaign', 'content');
  await Promise.all(['regulations', 'decks', 'gates', 'structures', 'localization', 'assets'].map((entry) => fs.mkdir(path.join(contentRoot, entry), { recursive: true })));
  await fs.writeFile(path.join(contentRoot, 'manifest.json'), `${JSON.stringify({
    ...defaultContentManifest(),
    authoring: { language: 'en' },
  }, null, 2)}\n`);
  await fs.writeFile(path.join(contentRoot, 'regulations', 'ui-test.json'), metadata());
  await fs.writeFile(path.join(contentRoot, 'regulations', 'ui-test.regulation'), validRules());
  await fs.writeFile(path.join(contentRoot, 'decks', 'fixture.decklist'), ['[main]', ...cards.map((card) => `1 ${card.names.english}`), '[extra]', '[side]', ''].join('\n'));
  await fs.writeFile(path.join(contentRoot, 'decks', 'fixture.json'), `${JSON.stringify({ regulation: 'regulation:ui-test' }, null, 2)}\n`);
  await fs.writeFile(path.join(contentRoot, 'gates', 'fixture.json'), `${JSON.stringify({
    formatVersion: 1,
    kind: 'gate',
    payload: {
      id: 'gate:regulation-ui',
      nameKey: 'gate.regulation.name',
      descriptionKey: 'gate.regulation.description',
      regulation: 'regulation:ui-test',
      priority: 1,
      goal: 'chapter:duel',
      chapters: [{
        id: 'chapter:duel', kind: 'duel', entry: true, required: true,
        descriptionKey: 'chapter.regulation.description',
        duel: {
          cpuDeck: 'fixture.decklist', rentalDeck: 'fixture.decklist', playerMode: 'rental',
          playerNameKey: 'duel.player.name', cpuNameKey: 'duel.cpu.name',
        },
      }],
      target: { ygomaster: { illust_id: 1001 } },
    },
  }, null, 2)}\n`);
  await fs.writeFile(path.join(contentRoot, 'structures', 'fixture.json'), `${JSON.stringify({
    formatVersion: 1,
    kind: 'structure',
    payload: {
      key: 'regulation-impact', targetId: 1129001,
      nameKey: 'structure.regulation.name', descriptionKey: 'structure.regulation.description',
      deck: 'fixture.decklist', focus: [cards[0]?.names.english], accessory: { box: 0, sleeve: 0 },
    },
  }, null, 2)}\n`);
  await fs.writeFile(path.join(contentRoot, 'localization', 'catalog.json'), `${JSON.stringify({ en: {
    'gate.regulation.name': 'Regulation Gate',
    'gate.regulation.description': 'Gate description',
    'chapter.regulation.description': 'Chapter description',
    'duel.player.name': 'Player',
    'duel.cpu.name': 'CPU',
    'structure.regulation.name': 'Regulation Structure',
    'structure.regulation.description': 'Structure description',
  } }, null, 2)}\n`);
  await fs.writeFile(path.join(contentRoot, 'assets', 'manifest.json'), `${JSON.stringify({ formatVersion: 1, assets: [{
    key: 'gate.regulation.background',
    source: 'assets/background.png',
    role: 'solo-gate-background',
    gateRefs: ['gate:regulation-ui'],
    provenance: 'EDITOR-014 fixture',
    license: 'test fixture',
    confirmed: true,
  }] }, null, 2)}\n`);
  await fs.writeFile(path.join(contentRoot, 'assets', 'background.png'), Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
  ]));
  const resolver = createCardResolver(cards);
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
const requestFor = async (value: Awaited<ReturnType<typeof makeFixture>>, rules = validRules(), metadataContent = metadata()) => ({
  metadata: { sourcePath: 'regulations/ui-test.json', content: metadataContent },
  rules: { sourcePath: 'regulations/ui-test.regulation', content: rules },
  operation: 'update' as const,
  expectedContentGeneration: await generationFor(value),
  confirmApply: false,
});

describe('EDITOR-014 Regulation authoring UI boundary', () => {
  it('reads and previews paired content legality, resolved names, consumers, and an unsupported runtime target separately', async () => {
    const value = await makeFixture();
    try {
      const read = await readCampaignRegulationDocuments({ ...optionsFor(value), sourcePath: 'regulations/ui-test.json' });
      assert.equal(read.ok, true, JSON.stringify(read.problems));
      assert.equal((read.data as { rules: { content: string } }).rules.content, validRules());
      const preview = await mutateCampaignRegulationDocuments(optionsFor(value), await requestFor(value));
      assert.equal(preview.ok, true, JSON.stringify(preview.problems));
      const data = preview.data as {
        requiresConfirmation: boolean;
        contentLegality: { status: string; cutoffRef: string; allowedRef: string; resolutions: Array<{ runtimeId?: number; sourceSpan?: { line: number } }>; impacts: { decks: string[]; gates: string[]; structures: Array<{ sourcePath: string; viaDeck: string }> } };
        runtimeTarget: { payload: { status: string; blockingCode: string; supportedSubset: unknown[] }; deployable: boolean; projection: unknown };
      };
      assert.equal(data.requiresConfirmation, true);
      assert.equal(data.contentLegality.status, 'valid');
      assert.equal(data.contentLegality.cutoffRef, 'release:ui-test');
      assert.equal(data.contentLegality.allowedRef, 'card-pool:ui-test');
      assert.equal(data.contentLegality.resolutions.length, 40);
      assert.equal(data.contentLegality.resolutions[0]?.runtimeId, 1001);
      assert.equal(data.contentLegality.resolutions[0]?.sourceSpan?.line, 2);
      assert.deepEqual(data.contentLegality.impacts.decks, ['decks/fixture.decklist']);
      assert.deepEqual(data.contentLegality.impacts.gates, ['gates/fixture.json']);
      assert.deepEqual(data.contentLegality.impacts.structures, [{ sourcePath: 'structures/fixture.json', viaDeck: 'fixture.decklist' }]);
      assert.equal(data.runtimeTarget.payload.status, 'unsupported');
      assert.equal(data.runtimeTarget.payload.blockingCode, 'REGULATION_TARGET_UNSUPPORTED');
      assert.deepEqual(data.runtimeTarget.payload.supportedSubset, []);
      assert.equal(data.runtimeTarget.deployable, false);
      assert.equal(data.runtimeTarget.projection, null);
      assert.equal(await fs.stat(path.join(value.root, 'campaign', 'source')).then(() => true, () => false), false);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('blocks rule resolution and affected-deck legality failures with authored locations and no writes', async () => {
    const value = await makeFixture();
    try {
      const metadataPath = path.join(value.contentRoot, 'regulations', 'ui-test.json');
      const rulesPath = path.join(value.contentRoot, 'regulations', 'ui-test.regulation');
      const originalMetadata = await fs.readFile(metadataPath, 'utf8');
      const originalRules = await fs.readFile(rulesPath, 'utf8');
      const unresolvedRules = validRules().replace('Regulation Card 40', 'No Such Regulation Card');
      const unresolved = await mutateCampaignRegulationDocuments(optionsFor(value), await requestFor(value, unresolvedRules));
      assert.equal(unresolved.ok, false);
      const unresolvedProblem = unresolved.problems.find((entry) => entry.code === 'CARD_NAME_UNRESOLVED');
      assert.equal(unresolvedProblem?.sourcePath, 'regulations/ui-test.regulation');
      assert.equal(unresolvedProblem?.line, 41);
      assert.equal((unresolved.data as { runtimeTarget: { payload: { status: string } } }).runtimeTarget.payload.status, 'unsupported');

      const conflictingRules = validRules()
        .replace('[limited]', '[limited]\n1 Regulation Card 02\n1 Regulation Card 02')
        .replace('[semi-limited]', '[semi-limited]\n2 Regulation Card 02');
      const conflicting = await mutateCampaignRegulationDocuments(optionsFor(value), await requestFor(value, conflictingRules));
      assert.equal(conflicting.ok, false);
      assert.ok(conflicting.problems.some((entry) => entry.code === 'REGULATION_RULE_DUPLICATE' && entry.sourcePath === 'regulations/ui-test.regulation'));
      assert.ok(conflicting.problems.some((entry) => entry.code === 'REGULATION_RULE_CONTRADICTORY' && entry.sourcePath === 'regulations/ui-test.regulation'));

      const withoutCutoff = metadata().replace('"cutoffRef": "release:ui-test",\n    ', '');
      const missingCutoff = await mutateCampaignRegulationDocuments(optionsFor(value), await requestFor(value, validRules(), withoutCutoff));
      assert.equal(missingCutoff.ok, false);
      assert.equal(missingCutoff.problems.find((entry) => entry.code === 'REGULATION_CUTOFF_MISSING')?.jsonPointer, '/payload/cutoffRef');

      const forbiddenRules = validRules().replace('[forbidden]', '[forbidden]\n0 Regulation Card 01');
      const forbidden = await mutateCampaignRegulationDocuments(optionsFor(value), await requestFor(value, forbiddenRules));
      assert.equal(forbidden.ok, false);
      const violation = forbidden.problems.find((entry) => entry.code === 'REGULATION_CARD_FORBIDDEN');
      assert.equal(violation?.sourcePath, 'decks/fixture.decklist');
      assert.equal(violation?.line, 2);
      assert.equal(await fs.readFile(metadataPath, 'utf8'), originalMetadata);
      assert.equal(await fs.readFile(rulesPath, 'utf8'), originalRules);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('atomically updates and recoverably deletes the pair with generation and containment guards', async () => {
    const value = await makeFixture();
    try {
      const updatedMetadata = metadata('Updated UI Test Regulation');
      const previewRequest = await requestFor(value, validRules(), updatedMetadata);
      const preview = await mutateCampaignRegulationDocuments(optionsFor(value), previewRequest);
      assert.equal(preview.ok, true, JSON.stringify(preview.problems));
      assert.notEqual(await fs.readFile(path.join(value.contentRoot, 'regulations', 'ui-test.json'), 'utf8'), updatedMetadata);
      const applied = await mutateCampaignRegulationDocuments(optionsFor(value), { ...previewRequest, confirmApply: true });
      assert.equal(applied.ok, true, JSON.stringify(applied.problems));
      assert.equal(await fs.readFile(path.join(value.contentRoot, 'regulations', 'ui-test.json'), 'utf8'), updatedMetadata);
      assert.equal(await fs.readFile(path.join(value.contentRoot, 'regulations', 'ui-test.regulation'), 'utf8'), validRules());

      const stale = await mutateCampaignRegulationDocuments(optionsFor(value), previewRequest);
      assert.equal(stale.problems[0]?.code, 'CONTENT_GENERATION_STALE');
      const escaped = await mutateCampaignRegulationDocuments(optionsFor(value), {
        ...await requestFor(value),
        rules: { sourcePath: 'regulations/../outside.regulation', content: validRules() },
      });
      assert.equal(escaped.problems[0]?.code, 'CONTENT_REGULATION_PATH_UNAUTHORIZED');
      const mismatched = await mutateCampaignRegulationDocuments(optionsFor(value), {
        ...await requestFor(value),
        rules: { sourcePath: 'regulations/other.regulation', content: validRules() },
      });
      assert.equal(mismatched.problems[0]?.code, 'CONTENT_REGULATION_PATH_UNAUTHORIZED');

      await fs.rm(path.join(value.contentRoot, 'gates', 'fixture.json'));
      await fs.rm(path.join(value.contentRoot, 'assets', 'manifest.json'));
      await fs.rm(path.join(value.contentRoot, 'assets', 'background.png'));
      await fs.rm(path.join(value.contentRoot, 'structures', 'fixture.json'));
      await fs.rm(path.join(value.contentRoot, 'decks', 'fixture.json'));
      const deleteRequest = {
        ...await requestFor(value),
        operation: 'delete' as const,
        confirmApply: true,
      };
      const deleted = await mutateCampaignRegulationDocuments(optionsFor(value), deleteRequest);
      assert.equal(deleted.ok, true, JSON.stringify(deleted.problems));
      assert.equal(await fs.stat(path.join(value.contentRoot, 'regulations', 'ui-test.json')).then(() => true, () => false), false);
      assert.equal(await fs.stat(path.join(value.contentRoot, 'regulations', 'ui-test.regulation')).then(() => true, () => false), false);
      const trashFiles = await fs.readdir(path.join(value.contentRoot, '.trash', 'regulation'), { recursive: true });
      assert.ok(trashFiles.some((entry) => String(entry).endsWith('ui-test.json')));
      assert.ok(trashFiles.some((entry) => String(entry).endsWith('ui-test.regulation')));
      const afterDelete = await inspectCampaignContent(optionsFor(value));
      assert.equal(afterDelete.ok, true, JSON.stringify(afterDelete.problems));
      assert.equal(await fs.stat(path.join(value.root, 'campaign', 'source')).then(() => true, () => false), false);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('renderer uses preload IPC and has no filesystem, network, generated IR, or runtime writer path', async () => {
    const source = await fs.readFile(path.join(editorRoot, 'src', 'renderer', 'components', 'regulation', 'RegulationAuthoring.tsx'), 'utf8');
    assert.match(source, /contentRegulationRead/u);
    assert.match(source, /contentRegulationMutate/u);
    assert.match(source, /Runtime target capability is unsupported/u);
    for (const forbidden of ['node:fs', 'fetch(', 'campaign/source', 'RegulationMaster', 'deployCampaign', 'writeFile(']) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  });
});
