import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  deckAuthoringLineLocation,
  emptyDeckAuthoringSections,
  formatDeckAuthoringSections,
  insertDeckAuthoringCard,
  parseDeckAuthoringSections,
} from '../src/common/deck-authoring';
import { createCardResolver } from '../src/core/card-resolver';
import { inspectCampaignContent, mutateCampaignContentDocument, previewCampaignDeckDocument } from '../src/core/content-operations';
import { createEmptyRegistry } from '../src/core/id-registry';
import { defaultContentManifest } from '../src/core/layers';
import type { CatalogCard } from '../src/core/types';

const editorRoot = path.resolve(__dirname, '..');
const makeCard = (id: number, english: string): CatalogCard => ({
  id,
  ydkId: 800000 + id,
  names: { english, display: english },
  texts: {},
  original: {},
  stats: {},
  autoTags: [],
});

const cards = [
  ...Array.from({ length: 40 }, (_, index) => makeCard(index + 1, `Fixture Card ${String(index + 1).padStart(2, '0')}`)),
  makeCard(101, 'Ambiguous Card'),
  makeCard(102, 'Ａmbiguous Card'),
];

const validSections = () => ({
  main: Array.from({ length: 40 }, (_, index) => `1 ${index === 0 ? 'Reviewed First' : `Fixture Card ${String(index + 1).padStart(2, '0')}`}`).join('\n'),
  extra: '',
  side: '',
});

const fixture = async () => {
  const root = await fs.mkdtemp(path.join(editorRoot, '.deck-authoring-ui-'));
  const contentRoot = path.join(root, 'campaign', 'content');
  await fs.mkdir(path.join(contentRoot, 'decks'), { recursive: true });
  await fs.writeFile(path.join(contentRoot, 'manifest.json'), `${JSON.stringify(defaultContentManifest(), null, 2)}\n`);
  await fs.writeFile(path.join(contentRoot, 'decks', 'fixture.decklist'), formatDeckAuthoringSections(validSections()));
  const resolver = createCardResolver(cards, {
    catalogGeneration: 'deck-authoring-ui-catalog',
    aliases: [{ name: 'Reviewed First', runtimeId: 1, reviewed: true, source: 'fixture' }],
  });
  return { root, contentRoot, resolver, registry: createEmptyRegistry() };
};

describe('EDITOR-011 deck authoring UI model', () => {
  it('serializes main/extra/side canonically and inserts catalog English names instead of runtime IDs', () => {
    let sections = emptyDeckAuthoringSections();
    sections = insertDeckAuthoringCard(sections, 'main', 'Blue-Eyes White Dragon');
    sections = insertDeckAuthoringCard(sections, 'extra', 'Flame Swordsman', 2);
    const canonical = formatDeckAuthoringSections(sections);
    assert.equal(canonical, '[main]\n1 Blue-Eyes White Dragon\n\n[extra]\n2 Flame Swordsman\n\n[side]\n');
    assert.deepEqual(parseDeckAuthoringSections(canonical), sections);
    assert.deepEqual(deckAuthoringLineLocation(sections, 2), { section: 'main', line: 1 });
    assert.deepEqual(deckAuthoringLineLocation(sections, 5), { section: 'extra', line: 1 });
    assert.equal(canonical.includes('runtime'), false);
    assert.throws(() => parseDeckAuthoringSections('1 Lost Card\n[main]\n1 Card\n[extra]\n[side]\n'), /outside a Deck section/u);
    assert.throws(() => parseDeckAuthoringSections('[main]\n1 Card\n[main]\n1 Other\n[extra]\n[side]\n'), /Duplicate \[main\]/u);
  });

  it('previews exact and alias resolution plus compiled runtime IDs without writing generated IR', async () => {
    const value = await fixture();
    try {
      const options = { projectRoot: value.root, contentRoot: value.contentRoot, resolver: value.resolver, registry: value.registry };
      const inspected = await inspectCampaignContent(options);
      assert.equal(inspected.ok, true, JSON.stringify(inspected.problems));
      const generation = (inspected.data as { contentGeneration: string }).contentGeneration;
      const preview = await previewCampaignDeckDocument(options, { sourcePath: 'decks/fixture.decklist', sections: validSections(), expectedContentGeneration: generation });
      assert.equal(preview.ok, true, JSON.stringify(preview.problems));
      const data = preview.data as { canonicalContent: string; resolutions: Array<{ state: string; runtimeId?: number }>; compiledRuntimeIds?: { m: { ids: number[] } } };
      assert.equal(data.resolutions[0]?.state, 'alias');
      assert.equal(data.resolutions[1]?.state, 'exact');
      assert.deepEqual(data.compiledRuntimeIds?.m.ids, Array.from({ length: 40 }, (_, index) => index + 1));
      assert.equal(await fs.stat(path.join(value.root, 'campaign', 'source')).then(() => true, () => false), false);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('returns line-linked unresolved and ambiguous candidates with no runtime-ID projection', async () => {
    const value = await fixture();
    try {
      const options = { projectRoot: value.root, contentRoot: value.contentRoot, resolver: value.resolver, registry: value.registry };
      const inspected = await inspectCampaignContent(options);
      const generation = (inspected.data as { contentGeneration: string }).contentGeneration;
      const sections = validSections();
      sections.main = sections.main.replace('1 Fixture Card 39', '1 Missing Card').replace('1 Fixture Card 40', '1 Ambiguous Card');
      const preview = await previewCampaignDeckDocument(options, { sourcePath: 'decks/fixture.decklist', sections, expectedContentGeneration: generation });
      assert.equal(preview.ok, false);
      const data = preview.data as { resolutions: Array<{ state: string; line: number; candidates: Array<{ name: string }> }>; compiledRuntimeIds?: unknown };
      assert.equal(data.resolutions.some((entry) => entry.state === 'unresolved' && entry.line === 40), true);
      assert.equal(data.resolutions.some((entry) => entry.state === 'ambiguous' && entry.line === 41 && entry.candidates.length === 2), true);
      assert.deepEqual(data.resolutions.find((entry) => entry.state === 'ambiguous')?.candidates.map((entry) => entry.name), ['Ambiguous Card', 'Ａmbiguous Card']);
      assert.equal(data.compiledRuntimeIds, undefined);
      assert.equal(preview.problems.every((entry) => Boolean(entry.line || entry.sourceSpan?.line)), true);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('rejects stale previews and traversal that leaves the manifest Deck directory', async () => {
    const value = await fixture();
    try {
      const options = { projectRoot: value.root, contentRoot: value.contentRoot, resolver: value.resolver, registry: value.registry };
      const stale = await previewCampaignDeckDocument(options, { sourcePath: 'decks/fixture.decklist', sections: validSections(), expectedContentGeneration: 'stale' });
      assert.equal(stale.problems[0]?.code, 'CONTENT_GENERATION_STALE');
      const escaped = await previewCampaignDeckDocument(options, { sourcePath: 'decks/../gates/fixture.decklist', sections: validSections(), expectedContentGeneration: 'stale' });
      assert.equal(escaped.problems[0]?.code, 'CONTENT_DECK_PATH_UNAUTHORIZED');
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('keeps staged regulation failures attached to the authored card line and blocks the save', async () => {
    const value = await fixture();
    try {
      const regulationRoot = path.join(value.contentRoot, 'regulations');
      await fs.mkdir(regulationRoot, { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(value.contentRoot, 'decks', 'fixture.json'), `${JSON.stringify({ regulation: 'regulation:ui-test' }, null, 2)}\n`),
        fs.writeFile(path.join(regulationRoot, 'ui-test.json'), `${JSON.stringify({ formatVersion: 1, kind: 'regulation', payload: { regulationId: 'regulation:ui-test', name: 'UI Test Regulation', cutoffRef: 'release:ui-test', allowedRef: 'card-pool:ui-test', rulesRef: 'ui-test.regulation' } }, null, 2)}\n`),
        fs.writeFile(path.join(regulationRoot, 'ui-test.regulation'), ['[allowed]', ...cards.slice(0, 40).map((card) => `3 ${card.names.english}`), '[forbidden]', '0 Fixture Card 01', ''].join('\n')),
      ]);
      const options = { projectRoot: value.root, contentRoot: value.contentRoot, resolver: value.resolver, registry: value.registry };
      const inspected = await inspectCampaignContent(options);
      assert.equal(inspected.ok, true, JSON.stringify(inspected.problems));
      const generation = (inspected.data as { contentGeneration: string }).contentGeneration;
      const original = await fs.readFile(path.join(value.contentRoot, 'decks', 'fixture.decklist'), 'utf8');
      const blocked = await mutateCampaignContentDocument(options, { sourcePath: 'decks/fixture.decklist', operation: 'update', content: original, expectedContentGeneration: generation, confirmApply: false });
      assert.equal(blocked.ok, false);
      const violation = blocked.problems.find((entry) => entry.code === 'REGULATION_CARD_FORBIDDEN');
      assert.ok(violation, JSON.stringify(blocked.problems));
      assert.equal(violation?.sourcePath, 'decks/fixture.decklist');
      assert.equal(violation?.line, 2);
      assert.equal(await fs.readFile(path.join(value.contentRoot, 'decks', 'fixture.decklist'), 'utf8'), original);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('saves exactly the previewed canonical decklist only through the confirmed content mutation boundary', async () => {
    const value = await fixture();
    try {
      const options = { projectRoot: value.root, contentRoot: value.contentRoot, resolver: value.resolver, registry: value.registry };
      const inspected = await inspectCampaignContent(options);
      const generation = (inspected.data as { contentGeneration: string }).contentGeneration;
      const preview = await previewCampaignDeckDocument(options, { sourcePath: 'decks/fixture.decklist', sections: validSections(), expectedContentGeneration: generation });
      assert.equal(preview.ok, true);
      const canonicalContent = (preview.data as { canonicalContent: string }).canonicalContent;
      const before = await fs.readFile(path.join(value.contentRoot, 'decks', 'fixture.decklist'), 'utf8');
      const validation = await mutateCampaignContentDocument(options, { sourcePath: 'decks/fixture.decklist', operation: 'update', content: canonicalContent, expectedContentGeneration: generation, confirmApply: false });
      assert.equal(validation.ok, true, JSON.stringify(validation.problems));
      assert.equal(await fs.readFile(path.join(value.contentRoot, 'decks', 'fixture.decklist'), 'utf8'), before);
      const saved = await mutateCampaignContentDocument(options, { sourcePath: 'decks/fixture.decklist', operation: 'update', content: canonicalContent, expectedContentGeneration: generation, confirmApply: true });
      assert.equal(saved.ok, true, JSON.stringify(saved.problems));
      assert.equal(await fs.readFile(path.join(value.contentRoot, 'decks', 'fixture.decklist'), 'utf8'), canonicalContent);
      assert.equal(await fs.stat(path.join(value.root, 'campaign', 'source')).then(() => true, () => false), false);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('renderer source uses content write-through and does not call legacy generated Deck CRUD', async () => {
    const source = await fs.readFile(path.join(editorRoot, 'src', 'renderer', 'components', 'deck', 'DeckList.tsx'), 'utf8');
    assert.match(source, /contentDeckPreview/u);
    assert.match(source, /contentDocumentMutate/u);
    for (const legacy of ['readDecks', 'readDeck(', 'createDeck', 'updateDeck', 'deleteDeck']) assert.equal(source.includes(legacy), false, legacy);
  });
});
