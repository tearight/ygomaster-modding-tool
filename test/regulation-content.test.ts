import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createCardResolver } from '../src/core/card-resolver';
import { compileDecklist, parseDecklist } from '../src/core/deck-content';
import type { CatalogCard, Problem } from '../src/core/types';
import {
  REGULATION_CODES,
  compileRegulationContent,
  createDeckRegulationHook,
  parseRegulationRules,
  regulationCapabilityGolden,
  validateRegulationContent,
} from '../src/core/regulation-content';

const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/regulation-content');

const readFixture = async (relativePath: string): Promise<string> =>
  readFile(path.join(fixtureRoot, relativePath), 'utf8');

const readJsonFixture = async (relativePath: string): Promise<unknown> =>
  JSON.parse(await readFixture(relativePath)) as unknown;

const makeCard = (id: number, english: string): CatalogCard => ({
  id,
  ydkId: id + 800000,
  names: { english, display: english },
  texts: {},
  original: {},
  stats: {},
  autoTags: [],
});

const cards = [
  makeCard(1001, 'Blue-Eyes White Dragon'),
  makeCard(1002, 'Firewall Dragon'),
  makeCard(1003, 'Chronicle Dragon'),
  makeCard(1004, 'Number 39: Utopia'),
  makeCard(1005, 'Allowed Deck Card'),
];

const resolver = createCardResolver(cards);

const validSources = async () => ({
  metadata: await readJsonFixture('metadata/chronicle-wave-1.json'),
  rules: await readFixture('rules/wave-1.regulation'),
  metadataSourcePath: 'campaign/fixtures/regulation-content/metadata/chronicle-wave-1.json',
  rulesSourcePath: 'campaign/fixtures/regulation-content/rules/wave-1.regulation',
});

describe('REG-001 campaign regulation content', () => {
  it('parses versioned metadata and resolves every named rule with source spans', async () => {
    const result = validateRegulationContent(await validSources(), resolver);
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
    assert.equal(result.metadata?.metadata.normalizedRegulationId, 'regulation:chronicle-wave-1');
    assert.equal(result.metadata?.metadata.cutoffRef, 'release:chronicle-wave-1');
    assert.equal(result.metadata?.metadata.allowedRef, 'card-pool:chronicle-wave-1');
    assert.equal(result.metadata?.metadata.fixtureUnknown && (result.metadata.metadata.fixtureUnknown as { preserve?: boolean }).preserve, true);
    assert.deepEqual(result.rules.entries.map((entry) => entry.section), [
      'allowed', 'allowed', 'allowed', 'allowed', 'forbidden', 'limited', 'semi-limited',
    ]);
    assert.equal(result.entries.find((entry) => entry.sourceName === 'Firewall Dragon' && entry.section === 'forbidden')?.copyLimit, 0);
    assert.equal(result.resolutions.length, 7);
    assert.equal(result.resolutions.every((resolution) => resolution.ok), true);
    assert.equal(result.resolutions.find((resolution) => resolution.lockEntry?.sourceSpan?.line === 8)?.sourceName, 'Firewall Dragon');
    assert.equal(result.resolutionLock?.entries.length, 7);
    assert.equal(result.regulation?.allowedRuntimeIds.has(1002), true);
    assert.equal(result.regulation?.limits.get(1002)?.copyLimit, 0);
  });

  it('reports missing cutoff, unresolved cards, duplicate rules, and contradictory limits', async () => {
    const invalidRules = await readFixture('invalid/duplicate-and-contradictory.regulation');
    const metadata = await readJsonFixture('metadata/chronicle-wave-1.json');
    const invalid = validateRegulationContent({
      metadata,
      rules: invalidRules,
      metadataSourcePath: 'fixture://regulation/invalid-metadata.json',
      rulesSourcePath: 'fixture://regulation/invalid.rules',
    }, resolver);
    const invalidCodes = new Set(invalid.problems.map((problem) => problem.code));
    assert.equal(invalid.ok, false);
    assert.equal(invalidCodes.has(REGULATION_CODES.RULE_DUPLICATE), true);
    assert.equal(invalidCodes.has(REGULATION_CODES.RULE_CONTRADICTORY), true);
    assert.equal(invalidCodes.has(REGULATION_CODES.CARD_UNRESOLVED), true);
    assert.equal(invalid.problems.find((problem) => problem.code === REGULATION_CODES.CARD_UNRESOLVED)?.line, 11);

    const missingCutoff = validateRegulationContent({
      metadata: await readJsonFixture('invalid/missing-cutoff.json'),
      rules: await readFixture('rules/wave-1.regulation'),
      metadataSourcePath: 'fixture://regulation/missing-cutoff.json',
      rulesSourcePath: 'fixture://regulation/rules.regulation',
    }, resolver);
    assert.equal(missingCutoff.problems.some((problem) => problem.code === REGULATION_CODES.CUTOFF_MISSING), true);

    const missingCopyLimit = parseRegulationRules('[allowed]\nBlue-Eyes White Dragon\n', 'fixture://regulation/missing-copy-limit.regulation');
    assert.equal(missingCopyLimit.diagnostics.some((problem) => problem.code === REGULATION_CODES.COPY_LIMIT_MISSING), true);
    assert.equal(missingCopyLimit.diagnostics.find((problem) => problem.code === REGULATION_CODES.COPY_LIMIT_MISSING)?.line, 2);
  });

  it('shares one role-agnostic DeckRegulationHook and reports card plus deck line', async () => {
    const source = await validSources();
    const content = validateRegulationContent(source, resolver);
    assert.equal(content.ok, true);
    const hook = createDeckRegulationHook(content);
    const direct = hook({
      section: 'main',
      runtimeId: 1002,
      count: 1,
      rarity: 1,
      sourceName: 'Firewall Dragon',
      normalizedName: 'firewall dragon',
      sourceNames: ['Firewall Dragon'],
      spans: [{ sourcePath: 'fixture://deck/player.decklist', line: 17, column: 1, endLine: 17, endColumn: 20 }],
      totalCopies: 1,
    });
    const directProblems = direct as readonly Problem[];
    assert.equal(directProblems[0]?.code, REGULATION_CODES.CARD_FORBIDDEN);
    assert.equal(directProblems[0]?.line, 17);
    assert.match(directProblems[0]?.message || '', /Firewall Dragon/u);

    const deckCards = Array.from({ length: 39 }, (_, index) => makeCard(2000 + index, `Allowed Deck Card ${String(index + 1).padStart(2, '0')}`));
    const deckResolver = createCardResolver([...cards, ...deckCards]);
    const deckRules = [
      '[allowed]',
      '3 Firewall Dragon',
      ...deckCards.map((card) => `3 ${card.names.english}`),
      '[forbidden]',
      '0 Firewall Dragon',
    ].join('\n');
    const deckRegulation = validateRegulationContent({
      metadata: (await validSources()).metadata,
      rules: deckRules,
      rulesSourcePath: 'fixture://regulation/deck.rules',
    }, deckResolver);
    assert.equal(deckRegulation.ok, true);
    const deckSource = [
      '[main]',
      '1 Firewall Dragon',
      ...deckCards.map((card) => `1 ${card.names.english}`),
      '[extra]',
      '[side]',
      '',
    ].join('\n');
    const deck = compileDecklist(
      parseDecklist(deckSource, { sourcePath: 'fixture://deck/player.decklist' }),
      deckResolver,
      { extraDeckCardIds: new Set<number>(), regulationHook: createDeckRegulationHook(deckRegulation) },
    );
    assert.equal(deck.ok, false);
    assert.equal(deck.ir, undefined);
    const violation = deck.problems.find((problem) => problem.code === REGULATION_CODES.CARD_FORBIDDEN);
    assert.ok(violation);
    assert.equal(violation?.sourcePath, 'fixture://deck/player.decklist');
    assert.equal(violation?.line, 2);
  });

  it('keeps content legality separate from the closed Regulation target capability', async () => {
    const source = await validSources();
    const result = compileRegulationContent(source, resolver);
    assert.equal(result.ok, false);
    assert.equal(result.deployable, false);
    assert.equal(result.targetCapability.status, 'unsupported');
    assert.equal(result.targetCapability.blockingCode, REGULATION_CODES.TARGET_UNSUPPORTED);
    assert.deepEqual(result.problems.map((problem) => problem.code), [REGULATION_CODES.TARGET_UNSUPPORTED]);
    assert.deepEqual(regulationCapabilityGolden(), await readJsonFixture('capability/regulation-unsupported.json'));
  });

  it('keeps minimal fixtures strict JSON and does not model a historical card database', async () => {
    const manifest = await readJsonFixture('manifest.json') as { formatVersion: number; fixtures: Record<string, string> };
    assert.equal(manifest.formatVersion, 1);
    assert.deepEqual(Object.keys(manifest.fixtures).sort(), ['capability', 'metadata', 'rules']);
    assert.equal((await readJsonFixture('metadata/chronicle-wave-1.json') as { payload?: { fixtureUnknown?: { preserve?: boolean } } }).payload?.fixtureUnknown?.preserve, true);
  });
});
