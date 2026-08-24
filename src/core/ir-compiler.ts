import * as fs from 'node:fs/promises';
import path from 'node:path';

import { publishAtomicDirectory } from './atomic-directory';
import type { CardNameResolver } from './card-resolver';
import { compileDecklist, type DeckIR, type DeckMetadata, type DeckResolutionOptions } from './deck-content';
import { exists, pathInside, removeExact } from './fs';
import { compileGateContent, parseGateContent, type GateCompileIR, type ParsedGateContent } from './gate-content';
import { GATE_BACKGROUND_CODES, projectGateBackgrounds, type GateBackgroundAsset } from './gate-background-assets';
import { planRegistry, type AllocationRequest, type IdRegistry } from './id-registry';
import { writeIrProjection, type IrProjectionFile, type IrStaleDisposition } from './ir-projection-writer';
import { discoverContentSnapshot, type IrSnapshot } from './ir-snapshot';
import { createIrGenerationMetadata, type IRGenerationMetadata } from './layers';
import type { LocalizationCatalog } from './localization-content';
import { compileShopContent, parseShopPackMetadata, type ShopContentSources, type ShopTargetProjection } from './shop-content';
import { defaultManifest, manifestToJson } from './manifest';
import { compareDirectories, type DirectoryComparison } from './pipeline-harness';
import {
  createDeckRegulationHook,
  validateRegulationContent,
  type CampaignRegulation,
  type RegulationContentSources,
} from './regulation-content';
import {
  compileStructureCollection,
  parseStructureContent,
  type StructureAccessoryCatalog,
  type StructureProjection,
  type StructureRewardReference,
} from './structure-content';
import type { JsonObject, Problem } from './types';
import { problem } from './types';
import { validateCampaign } from './validate';

export const IR_COMPILER_VERSION = 'ygomaster-ir-compiler/v1' as const;

export const IR_COMPILER_CODES = Object.freeze({
  OPTIONS_INVALID: 'IR_COMPILER_OPTIONS_INVALID',
  SOURCE_UNTRACKED: 'IR_COMPILER_SOURCE_UNTRACKED',
  REGULATION_MISSING: 'IR_COMPILER_REGULATION_MISSING',
  DECK_FAILED: 'IR_COMPILER_DECK_FAILED',
  GATE_FAILED: 'IR_COMPILER_GATE_FAILED',
  STRUCTURE_FAILED: 'IR_COMPILER_STRUCTURE_FAILED',
  SHOP_FAILED: 'IR_COMPILER_SHOP_FAILED',
  CARD_REFERENCE_FAILED: 'IR_COMPILER_CARD_REFERENCE_FAILED',
  CAPABILITY_BLOCKED: 'IR_COMPILER_CAPABILITY_BLOCKED',
  STAGING_FAILED: 'IR_COMPILER_STAGING_FAILED',
  IR_VALIDATION_FAILED: 'IR_COMPILER_IR_VALIDATION_FAILED',
  PUBLISH_FAILED: 'IR_COMPILER_PUBLISH_FAILED',
} as const);

export interface AuthoredDeckInput {
  /** Legacy relative deck reference, for example `decks/cpu.json`. */
  key: string;
  source: string;
  sourcePath: string;
  metadata?: DeckMetadata;
  regulation?: string;
}

export interface AuthoredDocumentInput {
  value: unknown;
  sourcePath: string;
}

export interface AuthoredRegulationInput extends RegulationContentSources {
  key: string;
}

export interface CampaignIrBundle {
  decks: readonly AuthoredDeckInput[];
  gates: readonly AuthoredDocumentInput[];
  structures?: readonly AuthoredDocumentInput[];
  shops?: readonly ShopContentSources[];
  regulations?: readonly AuthoredRegulationInput[];
  localization?: LocalizationCatalog;
  language?: string;
  fallbackLanguage?: string;
  accessories?: StructureAccessoryCatalog;
  structureRewards?: readonly StructureRewardReference[];
  /** Symbolic Gate reward reference to exact reviewed English card name. */
  cardReferences?: Record<string, string>;
  /** Snapshot-bound authored PNGs mapped to symbolic Gate references. */
  gateBackgrounds?: readonly GateBackgroundAsset[];
  overlay?: Record<string, IrProjectionFile>;
  /** Existing target capabilities already known to be blocking. */
  blockingCapabilities?: readonly Problem[];
  /** Non-family authored files consumed by localization/asset adapters. */
  consumedSourcePaths?: readonly string[];
}

export interface CompileCampaignIrOptions {
  projectRoot: string;
  contentRoot: string;
  irRoot: string;
  resolver: CardNameResolver;
  catalogGeneration: string;
  registry: IdRegistry;
  bundle: CampaignIrBundle;
  compilerVersion?: string;
  checkOnly?: boolean;
  allowAssumedStructure?: boolean;
  /**
   * The project IR compiler uses the approved fixture adapter by default.
   * Set false (and omit allowAssumedStructure) to exercise the raw
   * compatibility boundary; this does not change target-contract status.
   */
  verifiedStructureAdapter?: boolean;
  deckOptions?: DeckResolutionOptions;
  /** Test seam used only after staging is complete and validated. */
  publish?: typeof publishAtomicDirectory;
  writeProjection?: typeof writeIrProjection;
  validateProjection?: typeof validateCampaign;
}

export interface CampaignIrProvenance extends JsonObject {
  schemaVersion: 1;
  contentGeneration: string;
  compilerVersion: string;
  catalogGeneration: string;
  idRegistryGeneration: string;
  targetContractVersion: string;
  sources: Array<{ path: string; sha256: string; size: number }>;
  families: Record<string, string[]>;
}

export interface CompileCampaignIrResult {
  ok: boolean;
  checkOnly: boolean;
  published: boolean;
  zeroDiff: boolean;
  snapshot?: IrSnapshot;
  generation?: IRGenerationMetadata;
  provenance?: CampaignIrProvenance;
  registry?: IdRegistry;
  deckProjections?: Record<string, DeckIR>;
  gateProjection?: GateCompileIR;
  structureProjections?: StructureProjection[];
  shopProjections?: ShopTargetProjection[];
  diff?: DirectoryComparison;
  staleDisposition: IrStaleDisposition[];
  problems: Problem[];
  warnings: Problem[];
}

const compareOrdinal = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;

const sortedProblems = (entries: readonly Problem[]): Problem[] => [...entries].sort((left, right) =>
  compareOrdinal(left.path || left.sourcePath || '', right.path || right.sourcePath || '')
  || (left.line || 0) - (right.line || 0)
  || compareOrdinal(left.code, right.code)
  || compareOrdinal(left.message, right.message));

const failureResult = (
  checkOnly: boolean,
  problems: readonly Problem[],
  partial: Partial<CompileCampaignIrResult> = {},
): CompileCampaignIrResult => ({
  ok: false,
  checkOnly,
  published: false,
  zeroDiff: false,
  staleDisposition: [],
  warnings: [],
  ...partial,
  problems: sortedProblems(problems),
});

const normalizeRegulationKey = (value: string): string => value.startsWith('regulation:') ? value : `regulation:${value}`;

const trackedSourceProblems = (snapshot: IrSnapshot, bundle: CampaignIrBundle): Problem[] => {
  const tracked = new Set(snapshot.files.map((entry) => entry.path.replace(/\\/gu, '/')));
  const sources = [
    ...bundle.decks.map((entry) => entry.sourcePath),
    ...bundle.gates.map((entry) => entry.sourcePath),
    ...(bundle.structures || []).map((entry) => entry.sourcePath),
    ...(bundle.shops || []).flatMap((entry) => [entry.metadataSourcePath, entry.packListSourcePath, entry.oddsSourcePath].filter((value): value is string => Boolean(value))),
    ...(bundle.regulations || []).flatMap((entry) => [entry.metadataSourcePath, entry.rulesSourcePath].filter((value): value is string => Boolean(value))),
    ...(bundle.consumedSourcePaths || []),
  ];
  return sources
    .map((entry) => entry.replace(/\\/gu, '/'))
    .filter((entry) => !tracked.has(entry))
    .sort(compareOrdinal)
    .map((entry) => problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Compiler input is not part of the authored content snapshot: ${entry}`, entry));
};

const consumedSourceProblems = (snapshot: IrSnapshot, bundle: CampaignIrBundle): Problem[] => {
  const consumed = new Set([
    ...bundle.decks.map((entry) => entry.sourcePath),
    ...bundle.gates.map((entry) => entry.sourcePath),
    ...(bundle.structures || []).map((entry) => entry.sourcePath),
    ...(bundle.shops || []).flatMap((entry) => [entry.metadataSourcePath, entry.packListSourcePath, entry.oddsSourcePath].filter((value): value is string => Boolean(value))),
    ...(bundle.regulations || []).flatMap((entry) => [entry.metadataSourcePath, entry.rulesSourcePath].filter((value): value is string => Boolean(value))),
    ...(bundle.consumedSourcePaths || []),
  ].map((entry) => entry.replace(/\\/gu, '/')));
  return snapshot.files
    .map((entry) => entry.path)
    .filter((entry) => entry !== 'manifest.json' && entry !== 'README.md' && !entry.endsWith('/.gitkeep') && entry !== '.gitkeep')
    .filter((entry) => !consumed.has(entry))
    .map((entry) => problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Authored content file was not consumed by any compiler family: ${entry}`, entry));
};

const automaticCapabilityProblems = (snapshot: IrSnapshot, bundle: CampaignIrBundle): Problem[] => {
  const problems: Problem[] = [];
  for (const relative of Object.keys(bundle.overlay || {})) {
    const basename = path.posix.basename(relative.replace(/\\/gu, '/')).toLowerCase();
    if (['shop.json', 'shoppackodds.json', 'shoppackoddsvisuals.json'].includes(basename)) {
      problems.push(problem('SHOP_TARGET_UNSUPPORTED', `Shop overlay projection is unsupported: ${relative}`, relative));
    }
    if (basename === 'regulationmaster.json') problems.push(problem('REGULATION_TARGET_UNSUPPORTED', `Regulation overlay projection is unsupported: ${relative}`, relative));
  }
  return problems;
};

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareOrdinal(left, right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
};

const jsonMatches = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));

const verifyBundleSources = async (contentRoot: string, bundle: CampaignIrBundle): Promise<Problem[]> => {
  const problems: Problem[] = [];
  const readText = async (sourcePath: string): Promise<string> => fs.readFile(path.join(contentRoot, ...sourcePath.replace(/\\/gu, '/').split('/')), 'utf8');
  for (const entry of bundle.decks) {
    if (await readText(entry.sourcePath) !== entry.source) problems.push(problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Deck bundle differs from authored source bytes: ${entry.sourcePath}`, entry.sourcePath));
  }
  for (const entry of [...bundle.gates, ...(bundle.structures || [])]) {
    try {
      const authored = JSON.parse((await readText(entry.sourcePath)).replace(/^\uFEFF/u, '')) as unknown;
      if (!jsonMatches(authored, entry.value)) problems.push(problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Document bundle differs from authored source JSON: ${entry.sourcePath}`, entry.sourcePath));
    } catch (error) {
      problems.push(problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Authored JSON cannot be rebound into the compiler bundle: ${String(error)}`, entry.sourcePath));
    }
  }
  for (const entry of bundle.regulations || []) {
    if (entry.metadataSourcePath) {
      try {
        const authored = JSON.parse((await readText(entry.metadataSourcePath)).replace(/^\uFEFF/u, '')) as unknown;
        if (!jsonMatches(authored, entry.metadata)) problems.push(problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Regulation metadata bundle differs from authored source JSON: ${entry.metadataSourcePath}`, entry.metadataSourcePath));
      } catch (error) {
        problems.push(problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Regulation metadata cannot be rebound: ${String(error)}`, entry.metadataSourcePath));
      }
    }
    if (entry.rulesSourcePath && await readText(entry.rulesSourcePath) !== entry.rules) {
      problems.push(problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Regulation rules bundle differs from authored source bytes: ${entry.rulesSourcePath}`, entry.rulesSourcePath));
    }
  }
  for (const entry of bundle.gateBackgrounds || []) {
    try {
      const authored = await fs.readFile(path.join(contentRoot, ...entry.sourcePath.replace(/\\/gu, '/').split('/')));
      if (!authored.equals(Buffer.from(entry.bytes))) problems.push(problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Gate background bundle differs from authored source bytes: ${entry.sourcePath}`, entry.sourcePath));
    } catch (error) {
      problems.push(problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Gate background cannot be rebound: ${String(error)}`, entry.sourcePath));
    }
  }
  for (const entry of bundle.shops || []) {
    if (entry.metadataSourcePath) {
      try {
        const authored = JSON.parse((await readText(entry.metadataSourcePath)).replace(/^\uFEFF/u, '')) as unknown;
        if (!jsonMatches(authored, entry.metadata)) problems.push(problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Shop metadata bundle differs from authored source JSON: ${entry.metadataSourcePath}`, entry.metadataSourcePath));
      } catch (error) {
        problems.push(problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Shop metadata cannot be rebound: ${String(error)}`, entry.metadataSourcePath));
      }
    }
    if (entry.packListSourcePath && await readText(entry.packListSourcePath) !== (entry.packList ?? entry.packlist)) {
      problems.push(problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Shop packlist bundle differs from authored source bytes: ${entry.packListSourcePath}`, entry.packListSourcePath));
    }
    if (entry.oddsSourcePath) {
      try {
        const authored = JSON.parse((await readText(entry.oddsSourcePath)).replace(/^\uFEFF/u, '')) as unknown;
        if (!jsonMatches(authored, entry.odds)) problems.push(problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Shop odds bundle differs from authored source JSON: ${entry.oddsSourcePath}`, entry.oddsSourcePath));
      } catch (error) {
        problems.push(problem(IR_COMPILER_CODES.SOURCE_UNTRACKED, `Shop odds cannot be rebound: ${String(error)}`, entry.oddsSourcePath));
      }
    }
  }
  return problems;
};

const cardReferenceIds = (
  resolver: CardNameResolver,
  references: Record<string, string>,
): { ids: Record<string, number>; problems: Problem[] } => {
  const ids: Record<string, number> = {};
  const problems: Problem[] = [];
  for (const [reference, sourceName] of Object.entries(references).sort(([left], [right]) => compareOrdinal(left, right))) {
    const resolved = resolver.resolve({ sourceName, jsonPointer: `/cardReferences/${reference}` });
    if (!resolved.ok || resolved.runtimeId === undefined) problems.push(...resolved.problems.map((entry) => ({ ...entry, code: IR_COMPILER_CODES.CARD_REFERENCE_FAILED })));
    else ids[reference] = resolved.runtimeId;
  }
  return { ids, problems };
};

const gateDeckReferences = (gate: ParsedGateContent): string[] => {
  const references = new Set<string>();
  for (const chapter of gate.gate.chapters) {
    if (!chapter.duel) continue;
    if (chapter.duel.cpuDeck) references.add(chapter.duel.cpuDeck);
    if (chapter.duel.rentalDeck) references.add(chapter.duel.rentalDeck);
    if (chapter.duel.playerDeck) references.add(chapter.duel.playerDeck);
  }
  return [...references].sort(compareOrdinal);
};

const createProvenance = (snapshot: IrSnapshot, bundle: CampaignIrBundle, generation: IRGenerationMetadata): CampaignIrProvenance => ({
  schemaVersion: 1,
  contentGeneration: snapshot.contentGeneration,
  compilerVersion: generation.compilerVersion,
  catalogGeneration: generation.catalogGeneration,
  idRegistryGeneration: generation.idRegistryGeneration || generation.idLockGeneration || '',
  targetContractVersion: generation.targetContractVersion,
  sources: snapshot.files.map((entry) => ({ path: entry.path, sha256: entry.hash, size: entry.size })),
  families: {
    decks: bundle.decks.map((entry) => entry.sourcePath).sort(compareOrdinal),
    gates: bundle.gates.map((entry) => entry.sourcePath).sort(compareOrdinal),
    regulations: (bundle.regulations || []).flatMap((entry) => [entry.metadataSourcePath, entry.rulesSourcePath].filter((value): value is string => Boolean(value))).sort(compareOrdinal),
    structures: (bundle.structures || []).map((entry) => entry.sourcePath).sort(compareOrdinal),
    shops: (bundle.shops || []).flatMap((entry) => [entry.metadataSourcePath, entry.packListSourcePath, entry.oddsSourcePath].filter((value): value is string => Boolean(value))).sort(compareOrdinal),
  },
});

export const compileCampaignIr = async (options: CompileCampaignIrOptions): Promise<CompileCampaignIrResult> => {
  const checkOnly = options?.checkOnly === true;
  if (!options || !options.projectRoot || !options.contentRoot || !options.irRoot || !options.resolver || !options.registry || !options.bundle) {
    return failureResult(checkOnly, [problem(IR_COMPILER_CODES.OPTIONS_INVALID, 'projectRoot, contentRoot, irRoot, resolver, registry, and bundle are required')]);
  }
  const projectRoot = path.resolve(options.projectRoot);
  const contentRoot = path.resolve(options.contentRoot);
  const irRoot = path.resolve(options.irRoot);
  if (!pathInside(projectRoot, contentRoot) || !pathInside(projectRoot, irRoot)
    || pathInside(contentRoot, irRoot) || pathInside(irRoot, contentRoot)) {
    return failureResult(checkOnly, [problem(IR_COMPILER_CODES.OPTIONS_INVALID, 'contentRoot and irRoot must be separate strict children of projectRoot')]);
  }
  let snapshot: IrSnapshot;
  try {
    const discovered = await discoverContentSnapshot(options.contentRoot, { projectRoot: options.projectRoot });
    if (!discovered.ok || !discovered.snapshot) return failureResult(checkOnly, discovered.problems);
    snapshot = discovered.snapshot;
  } catch (error) {
    const nested = error && typeof error === 'object' && 'problems' in error && Array.isArray(error.problems)
      ? error.problems as Problem[]
      : [problem(IR_COMPILER_CODES.OPTIONS_INVALID, String(error), options.contentRoot)];
    return failureResult(checkOnly, nested);
  }
  const sourceProblems = trackedSourceProblems(snapshot, options.bundle);
  if (sourceProblems.length) return failureResult(checkOnly, sourceProblems, { snapshot });
  sourceProblems.push(...await verifyBundleSources(options.contentRoot, options.bundle));
  if (sourceProblems.length) return failureResult(checkOnly, sourceProblems, { snapshot });
  const capabilityProblems = [...automaticCapabilityProblems(snapshot, options.bundle), ...(options.bundle.blockingCapabilities || [])];
  if (capabilityProblems.length) {
    return failureResult(checkOnly, capabilityProblems.map((entry) => ({ ...entry, code: entry.code || IR_COMPILER_CODES.CAPABILITY_BLOCKED })), { snapshot });
  }
  sourceProblems.push(...consumedSourceProblems(snapshot, options.bundle));
  if (sourceProblems.length) return failureResult(checkOnly, sourceProblems, { snapshot });

  const problems: Problem[] = [];
  const warnings: Problem[] = [];
  const regulations = new Map<string, CampaignRegulation>();
  for (const entry of [...(options.bundle.regulations || [])].sort((left, right) => compareOrdinal(left.key, right.key))) {
    const validated = validateRegulationContent(entry, options.resolver);
    problems.push(...validated.problems);
    warnings.push(...validated.warnings);
    if (validated.regulation) regulations.set(normalizeRegulationKey(entry.key), validated.regulation);
  }
  if (regulations.size) warnings.push(problem(
    'REGULATION_TARGET_VALIDATION_ONLY',
    'Regulation content is active for compile-time deck legality only; no target Regulation overlay will be published',
    undefined,
    'warning',
  ));

  const deckInputs = new Map(options.bundle.decks.map((entry) => [entry.key, entry]));
  if (deckInputs.size !== options.bundle.decks.length) {
    problems.push(problem(IR_COMPILER_CODES.DECK_FAILED, 'Deck output keys must be unique'));
  }
  const deckProjections: Record<string, DeckIR> = {};
  for (const entry of [...options.bundle.decks].sort((left, right) => compareOrdinal(left.key, right.key))) {
    const regulation = entry.regulation ? regulations.get(normalizeRegulationKey(entry.regulation)) : undefined;
    if (entry.regulation && !regulation) problems.push(problem(IR_COMPILER_CODES.REGULATION_MISSING, `Deck ${entry.key} references missing regulation ${entry.regulation}`, entry.sourcePath));
    const compiled = compileDecklist(entry.source, options.resolver, {
      ...(options.deckOptions || {}),
      sourcePath: entry.sourcePath,
      metadata: entry.metadata,
      ...(regulation ? { regulationHook: createDeckRegulationHook(regulation) } : {}),
    });
    problems.push(...compiled.problems);
    if (compiled.ir) deckProjections[entry.key] = compiled.ir;
  }

  const parsedGates: ParsedGateContent[] = [];
  for (const entry of options.bundle.gates) {
    const parsed = parseGateContent(entry.value, entry.sourcePath);
    problems.push(...parsed.problems);
    if (parsed.document) parsedGates.push(parsed.document);
  }
  for (const gate of parsedGates) {
    const regulation = gate.gate.regulation ? regulations.get(gate.gate.regulation) : undefined;
    if (gate.gate.regulation && !regulation) {
      problems.push(problem(IR_COMPILER_CODES.REGULATION_MISSING, `Gate ${gate.gate.id} references missing regulation ${gate.gate.regulation}`, gate.sourcePath));
      continue;
    }
    if (!regulation) continue;
    for (const reference of gateDeckReferences(gate)) {
      const deck = deckInputs.get(reference);
      if (!deck) continue;
      const regulated = compileDecklist(deck.source, options.resolver, {
        ...(options.deckOptions || {}),
        sourcePath: deck.sourcePath,
        metadata: deck.metadata,
        regulationHook: createDeckRegulationHook(regulation),
      });
      problems.push(...regulated.problems);
    }
  }
  if (problems.length) return failureResult(checkOnly, problems, { snapshot, warnings: sortedProblems(warnings), deckProjections });

  const structureInputs = options.bundle.structures || [];
  // STC-002 approves the existing fixture adapter for the project compiler
  // path.  The lower-level structure compiler still requires an explicit
  // allowAssumed/verifiedAdapter opt-in, so this default cannot silently
  // broaden that API's target capability.
  const approvedStructureAdapter = options.verifiedStructureAdapter
    ?? options.allowAssumedStructure
    ?? true;
  const parsedStructures = structureInputs.map((entry) => parseStructureContent(entry.value, entry.sourcePath));
  const structureCollection = await compileStructureCollection(
    parsedStructures,
    options.resolver,
    {
      registry: options.registry,
      deckSources: Object.fromEntries(options.bundle.decks.map((entry) => [entry.key, entry.source])),
      deckOptions: options.deckOptions,
      localization: options.bundle.localization,
      language: undefined,
      accessories: options.bundle.accessories,
      rewardReferences: options.bundle.structureRewards,
      allowAssumed: options.allowAssumedStructure,
      verifiedAdapter: approvedStructureAdapter,
    } as Parameters<typeof compileStructureCollection>[2],
  );
  problems.push(...structureCollection.problems);
  warnings.push(...structureCollection.warnings);
  const registry = structureCollection.registry || options.registry;
  const structureIds: Record<string, number> = {};
  const structureDecks: Record<string, string> = {};
  const structureMetadata: Record<string, { name?: string; description?: string }> = {};
  const structureProjections: StructureProjection[] = [];
  for (const compiled of structureCollection.structures) {
    if (compiled.key && compiled.structureId !== undefined) structureIds[`structure:${compiled.key}`] = compiled.structureId;
    if (compiled.projection) {
      structureProjections.push(compiled.projection);
      if (compiled.definition?.deck) structureDecks[compiled.projection.path] = compiled.definition.deck;
      if (compiled.localization) structureMetadata[compiled.projection.path] = {
        ...(compiled.localization.name ? { name: compiled.localization.name } : {}),
        ...(compiled.localization.description ? { description: compiled.localization.description } : {}),
      };
    }
  }
  const shopInputs = [...(options.bundle.shops || [])].sort((left, right) => compareOrdinal(left.metadataSourcePath || '', right.metadataSourcePath || ''));
  const shopRequests: AllocationRequest[] = [];
  for (const entry of shopInputs) {
    const parsed = parseShopPackMetadata(entry.metadata, entry.metadataSourcePath);
    problems.push(...parsed.problems);
    const key = parsed.document?.metadata.normalizedShopId.replace(/^shop:/u, '');
    if (key) shopRequests.push({ namespace: 'shop', key });
  }
  let registryAfterShop = registry;
  if (!problems.length && shopRequests.length) {
    try {
      registryAfterShop = planRegistry(registry, shopRequests).registry;
    } catch (error) {
      problems.push(problem(IR_COMPILER_CODES.SHOP_FAILED, `Shop ID allocation failed: ${String(error)}`, 'shop'));
    }
  }
  const knownShopTargets = shopRequests.map((entry) => `shop:${entry.key}`).sort(compareOrdinal);
  const shopProjections: ShopTargetProjection[] = [];
  for (const entry of shopInputs) {
    const compiled = compileShopContent(entry, {
      resolver: options.resolver,
      registry: registryAfterShop,
      requireRegistryAssignment: true,
      knownContentTargets: knownShopTargets,
    });
    problems.push(...compiled.problems);
    warnings.push(...compiled.warnings);
    if (compiled.projection) shopProjections.push(compiled.projection);
  }
  const shopBySymbol = new Map(shopProjections.map((entry) => [entry.symbolicShopId, entry]));
  const predecessorBySuccessor = new Map<string, string>();
  for (const projection of shopProjections) {
    if (!projection.predecessorRef) continue;
    predecessorBySuccessor.set(projection.symbolicShopId, projection.predecessorRef);
    const predecessor = shopBySymbol.get(projection.predecessorRef);
    if (!predecessor) {
      problems.push(problem(IR_COMPILER_CODES.SHOP_FAILED, `Shop predecessor does not resolve: ${projection.predecessorRef}`, projection.symbolicShopId));
      continue;
    }
    const unlocks = predecessor.shopEntry.unlockSecrets as unknown as number[];
    if (!unlocks.includes(projection.shopId)) unlocks.push(projection.shopId);
    unlocks.sort((left, right) => left - right);
  }
  for (const start of predecessorBySuccessor.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = start;
    while (current && predecessorBySuccessor.has(current)) {
      if (seen.has(current)) {
        problems.push(problem(IR_COMPILER_CODES.SHOP_FAILED, `Shop progression contains a cycle at ${current}`, current));
        break;
      }
      seen.add(current);
      current = predecessorBySuccessor.get(current);
    }
  }
  const shopOverlay: Record<string, IrProjectionFile> = shopProjections.length ? {
    'Shop.json': {
      PackShop: Object.fromEntries(shopProjections
        .slice()
        .sort((left, right) => left.shopId - right.shopId)
        .map((entry) => [String(entry.shopId), entry.shopEntry])),
    },
    'ShopPackOdds.json': {
      entries: shopProjections
        .slice()
        .sort((left, right) => left.shopId - right.shopId)
        .map((entry) => entry.oddsEntry),
    },
  } : {};
  for (const managedPath of Object.keys(shopOverlay)) {
    if (Object.keys(options.bundle.overlay || {}).some((entry) => entry.replace(/\\/gu, '/').replace(/^Data\//u, '').toLowerCase() === managedPath.toLowerCase())) {
      problems.push(problem(IR_COMPILER_CODES.SHOP_FAILED, `Generated Shop projection collides with a supplied overlay: ${managedPath}`, managedPath));
    }
  }
  const cards = cardReferenceIds(options.resolver, options.bundle.cardReferences || {});
  problems.push(...cards.problems);
  if (problems.length) return failureResult(checkOnly, problems, { snapshot, registry: registryAfterShop, warnings: sortedProblems(warnings), deckProjections, structureProjections, shopProjections });

  const gateCompiled = compileGateContent({ documents: parsedGates }, {
    registry: registryAfterShop,
    localization: options.bundle.localization,
    language: options.bundle.language,
    fallbackLanguage: options.bundle.fallbackLanguage,
    deckReferences: Object.keys(deckProjections),
    deckProjections,
    cardIds: cards.ids,
    structureIds,
  });
  problems.push(...gateCompiled.problems);
  warnings.push(...gateCompiled.warnings);
  if (!gateCompiled.ir || problems.length) return failureResult(checkOnly, problems.length ? problems : [problem(IR_COMPILER_CODES.GATE_FAILED, 'Gate compilation produced no IR')], {
    snapshot,
    registry: gateCompiled.registry || registryAfterShop,
    warnings: sortedProblems(warnings),
    deckProjections,
    structureProjections,
    shopProjections,
  });

  const finalRegistry = gateCompiled.registry || registryAfterShop;
  const backgrounds = projectGateBackgrounds(
    parsedGates.map((entry) => entry.gate.id),
    options.bundle.gateBackgrounds || [],
    finalRegistry,
  );
  problems.push(...backgrounds.problems);
  for (const relative of Object.keys(backgrounds.overlay)) {
    if (Object.keys(options.bundle.overlay || {}).some((entry) => entry.replace(/\\/gu, '/').replace(/^Data\//u, '').toLowerCase() === relative.toLowerCase())) {
      problems.push(problem(GATE_BACKGROUND_CODES.DUPLICATE, `Generated Gate background collides with a supplied overlay: ${relative}`, relative));
    }
  }
  if (problems.length) return failureResult(checkOnly, problems, {
    snapshot,
    registry: finalRegistry,
    warnings: sortedProblems(warnings),
    deckProjections,
    gateProjection: gateCompiled.ir,
    structureProjections,
    shopProjections,
  });
  const generation = createIrGenerationMetadata({
    contentGeneration: snapshot.contentGeneration,
    compilerVersion: options.compilerVersion || IR_COMPILER_VERSION,
    catalogGeneration: options.catalogGeneration,
    idRegistryGeneration: finalRegistry.generation,
    sourceManifestVersion: snapshot.manifest.formatVersion,
  });
  const provenance = createProvenance(snapshot, options.bundle, generation);
  const parent = path.dirname(path.resolve(options.irRoot));
  const nonce = `${process.pid}-${Date.now()}`;
  const stagingRoot = path.join(parent, `.campaign-ir-staging-${nonce}`);
  const backupRoot = path.join(parent, `.campaign-ir-backup-${nonce}`);
  await fs.mkdir(stagingRoot, { recursive: false });
  try {
    const manifest = defaultManifest();
    manifest.campaign = { ...snapshot.manifest.campaign };
    const written = await (options.writeProjection || writeIrProjection)({
      stagingRoot,
      manifest: manifestToJson(manifest),
      decks: deckProjections,
      gates: [gateCompiled.ir],
      structures: structureProjections,
      structureDecks,
      structureMetadata,
      overlay: { ...(options.bundle.overlay || {}), ...shopOverlay, ...backgrounds.overlay },
      generation,
      provenance,
      ...(await exists(options.irRoot) ? { preservedSourceRoot: options.irRoot } : {}),
    });
    if (!written.ok) return failureResult(checkOnly, written.problems, { snapshot, generation, provenance, registry: finalRegistry, deckProjections, gateProjection: gateCompiled.ir, structureProjections, shopProjections, staleDisposition: written.staleDisposition });
    const validation = await (options.validateProjection || validateCampaign)(options.projectRoot, stagingRoot);
    warnings.push(...validation.warnings);
    if (!validation.ok) return failureResult(checkOnly, validation.problems.map((entry) => ({ ...entry, code: entry.code || IR_COMPILER_CODES.IR_VALIDATION_FAILED })), {
      snapshot, generation, provenance, registry: finalRegistry, warnings: sortedProblems(warnings), deckProjections, gateProjection: gateCompiled.ir, structureProjections, shopProjections, staleDisposition: written.staleDisposition,
    });
    const diff = await compareDirectories(stagingRoot, options.irRoot);
    const zeroDiff = diff.equal;
    const resultBase = {
      snapshot, generation, provenance, registry: finalRegistry, warnings: sortedProblems(warnings), deckProjections,
      gateProjection: gateCompiled.ir, structureProjections, shopProjections, diff, staleDisposition: written.staleDisposition,
    };
    if (checkOnly || zeroDiff) {
      await removeExact(stagingRoot);
      return { ok: true, checkOnly, published: false, zeroDiff, problems: [], ...resultBase };
    }
    await (options.publish || publishAtomicDirectory)({ root: parent, stagingPath: stagingRoot, finalPath: options.irRoot, backupPath: backupRoot });
    return { ok: true, checkOnly: false, published: true, zeroDiff: false, problems: [], ...resultBase };
  } catch (error) {
    return failureResult(checkOnly, [problem(IR_COMPILER_CODES.PUBLISH_FAILED, String(error), options.irRoot)], { snapshot, generation, provenance, registry: finalRegistry, warnings: sortedProblems(warnings), deckProjections, gateProjection: gateCompiled.ir, structureProjections, shopProjections });
  } finally {
    if (await exists(stagingRoot)) await removeExact(stagingRoot);
    // Never delete a backup after a publisher rollback failure. A successful
    // atomic publisher removes it; a failed rollback must remain recoverable.
  }
};

export const compileIr = compileCampaignIr;
export const compileCampaignIR = compileCampaignIr;
