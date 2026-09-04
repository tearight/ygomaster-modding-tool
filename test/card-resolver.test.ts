import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  CARD_RESOLVER_CODES,
  CARD_RESOLVER_VERSION,
  CardResolverError,
  assertResolutionLock,
  canCompileWithResolutionLock,
  createCardResolver,
  loadCardResolver,
  normalizeCardName,
  parseCardReferenceText,
  validateResolutionLock,
} from '../src/core/card-resolver';
import type { CardResolverOptions } from '../src/core/card-resolver';
import type { CatalogCard } from '../src/core/types';

interface CatalogFixture {
  schemaVersion: number;
  cards: CatalogCard[];
}

interface AliasFixture {
  schemaVersion: number;
  aliases: CardResolverOptions['aliases'];
}

interface BenchmarkFixture {
  schemaVersion: number;
  entryCount: number;
  entries: Array<{ id: number; name: string }>;
}

const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/card-resolver');

const readFixture = async <T>(fileName: string): Promise<T> =>
  JSON.parse(await readFile(path.join(fixtureRoot, fileName), 'utf8')) as T;

const fixtureResolver = async (options: CardResolverOptions = {}) => {
  const catalog = await readFixture<CatalogFixture>('catalog.json');
  const aliases = await readFixture<AliasFixture>('aliases.json');
  return createCardResolver(catalog.cards, {
    ...options,
    aliases: aliases.aliases,
  });
};

const problemCodes = (problems: readonly { code: string }[]): string[] =>
  problems.map((problem) => problem.code);

describe('card name resolver', () => {
  it('normalizes official names, reviewed renames, punctuation, and numeric names', async () => {
    const resolver = await fixtureResolver();

    assert.equal(normalizeCardName('  BLUE—EYES\u00a0WHITE   DRAGON '), 'blue eyes white dragon');
    assert.equal(normalizeCardName('Number 39: Utopia'), 'number 39 utopia');
    assert.deepEqual(resolver.cards.map((card) => card.id), [1001, 1002, 1003, 1004, 1005, 1006, 1007]);

    const official = resolver.resolve({
      sourceName: '  BLUE—EYES\u00a0WHITE   DRAGON ',
      sourcePath: 'decks/chronicle.decklist',
      sourceSpan: { line: 2, column: 1, endLine: 2, endColumn: 32 },
      jsonPointer: '/mainDeck/0/name',
    });
    assert.equal(official.ok, true);
    assert.equal(official.runtimeId, 1001);
    assert.equal(official.match?.kind, 'official');
    assert.equal(official.lockEntry?.sourceName, '  BLUE—EYES\u00a0WHITE   DRAGON ');
    assert.equal(official.lockEntry?.runtimeId, 1001);
    assert.equal(official.lockEntry?.catalogGeneration, resolver.catalogGeneration);
    assert.equal(official.lockEntry?.resolverVersion, CARD_RESOLVER_VERSION);
    assert.equal(official.lockEntry?.matchKind, 'exact');
    assert.equal(official.lockEntry?.aliasOf, undefined);
    assert.equal(official.lockEntry?.aliasProvenance, undefined);
    assert.deepEqual(official.lockEntry?.sourceSpan, { line: 2, column: 1, endLine: 2, endColumn: 32 });

    assert.equal(resolver.resolve({ sourceName: 'Number 39 Utopia' }).runtimeId, 1002);
    const rename = resolver.resolve({ sourceName: 'Chronicle Dragon' });
    assert.equal(rename.ok, true);
    assert.equal(rename.runtimeId, 1005);
    assert.equal(rename.match?.kind, 'alias');
    assert.equal(rename.lockEntry?.matchKind, 'alias');
    assert.equal(rename.lockEntry?.aliasOf, 'Chronicle Dragon — Revised');
    assert.equal(rename.lockEntry?.aliasProvenance, 'official-rename-fixture');

    const numericName = resolver.resolve({ sourceName: '1000 Eyes Restrict' });
    assert.equal(numericName.ok, true);
    assert.equal(numericName.runtimeId, 1006);
    assert.equal(resolver.resolve({ sourceName: '1006' }).problems[0]?.code, CARD_RESOLVER_CODES.NAME_UNRESOLVED);

    const unreviewed = resolver.resolve({ sourceName: 'Blue Eyes White Dragon (legacy name)' });
    assert.equal(unreviewed.ok, false);
    assert.deepEqual(problemCodes(unreviewed.problems), [CARD_RESOLVER_CODES.ALIAS_UNREVIEWED]);
    assert.equal(unreviewed.runtimeId, undefined);
    assert.equal(unreviewed.lockEntry, undefined);
  });

  it('reports normalized collisions, unresolved names, fuzzy suggestions, and unavailable runtime IDs', async () => {
    const resolver = await fixtureResolver();
    const ambiguous = resolver.resolve({
      sourceName: 'Ancient—Fairy Dragon',
      sourcePath: 'gates/intro.json',
      span: { line: 7, column: 3, endLine: 7, endColumn: 24 },
    });
    assert.equal(ambiguous.ok, false);
    assert.deepEqual(problemCodes(ambiguous.problems), [CARD_RESOLVER_CODES.NAME_AMBIGUOUS]);
    assert.deepEqual(ambiguous.candidates.map((candidate) => candidate.runtimeId), [1003, 1004]);
    assert.equal(ambiguous.lockEntry, undefined);
    assert.equal(ambiguous.problems[0]?.sourcePath, 'gates/intro.json');
    assert.equal(ambiguous.problems[0]?.line, 7);
    assert.equal(ambiguous.problems[0]?.column, 3);
    assert.equal(ambiguous.problems[0]?.sourceSpan?.endColumn, 24);

    const unresolved = resolver.resolve({
      sourceName: 'Blue-Eyes White Draggon',
      sourcePath: 'decks/intro.decklist',
      sourceSpan: { line: 11, column: 2, endLine: 11, endColumn: 26 },
    });
    assert.equal(unresolved.ok, false);
    assert.deepEqual(problemCodes(unresolved.problems), [CARD_RESOLVER_CODES.NAME_UNRESOLVED]);
    assert.equal(unresolved.runtimeId, undefined);
    assert.equal(unresolved.lockEntry, undefined);
    assert.ok(unresolved.suggestions.length > 0);
    assert.match(unresolved.problems[0]?.suggestion || '', /Suggestions:/);
    assert.equal(unresolved.problems[0]?.sourcePath, 'decks/intro.decklist');
    assert.equal(unresolved.problems[0]?.line, 11);
    assert.equal(unresolved.problems[0]?.column, 2);
    assert.deepEqual(unresolved.suggestions, resolver.suggestCardNames('Blue-Eyes White Draggon'));

    const unavailableResolver = await fixtureResolver({ runtimeIds: [1001, 1003, 1004, 1005, 1006, 1007] });
    const unavailable = unavailableResolver.resolve({ sourceName: 'Number 39 Utopia' });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.runtimeId, 1002);
    assert.deepEqual(problemCodes(unavailable.problems), [CARD_RESOLVER_CODES.RUNTIME_UNAVAILABLE]);
    assert.equal(unavailable.lockEntry, undefined);
  });

  it('resolves only reviewed runtime selectors and preserves selector meaning in generation locks', async () => {
    const resolver = await fixtureResolver();
    const selector = { runtimeId: 1004, provenance: 'official-ocg-db:fixture-1004', variant: 'reviewed-art-b' };
    const selected = resolver.resolve({
      sourceName: 'Ancient—Fairy Dragon',
      selector,
      sourcePath: 'shop/pools/variant.packlist',
      sourceSpan: { line: 3, column: 1, endLine: 3, endColumn: 92 },
    });
    assert.equal(selected.ok, true, JSON.stringify(selected.problems));
    assert.equal(selected.runtimeId, 1004);
    assert.deepEqual(selected.lockEntry?.selector, selector);
    const lock = resolver.resolveBatch([{ sourceName: 'Ancient Fairy Dragon', selector }]).lock;
    assert.ok(lock);
    assert.deepEqual(validateResolutionLock(resolver, lock), []);

    const parsed = parseCardReferenceText('Ancient Fairy Dragon @runtime=1004 @provenance=official-ocg-db:fixture-1004 @variant=reviewed-art-b');
    assert.deepEqual(parsed, { name: 'Ancient Fairy Dragon', selector });
    assert.equal(resolver.resolve({ sourceName: parsed.name, selector: parsed.selector }).runtimeId, 1004);

    const missingEvidence = resolver.resolve({ sourceName: 'Ancient Fairy Dragon', selector: { runtimeId: 1004, provenance: '' } });
    assert.equal(missingEvidence.problems[0]?.code, CARD_RESOLVER_CODES.SELECTOR_INVALID);
    const missingTarget = resolver.resolve({ sourceName: 'Ancient Fairy Dragon', selector: { runtimeId: 9999, provenance: 'fixture' } });
    assert.equal(missingTarget.problems[0]?.code, CARD_RESOLVER_CODES.SELECTOR_TARGET_MISSING);
    const mismatch = resolver.resolve({ sourceName: 'Blue-Eyes White Dragon', selector: { runtimeId: 1004, provenance: 'fixture' } });
    assert.equal(mismatch.problems[0]?.code, CARD_RESOLVER_CODES.SELECTOR_NAME_MISMATCH);
    assert.equal(mismatch.problems[0]?.sourceSpan, undefined);

    const staleResolver = await fixtureResolver({ catalogGeneration: 'new-generation' });
    assert.ok(validateResolutionLock(staleResolver, lock).some((problem) => problem.code === CARD_RESOLVER_CODES.LOCK_STALE_GENERATION));
  });

  it('orders batch results and locks deterministically independent of input order', async () => {
    const resolver = await fixtureResolver();
    const requests = [
      {
        sourceName: '1000-Eyes Restrict',
        sourcePath: 'decks/z.decklist',
        sourceSpan: { line: 1, column: 1, endLine: 1, endColumn: 20 },
      },
      {
        sourceName: 'Blue-Eyes White Dragon',
        sourcePath: 'decks/a.decklist',
        sourceSpan: { line: 1, column: 1, endLine: 1, endColumn: 23 },
      },
      {
        sourceName: 'Number 39: Utopia',
        sourcePath: 'decks/a.decklist',
        sourceSpan: { line: 4, column: 1, endLine: 4, endColumn: 18 },
      },
    ] as const;
    const forward = resolver.resolveBatch(requests);
    const reverse = resolver.resolveBatch([...requests].reverse());
    assert.equal(forward.ok, true);
    assert.equal(reverse.ok, true);
    assert.deepEqual(reverse, forward);
    assert.deepEqual(forward.resolutions.map((resolution) => resolution.sourceName), [
      'Blue-Eyes White Dragon',
      'Number 39: Utopia',
      '1000-Eyes Restrict',
    ]);
    assert.deepEqual(forward.lock?.entries.map((entry) => entry.runtimeId), [1001, 1002, 1006]);
    assert.equal(forward.lock?.schemaVersion, 1);
    assert.equal(forward.lock?.resolverVersion, CARD_RESOLVER_VERSION);
    assert.equal(forward.lock?.catalogGeneration, resolver.catalogGeneration);
  });

  it('rejects stale, changed, malformed, and wrong-version locks at compile time', async () => {
    const resolver = await fixtureResolver();
    const batch = resolver.resolveBatch([
      { sourceName: 'Blue-Eyes White Dragon', sourcePath: 'deck.json', span: { line: 1, column: 1, endLine: 1, endColumn: 23 } },
      { sourceName: 'Number 39: Utopia', sourcePath: 'deck.json', span: { line: 2, column: 1, endLine: 2, endColumn: 18 } },
    ]);
    assert.ok(batch.lock);
    const validLock = batch.lock;
    assert.deepEqual(validateResolutionLock(resolver, validLock), []);
    assert.equal(canCompileWithResolutionLock(resolver, validLock), true);
    assert.deepEqual(assertResolutionLock(resolver, validLock), validLock);

    const staleResolver = await fixtureResolver({ catalogGeneration: 'stale-generation' });
    const staleProblems = validateResolutionLock(staleResolver, validLock);
    assert.ok(staleProblems.some((problem) => problem.code === CARD_RESOLVER_CODES.LOCK_STALE_GENERATION));
    assert.throws(
      () => assertResolutionLock(staleResolver, validLock),
      (error: unknown) => error instanceof CardResolverError && error.code === CARD_RESOLVER_CODES.LOCK_STALE_GENERATION,
    );

    const changed = JSON.parse(JSON.stringify(validLock)) as typeof validLock;
    changed.entries[0] = { ...changed.entries[0], runtimeId: 1002 };
    assert.ok(validateResolutionLock(resolver, changed).some((problem) => problem.code === CARD_RESOLVER_CODES.LOCK_RESOLUTION_CHANGED));

    const unresolved = JSON.parse(JSON.stringify(validLock)) as typeof validLock;
    unresolved.entries = [{
      sourceName: 'No Such Card',
      normalizedName: 'no such card',
      runtimeId: 1001,
      catalogGeneration: resolver.catalogGeneration,
      resolverVersion: CARD_RESOLVER_VERSION,
      matchKind: 'exact',
    }];
    assert.ok(validateResolutionLock(resolver, unresolved).some((problem) => problem.code === CARD_RESOLVER_CODES.LOCK_UNRESOLVED));

    const matchKindTamper = JSON.parse(JSON.stringify(validLock)) as typeof validLock;
    matchKindTamper.entries[0] = { ...matchKindTamper.entries[0], matchKind: 'alias', aliasOf: 'Blue-Eyes White Dragon' };
    assert.ok(validateResolutionLock(resolver, matchKindTamper).some((problem) => problem.code === CARD_RESOLVER_CODES.LOCK_RESOLUTION_CHANGED));

    const aliasBatch = resolver.resolveBatch([{ sourceName: 'Chronicle Dragon', sourcePath: 'deck.json', span: { line: 3, column: 1, endLine: 3, endColumn: 17 } }]);
    assert.ok(aliasBatch.lock);
    const aliasTamper = JSON.parse(JSON.stringify(aliasBatch.lock)) as typeof aliasBatch.lock;
    aliasTamper.entries[0] = { ...aliasTamper.entries[0], aliasProvenance: 'tampered-provenance' };
    assert.ok(validateResolutionLock(resolver, aliasTamper).some((problem) => problem.code === CARD_RESOLVER_CODES.LOCK_RESOLUTION_CHANGED));

    const wrongVersion = JSON.parse(JSON.stringify(validLock)) as Record<string, unknown>;
    wrongVersion.resolverVersion = 'ygomaster-card-resolver/v0';
    assert.ok(validateResolutionLock(resolver, wrongVersion).some((problem) => problem.code === CARD_RESOLVER_CODES.LOCK_RESOLVER_VERSION));
  });

  it('rejects malformed catalog entries before deterministic sorting', () => {
    const malformedCatalogs: unknown[][] = [
      [null],
      ['not-a-card'],
      [{ id: 1001 }],
      [{ names: { english: 'Missing runtime ID' } }],
      [{ id: 1001, names: {} }],
      [{ id: 1001, names: null }],
    ];
    malformedCatalogs.forEach((malformed) => {
      assert.throws(
        () => createCardResolver(malformed as readonly CatalogCard[]),
        (error: unknown) => error instanceof CardResolverError && error.code === CARD_RESOLVER_CODES.CATALOG_INVALID,
      );
    });
  });

  it('uses Unicode code-point ordering for paths and lock output', async () => {
    const resolver = await fixtureResolver();
    const requests = [
      { sourceName: 'Blue-Eyes White Dragon', sourcePath: 'Å.decklist', span: { line: 1, column: 1, endLine: 1, endColumn: 23 } },
      { sourceName: 'Number 39: Utopia', sourcePath: 'a.decklist', span: { line: 1, column: 1, endLine: 1, endColumn: 18 } },
      { sourceName: '1000-Eyes Restrict', sourcePath: 'Z.decklist', span: { line: 1, column: 1, endLine: 1, endColumn: 20 } },
    ] as const;
    const batch = resolver.resolveBatch(requests);
    assert.equal(batch.ok, true);
    assert.deepEqual(batch.resolutions.map((resolution) => resolution.lockEntry?.sourcePath), [
      'Z.decklist',
      'a.decklist',
      'Å.decklist',
    ]);
    assert.deepEqual(batch.lock?.entries.map((entry) => entry.sourcePath), [
      'Z.decklist',
      'a.decklist',
      'Å.decklist',
    ]);
  });

  it('loads only local catalog cache data and preserves metadata generation/runtime availability', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ygomaster-card-resolver-'));
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('network must not be used by card resolver');
    }) as typeof globalThis.fetch;
    try {
      const catalog = await readFixture<CatalogFixture>('catalog.json');
      await mkdir(path.join(root, '.db'), { recursive: true });
      await writeFile(path.join(root, '.db', 'catalog.json'), JSON.stringify({ schemaVersion: 1, cards: catalog.cards }));
      await writeFile(path.join(root, '.db', 'metadata.json'), JSON.stringify({
        schemaVersion: 1,
        generation: 'fixture-local-generation',
        missingRuntimeIds: [1001],
      }));

      const resolver = await loadCardResolver(root);
      assert.equal(resolver.catalogGeneration, 'fixture-local-generation');
      assert.equal(resolver.resolve({ sourceName: 'Blue-Eyes White Dragon' }).problems[0]?.code, CARD_RESOLVER_CODES.RUNTIME_UNAVAILABLE);
      assert.equal(resolver.resolve({ sourceName: 'Number 39: Utopia' }).runtimeId, 1002);
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('parses the self-contained resolver and benchmark fixtures as strict JSON', async () => {
    const fixtureNames = ['catalog.json', 'aliases.json', 'requests.json', 'scenarios.json', 'benchmark.json'];
    await Promise.all(fixtureNames.map(async (fileName) => {
      const parsed: unknown = JSON.parse(await readFile(path.join(fixtureRoot, fileName), 'utf8'));
      assert.equal(typeof parsed, 'object');
    }));
    const benchmark = await readFixture<BenchmarkFixture>('benchmark.json');
    assert.equal(benchmark.schemaVersion, 1);
    assert.equal(benchmark.entryCount, 200);
    assert.equal(benchmark.entries.length, 200);
    assert.equal(new Set(benchmark.entries.map((entry) => entry.id)).size, 200);
  });
});
