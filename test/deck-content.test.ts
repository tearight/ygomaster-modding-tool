import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  DECK_CODES,
  DeckIR,
  DeckMetadata,
  DeckProvenance,
  DeckContentError,
  assertDeckCompilation,
  compileDecklist,
  deckIrSemanticEqual,
  parseDecklist,
  previewPlainTextDecklist,
  reloadDeckIr,
} from '../src/core/deck-content';
import { createCardResolver } from '../src/core/card-resolver';
import type { CatalogCard } from '../src/core/types';

const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/deck-content');

const readFixture = async (relativePath: string): Promise<string> =>
  readFile(path.join(fixtureRoot, relativePath), 'utf8');

const makeCard = (id: number, english: string, type?: number): CatalogCard => ({
  id,
  ydkId: id + 800000,
  names: { english, display: english },
  texts: {},
  original: {},
  stats: { ...(type === undefined ? {} : { type }) },
  autoTags: [],
});

const cards: CatalogCard[] = [
  makeCard(1001, 'Blue-Eyes White Dragon'),
  makeCard(1002, 'Number 39: Utopia'),
  makeCard(1003, 'Ancient Fairy Dragon'),
  makeCard(1004, 'Chronicle Dragon — Revised'),
  makeCard(1005, '1000-Eyes Restrict'),
  makeCard(1006, 'Firewall Dragon'),
  ...Array.from({ length: 9 }, (_, index) => makeCard(1007 + index, `Main Card ${String(index + 7).padStart(2, '0')}`)),
  makeCard(1016, 'Extra Card Alpha', 0x41),
  makeCard(1017, 'Extra Card Beta', 0x41),
  makeCard(1018, 'Side Card'),
  makeCard(1020, 'Normal Extra Card'),
  makeCard(1021, 'Ritual Main Card', 0x81),
];

const resolver = createCardResolver(cards, {
  aliases: [{
    name: 'Chronicle Dragon',
    runtimeId: 1004,
    reviewed: true,
    source: 'dck-001-reviewed-rename',
  }],
});

const ambiguousResolver = createCardResolver([...cards, makeCard(1019, 'Ancient-Fairy Dragon')], {
  aliases: [{
    name: 'Chronicle Dragon',
    runtimeId: 1004,
    reviewed: true,
    source: 'dck-001-reviewed-rename',
  }],
});

const metadata: DeckMetadata = {
  name: 'Chronicle Fixture Deck',
  role: 'cpu',
  provenance: {
    source: 'test',
    sourceUrl: 'fixture://deck-content/success',
    revision: 'fixture-1',
  } satisfies DeckProvenance,
};

const eligibleExtraDeckCardIds = new Set([1016, 1017]);

const compileFixture = async (relativePath: string, options: Parameters<typeof compileDecklist>[2] = {}) => {
  const source = await readFixture(relativePath);
  const document = parseDecklist(source, { sourcePath: `campaign/fixtures/deck-content/${relativePath}`, metadata });
  return compileDecklist(document, resolver, { extraDeckCardIds: eligibleExtraDeckCardIds, ...options });
};

describe('DCK-001 line-based decklists', () => {
  it('parses required sections, comments, punctuation, numeric-leading names, metadata, and source lines', async () => {
    const source = await readFixture('success/deck.decklist');
    const document = parseDecklist(source, {
      sourcePath: 'fixtures/deck-content/success/deck.decklist',
      metadata,
    });
    assert.equal(document.ok, true);
    assert.deepEqual(Object.keys(document.sections), ['main', 'extra', 'side']);
    assert.equal(document.sections.main.entries.length, 16);
    assert.equal(document.sections.extra.entries.length, 2);
    assert.equal(document.sections.side.entries.length, 1);
    assert.equal(document.entries.length, 19);
    assert.equal(document.entries[0]?.count, 2);
    assert.equal(document.entries[1]?.sourceName, 'BLUE—EYES WHITE DRAGON');
    assert.equal(document.entries[1]?.span.line, 5);
    assert.equal(document.entries[5]?.sourceName, '1000-Eyes Restrict');
    assert.equal(document.metadata.provenance && (document.metadata.provenance as DeckProvenance).sourceUrl, 'fixture://deck-content/success');
    assert.equal(document.originalText, source);
    assert.equal(document.lines.some((line) => line.normalized.kind === 'comment'), true);
    assert.equal(/^\s*\d+\s+\d+\s*$/mu.test(source), false);
  });

  it('compiles to the current m/e/s ids/r projection and reloads with zero semantic diff', async () => {
    const result = await compileFixture('success/deck.decklist');
    const expected = JSON.parse(await readFixture('success/expected-ir.json')) as DeckIR;
    assert.equal(result.ok, true);
    assert.ok(result.ir);
    assert.deepEqual(result.ir, expected);
    assert.equal(result.ir.m.ids.length, result.ir.m.r.length);
    assert.equal(result.ir.e.ids.length, result.ir.e.r.length);
    assert.equal(result.ir.s.ids.length, result.ir.s.r.length);
    assert.deepEqual(reloadDeckIr(result.ir), result.ir);
    assert.equal(deckIrSemanticEqual(result.ir, JSON.parse(JSON.stringify(result.ir))), true);
    assert.equal(result.lock?.entries.length, 19);
    assert.equal(result.lock?.entries.find((entry) => entry.sourceName === 'Chronicle Dragon')?.matchKind, 'alias');
    assert.equal(result.entries[0]?.count, 3);
    assert.deepEqual(result.entries[0]?.sourceNames, ['Blue-Eyes White Dragon', 'BLUE—EYES WHITE DRAGON']);
    assert.equal(result.defaultRarity, 1);

    const second = await compileFixture('success/deck.decklist');
    assert.deepEqual(second.ir, result.ir);
    assert.deepEqual(second.lock, result.lock);
    assert.deepEqual(assertDeckCompilation(result), result.ir);
  });

  it('keeps plain-text intake reviewable with originals, normalized names, discarded, and unparsed lines', async () => {
    const source = await readFixture('intake.txt');
    const preview = previewPlainTextDecklist(source, { sourcePath: 'fixture://deck-content/intake.txt' });
    assert.equal(preview.ok, false);
    assert.equal(preview.originalText, source);
    assert.equal(preview.entries.length, 3);
    assert.equal(preview.parsed, preview.entries);
    assert.equal(preview.entries[0]?.original, '2 Blue-Eyes White Dragon');
    assert.equal(preview.entries[0]?.normalizedName, 'blue eyes white dragon');
    assert.equal(preview.entries[1]?.sourceName, 'Number 39: Utopia');
    assert.equal(preview.entries[2]?.normalizedName, '1000 eyes restrict');
    assert.equal(preview.discardedLines.length, 3);
    assert.equal(preview.discarded, preview.discardedLines);
    assert.equal(preview.unparsedLines.length, 1);
    assert.match(preview.unparsedLines[0]?.reason || '', /count/i);
    assert.equal(preview.unparsed, preview.unparsedLines);
    assert.equal(preview.diagnostics[0]?.code, DECK_CODES.INTAKE_UNPARSED);
    assert.equal(preview.diagnostics[0]?.severity, 'warning');
    assert.equal(preview.diagnostics[0]?.sourcePath, 'fixture://deck-content/intake.txt');
  });

  it('reports invalid counts, missing sections, size/copy limits, and keeps IR blocked', async () => {
    const invalid = await compileFixture('cases/invalid-count-and-limits.decklist');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.ir, undefined);
    assert.ok(invalid.problems.some((problem) => problem.code === DECK_CODES.COUNT_INVALID));
    assert.ok(invalid.problems.some((problem) => problem.code === DECK_CODES.MAIN_SIZE_INVALID));
    assert.ok(invalid.problems.some((problem) => problem.code === DECK_CODES.EXTRA_SIZE_INVALID));
    assert.ok(invalid.problems.some((problem) => problem.code === DECK_CODES.COPY_LIMIT));
    assert.ok(invalid.problems.every((problem) => problem.line === undefined || problem.line > 0));

    const missing = await compileFixture('cases/missing-section.decklist');
    assert.equal(missing.ok, false);
    assert.ok(missing.problems.some((problem) => problem.code === DECK_CODES.SECTION_MISSING));
    assert.equal(missing.ir, undefined);
  });

  it('retains resolver candidate diagnostics and blocks unresolved, ambiguous, and unavailable cards', async () => {
    const unresolved = await compileFixture('cases/unresolved.decklist');
    assert.equal(unresolved.ok, false);
    assert.equal(unresolved.ir, undefined);
    const unresolvedProblem = unresolved.problems.find((problem) => problem.code === DECK_CODES.CARD_UNRESOLVED);
    assert.ok(unresolvedProblem);
    assert.equal(unresolvedProblem?.sourcePath, 'campaign/fixtures/deck-content/cases/unresolved.decklist');
    assert.equal(unresolvedProblem?.line, 2);

    const ambiguousSource = await readFixture('cases/ambiguous.decklist');
    const ambiguous = compileDecklist(
      parseDecklist(ambiguousSource, { sourcePath: 'fixture://deck-content/cases/ambiguous.decklist', metadata }),
      ambiguousResolver,
    );
    assert.equal(ambiguous.ok, false);
    assert.ok(ambiguous.problems.some((problem) => problem.code === DECK_CODES.CARD_AMBIGUOUS));
    assert.match(ambiguous.problems.find((problem) => problem.code === DECK_CODES.CARD_AMBIGUOUS)?.message || '', /1003|1019/u);

    const unavailableResolver = createCardResolver(cards, {
      aliases: [{ name: 'Chronicle Dragon', runtimeId: 1004, reviewed: true, source: 'fixture' }],
      runtimeIds: cards.map((card) => card.id).filter((id) => id !== 1002),
    });
    const unavailableSource = await readFixture('cases/unavailable.decklist');
    const unavailable = compileDecklist(
      parseDecklist(unavailableSource, { sourcePath: 'fixture://deck-content/cases/unavailable.decklist', metadata }),
      unavailableResolver,
    );
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.ir, undefined);
    assert.ok(unavailable.problems.some((problem) => problem.code === DECK_CODES.CARD_RUNTIME_UNAVAILABLE));
  });

  it('preserves reviewed runtime selectors from decklist text through the resolution lock', async () => {
    const source = (await readFixture('success/deck.decklist'))
      .replace(/Blue-Eyes White Dragon/gu, 'Blue-Eyes White Dragon @runtime=1001 @provenance=official-ocg-db:4007 @variant=official-art')
      .replace(/BLUE—EYES WHITE DRAGON/gu, 'BLUE—EYES WHITE DRAGON @runtime=1001 @provenance=official-ocg-db:4007 @variant=official-art');
    const selectedResolver = createCardResolver([...cards, makeCard(1022, 'Blue Eyes White Dragon')], {
      aliases: [{ name: 'Chronicle Dragon', runtimeId: 1004, reviewed: true, source: 'fixture' }],
    });
    const document = parseDecklist(source, { sourcePath: 'fixture://deck-content/selected.decklist', metadata });
    const result = compileDecklist(document, selectedResolver, { extraDeckCardIds: eligibleExtraDeckCardIds });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(document.entries[0]?.selector?.runtimeId, 1001);
    assert.equal(result.lock?.entries.filter((entry) => entry.selector?.runtimeId === 1001).length, 2);
    assert.equal(result.ir?.m.ids.filter((id) => id === 1001).length, 3);
  });

  it('applies explicit rarity and optional regulation without silently compiling failures', async () => {
    const rejected = await compileFixture('success/deck.decklist', {
      defaultRarity: 2,
      regulation: (entry) => entry.runtimeId === 1002 ? false : undefined,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.defaultRarity, 2);
    assert.equal(rejected.ir, undefined);
    assert.ok(rejected.problems.some((problem) => problem.code === DECK_CODES.REGULATION_VIOLATION));

    const invalidRarity = await compileFixture('success/deck.decklist', { defaultRarity: -1 });
    assert.equal(invalidRarity.ok, false);
    assert.equal(invalidRarity.ir, undefined);
    assert.ok(invalidRarity.problems.some((problem) => problem.code === DECK_CODES.DEFAULT_RARITY_INVALID));
  });

  it('requires an explicit Extra legality policy, accepts eligible IDs/hooks, and rejects normal cards with spans', async () => {
    const missingPolicy = await compileFixture('success/deck.decklist', { extraDeckCardIds: undefined });
    assert.equal(missingPolicy.ok, false);
    assert.equal(missingPolicy.ir, undefined);
    const unavailable = missingPolicy.problems.find((problem) => problem.code === DECK_CODES.EXTRA_LEGALITY_UNAVAILABLE);
    assert.ok(unavailable);
    assert.equal(unavailable?.line, 22);

    const hookPolicy = await compileFixture('success/deck.decklist', {
      extraDeckCardIds: undefined,
      isExtraDeckCard: (runtimeId) => eligibleExtraDeckCardIds.has(runtimeId),
    });
    assert.equal(hookPolicy.ok, true);
    assert.ok(hookPolicy.ir);

    const normalCard = await compileFixture('cases/normal-card-in-extra.decklist');
    assert.equal(normalCard.ok, false);
    assert.equal(normalCard.ir, undefined);
    const invalid = normalCard.problems.find((problem) => problem.code === DECK_CODES.EXTRA_CARD_INVALID);
    assert.ok(invalid);
    assert.equal(invalid?.sourcePath, 'campaign/fixtures/deck-content/cases/normal-card-in-extra.decklist');
    assert.equal(invalid?.line, 18);

    const emptyExtraSource = (await readFixture('success/deck.decklist')).replace('1 Extra Card Alpha\n1 Extra Card Beta\n', '');
    const emptyExtra = compileDecklist(
      parseDecklist(emptyExtraSource, { sourcePath: 'fixture://deck-content/cases/extra-empty.decklist', metadata }),
      resolver,
    );
    assert.equal(emptyExtra.ok, true);
    assert.ok(emptyExtra.ir);
  });

  it('uses catalog type bits to reject Fusion in Main while retaining Ritual in Main', async () => {
    const success = await readFixture('success/deck.decklist');
    const catalogPolicy = (runtimeId: number) => resolver.isExtraDeckCard(runtimeId);
    const fusionInMain = compileDecklist(
      parseDecklist(success.replace('3 Main Card 07', '3 Extra Card Alpha'), { sourcePath: 'fixture://deck-content/fusion-main.decklist', metadata }),
      resolver,
      { isExtraDeckCard: catalogPolicy },
    );
    assert.equal(fusionInMain.ok, false);
    assert.equal(fusionInMain.ir, undefined);
    assert.equal(fusionInMain.problems.some((problem) => problem.code === DECK_CODES.MAIN_CARD_INVALID), true);

    const ritualInMain = compileDecklist(
      parseDecklist(success.replace('3 Main Card 07', '3 Ritual Main Card'), { sourcePath: 'fixture://deck-content/ritual-main.decklist', metadata }),
      resolver,
      { isExtraDeckCard: catalogPolicy },
    );
    assert.equal(ritualInMain.ok, true, JSON.stringify(ritualInMain.problems));
    assert.equal(ritualInMain.ir?.m.ids.includes(1021), true);
    assert.equal(resolver.isExtraDeckCard(1016), true);
    assert.equal(resolver.isExtraDeckCard(1021), false);
  });

  it('rejects malformed IR and parses every JSON fixture strictly', async () => {
    assert.throws(
      () => reloadDeckIr({ m: { ids: [1001], r: [] }, e: { ids: [], r: [] }, s: { ids: [], r: [] } }),
      (error: unknown) => error instanceof DeckContentError && error.code === DECK_CODES.IR_INVALID,
    );
    const jsonFiles = ['success/metadata.json', 'success/expected-ir.json'];
    await Promise.all(jsonFiles.map(async (file) => {
      const parsed: unknown = JSON.parse(await readFixture(file));
      assert.equal(typeof parsed, 'object');
    }));
    const authoredDecklists = [
      'success/deck.decklist',
      'cases/invalid-count-and-limits.decklist',
      'cases/missing-section.decklist',
      'cases/unresolved.decklist',
      'cases/ambiguous.decklist',
      'cases/unavailable.decklist',
    ];
    await Promise.all(authoredDecklists.map(async (file) => {
      const source = await readFixture(file);
      assert.equal(/^\s*\d+\s+\d+\s*$/mu.test(source), false);
    }));
  });
});
