import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  CARD_RESOLVER_CODES,
  createCardResolver,
} from '../src/core/card-resolver';
import type { CatalogCard } from '../src/core/types';
import {
  STRUCTURE_CODES,
  compileStructureCollection,
  compileStructureContent,
  createStructureEnvelope,
  parseStructureContent,
} from '../src/core/structure-content';
import {
  createLocalizationCatalog,
  parseLocalizationText,
} from '../src/core/localization-content';
import { createEmptyRegistry } from '../src/core/id-registry';
import { applyCampaignOverlay } from '../src/core/overlay';
import type { DeckIR } from '../src/core/deck-content';

const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/structure-content');

const readFixture = async (relativePath: string): Promise<string> =>
  readFile(path.join(fixtureRoot, relativePath), 'utf8');

const readJsonFixture = async (relativePath: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFixture(relativePath)) as Record<string, unknown>;

const makeCard = (id: number, english: string): CatalogCard => ({
  id,
  ydkId: id + 800000,
  names: { english, display: english },
  texts: {},
  original: {},
  stats: {},
  autoTags: [],
});

const cards: CatalogCard[] = [
  makeCard(1001, 'Blue-Eyes White Dragon'),
  makeCard(1002, 'Number 39: Utopia'),
  makeCard(1003, 'Ancient Fairy Dragon'),
  makeCard(1004, 'Chronicle Dragon — Revised'),
  makeCard(1005, '1000-Eyes Restrict'),
  ...Array.from({ length: 9 }, (_, index) => makeCard(1007 + index, `Main Card ${String(index + 7).padStart(2, '0')}`)),
  makeCard(1016, 'Extra Card Alpha'),
  makeCard(1017, 'Extra Card Beta'),
  makeCard(1018, 'Side Card'),
];

const resolver = createCardResolver(cards, {
  aliases: [{
    name: 'Chronicle Dragon',
    runtimeId: 1004,
    reviewed: true,
    source: 'stc-001-reviewed-rename',
  }],
});

const localization = createLocalizationCatalog([
  parseLocalizationText(
    '[structure.demo.name]\nChronicle Starter\n\n[structure.demo.description]\nA fixture structure deck.\n',
    'en',
    'fixture://structure-content/localization.en.txt',
  ),
], { fallbackLanguage: 'en' });

const baseOptions = async (overrides: Record<string, unknown> = {}) => ({
  sourcePath: 'campaign/fixtures/structure-content/success/structure.json',
  registry: createEmptyRegistry(),
  deckSources: { 'deck.decklist': await readFixture('success/deck.decklist') },
  localization,
  accessories: { 'starter-accessory': { box: 0, sleeve: 0 } },
  extraDeckCardIds: new Set([1016]),
  allowAssumed: true,
  ...overrides,
});

describe('STC-001 symbolic structure content', () => {
  it('parses an envelope, preserves wrappers/unknown fields, and forbids inline card arrays', async () => {
    const source = await readFixture('success/structure.json');
    const parsed = parseStructureContent(source, 'fixture://structure-content/success/structure.json');
    assert.equal(parsed.payloadKey, 'payload');
    assert.equal(parsed.raw.fixture_unknown_envelope && typeof parsed.raw.fixture_unknown_envelope, 'object');
    assert.equal(parsed.payload.fixture_unknown_structure && typeof parsed.payload.fixture_unknown_structure, 'object');

    const result = await compileStructureContent(
      await readJsonFixture('cases/inline-cards.json'),
      resolver,
      await baseOptions(),
    );
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((entry) => entry.code === STRUCTURE_CODES.DECK_ARRAY_FORBIDDEN));
  });

  it('resolves the deck reference/focus/localization/accessory and projects the current target shape', async () => {
    const result = await compileStructureContent(
      await readJsonFixture('success/structure.json'),
      resolver,
      await baseOptions(),
    );
    const expected = await readJsonFixture('success/expected-structure.json');
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.contentOk, true);
    assert.equal(result.structureId, 1129001);
    assert.deepEqual(result.target, expected);
    assert.equal(result.projection?.path, 'Data/StructureDecks/1129001.json');
    assert.equal(result.localization?.name, 'Chronicle Starter');
    assert.equal(result.localization?.description, 'A fixture structure deck.');
    assert.deepEqual(result.focus?.map((entry) => entry.runtimeId), [1001, 1004, 1002]);
    assert.equal(result.focus?.[1]?.matchKind, 'alias');
    assert.ok(result.deckIr);
    assert.equal(result.deckIr?.m.ids.length, 42);
    assert.deepEqual(result.deckIr?.e, { ids: [1016], r: [1] });
    assert.deepEqual(result.deckIr?.s, { ids: [1018], r: [1] });
    assert.ok(result.warnings.some((entry) => entry.code === STRUCTURE_CODES.REWARD_ONE_COPY_ASSUMED));
  });

  it('requires an explicit assumed/verified structure adapter and supports either opt-in', async () => {
    const noOptIn = await compileStructureContent(
      await readJsonFixture('success/structure.json'),
      resolver,
      await baseOptions({ allowAssumed: false }),
    );
    assert.equal(noOptIn.ok, false);
    assert.equal(noOptIn.target, undefined);
    assert.ok(noOptIn.problems.some((entry) => entry.code === STRUCTURE_CODES.TARGET_UNVERIFIED));

    const verified = await compileStructureContent(
      await readJsonFixture('success/structure.json'),
      resolver,
      await baseOptions({ allowAssumed: false, verifiedAdapter: true }),
    );
    assert.equal(verified.ok, true, JSON.stringify(verified.problems));
    assert.equal(verified.targetCapability.allowed, true);
  });

  it('fails closed for missing deck/localization/accessory and focus membership', async () => {
    const cases: Array<[string, string]> = [
      ['cases/missing-deck.json', STRUCTURE_CODES.DECK_MISSING],
      ['cases/missing-localization.json', STRUCTURE_CODES.LOCALIZATION_MISSING],
      ['cases/missing-accessory.json', STRUCTURE_CODES.ACCESSORY_MISSING],
      ['cases/empty-accessory.json', STRUCTURE_CODES.ACCESSORY_INVALID],
      ['cases/focus-not-in-deck.json', STRUCTURE_CODES.FOCUS_NOT_IN_DECK],
    ];
    for (const [file, code] of cases) {
      const result = await compileStructureContent(await readJsonFixture(file), resolver, await baseOptions());
      assert.equal(result.ok, false, file);
      assert.ok(result.problems.some((entry) => entry.code === code), `${file} should report ${code}`);
    }
  });

  it('enforces focus maximum/duplicate policy and retains resolver diagnostics', async () => {
    const source = await readJsonFixture('success/structure.json');
    const tooMany = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
    (tooMany.payload as Record<string, unknown>).focus = [
      'Blue-Eyes White Dragon',
      'Chronicle Dragon',
      'Number 39: Utopia',
      'Ancient Fairy Dragon',
    ];
    const maxResult = await compileStructureContent(tooMany, resolver, await baseOptions());
    assert.equal(maxResult.ok, false);
    assert.ok(maxResult.problems.some((entry) => entry.code === STRUCTURE_CODES.FOCUS_MAX));

    const duplicate = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
    (duplicate.payload as Record<string, unknown>).focus = [
      'Blue-Eyes White Dragon',
      'Blue—Eyes White Dragon',
    ];
    const duplicateResult = await compileStructureContent(duplicate, resolver, await baseOptions());
    assert.equal(duplicateResult.ok, false);
    assert.ok(duplicateResult.problems.some((entry) => entry.code === STRUCTURE_CODES.FOCUS_DUPLICATE));

    const unresolved = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
    (unresolved.payload as Record<string, unknown>).focus = 'No Such Structure Card';
    const unresolvedResult = await compileStructureContent(unresolved, resolver, await baseOptions());
    assert.equal(unresolvedResult.ok, false);
    assert.ok(unresolvedResult.problems.some((entry) => entry.code === CARD_RESOLVER_CODES.NAME_UNRESOLVED));
    assert.ok(unresolvedResult.problems.some((entry) => entry.code === STRUCTURE_CODES.FOCUS_NOT_IN_DECK) === false);

    const mixed = await compileStructureContent(await readJsonFixture('cases/mixed-focus-cards.json'), resolver, await baseOptions());
    assert.equal(mixed.ok, false);
    assert.equal(mixed.problems.find((entry) => entry.code === CARD_RESOLVER_CODES.NAME_UNRESOLVED)?.jsonPointer, '/payload/focusCards/1');
    assert.equal(mixed.problems.find((entry) => entry.code === STRUCTURE_CODES.FOCUS_NOT_IN_DECK)?.jsonPointer, '/payload/focusCards/2');
    assert.equal(mixed.focus?.[1]?.sourceIndex, 2);
  });

  it('keeps deterministic structure IDs and rejects duplicate pins/orphan rewards', async () => {
    const source = await readJsonFixture('success/structure.json');
    const first = await compileStructureContent(source, resolver, await baseOptions());
    assert.equal(first.ok, true, JSON.stringify(first.problems));
    const second = await compileStructureContent(source, resolver, await baseOptions({ registry: first.registry }));
    assert.equal(second.ok, true);
    assert.equal(second.structureId, first.structureId);

    const duplicatePin = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
    (duplicatePin.payload as Record<string, unknown>).key = 'different-structure';
    const collection = await compileStructureCollection([source, duplicatePin], resolver, await baseOptions());
    assert.equal(collection.ok, false);
    assert.ok(collection.problems.some((entry) => entry.code === STRUCTURE_CODES.ID_CONFLICT));

    const orphan = await compileStructureCollection([source], resolver, await baseOptions({
      rewardReferences: [{ structureKey: 'not-a-structure', quantity: 1, oneCopy: true }],
    }));
    assert.equal(orphan.ok, false);
    assert.ok(orphan.problems.some((entry) => entry.code === STRUCTURE_CODES.REWARD_ORPHAN));
  });

  it('accepts an explicit reward quantity while warning that one-copy semantics are undocumented', async () => {
    const reward = await readJsonFixture('cases/reward-orphan.json');
    const result = await compileStructureContent(reward, resolver, await baseOptions());
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((entry) => entry.code === STRUCTURE_CODES.REWARD_ORPHAN));
    assert.ok(result.warnings.some((entry) => entry.code === STRUCTURE_CODES.REWARD_ONE_COPY_ASSUMED));

    const invalidOneCopy = await compileStructureContent(await readJsonFixture('cases/invalid-one-copy.json'), resolver, await baseOptions());
    assert.equal(invalidOneCopy.ok, false);
    assert.equal(invalidOneCopy.problems.find((entry) => entry.code === STRUCTURE_CODES.REWARD_ONE_COPY_INVALID)?.jsonPointer, '/payload/reward/oneCopy');

    const envelope = createStructureEnvelope({
      key: 'minimal',
      nameKey: 'structure.demo.name',
      descriptionKey: 'structure.demo.description',
      deck: 'deck.decklist',
      focus: 'Blue-Eyes White Dragon',
      accessory: 'starter-accessory',
    }, { fixture_wrapper: { keep: 'yes' } });
    const parsed = parseStructureContent(envelope);
    assert.equal(parsed.raw.fixture_wrapper && typeof parsed.raw.fixture_wrapper, 'object');
  });

  it('projects a compiled structure through the additive overlay core and preserves deck IR semantics', async () => {
    const compiled = await compileStructureContent(
      await readJsonFixture('success/structure.json'),
      resolver,
      await baseOptions(),
    );
    assert.equal(compiled.ok, true, JSON.stringify(compiled.problems));
    assert.ok(compiled.target && compiled.deckIr);

    const root = await mkdtemp(path.join(os.tmpdir(), 'ygomaster-stc-'));
    const sourceRoot = path.join(root, 'source');
    const runtimeRoot = path.join(root, 'runtime');
    try {
      await Promise.all([
        mkdir(path.join(sourceRoot, 'gate'), { recursive: true }),
        mkdir(path.join(sourceRoot, 'deck'), { recursive: true }),
        mkdir(path.join(sourceRoot, 'structure'), { recursive: true }),
        mkdir(path.join(sourceRoot, 'overlay'), { recursive: true }),
        mkdir(path.join(runtimeRoot, 'Data'), { recursive: true }),
      ]);
      await writeFile(path.join(sourceRoot, 'manifest.json'), JSON.stringify({
        formatVersion: 1,
        campaign: { name: 'STC fixture', slug: 'stc-fixture', version: 'test/1' },
        directories: { gate: 'gate', deck: 'deck', structure: 'structure', overlay: 'overlay' },
        authoring: { language: 'English' },
        idPolicy: { gatePrefix: 90000, structurePrefix: 1129000 },
        runtime: { repository: 'pixeltris/YgoMaster', channel: 'latest', autoDownload: false },
      }), 'utf8');
      await writeFile(path.join(sourceRoot, 'deck', 'deck.json'), JSON.stringify(compiled.deckIr), 'utf8');
      await writeFile(path.join(sourceRoot, 'structure', 'structure.json'), JSON.stringify({
        id: compiled.structureId,
        deck: 'deck.json',
        box: compiled.target?.accessory.box,
        sleeve: compiled.target?.accessory.sleeve,
        focus: compiled.target?.focus.ids,
        name: 'Chronicle Starter',
        description: 'A fixture structure deck.',
      }), 'utf8');
      await writeFile(path.join(runtimeRoot, 'Data', 'Solo.json'), JSON.stringify({
        Master: { Solo: { gate: {}, chapter: {}, unlock: {}, unlock_item: {}, reward: {} } },
      }), 'utf8');

      const applied = await applyCampaignOverlay(sourceRoot, runtimeRoot, { projectRoot: root });
      assert.ok(applied.changedFiles.includes('Data/StructureDecks/1129001.json'));
      const generated = JSON.parse(await readFile(path.join(runtimeRoot, 'Data', 'StructureDecks', '1129001.json'), 'utf8')) as Record<string, unknown>;
      assert.deepEqual(generated.structure_id, compiled.target?.structure_id);
      assert.deepEqual(generated.accessory, compiled.target?.accessory);
      assert.deepEqual(generated.focus, compiled.target?.focus);
      assert.deepEqual(generated.contents, compiled.target?.contents);
      assert.deepEqual((generated.contents as unknown as Record<string, unknown>).m, (compiled.deckIr as unknown as DeckIR).m);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('strictly parses every JSON fixture', async () => {
    const jsonFiles = [
      'success/structure.json',
      'success/expected-structure.json',
      'cases/missing-deck.json',
      'cases/missing-localization.json',
      'cases/missing-accessory.json',
      'cases/empty-accessory.json',
      'cases/invalid-one-copy.json',
      'cases/mixed-focus-cards.json',
      'cases/inline-cards.json',
      'cases/focus-not-in-deck.json',
      'cases/reward-orphan.json',
    ];
    for (const file of jsonFiles) {
      const parsed = JSON.parse(await readFixture(file)) as unknown;
      assert.equal(typeof parsed, 'object', file);
    }
  });
});
