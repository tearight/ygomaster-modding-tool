import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  SHOP_CONTENT_CODES,
  SHOP_TARGET_CONTRACT_VERSION,
  SHOP_TARGET_SUPPORTED_SUBSET,
  compileShopContent,
  parseShopOdds,
  parseShopPackList,
  parseShopPackMetadata,
  validateShopContent,
} from '../src/core/shop-content';
import { createCardResolver } from '../src/core/card-resolver';
import { createEmptyRegistry, planRegistry } from '../src/core/id-registry';
import type { CardResolverOptions } from '../src/core/card-resolver';
import type { CatalogCard } from '../src/core/types';

interface CatalogFixture {
  schemaVersion: number;
  cards: CatalogCard[];
}

const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/shop-content');

const readFixture = async <T>(relativePath: string): Promise<T> =>
  JSON.parse(await readFile(path.join(fixtureRoot, relativePath), 'utf8')) as T;

const readTextFixture = (relativePath: string): Promise<string> =>
  readFile(path.join(fixtureRoot, relativePath), 'utf8');

const fixtureResolver = async (options: CardResolverOptions = {}) => {
  const catalog = await readFixture<CatalogFixture>('catalog.json');
  return createCardResolver(catalog.cards, options);
};

const validSources = async () => ({
  metadata: await readFixture('metadata/chronicle-first.json'),
  packList: await readTextFixture('pools/chronicle-first.packlist'),
  odds: await readFixture('odds/chronicle-first.json'),
  metadataSourcePath: 'metadata/chronicle-first.json',
  packListSourcePath: 'pools/chronicle-first.packlist',
  oddsSourcePath: 'odds/chronicle-first.json',
});

const targetSources = async () => {
  const sources = await validSources();
  const metadata = await readFixture<{ formatVersion: number; kind: string; payload: Record<string, unknown> }>('metadata/chronicle-first.json');
  const payload: Record<string, unknown> = { ...metadata.payload, availability: 'always', oddsName: 'chronicle-first', imageKey: 'set-chronicle-first', cover: 'Blue-Eyes White Dragon' };
  delete payload.unlock;
  delete payload.unlockRef;
  delete payload.fixtureUnknown;
  const odds = { ...(sources.odds as { formatVersion: number; kind: string; payload: Record<string, unknown> }), payload: { ...((sources.odds as { payload: Record<string, unknown> }).payload) } };
  delete odds.payload.fixtureUnknown;
  return { ...sources, metadata: { ...metadata, payload }, odds };
};

const codes = (problems: readonly { code: string }[]): string[] => problems.map((entry) => entry.code);

describe('versioned Shop content source validation', () => {
  it('validates metadata, rarity membership, and odds with the shared resolver', async () => {
    const resolver = await fixtureResolver();
    const result = validateShopContent(await validSources(), {
      resolver,
      knownContentTargets: ['chapter:chronicle-opening'],
    });

    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.deepEqual(result.problems, []);
    assert.equal(result.metadata?.metadata.normalizedShopId, 'shop:chronicle-first-pack');
    assert.deepEqual(result.packList?.rarities, ['common', 'rare', 'secret', 'ultra']);
    assert.equal(result.packList?.entries[1]?.weight, 2);
    assert.equal(result.packList?.entries[2]?.variant, 'foil');
    assert.equal(result.packList?.entries[3]?.variant, 'alternate');
    assert.deepEqual(result.resolutions.map((resolution) => resolution.runtimeId), [1001, 1002, 1003, 1004, 1005]);
    assert.equal(result.packList?.entries[3]?.sourceSpan.sourcePath, 'pools/chronicle-first.packlist');
    assert.equal(result.packList?.entries[3]?.sourceSpan.line, 8);
    assert.equal(result.resolutions[2]?.problems.length, 0);
    assert.equal(result.resolutionLock?.entries.length, 5);
    assert.deepEqual(result.metadata?.envelope.raw.payload, {
      shopId: 'shop:chronicle-first-pack',
      name: 'Chronicle First Pack',
      price: 100,
      availability: 'unlock',
      unlock: { ref: 'chapter:chronicle-opening' },
      packlist: 'pools/chronicle-first.packlist',
      odds: 'odds/chronicle-first.json',
      packSize: 8,
      localization: { name: 'chronicle.first.name' },
      fixtureUnknown: { preserve: true },
    });
  });

  it('keeps catalog-classified Fusion cards eligible for pack ownership', async () => {
    const catalog = await readFixture<CatalogFixture>('catalog.json');
    const fusionCatalog = catalog.cards.map((card, index) => index === 0
      ? { ...card, stats: { ...card.stats, type: 0x41 }, autoTags: [...card.autoTags, 'type:fusion'] }
      : card);
    const resolver = createCardResolver(fusionCatalog);
    const result = validateShopContent(await validSources(), {
      resolver,
      knownContentTargets: ['chapter:chronicle-opening'],
    });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(resolver.isExtraDeckCard(1001), true);
    assert.equal(result.packList?.entries.some((entry) => entry.runtimeId === 1001), true);
  });

  it('keeps card resolver diagnostics tied to the packlist source span', async () => {
    const resolver = await fixtureResolver();
    const sources = await validSources();
    sources.packList = '[common]\nBlue-Eyes White Draggon\n';
    const result = validateShopContent(sources, { resolver, knownContentTargets: ['chapter:chronicle-opening'] });
    const unresolved = result.problems.find((problem) => problem.code === 'CARD_NAME_UNRESOLVED');

    assert.equal(result.ok, false);
    assert.equal(unresolved?.sourcePath, 'pools/chronicle-first.packlist');
    assert.equal(unresolved?.line, 2);
    assert.equal(unresolved?.column, 1);
    assert.equal(unresolved?.sourceSpan?.sourcePath, 'pools/chronicle-first.packlist');
    assert.equal(result.resolutionLock, undefined);
  });

  it('uses a reviewed selector for an ambiguous pack member and retains it in the lock', async () => {
    const catalog = await readFixture<CatalogFixture>('catalog.json');
    const resolver = createCardResolver([
      ...catalog.cards,
      { ...catalog.cards[0], id: 2001, ydkId: 20001 },
    ]);
    const sources = await validSources();
    sources.packList = sources.packList.replace(
      'Blue-Eyes White Dragon',
      'Blue-Eyes White Dragon @runtime=1001 @provenance=official-ocg-db:4007 @variant=official-art',
    );
    const result = validateShopContent(sources, { resolver, knownContentTargets: ['chapter:chronicle-opening'] });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.packList?.entries[0]?.selector?.runtimeId, 1001);
    assert.equal(result.resolutionLock?.entries[0]?.selector?.provenance, 'official-ocg-db:4007');
    assert.equal(result.packList?.entries[0]?.runtimeId, 1001);
  });
});

describe('Shop packlist semantic diagnostics', () => {
  it('detects duplicate card membership and empty rarity sections', async () => {
    const resolver = await fixtureResolver();
    const sources = await validSources();
    const duplicate = await readTextFixture('invalid/duplicate.packlist');
    const duplicateResult = validateShopContent({ ...sources, packList: duplicate, packListSourcePath: 'invalid/duplicate.packlist' }, resolver);
    const duplicateProblem = duplicateResult.problems.find((problem) => problem.code === SHOP_CONTENT_CODES.DUPLICATE_MEMBERSHIP);
    assert.ok(duplicateProblem);
    assert.equal(duplicateProblem.sourcePath, 'invalid/duplicate.packlist');
    assert.equal(duplicateProblem.line, 4);

    const empty = await readTextFixture('invalid/empty.packlist');
    const emptyResult = validateShopContent({ ...sources, packList: empty, packListSourcePath: 'invalid/empty.packlist' }, resolver);
    assert.equal(emptyResult.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.EMPTY_RARITY), true);
    assert.equal(emptyResult.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.PACKLIST_EMPTY), false);

    const fullyEmpty = await readTextFixture('invalid/fully-empty.packlist');
    const fullyEmptyResult = validateShopContent({ ...sources, packList: fullyEmpty, packListSourcePath: 'invalid/fully-empty.packlist' }, {
      resolver,
      knownContentTargets: ['chapter:chronicle-opening'],
    });
    assert.equal(fullyEmptyResult.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.EMPTY_RARITY), true);
    assert.equal(fullyEmptyResult.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.PACKLIST_EMPTY), true);
  });

  it('parses explicit rarity tokens, numeric weights, and variants without a section', () => {
    const parsed = parseShopPackList(
      'common 2 Blue-Eyes White Dragon\nrare weight=0.5 variant=foil Dark Magician\n',
      'inline.packlist',
    );
    assert.deepEqual(parsed.problems, []);
    assert.deepEqual(parsed.document.entries.map((entry) => ({
      rarity: entry.rarity,
      cardName: entry.cardName,
      weight: entry.weight,
      variant: entry.variant,
    })), [
      { rarity: 'common', cardName: 'Blue-Eyes White Dragon', weight: 2, variant: undefined },
      { rarity: 'rare', cardName: 'Dark Magician', weight: 0.5, variant: 'foil' },
    ]);
  });
});

describe('Shop odds, unlock, and capability boundaries', () => {
  it('reports invalid probability, probability sum, and collation references', async () => {
    const resolver = await fixtureResolver();
    const sources = await validSources();
    const invalidProbability = await readFixture('invalid/probability.json');
    const probabilityResult = validateShopContent({ ...sources, odds: invalidProbability, oddsSourcePath: 'invalid/probability.json' }, resolver);
    assert.equal(probabilityResult.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.PROBABILITY_INVALID), true);

    const invalidSum = await readFixture('invalid/sum.json');
    const sumResult = validateShopContent({ ...sources, odds: invalidSum, oddsSourcePath: 'invalid/sum.json' }, resolver);
    assert.equal(sumResult.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.PROBABILITY_SUM_INVALID), true);

    const invalidCollation = await readFixture('invalid/collation.json');
    const collationResult = validateShopContent({ ...sources, odds: invalidCollation, oddsSourcePath: 'invalid/collation.json' }, resolver);
    assert.equal(collationResult.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.COLLATION_SLOT_UNKNOWN), true);
    assert.equal(collationResult.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.COLLATION_SIZE_MISMATCH), true);
  });

  it('requires unlock references to resolve against supplied content targets', async () => {
    const resolver = await fixtureResolver();
    const sources = await validSources();
    const metadata = await readFixture('invalid/unlock-missing-target.json');
    const result = validateShopContent({ ...sources, metadata, metadataSourcePath: 'invalid/unlock-missing-target.json' }, {
      resolver,
      knownContentTargets: ['chapter:chronicle-opening'],
    });
    assert.equal(result.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.UNLOCK_REF_UNKNOWN), true);
    assert.equal(result.metadata?.metadata.unlockRef, 'chapter:does-not-exist');

    const validMetadata = await readFixture<Record<string, unknown>>('metadata/chronicle-first.json');
    const validPayload = validMetadata.payload as Record<string, unknown>;
    const payloadWithoutUnlock = { ...validPayload };
    delete payloadWithoutUnlock.unlock;
    const unlockRefMetadata = {
      ...validMetadata,
      payload: { ...payloadWithoutUnlock, unlockRef: 'chapter:chronicle-opening' },
    };
    const omittedTargets = validateShopContent({ ...sources, metadata: unlockRefMetadata }, { resolver });
    assert.equal(omittedTargets.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.UNLOCK_TARGETS_REQUIRED), true);

    const emptyTargets = validateShopContent({ ...sources, metadata: unlockRefMetadata }, {
      resolver,
      knownContentTargets: [],
    });
    assert.equal(emptyTargets.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.UNLOCK_REF_UNKNOWN), true);
    assert.equal(emptyTargets.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.UNLOCK_TARGETS_REQUIRED), false);
  });

  it('refuses chapter unlocks while retaining the source validation result', async () => {
    const resolver = await fixtureResolver();
    const sources = await validSources();
    const registryPlan = planRegistry(createEmptyRegistry(), [{ namespace: 'shop', key: 'chronicle-first-pack' }]);
    const options = {
      resolver,
      registry: registryPlan.registry,
      requireRegistryAssignment: true,
      knownContentTargets: ['chapter:chronicle-opening'],
    } as const;
    const content = validateShopContent(sources, options);
    assert.equal(content.ok, true, JSON.stringify(content.problems));
    assert.equal(content.metadata?.metadata.shopId, 'shop:chronicle-first-pack');
    assert.equal(content.metadata?.metadata.normalizedShopId, 'shop:chronicle-first-pack');

    const compiled = compileShopContent(sources, options);
    assert.equal(compiled.ok, false);
    assert.equal(compiled.deployable, false);
    assert.equal(compiled.targetCapability.status, 'assumed');
    assert.equal(compiled.targetCapability.contractVersion, SHOP_TARGET_CONTRACT_VERSION);
    assert.equal(compiled.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.UNLOCK_SECRET_UNSUPPORTED), true);
    assert.equal(compiled.resolutionLock?.entries.length, 5);
    assert.equal(Object.prototype.hasOwnProperty.call(compiled, 'deploy'), false);
  });

  it('projects an always-available pack using a read-only symbolic registry assignment', async () => {
    const resolver = await fixtureResolver();
    const sources = await targetSources();
    const registryPlan = planRegistry(createEmptyRegistry(), [{ namespace: 'shop', key: 'chronicle-first-pack', pin: 1130001 }]);
    const compiled = compileShopContent(sources, {
      resolver,
      registry: registryPlan.registry,
      requireRegistryAssignment: true,
    });
    assert.equal(compiled.ok, true, JSON.stringify(compiled.problems));
    assert.equal(compiled.deployable, true);
    assert.equal(compiled.projection?.shopId, 1130001);
    assert.equal(compiled.projection?.shopEntry.secretType, 0);
    assert.equal(compiled.projection?.shopEntry.pack_card_num, 8);
    assert.equal(compiled.projection?.shopEntry.price, 100);
    assert.equal(compiled.projection?.shopEntry.iconMrk, 1001);
    assert.equal(compiled.projection?.shopEntry.packImage, 'set-chronicle-first');
    assert.deepEqual(compiled.projection?.shopEntry.cardList, { '1001': 1, '1002': 1, '1003': 2, '1004': 4, '1005': 4 });
    assert.equal(compiled.projection?.shopEntry.fixtureUnknown, undefined);
    assert.equal(compiled.projection?.oddsEntry.packShopIds[0], 1130001);
    assert.equal(compiled.projection?.oddsEntry.cardRateList.length, 1);
    assert.equal(compiled.projection?.oddsEntry.cardRateList[0]?.standard, false);
    assert.equal(compiled.projection?.oddsEntry.cardRateList[0]?.start_num, 1);
    assert.equal(compiled.projection?.oddsEntry.cardRateList[0]?.end_num, 8);
    assert.equal(compiled.projection?.oddsEntry.name, 'chronicle-first:chronicle-first-pack');
    assert.deepEqual((compiled.projection?.oddsEntry.cardRateList[0]?.rate as Record<string, unknown>), {
      '1': { rate: '70.00' },
      '2': { rate: '20.00' },
      '4': { rate: '10.00' },
    });
    assert.equal(compiled.warnings.some((problem) => problem.code === SHOP_CONTENT_CODES.PACKLIST_WEIGHT_TARGET_IGNORED), true);
    assert.equal(compiled.warnings.some((problem) => problem.code === SHOP_CONTENT_CODES.PACKLIST_VARIANT_TARGET_IGNORED), true);
  });

  it('returns a typed shop predecessor for unlock progression', async () => {
    const resolver = await fixtureResolver();
    const base = await targetSources();
    const metadata = base.metadata as { formatVersion: number; kind: string; payload: Record<string, unknown> };
    const sources = {
      ...base,
      metadata: {
        ...metadata,
        payload: {
          ...metadata.payload,
          shopId: 'shop:chronicle-second-pack',
          availability: 'unlock',
          unlock: { ref: 'shop:chronicle-first-pack' },
        },
      },
    };
    const registryPlan = planRegistry(createEmptyRegistry(), [
      { namespace: 'shop', key: 'chronicle-first-pack', pin: 1130001 },
      { namespace: 'shop', key: 'chronicle-second-pack', pin: 1130002 },
    ]);
    const compiled = compileShopContent(sources, { resolver, registry: registryPlan.registry });
    assert.equal(compiled.ok, true, JSON.stringify(compiled.problems));
    assert.equal(compiled.projection?.shopId, 1130002);
    assert.equal(compiled.projection?.predecessorRef, 'shop:chronicle-first-pack');
    assert.equal(compiled.projection?.shopEntry.secretType, 4);
    assert.deepEqual(compiled.projection?.shopEntry.unlockSecrets, []);
  });

  it('fails closed for unsupported rarity, oversized packs, and unregistered IDs', async () => {
    const resolver = await fixtureResolver();
    const sources = await targetSources();
    const unsupportedRarity = compileShopContent({
      ...sources,
      packList: '[mythic]\nBlue-Eyes White Dragon\n[common]\nDark Magician\n[rare]\nRed-Eyes Black Dragon\n[ultra]\nNumber 39: Utopia\n[secret]\nElemental HERO Neos\n',
    }, {
      resolver,
      registry: planRegistry(createEmptyRegistry(), [{ namespace: 'shop', key: 'chronicle-first-pack', pin: 1130001 }]).registry,
    });
    assert.equal(unsupportedRarity.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.RARITY_UNSUPPORTED), true);
    assert.equal(unsupportedRarity.projection, undefined);

    const oversized = compileShopContent({
      ...sources,
      metadata: { ...(sources.metadata as Record<string, unknown>), payload: { ...((sources.metadata as Record<string, unknown>).payload as Record<string, unknown>), packSize: 9 } },
    }, {
      resolver,
      registry: planRegistry(createEmptyRegistry(), [{ namespace: 'shop', key: 'chronicle-first-pack', pin: 1130001 }]).registry,
    });
    assert.equal(oversized.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.PACK_SIZE_UNSUPPORTED), true);
    assert.equal(oversized.projection, undefined);

    const unregistered = compileShopContent(sources, { resolver, registry: createEmptyRegistry() });
    assert.equal(unregistered.problems.some((problem) => problem.code === SHOP_CONTENT_CODES.SHOP_ID_UNREGISTERED), true);
    assert.equal(unregistered.projection, undefined);
  });

  it('preserves unknown source fields while blocking them from the target allowlist', async () => {
    const resolver = await fixtureResolver();
    const sources = await targetSources();
    const metadata = sources.metadata as { formatVersion: number; kind: string; payload: Record<string, unknown> };
    metadata.payload.cashProduct = { sku: 'unsupported' };
    const registry = planRegistry(createEmptyRegistry(), [{ namespace: 'shop', key: 'chronicle-first-pack', pin: 1130001 }]).registry;
    const compiled = compileShopContent(sources, { resolver, registry });
    const unsupported = compiled.problems.find((entry) => entry.code === SHOP_CONTENT_CODES.FIELD_UNSUPPORTED);
    assert.equal(compiled.ok, false);
    assert.equal(compiled.projection, undefined);
    assert.equal(unsupported?.sourcePath, 'metadata/chronicle-first.json');
    assert.equal(unsupported?.jsonPointer, '/payload/cashProduct');
    assert.deepEqual((compiled.metadata?.envelope.raw.payload as Record<string, unknown>).cashProduct, { sku: 'unsupported' });
  });

  it('emits a deterministic official-example semantic projection', async () => {
    const resolver = await fixtureResolver();
    const sources = await targetSources();
    const registry = planRegistry(createEmptyRegistry(), [{ namespace: 'shop', key: 'chronicle-first-pack', pin: 1130001 }]).registry;
    const first = compileShopContent(sources, { resolver, registry });
    const second = compileShopContent(sources, { resolver, registry });
    assert.equal(first.ok, true, JSON.stringify(first.problems));
    assert.deepEqual(first.projection, second.projection);
    assert.equal(first.targetCapability.status, 'assumed');
    assert.equal(first.targetCapability.evidence, 'official-example');
    assert.equal(first.targetCapability.projectApproval, 'SHP-002');
  });
});

describe('Shop fixture and parser contracts', () => {
  it('keeps metadata, odds, and capability fixtures versioned and strict', async () => {
    const manifest = await readFixture<{ formatVersion: number; fixtures: Record<string, string> }>('manifest.json');
    assert.equal(manifest.formatVersion, 1);
    const metadata = await readFixture('metadata/chronicle-first.json');
    const odds = await readFixture('odds/chronicle-first.json');
    const capability = await readFixture<{ formatVersion: number; kind: string; payload: { status: string; targetContractVersion: string; supportedSubset: string[]; evidence: string; projectApproval: string } }>('capability/shop-unsupported.json');
    assert.equal(parseShopPackMetadata(metadata, 'metadata/chronicle-first.json').problems.length, 0);
    assert.equal(parseShopOdds(odds, 'odds/chronicle-first.json').problems.length, 0);
    assert.equal(capability.formatVersion, 1);
    assert.equal(capability.kind, 'shop-capability');
    assert.equal(capability.payload.status, 'assumed');
    assert.equal(capability.payload.targetContractVersion, SHOP_TARGET_CONTRACT_VERSION);
    assert.deepEqual(capability.payload.supportedSubset, [SHOP_TARGET_SUPPORTED_SUBSET]);
    assert.equal(capability.payload.evidence, 'official-example');
    assert.equal(capability.payload.projectApproval, 'SHP-002');
    await Promise.all(Object.values(manifest.fixtures).map(async (relativePath) => {
      if (!relativePath.endsWith('.json')) return;
      const parsed = await readFixture(relativePath);
      assert.equal(typeof parsed, 'object');
    }));
  });

  it('returns stable parser diagnostics for malformed optional syntax', () => {
    const parsed = parseShopPackList('[common]\nweight=0 Blue-Eyes White Dragon\n', 'malformed.packlist');
    assert.equal(codes(parsed.problems).includes(SHOP_CONTENT_CODES.PACKLIST_WEIGHT_INVALID), true);
    assert.equal(parsed.problems.every((problem) => problem.sourcePath === 'malformed.packlist'), true);
  });
});
