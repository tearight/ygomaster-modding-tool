import * as path from 'node:path';

import {
  ContentFormatError,
  ParsedContentEnvelope,
  contentDiagnostic,
  normalizeSymbolicKey,
  normalizeSymbolicReference,
  parseContentEnvelopeWithSource,
  semanticEqual,
} from './content-format';
import type { DeckIR } from './deck-content';
import {
  IdRegistry,
  RegistryAllocationOptions,
  RegistryPlan,
  createEmptyRegistry,
  planRegistry,
  parseRegistry,
} from './id-registry';
import {
  LocalizationCatalog,
  LocalizationReference,
  resolveLocalization,
  normalizeLocalizationKey,
} from './localization-content';
import type { JsonObject, JsonValue, Problem } from './types';
import { YGOMASTER_TARGET_CONTRACT_VERSION } from './layers';
import { normalizeDeckFolderReference } from './deck-organization';

/** Authored Gate/Chapter content is deliberately separate from Solo.json. */
export const GATE_CONTENT_FORMAT_VERSION = 1 as const;
export const GATE_CONTENT_PARSER_VERSION = 1 as const;
export const GATE_CONTENT_KIND = 'gate' as const;
export const GATE_CONTENT_VERSION = GATE_CONTENT_FORMAT_VERSION;

export const GATE_CONTENT_CODES = Object.freeze({
  ENVELOPE_INVALID: 'GATE_ENVELOPE_INVALID',
  KIND_INVALID: 'GATE_KIND_INVALID',
  FORMAT_VERSION_INVALID: 'GATE_FORMAT_VERSION_INVALID',
  TOP_LEVEL_UNKNOWN: 'GATE_TOP_LEVEL_UNKNOWN',
  FIELD_UNKNOWN: 'GATE_FIELD_UNKNOWN',
  CHAPTER_FIELD_UNKNOWN: 'CHAPTER_FIELD_UNKNOWN',
  TARGET_EXTENSION_INVALID: 'GATE_TARGET_EXTENSION_INVALID',
  TARGET_EXTENSION_UNKNOWN: 'GATE_TARGET_EXTENSION_UNKNOWN',
  TARGET_OVERRIDE_FORBIDDEN: 'GATE_TARGET_OVERRIDE_FORBIDDEN',
  SYMBOLIC_ID_REQUIRED: 'GATE_SYMBOLIC_ID_REQUIRED',
  SYMBOLIC_REFERENCE_INVALID: 'GATE_SYMBOLIC_REFERENCE_INVALID',
  SYMBOLIC_NAMESPACE_INVALID: 'GATE_SYMBOLIC_NAMESPACE_INVALID',
  NUMERIC_ID_FORBIDDEN: 'GATE_NUMERIC_ID_FORBIDDEN',
  ID_MISSING: 'GATE_ID_MISSING',
  ID_DUPLICATE: 'GATE_ID_DUPLICATE',
  ID_INVALID: 'GATE_ID_INVALID',
  PARENT_INVALID: 'GATE_PARENT_INVALID',
  PARENT_ORPHAN: 'GATE_PARENT_ORPHAN',
  PARENT_CYCLE: 'GATE_PARENT_CYCLE',
  VIEW_INVALID: 'GATE_VIEW_INVALID',
  VIEW_ORPHAN: 'GATE_VIEW_ORPHAN',
  REGULATION_REF_INVALID: 'GATE_REGULATION_REF_INVALID',
  REGULATION_REFERENCE_INVALID: 'GATE_REGULATION_REF_INVALID',
  REGULATION_REF_NAMESPACE_INVALID: 'GATE_REGULATION_REF_NAMESPACE_INVALID',
  REGULATION_NAMESPACE_INVALID: 'GATE_REGULATION_REF_NAMESPACE_INVALID',
  GOAL_MISSING: 'GATE_GOAL_MISSING',
  GOAL_INVALID: 'GATE_GOAL_INVALID',
  GOAL_ORPHAN: 'GATE_GOAL_ORPHAN',
  CLEAR_CHAPTER_ZERO_FORBIDDEN: 'GATE_CLEAR_CHAPTER_ZERO_FORBIDDEN',
  CHAPTERS_MISSING: 'GATE_CHAPTERS_MISSING',
  CHAPTERS_INVALID: 'GATE_CHAPTERS_INVALID',
  CHAPTER_ID_MISSING: 'CHAPTER_ID_MISSING',
  CHAPTER_ID_REQUIRED: 'CHAPTER_SYMBOLIC_ID_REQUIRED',
  CHAPTER_ID_INVALID: 'CHAPTER_ID_INVALID',
  CHAPTER_ID_DUPLICATE: 'CHAPTER_ID_DUPLICATE',
  CHAPTER_PARENT_INVALID: 'CHAPTER_PARENT_INVALID',
  CHAPTER_PARENT_ORPHAN: 'CHAPTER_PARENT_ORPHAN',
  CHAPTER_PARENT_CYCLE: 'CHAPTER_PARENT_CYCLE',
  CHAPTER_KIND_MISSING: 'CHAPTER_KIND_MISSING',
  CHAPTER_KIND_INVALID: 'CHAPTER_KIND_INVALID',
  CHAPTER_REQUIRED_INVALID: 'CHAPTER_REQUIRED_INVALID',
  REQUIRED_UNREACHABLE: 'GATE_REQUIRED_UNREACHABLE',
  GRAPH_CYCLE: 'GATE_GRAPH_CYCLE',
  PARENT_UNLOCK_CYCLE: 'GATE_PARENT_UNLOCK_CYCLE',
  UNLOCK_INVALID: 'GATE_UNLOCK_INVALID',
  UNLOCK_MODE_INVALID: 'GATE_UNLOCK_MODE_INVALID',
  UNLOCK_REF_INVALID: 'GATE_UNLOCK_REF_INVALID',
  UNLOCK_REF_ORPHAN: 'GATE_UNLOCK_REF_ORPHAN',
  UNLOCK_GRAPH_CYCLE: 'UNLOCK_GRAPH_CYCLE',
  UNLOCK_CHAPTER_TARGET_MISSING: 'UNLOCK_CHAPTER_TARGET_MISSING',
  UNLOCK_SECRET_UNSUPPORTED: 'UNLOCK_SECRET_UNSUPPORTED',
  UNLOCK_SECRET_TARGET_ID_MISSING: 'UNLOCK_SECRET_TARGET_ID_MISSING',
  DUEL_INVALID: 'DUEL_INVALID',
  DUEL_CPU_DECK_MISSING: 'DUEL_CPU_DECK_MISSING',
  DUEL_RENTAL_DECK_MISSING: 'DUEL_RENTAL_DECK_MISSING',
  DUEL_PLAYER_MODE_MISSING: 'DUEL_PLAYER_MODE_MISSING',
  DUEL_PLAYER_MODE_INVALID: 'DUEL_PLAYER_MODE_INVALID',
  DUEL_CPU_DECK_PROJECTION_MISSING: 'DUEL_CPU_DECK_PROJECTION_MISSING',
  DUEL_RENTAL_DECK_PROJECTION_MISSING: 'DUEL_RENTAL_DECK_PROJECTION_MISSING',
  DUEL_PLAYER_DECK_PROJECTION_MISSING: 'DUEL_PLAYER_DECK_PROJECTION_MISSING',
  DUEL_DECK_PROJECTION_EMPTY: 'DUEL_DECK_PROJECTION_EMPTY',
  DUEL_DECK_PROJECTION_LENGTH_MISMATCH: 'DUEL_DECK_PROJECTION_LENGTH_MISMATCH',
  DECK_REFERENCE_INVALID: 'DECK_REFERENCE_INVALID',
  DECK_REFERENCE_MISSING: 'DECK_REFERENCE_MISSING',
  LOCALIZATION_REFERENCE_MISSING: 'LOCALIZATION_REFERENCE_MISSING',
  LOCALIZATION_REFERENCE_INVALID: 'LOCALIZATION_REFERENCE_INVALID',
  LOCALIZATION_REFERENCE_UNKNOWN: 'LOCALIZATION_REFERENCE_UNKNOWN',
  REWARD_INVALID: 'REWARD_INVALID',
  REWARD_REQUIRED: 'REWARD_REQUIRED',
  REWARD_KIND_INVALID: 'REWARD_KIND_INVALID',
  REWARD_REF_MISSING: 'REWARD_REF_MISSING',
  REWARD_REF_INVALID: 'REWARD_REF_INVALID',
  REWARD_AMOUNT_INVALID: 'REWARD_AMOUNT_INVALID',
  REWARD_ID_INVALID: 'REWARD_ID_INVALID',
  CARD_REWARD_TARGET_ID_MISSING: 'CARD_REWARD_TARGET_ID_MISSING',
  STRUCTURE_REWARD_TARGET_ID_MISSING: 'STRUCTURE_REWARD_TARGET_ID_MISSING',
  TARGET_ID_INVALID: 'GATE_TARGET_ID_INVALID',
  TARGET_ID_MISSING: 'GATE_TARGET_ID_MISSING',
  ID_REGISTRY_INVALID: 'GATE_ID_REGISTRY_INVALID',
  ID_REGISTRY_ALLOCATION_FAILED: 'GATE_ID_REGISTRY_ALLOCATION_FAILED',
  IR_BLOCKED: 'GATE_IR_BLOCKED',
  IR_INVALID: 'GATE_IR_INVALID',
} as const);

/** Compatibility spelling used by domain-family callers. */
export const GATE_CODES = GATE_CONTENT_CODES;
export type GateContentCode = (typeof GATE_CONTENT_CODES)[keyof typeof GATE_CONTENT_CODES];

export type GateChapterKind = 'duel' | 'reward' | 'unlock';
export type GateUnlockMode = 'or' | 'and';
export type GatePlayerMode = 'mydeck' | 'rental' | 'both';

export interface GateLocalizationReference extends LocalizationReference {
  key: string;
}

export interface GateTargetExtension {
  ygomaster: JsonObject;
}

export interface GateUnlockDefinition {
  mode: GateUnlockMode;
  chapterRefs: string[];
  packRefs: string[];
}

export type GateRewardKind = 'gem' | 'card' | 'structure' | 'pack';

export interface GateRewardDefinition {
  kind: GateRewardKind;
  ref?: string;
  amount: number;
  rewardKey?: string;
}

export interface GateDuelDefinition {
  cpuDeck: string;
  rentalDeck?: string;
  playerDeck?: string;
  playerMode: GatePlayerMode;
  playerNameKey?: GateLocalizationReference;
  cpuNameKey?: GateLocalizationReference;
  target?: GateTargetExtension;
}

export interface GateChapterDefinition {
  id: string;
  key: string;
  kind: GateChapterKind;
  parent?: string;
  required: boolean;
  entry: boolean;
  descriptionKey: GateLocalizationReference;
  nameKey?: GateLocalizationReference;
  duel?: GateDuelDefinition;
  rewards: GateRewardDefinition[];
  unlock?: GateUnlockDefinition;
  /** TCG compatibility extension: symbolic Shop packs opened by this Chapter. */
  unlockSecrets?: string[];
  target?: GateTargetExtension;
  sourceIndex: number;
}

export interface GateDefinition {
  id: string;
  key: string;
  /** Authoring-only scope; never emitted to Modding Tool IR or YgoMaster Data. */
  deckFolder?: string;
  /** Optional symbolic hook consumed by regulation/deck validation orchestration. */
  regulation?: string;
  priority: number;
  nameKey: GateLocalizationReference;
  descriptionKey: GateLocalizationReference;
  parent?: string;
  view?: string;
  goal?: string;
  unlock?: GateUnlockDefinition;
  chapters: GateChapterDefinition[];
  target?: GateTargetExtension;
}

export interface ParsedGateContent {
  formatVersion: typeof GATE_CONTENT_FORMAT_VERSION;
  parserVersion: typeof GATE_CONTENT_PARSER_VERSION;
  kind: typeof GATE_CONTENT_KIND;
  sourcePath?: string;
  original: ParsedContentEnvelope<JsonObject>;
  gate: GateDefinition;
  diagnostics: Problem[];
  ok: boolean;
}

export interface GateContentParseResult {
  document?: ParsedGateContent;
  problems: Problem[];
}

export interface GateGraphInput {
  documents?: readonly (ParsedGateContent | GateContentParseResult | unknown)[];
  gates?: readonly (ParsedGateContent | GateContentParseResult | unknown)[];
}

export interface GateValidationOptions {
  /** Other gate documents in the same content graph. */
  documents?: readonly (ParsedGateContent | GateContentParseResult | unknown)[];
  gates?: readonly (ParsedGateContent | GateContentParseResult | unknown)[];
  knownGateIds?: readonly string[];
  knownChapterIds?: readonly string[];
  localization?: LocalizationCatalog;
  language?: string;
  fallbackLanguage?: string;
  /** Optional discovered deck paths; omitted means path syntax is still checked but existence is deferred. */
  deckReferences?: readonly string[];
  /** Resolved deck projections required by the Gate/Duel compiler. */
  deckProjections?: ReadonlyMap<string, DeckIR> | Record<string, DeckIR>;
  /** Authored deck identity to generated legacy adapter path. */
  deckOutputReferences?: ReadonlyMap<string, string> | Record<string, string>;
}

export interface GateValidationResult {
  ok: boolean;
  documents: ParsedGateContent[];
  gates: GateDefinition[];
  problems: Problem[];
  warnings: Problem[];
}

export interface GateCompileOptions extends GateValidationOptions {
  registry?: IdRegistry;
  registryOptions?: RegistryAllocationOptions;
  /** Runtime card IDs remain card-catalog input, never ID-registry assignments. */
  cardIds?: ReadonlyMap<string, number> | Record<string, number>;
  /** Optional symbolic structure IDs; otherwise the existing ID registry is consulted. */
  structureIds?: ReadonlyMap<string, number> | Record<string, number>;
  /** Symbolic Shop pack identities resolved by the collection compiler. */
  shopIds?: ReadonlyMap<string, number> | Record<string, number>;
  /** If true, do not attempt to allocate new target IDs. */
  requireExistingIds?: boolean;
}

export interface GateRewardTargetItem {
  category: number;
  id: number;
  count: number;
}

export interface GateCompileIR {
  formatVersion: typeof GATE_CONTENT_FORMAT_VERSION;
  kind: 'gate-ir';
  targetContractVersion: string;
  registryGeneration: string;
  /** Target-compatible Solo payload, without the Master wrapper. */
  solo: {
    gate: Record<string, JsonObject>;
    chapter: Record<string, Record<string, JsonObject>>;
    unlock: Record<string, JsonObject>;
    unlock_item: Record<string, JsonObject>;
    reward: Record<string, JsonObject>;
  };
  /** Target-compatible Duel files keyed by composite chapter ID. */
  duels: Record<string, JsonObject>;
  /** Source files accepted by the YgoMaster Data materializer. */
  sourceFiles: Record<string, JsonObject>;
  /** Symbolic-to-numeric reward projection for review. */
  rewardItems: Record<string, GateRewardTargetItem[]>;
}

export interface GateCompileResult extends GateValidationResult {
  ir?: GateCompileIR;
  registry?: IdRegistry;
  registryPlan?: RegistryPlan;
  targetCapability: { status: 'confirmed' | 'blocked'; blockingCode?: string };
}

export class GateContentError extends Error {
  readonly code: string;
  readonly problems: Problem[];

  constructor(code: string, message: string, problems: Problem[] = []) {
    super(message);
    this.name = 'GateContentError';
    this.code = code;
    this.problems = problems.length ? problems : [contentDiagnostic({ code, message })];
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const compareOrdinal = (left: string, right: string): number => {
  if (left === right) return 0;
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0) || 0;
    const rightPoint = rightPoints[index]?.codePointAt(0) || 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
};

const problemSort = (left: Problem, right: Problem): number =>
  compareOrdinal(left.sourcePath || left.path || '', right.sourcePath || right.path || '')
  || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
  || (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER)
  || compareOrdinal(left.jsonPointer || '', right.jsonPointer || '')
  || compareOrdinal(left.code, right.code)
  || compareOrdinal(left.message, right.message);

const sortProblems = (problems: readonly Problem[]): Problem[] => [...problems].sort(problemSort);

const diagnostic = (
  code: string,
  message: string,
  sourcePath?: string,
  jsonPointer?: string,
  severity: 'error' | 'warning' = 'error',
): Problem => contentDiagnostic({ code, message, sourcePath, jsonPointer, severity });

const pointer = (base: string, key: string | number): string =>
  `${base}/${String(key).replace(/~/gu, '~0').replace(/\//gu, '~1')}`;

const unknownKeys = (
  record: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
  sourcePath: string | undefined,
  basePointer: string,
): Problem[] => Object.keys(record)
  .filter((key) => !allowed.includes(key))
  .sort(compareOrdinal)
  .map((key) => diagnostic(code, `Unknown authored field is not allowed: ${key}`, sourcePath, pointer(basePointer, key)));

const normalizedKey = (value: string): string => normalizeSymbolicKey(value);

const referenceKey = (value: string): string => {
  const parsed = normalizeSymbolicReference(value);
  return parsed.key;
};

interface SymbolicResult {
  value?: string;
  key?: string;
  namespace?: string;
  problems: Problem[];
}

const normalizeSymbolic = (
  value: unknown,
  namespace: string,
  sourcePath: string | undefined,
  jsonPointer: string,
  code: string = GATE_CONTENT_CODES.SYMBOLIC_REFERENCE_INVALID,
): SymbolicResult => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return { problems: [diagnostic(GATE_CONTENT_CODES.NUMERIC_ID_FORBIDDEN, 'Authored Gate content uses symbolic IDs, not numeric or composite IDs', sourcePath, jsonPointer)] };
  }
  if (typeof value !== 'string' || !value.trim()) {
    return { problems: [diagnostic(code, 'A non-empty symbolic reference is required', sourcePath, jsonPointer)] };
  }
  const raw = value.trim();
  if (/^\d+$/u.test(raw)) {
    return { problems: [diagnostic(GATE_CONTENT_CODES.NUMERIC_ID_FORBIDDEN, 'Authored Gate content uses symbolic IDs, not numeric or composite IDs', sourcePath, jsonPointer)] };
  }
  try {
    const parsed = normalizeSymbolicReference(raw);
    if (parsed.namespace && parsed.namespace !== namespace) {
      return {
        problems: [diagnostic(
          GATE_CONTENT_CODES.SYMBOLIC_NAMESPACE_INVALID,
          `Expected ${namespace}: reference, received ${parsed.namespace}:`,
          sourcePath,
          jsonPointer,
        )],
      };
    }
    if (/^\d+$/u.test(parsed.key)) {
      return { problems: [diagnostic(GATE_CONTENT_CODES.NUMERIC_ID_FORBIDDEN, 'Numeric symbolic keys are not authored IDs', sourcePath, jsonPointer)] };
    }
    const key = normalizedKey(parsed.key);
    return { value: `${namespace}:${key}`, key, namespace, problems: [] };
  } catch (error) {
    const message = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
    return { problems: [diagnostic(code, message || 'Invalid symbolic reference', sourcePath, jsonPointer)] };
  }
};

const normalizeAnyReference = (
  value: unknown,
  sourcePath: string | undefined,
  jsonPointer: string,
): SymbolicResult => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return { problems: [diagnostic(GATE_CONTENT_CODES.NUMERIC_ID_FORBIDDEN, 'Numeric or composite IDs are not authored references', sourcePath, jsonPointer)] };
  }
  if (typeof value !== 'string' || !value.trim()) {
    return { problems: [diagnostic(GATE_CONTENT_CODES.SYMBOLIC_REFERENCE_INVALID, 'A non-empty symbolic reference is required', sourcePath, jsonPointer)] };
  }
  const raw = value.trim();
  if (/^\d+$/u.test(raw)) {
    return { problems: [diagnostic(GATE_CONTENT_CODES.NUMERIC_ID_FORBIDDEN, 'Numeric or composite IDs are not authored references', sourcePath, jsonPointer)] };
  }
  try {
    const parsed = normalizeSymbolicReference(raw);
    if (/^\d+$/u.test(parsed.key)) {
      return { problems: [diagnostic(GATE_CONTENT_CODES.NUMERIC_ID_FORBIDDEN, 'Numeric symbolic keys are not authored references', sourcePath, jsonPointer)] };
    }
    return { value: parsed.normalized, key: parsed.key, namespace: parsed.namespace, problems: [] };
  } catch (error) {
    const message = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
    return { problems: [diagnostic(GATE_CONTENT_CODES.SYMBOLIC_REFERENCE_INVALID, message || 'Invalid symbolic reference', sourcePath, jsonPointer)] };
  }
};

const parseLocalizationReference = (
  value: unknown,
  sourcePath: string | undefined,
  jsonPointer: string,
  required: boolean,
): { value?: GateLocalizationReference; problems: Problem[] } => {
  if (value === undefined || value === null) {
    return required
      ? { problems: [diagnostic(GATE_CONTENT_CODES.LOCALIZATION_REFERENCE_MISSING, 'A localization key reference is required', sourcePath, jsonPointer)] }
      : { problems: [] };
  }
  const record = isRecord(value) ? value : undefined;
  const rawKey = typeof value === 'string'
    ? value
    : record?.key ?? record?.ref ?? record?.id;
  if (typeof rawKey !== 'string' || !rawKey.trim()) {
    return { problems: [diagnostic(GATE_CONTENT_CODES.LOCALIZATION_REFERENCE_INVALID, 'Localization references require a stable key', sourcePath, jsonPointer)] };
  }
  try {
    const key = normalizeLocalizationKey(rawKey);
    const language = record && typeof record.language === 'string' ? record.language : undefined;
    return {
      value: { key, ...(language ? { language } : {}) },
      problems: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { problems: [diagnostic(GATE_CONTENT_CODES.LOCALIZATION_REFERENCE_INVALID, message, sourcePath, jsonPointer)] };
  }
};

const parseRegulationReference = (
  value: unknown,
  sourcePath: string | undefined,
  jsonPointer: string,
): { value?: string; problems: Problem[] } => {
  if (value === undefined || value === null) return { problems: [] };
  if (typeof value !== 'string' || !value.trim()) {
    return { problems: [diagnostic(GATE_CONTENT_CODES.REGULATION_REF_INVALID, 'regulation must be a non-empty symbolic regulation:<key> reference', sourcePath, jsonPointer)] };
  }
  const raw = value.trim();
  if (/^\d+$/u.test(raw)) {
    return { problems: [diagnostic(GATE_CONTENT_CODES.REGULATION_REF_INVALID, 'regulation must be symbolic, not a numeric target ID', sourcePath, jsonPointer)] };
  }
  try {
    const parsed = normalizeSymbolicReference(raw);
    if (parsed.namespace !== 'regulation') {
      return { problems: [diagnostic(GATE_CONTENT_CODES.REGULATION_REF_NAMESPACE_INVALID, 'regulation must use the regulation: namespace', sourcePath, jsonPointer)] };
    }
    return { value: parsed.normalized, problems: [] };
  } catch (error) {
    const message = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
    return { problems: [diagnostic(GATE_CONTENT_CODES.REGULATION_REF_INVALID, message || 'Invalid regulation reference', sourcePath, jsonPointer)] };
  }
};

const parseTargetExtension = (
  value: unknown,
  sourcePath: string | undefined,
  jsonPointer: string,
): { value?: GateTargetExtension; problems: Problem[] } => {
  if (value === undefined) return { problems: [] };
  if (!isRecord(value)) return { problems: [diagnostic(GATE_CONTENT_CODES.TARGET_EXTENSION_INVALID, 'target must be an object', sourcePath, jsonPointer)] };
  const problems = unknownKeys(value, ['ygomaster'], GATE_CONTENT_CODES.TARGET_EXTENSION_UNKNOWN, sourcePath, jsonPointer);
  const ygomaster = value.ygomaster;
  if (!isRecord(ygomaster)) {
    problems.push(diagnostic(GATE_CONTENT_CODES.TARGET_EXTENSION_INVALID, 'target.ygomaster must be an object', sourcePath, pointer(jsonPointer, 'ygomaster')));
    return { problems };
  }
  return { value: { ygomaster: clone(ygomaster) as JsonObject }, problems };
};

const forbiddenTargetKeys = new Set([
  'id', 'parent_id', 'parent_gate', 'parent_chapter', 'view_gate', 'clear_chapter',
  'unlock_id', 'npc_id', 'mydeck_set_id', 'set_id', 'reward', 'unlock', 'chapter', 'begin_sn',
]);

const validateTargetOverrides = (
  extension: GateTargetExtension | undefined,
  sourcePath: string | undefined,
  jsonPointer: string,
): Problem[] => extension
  ? Object.keys(extension.ygomaster)
    .filter((key) => forbiddenTargetKeys.has(key))
    .sort(compareOrdinal)
    .map((key) => diagnostic(GATE_CONTENT_CODES.TARGET_OVERRIDE_FORBIDDEN, `target.ygomaster cannot override generated field: ${key}`, sourcePath, pointer(`${jsonPointer}/ygomaster`, key)))
  : [];

const normalizeDeckReference = (
  value: unknown,
  sourcePath: string | undefined,
  jsonPointer: string,
): { value?: string; problems: Problem[] } => {
  if (typeof value !== 'string' || !value.trim()) return { problems: [diagnostic(GATE_CONTENT_CODES.DECK_REFERENCE_INVALID, 'Deck reference must be a non-empty relative path', sourcePath, jsonPointer)] };
  const raw = value.trim().replace(/\\/gu, '/');
  const segments = raw.split('/');
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:\//u.test(raw) || raw.includes('\0') || segments.includes('..') || segments.some((segment) => !segment || segment === '.')) {
    return { problems: [diagnostic(GATE_CONTENT_CODES.DECK_REFERENCE_INVALID, `Deck reference must stay inside authored content: ${value}`, sourcePath, jsonPointer)] };
  }
  return { value: segments.join('/'), problems: [] };
};

const normalizeMode = (value: unknown): GateUnlockMode | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'or' || normalized === 'any' || normalized === 'chapter-or') return 'or';
  if (normalized === 'and' || normalized === 'all' || normalized === 'chapter-and') return 'and';
  return undefined;
};

const normalizePlayerMode = (value: unknown): GatePlayerMode | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[_ -]+/gu, '');
  if (normalized === 'mydeck' || normalized === 'player' || normalized === 'owned') return 'mydeck';
  if (normalized === 'rental' || normalized === 'loaner') return 'rental';
  if (normalized === 'both' || normalized === 'either') return 'both';
  return undefined;
};

const referenceValues = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && (value.ref !== undefined || value.target !== undefined || value.chapter !== undefined)) {
    return [value.ref ?? value.target ?? value.chapter];
  }
  if (value === undefined || value === null) return [];
  return [value];
};

const parseUnlockDefinition = (
  value: unknown,
  sourcePath: string | undefined,
  jsonPointer: string,
): { value?: GateUnlockDefinition; problems: Problem[] } => {
  if (value === undefined || value === null) return { problems: [] };
  const problems: Problem[] = [];
  const record = isRecord(value) ? value : undefined;
  if (record) {
    problems.push(...unknownKeys(record, ['mode', 'type', 'refs', 'chapters', 'chapterRefs', 'targets', 'packs', 'packRefs', 'packUnlocks'], GATE_CONTENT_CODES.FIELD_UNKNOWN, sourcePath, jsonPointer));
  }
  const mode = normalizeMode(record?.mode ?? record?.type ?? 'or');
  if (!mode) problems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_MODE_INVALID, 'Unlock mode must be or or and', sourcePath, pointer(jsonPointer, 'mode')));
  const rawRefs = record ? (record.refs ?? record.chapters ?? record.chapterRefs ?? record.targets) : value;
  const rawPacks = record?.packs ?? record?.packRefs ?? record?.packUnlocks;
  const chapterRefs: string[] = [];
  const packRefs: string[] = [];
  referenceValues(rawRefs).forEach((raw, index) => {
    const parsed = normalizeAnyReference(raw, sourcePath, pointer(`${jsonPointer}/refs`, index));
    problems.push(...parsed.problems);
    if (!parsed.value) return;
    if (parsed.namespace === 'pack' || parsed.namespace === 'shop') packRefs.push(parsed.value);
    else if (parsed.namespace && parsed.namespace !== 'chapter') problems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_REF_INVALID, `Unlock reference must target a chapter or pack, received ${parsed.namespace}:`, sourcePath, pointer(`${jsonPointer}/refs`, index)));
    else chapterRefs.push(`chapter:${parsed.key || referenceKey(parsed.value)}`);
  });
  referenceValues(rawPacks).forEach((raw, index) => {
    const parsed = normalizeAnyReference(raw, sourcePath, pointer(`${jsonPointer}/packRefs`, index));
    problems.push(...parsed.problems);
    if (!parsed.value) return;
    if (parsed.namespace !== 'pack' && parsed.namespace !== 'shop') {
      problems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_REF_INVALID, 'Pack unlock references must use pack: or shop: namespace', sourcePath, pointer(`${jsonPointer}/packRefs`, index)));
    } else packRefs.push(parsed.value);
  });
  if (problems.length) return { problems };
  return { value: { mode: mode || 'or', chapterRefs, packRefs }, problems };
};

const parseRewardDefinitions = (
  value: unknown,
  sourcePath: string | undefined,
  jsonPointer: string,
): { value: GateRewardDefinition[]; problems: Problem[] } => {
  if (value === undefined || value === null) return { value: [], problems: [] };
  const rawItems = isRecord(value) && Array.isArray(value.items) ? value.items : value;
  if (!Array.isArray(rawItems)) return { value: [], problems: [diagnostic(GATE_CONTENT_CODES.REWARD_INVALID, 'rewards must be an array or an object with items', sourcePath, jsonPointer)] };
  const problems: Problem[] = [];
  const rewards: GateRewardDefinition[] = [];
  rawItems.forEach((raw, index) => {
    const itemPointer = pointer(jsonPointer, index);
    if (!isRecord(raw)) {
      problems.push(diagnostic(GATE_CONTENT_CODES.REWARD_INVALID, 'Reward item must be an object', sourcePath, itemPointer));
      return;
    }
    problems.push(...unknownKeys(raw, ['kind', 'type', 'ref', 'key', 'amount', 'count', 'quantity', 'id'], GATE_CONTENT_CODES.REWARD_INVALID, sourcePath, itemPointer));
    const kindRaw = raw.kind ?? raw.type;
    const kind = typeof kindRaw === 'string' ? kindRaw.trim().toLowerCase() : '';
    if (kind !== 'gem' && kind !== 'card' && kind !== 'structure' && kind !== 'pack') {
      problems.push(diagnostic(GATE_CONTENT_CODES.REWARD_KIND_INVALID, `Unsupported reward kind: ${String(kindRaw)}`, sourcePath, pointer(itemPointer, 'kind')));
      return;
    }
    const rawAmount = raw.amount ?? raw.count ?? raw.quantity;
    const amount = rawAmount === undefined ? 1 : rawAmount;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
      problems.push(diagnostic(GATE_CONTENT_CODES.REWARD_AMOUNT_INVALID, 'Reward amount must be a positive safe integer', sourcePath, pointer(itemPointer, 'amount')));
      return;
    }
    let ref: string | undefined;
    if (kind !== 'gem') {
      const rawRef = raw.ref ?? raw.key;
      if (rawRef === undefined) {
        problems.push(diagnostic(GATE_CONTENT_CODES.REWARD_REF_MISSING, `Reward kind ${kind} requires a symbolic ref`, sourcePath, pointer(itemPointer, 'ref')));
      } else {
        const expectedNamespace = kind === 'card' ? 'card' : kind === 'structure' ? 'structure' : 'pack';
        const parsed = normalizeAnyReference(rawRef, sourcePath, pointer(itemPointer, 'ref'));
        problems.push(...parsed.problems);
        if (parsed.value) {
          if (kind === 'pack') {
            if (parsed.namespace !== 'pack' && parsed.namespace !== 'shop') problems.push(diagnostic(GATE_CONTENT_CODES.REWARD_REF_INVALID, 'Pack rewards require pack: or shop: namespace', sourcePath, pointer(itemPointer, 'ref')));
          } else if (parsed.namespace && parsed.namespace !== expectedNamespace) {
            problems.push(diagnostic(GATE_CONTENT_CODES.REWARD_REF_INVALID, `Reward ref must use ${expectedNamespace}: namespace`, sourcePath, pointer(itemPointer, 'ref')));
          }
          ref = `${expectedNamespace}:${parsed.key || referenceKey(parsed.value)}`;
        }
      }
    }
    let rewardKey: string | undefined;
    if (raw.id !== undefined) {
      const parsed = normalizeSymbolic(raw.id, 'reward', sourcePath, pointer(itemPointer, 'id'), GATE_CONTENT_CODES.REWARD_ID_INVALID);
      problems.push(...parsed.problems);
      rewardKey = parsed.key;
    }
    if (!problems.some((problem) => problem.jsonPointer === itemPointer)) rewards.push({ kind, ...(ref ? { ref } : {}), amount, ...(rewardKey ? { rewardKey } : {}) });
  });
  return { value: rewards, problems };
};

const parseDuelDefinition = (
  value: unknown,
  chapterRecord: Record<string, unknown>,
  sourcePath: string | undefined,
  jsonPointer: string,
  required: boolean,
): { value?: GateDuelDefinition; problems: Problem[] } => {
  const raw = isRecord(value) ? value : chapterRecord;
  if (value !== undefined && !isRecord(value)) return { problems: [diagnostic(GATE_CONTENT_CODES.DUEL_INVALID, 'duel must be an object', sourcePath, jsonPointer)] };
  const problems: Problem[] = [];
  if (value !== undefined) problems.push(...unknownKeys(raw, ['cpuDeck', 'cpu_deck', 'rentalDeck', 'rental_deck', 'playerDeck', 'player_deck', 'playerMode', 'player_mode', 'playerNameKey', 'cpuNameKey', 'target'], GATE_CONTENT_CODES.DUEL_INVALID, sourcePath, jsonPointer));
  const cpuRaw = raw.cpuDeck ?? raw.cpu_deck;
  const rentalRaw = raw.rentalDeck ?? raw.rental_deck;
  const playerRaw = raw.playerDeck ?? raw.player_deck;
  const playerModeRaw = raw.playerMode ?? raw.player_mode;
  const cpuDeck = normalizeDeckReference(cpuRaw, sourcePath, pointer(jsonPointer, value !== undefined ? 'cpuDeck' : 'cpu_deck'));
  problems.push(...cpuDeck.problems);
  const rentalDeck = rentalRaw === undefined ? { problems: [] as Problem[] } : normalizeDeckReference(rentalRaw, sourcePath, pointer(jsonPointer, 'rentalDeck'));
  problems.push(...rentalDeck.problems);
  const playerDeck = playerRaw === undefined ? { problems: [] as Problem[] } : normalizeDeckReference(playerRaw, sourcePath, pointer(jsonPointer, 'playerDeck'));
  problems.push(...playerDeck.problems);
  const playerMode = normalizePlayerMode(playerModeRaw);
  if (!playerMode) problems.push(diagnostic(playerModeRaw === undefined ? GATE_CONTENT_CODES.DUEL_PLAYER_MODE_MISSING : GATE_CONTENT_CODES.DUEL_PLAYER_MODE_INVALID, 'Duel playerMode must be mydeck, rental, or both', sourcePath, pointer(jsonPointer, 'playerMode')));
  if (!cpuDeck.value && required) problems.push(diagnostic(GATE_CONTENT_CODES.DUEL_CPU_DECK_MISSING, 'Duel chapter requires a CPU deck reference', sourcePath, pointer(jsonPointer, 'cpuDeck')));
  if ((playerMode === 'rental' || playerMode === 'both') && !rentalDeck.value) problems.push(diagnostic(GATE_CONTENT_CODES.DUEL_RENTAL_DECK_MISSING, 'Rental or both player mode requires a rental deck reference', sourcePath, pointer(jsonPointer, 'rentalDeck')));
  const playerName = parseLocalizationReference(raw.playerNameKey, sourcePath, pointer(jsonPointer, 'playerNameKey'), false);
  const cpuName = parseLocalizationReference(raw.cpuNameKey, sourcePath, pointer(jsonPointer, 'cpuNameKey'), false);
  problems.push(...playerName.problems, ...cpuName.problems);
  const target = parseTargetExtension(raw.target, sourcePath, pointer(jsonPointer, 'target'));
  problems.push(...target.problems, ...validateTargetOverrides(target.value, sourcePath, pointer(jsonPointer, 'target')));
  if (problems.length) return { problems };
  return {
    value: {
      cpuDeck: cpuDeck.value || '',
      ...(rentalDeck.value ? { rentalDeck: rentalDeck.value } : {}),
      ...(playerDeck.value ? { playerDeck: playerDeck.value } : {}),
      playerMode: playerMode || 'rental',
      ...(playerName.value ? { playerNameKey: playerName.value } : {}),
      ...(cpuName.value ? { cpuNameKey: cpuName.value } : {}),
      ...(target.value ? { target: target.value } : {}),
    },
    problems,
  };
};

const parseChapter = (
  raw: unknown,
  index: number,
  sourcePath: string | undefined,
  jsonPointer: string,
): { value?: GateChapterDefinition; problems: Problem[] } => {
  if (!isRecord(raw)) return { problems: [diagnostic(GATE_CONTENT_CODES.CHAPTERS_INVALID, 'Chapter must be an object', sourcePath, jsonPointer)] };
  const problems = unknownKeys(raw, [
    'id', 'kind', 'type', 'parent', 'parentRef', 'required', 'entry', 'descriptionKey', 'descriptionRef', 'nameKey', 'nameRef', 'localization',
    'duel', 'cpuDeck', 'cpu_deck', 'rentalDeck', 'rental_deck', 'playerDeck', 'player_deck', 'playerMode', 'player_mode', 'playerNameKey', 'cpuNameKey',
    'rewards', 'reward', 'rewardId', 'unlock', 'unlocks', 'packUnlock', 'packUnlocks', 'unlockPack', 'unlockSecrets', 'unlockSecretRefs', 'target',
  ], GATE_CONTENT_CODES.CHAPTER_FIELD_UNKNOWN, sourcePath, jsonPointer);
  const idRaw = raw.id;
  const id = normalizeSymbolic(
    idRaw,
    'chapter',
    sourcePath,
    pointer(jsonPointer, 'id'),
    idRaw === undefined ? GATE_CONTENT_CODES.CHAPTER_ID_REQUIRED : GATE_CONTENT_CODES.CHAPTER_ID_INVALID,
  );
  problems.push(...id.problems);
  const kindRaw = raw.kind ?? raw.type;
  const kindText = typeof kindRaw === 'string' ? kindRaw.trim().toLowerCase() : '';
  const kind = kindText === 'duel' || kindText === 'reward' || kindText === 'unlock' ? kindText as GateChapterKind : undefined;
  if (!kind) problems.push(diagnostic(kindRaw === undefined ? GATE_CONTENT_CODES.CHAPTER_KIND_MISSING : GATE_CONTENT_CODES.CHAPTER_KIND_INVALID, 'Chapter kind must be duel, reward, or unlock', sourcePath, pointer(jsonPointer, 'kind')));
  const parentRaw = raw.parent ?? raw.parentRef;
  let parent: string | undefined;
  if (parentRaw !== undefined) {
    const parentResult = normalizeSymbolic(parentRaw, 'chapter', sourcePath, pointer(jsonPointer, 'parent'), GATE_CONTENT_CODES.CHAPTER_PARENT_INVALID);
    problems.push(...parentResult.problems);
    parent = parentResult.value;
  }
  const required = raw.required === undefined ? true : raw.required;
  const entry = raw.entry === undefined ? false : raw.entry;
  if (typeof required !== 'boolean') problems.push(diagnostic(GATE_CONTENT_CODES.CHAPTER_REQUIRED_INVALID, 'Chapter required must be boolean', sourcePath, pointer(jsonPointer, 'required')));
  if (typeof entry !== 'boolean') problems.push(diagnostic(GATE_CONTENT_CODES.CHAPTER_REQUIRED_INVALID, 'Chapter entry must be boolean', sourcePath, pointer(jsonPointer, 'entry')));
  const localization = isRecord(raw.localization) ? raw.localization : undefined;
  const description = parseLocalizationReference(raw.descriptionKey ?? raw.descriptionRef ?? localization?.description, sourcePath, pointer(jsonPointer, 'descriptionKey'), true);
  const name = parseLocalizationReference(raw.nameKey ?? raw.nameRef ?? localization?.name, sourcePath, pointer(jsonPointer, 'nameKey'), false);
  problems.push(...description.problems, ...name.problems);
  const duel = parseDuelDefinition(raw.duel, raw, sourcePath, pointer(jsonPointer, 'duel'), kind === 'duel');
  if (kind === 'duel') problems.push(...duel.problems);
  else if (raw.duel !== undefined || raw.cpuDeck !== undefined || raw.cpu_deck !== undefined) problems.push(diagnostic(GATE_CONTENT_CODES.DUEL_INVALID, 'Only duel chapters may declare duel deck fields', sourcePath, pointer(jsonPointer, 'duel')));
  const rewards = parseRewardDefinitions(raw.rewards ?? raw.reward, sourcePath, pointer(jsonPointer, 'rewards'));
  problems.push(...rewards.problems);
  let rewardKey: string | undefined;
  if (raw.rewardId !== undefined) {
    const rewardId = normalizeSymbolic(raw.rewardId, 'reward', sourcePath, pointer(jsonPointer, 'rewardId'), GATE_CONTENT_CODES.REWARD_ID_INVALID);
    problems.push(...rewardId.problems);
    rewardKey = rewardId.key;
  }
  const unlock = parseUnlockDefinition(raw.unlock ?? raw.unlocks, sourcePath, pointer(jsonPointer, 'unlock'));
  problems.push(...unlock.problems);
  const packUnlock = parseUnlockDefinition(raw.packUnlock ?? raw.packUnlocks ?? raw.unlockPack, sourcePath, pointer(jsonPointer, 'packUnlock'));
  problems.push(...packUnlock.problems);
  if (packUnlock.value) {
    if (unlock.value) unlock.value.packRefs.push(...packUnlock.value.chapterRefs, ...packUnlock.value.packRefs);
    else if (unlock.value === undefined) unlock.value = { mode: 'or', chapterRefs: [], packRefs: [...packUnlock.value.chapterRefs, ...packUnlock.value.packRefs] };
  }
  if (kind === 'reward' && rewards.value.length === 0) problems.push(diagnostic(GATE_CONTENT_CODES.REWARD_REQUIRED, 'Reward chapter requires at least one symbolic reward', sourcePath, pointer(jsonPointer, 'rewards')));
  if (kind === 'unlock' && !unlock.value?.chapterRefs.length && !unlock.value?.packRefs.length) problems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_CHAPTER_TARGET_MISSING, 'Unlock chapter requires at least one unlock target', sourcePath, pointer(jsonPointer, 'unlock')));
  const target = parseTargetExtension(raw.target, sourcePath, pointer(jsonPointer, 'target'));
  problems.push(...target.problems, ...validateTargetOverrides(target.value, sourcePath, pointer(jsonPointer, 'target')));
  if (unlock.value?.packRefs.length || rewards.value.some((reward) => reward.kind === 'pack')) {
    problems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_SECRET_UNSUPPORTED, 'Pack unlock content is blocked by the current target contract', sourcePath, pointer(jsonPointer, 'unlock')));
  }
  const ygoTarget = target.value?.ygomaster;
  if (ygoTarget && ['unlock_secret', 'unlock_pack', 'unlockSecrets', 'secretType', 'secret_type', 'unlock_secrets'].some((key) => Object.prototype.hasOwnProperty.call(ygoTarget, key))) {
    problems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_SECRET_UNSUPPORTED, 'target.ygomaster pack unlock fields are unsupported by the current target contract', sourcePath, pointer(jsonPointer, 'target/ygomaster')));
  }
  const unlockSecrets: string[] = [];
  const rawUnlockSecrets = raw.unlockSecrets ?? raw.unlockSecretRefs;
  if (rawUnlockSecrets !== undefined) {
    if (kind !== 'duel') problems.push(diagnostic(GATE_CONTENT_CODES.DUEL_INVALID, 'unlockSecrets is supported only on Duel chapters', sourcePath, pointer(jsonPointer, 'unlockSecrets')));
    referenceValues(rawUnlockSecrets).forEach((value, secretIndex) => {
      const parsed = normalizeAnyReference(value, sourcePath, pointer(`${jsonPointer}/unlockSecrets`, secretIndex));
      problems.push(...parsed.problems);
      if (!parsed.value) return;
      if (parsed.namespace !== 'shop') {
        problems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_REF_INVALID, 'unlockSecrets references must use the shop: namespace', sourcePath, pointer(`${jsonPointer}/unlockSecrets`, secretIndex)));
        return;
      }
      if (!unlockSecrets.includes(parsed.value)) unlockSecrets.push(parsed.value);
    });
  }
  if (problems.length) return { problems };
  const chapter: GateChapterDefinition = {
    id: id.value || '',
    key: id.key || '',
    kind: kind || 'unlock',
    ...(parent ? { parent } : {}),
    required: required as boolean,
    entry: entry as boolean,
    descriptionKey: description.value as GateLocalizationReference,
    ...(name.value ? { nameKey: name.value } : {}),
    ...(duel.value ? { duel: duel.value } : {}),
    rewards: rewards.value.map((reward) => rewardKey && !reward.rewardKey ? { ...reward, rewardKey } : reward),
    ...(unlock.value ? { unlock: unlock.value } : {}),
    ...(unlockSecrets.length ? { unlockSecrets } : {}),
    ...(target.value ? { target: target.value } : {}),
    sourceIndex: index,
  };
  return { value: chapter, problems };
};

const parseGateDefinition = (
  payload: unknown,
  sourcePath: string | undefined,
): { value?: GateDefinition; problems: Problem[] } => {
  if (!isRecord(payload)) return { problems: [diagnostic(GATE_CONTENT_CODES.ENVELOPE_INVALID, 'Gate payload must be an object', sourcePath, '/payload')] };
  const problems = unknownKeys(payload, [
    'id', 'nameKey', 'nameRef', 'descriptionKey', 'descriptionRef', 'localization', 'priority', 'parent', 'parentRef', 'parentGate', 'view', 'viewRef', 'viewGate',
    'goal', 'goalChapter', 'clearChapter', 'regulation', 'deckFolder', 'unlock', 'packUnlock', 'packUnlocks', 'unlockPack', 'chapters', 'target',
  ], GATE_CONTENT_CODES.FIELD_UNKNOWN, sourcePath, '/payload');
  const id = normalizeSymbolic(
    payload.id,
    'gate',
    sourcePath,
    '/payload/id',
    payload.id === undefined ? GATE_CONTENT_CODES.ID_MISSING : GATE_CONTENT_CODES.ID_INVALID,
  );
  problems.push(...id.problems);
  const localization = isRecord(payload.localization) ? payload.localization : undefined;
  const name = parseLocalizationReference(payload.nameKey ?? payload.nameRef ?? localization?.name, sourcePath, '/payload/nameKey', true);
  const description = parseLocalizationReference(payload.descriptionKey ?? payload.descriptionRef ?? localization?.description, sourcePath, '/payload/descriptionKey', true);
  problems.push(...name.problems, ...description.problems);
  const priority = payload.priority === undefined ? 0 : payload.priority;
  if (typeof priority !== 'number' || !Number.isSafeInteger(priority) || priority < 0) problems.push(diagnostic(GATE_CONTENT_CODES.ID_INVALID, 'Gate priority must be a non-negative safe integer', sourcePath, '/payload/priority'));
  const parentRaw = payload.parent ?? payload.parentRef ?? payload.parentGate;
  let parent: string | undefined;
  if (parentRaw !== undefined) {
    const parsed = normalizeSymbolic(parentRaw, 'gate', sourcePath, '/payload/parent', GATE_CONTENT_CODES.PARENT_INVALID);
    problems.push(...parsed.problems);
    parent = parsed.value;
  }
  const viewRaw = payload.view ?? payload.viewRef ?? payload.viewGate;
  let view: string | undefined;
  if (viewRaw !== undefined) {
    const parsed = normalizeSymbolic(viewRaw, 'gate', sourcePath, '/payload/view', GATE_CONTENT_CODES.VIEW_INVALID);
    problems.push(...parsed.problems);
    view = parsed.value;
  }
  const goalRaw = payload.goal ?? payload.goalChapter ?? payload.clearChapter;
  let goal: string | undefined;
  if (goalRaw !== undefined) {
    const rawGoal = isRecord(goalRaw) ? goalRaw.chapter ?? goalRaw.chapterRef ?? goalRaw.ref : goalRaw;
    const parsed = normalizeSymbolic(rawGoal, 'chapter', sourcePath, '/payload/goal', GATE_CONTENT_CODES.GOAL_INVALID);
    problems.push(...parsed.problems);
    goal = parsed.value;
  } else problems.push(diagnostic(GATE_CONTENT_CODES.GOAL_MISSING, 'Gate goal chapter is required', sourcePath, '/payload/goal'));
  const regulation = parseRegulationReference(payload.regulation, sourcePath, '/payload/regulation');
  problems.push(...regulation.problems);
  const deckFolder = payload.deckFolder === undefined
    ? { problems: [] as Problem[] }
    : normalizeDeckFolderReference(payload.deckFolder, sourcePath, '/payload/deckFolder');
  problems.push(...deckFolder.problems);
  const unlock = parseUnlockDefinition(payload.unlock, sourcePath, '/payload/unlock');
  problems.push(...unlock.problems);
  const packUnlock = parseUnlockDefinition(payload.packUnlock ?? payload.packUnlocks ?? payload.unlockPack, sourcePath, '/payload/packUnlock');
  problems.push(...packUnlock.problems);
  if (packUnlock.value) {
    if (unlock.value) unlock.value.packRefs.push(...packUnlock.value.chapterRefs, ...packUnlock.value.packRefs);
    else unlock.value = { mode: 'or', chapterRefs: [], packRefs: [...packUnlock.value.chapterRefs, ...packUnlock.value.packRefs] };
  }
  if (unlock.value?.packRefs.length) problems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_SECRET_UNSUPPORTED, 'Pack unlock content is blocked by the current target contract', sourcePath, '/payload/unlock'));
  const chaptersRaw = payload.chapters;
  if (!Array.isArray(chaptersRaw)) {
    problems.push(diagnostic(chaptersRaw === undefined ? GATE_CONTENT_CODES.CHAPTERS_MISSING : GATE_CONTENT_CODES.CHAPTERS_INVALID, 'Gate chapters must be an array', sourcePath, '/payload/chapters'));
  }
  const chapters: GateChapterDefinition[] = [];
  (Array.isArray(chaptersRaw) ? chaptersRaw : []).forEach((chapter, index) => {
    const parsed = parseChapter(chapter, index, sourcePath, pointer('/payload/chapters', index));
    problems.push(...parsed.problems);
    if (parsed.value) chapters.push(parsed.value);
  });
  const target = parseTargetExtension(payload.target, sourcePath, '/payload/target');
  problems.push(...target.problems, ...validateTargetOverrides(target.value, sourcePath, '/payload/target'));
  const ygoTarget = target.value?.ygomaster;
  if (ygoTarget && ['unlock_secret', 'unlock_pack', 'unlockSecrets', 'secretType', 'secret_type', 'unlock_secrets'].some((key) => Object.prototype.hasOwnProperty.call(ygoTarget, key))) {
    problems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_SECRET_UNSUPPORTED, 'target.ygomaster pack unlock fields are unsupported by the current target contract', sourcePath, '/payload/target/ygomaster'));
  }
  if (problems.length) return { problems };
  return {
    value: {
      id: id.value || '',
      key: id.key || '',
      ...(deckFolder.value ? { deckFolder: deckFolder.value } : {}),
      ...(regulation.value ? { regulation: regulation.value } : {}),
      priority: priority as number,
      nameKey: name.value as GateLocalizationReference,
      descriptionKey: description.value as GateLocalizationReference,
      ...(parent ? { parent } : {}),
      ...(view ? { view } : {}),
      ...(goal ? { goal } : {}),
      ...(unlock.value ? { unlock: unlock.value } : {}),
      chapters,
      ...(target.value ? { target: target.value } : {}),
    },
    problems,
  };
};

export const parseGateContent = (input: unknown, sourcePath?: string): GateContentParseResult => {
  let parsed: ParsedContentEnvelope<JsonObject>;
  try {
    parsed = parseContentEnvelopeWithSource<JsonObject>(input, { sourcePath, supportedVersion: GATE_CONTENT_FORMAT_VERSION });
  } catch (error) {
    if (error instanceof ContentFormatError) {
      return { problems: sortProblems(error.problems.map((entry) => ({ ...entry, code: entry.code.startsWith('CONTENT_') ? `GATE_${entry.code.slice('CONTENT_'.length)}` : entry.code }))) };
    }
    return { problems: [diagnostic(GATE_CONTENT_CODES.ENVELOPE_INVALID, String(error), sourcePath, '')] };
  }
  const problems: Problem[] = [];
  const root = parsed.raw;
  problems.push(...unknownKeys(root, ['formatVersion', 'kind', 'payload'], GATE_CONTENT_CODES.TOP_LEVEL_UNKNOWN, sourcePath, ''));
  if (parsed.envelope.kind !== GATE_CONTENT_KIND) problems.push(diagnostic(GATE_CONTENT_CODES.KIND_INVALID, `Gate content kind must be ${GATE_CONTENT_KIND}`, sourcePath, '/kind'));
  const gate = parseGateDefinition(parsed.envelope.payload, sourcePath);
  problems.push(...gate.problems);
  if (!gate.value) return { problems: sortProblems(problems) };
  const document: ParsedGateContent = {
    formatVersion: GATE_CONTENT_FORMAT_VERSION,
    parserVersion: GATE_CONTENT_PARSER_VERSION,
    kind: GATE_CONTENT_KIND,
    ...(sourcePath ? { sourcePath } : {}),
    original: parsed,
    gate: gate.value,
    diagnostics: sortProblems(problems),
    ok: problems.every((entry) => entry.severity === 'warning'),
  };
  return { document, problems: document.diagnostics };
};

export const parseGate = parseGateContent;
export const parseGateDocument = parseGateContent;
export const parseGateContentDocument = parseGateContent;

const problemIdentity = (entry: Problem): string => JSON.stringify([
  entry.code,
  entry.message,
  entry.sourcePath || entry.path || '',
  entry.line ?? 0,
  entry.column ?? 0,
  entry.endLine ?? 0,
  entry.endColumn ?? 0,
  entry.jsonPointer || '',
  entry.severity || 'error',
]);

const uniqueProblems = (problems: readonly Problem[]): Problem[] => {
  const seen = new Set<string>();
  return problems.filter((entry) => {
    const identity = problemIdentity(entry);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};

const documentDiagnostics = (document: ParsedGateContent): Problem[] => {
  const rootProblems = document.original && isRecord(document.original.raw)
    ? unknownKeys(document.original.raw, ['formatVersion', 'kind', 'payload'], GATE_CONTENT_CODES.TOP_LEVEL_UNKNOWN, document.sourcePath, '')
    : [];
  return uniqueProblems([...(document.diagnostics || []), ...rootProblems]);
};

const asDocument = (input: unknown, sourcePath?: string): { document?: ParsedGateContent; problems: Problem[] } => {
  if (isRecord(input) && 'gate' in input && isRecord(input.gate) && typeof input.formatVersion === 'number' && typeof input.parserVersion === 'number') {
    const document = input as unknown as ParsedGateContent;
    return { document, problems: documentDiagnostics(document) };
  }
  if (isRecord(input) && isRecord(input.document) && 'gate' in input.document) {
    const nested = asDocument(input.document, sourcePath);
    const outerProblems = Array.isArray(input.problems)
      ? input.problems.filter((entry): entry is Problem => isRecord(entry) && typeof entry.code === 'string')
      : [];
    return { document: nested.document, problems: uniqueProblems([...outerProblems, ...nested.problems]) };
  }
  return parseGateContent(input, sourcePath);
};

const collectDocuments = (input: unknown, options: GateValidationOptions): { documents: ParsedGateContent[]; problems: Problem[] } => {
  const values: unknown[] = [];
  if (Array.isArray(input)) values.push(...input);
  else if (isRecord(input) && Array.isArray(input.gates)) values.push(...input.gates);
  else if (isRecord(input) && Array.isArray(input.documents)) values.push(...input.documents);
  else values.push(input);
  values.push(...(options.documents || []), ...(options.gates || []));
  const documents: ParsedGateContent[] = [];
  const problems: Problem[] = [];
  values.forEach((value, index) => {
    const parsed = asDocument(value, `gate[${index}]`);
    problems.push(...parsed.problems);
    if (parsed.document) documents.push(parsed.document);
  });
  return { documents, problems };
};

const knownReferenceSet = (values: readonly string[] | undefined, namespace: string): Set<string> => {
  const result = new Set<string>();
  for (const value of values || []) {
    const parsed = normalizeAnyReference(value, undefined, '');
    if (parsed.value) result.add(parsed.namespace ? parsed.value : `${namespace}:${parsed.key}`);
  }
  return result;
};

interface GraphEdge {
  from: string;
  to: string;
}

const detectCycle = (edges: readonly GraphEdge[]): boolean => {
  const adjacency = new Map<string, string[]>();
  edges.forEach((edge) => adjacency.set(edge.from, [...(adjacency.get(edge.from) || []), edge.to]));
  const state = new Map<string, number>();
  const visit = (node: string): boolean => {
    if (state.get(node) === 1) return true;
    if (state.get(node) === 2) return false;
    state.set(node, 1);
    for (const child of adjacency.get(node) || []) if (visit(child)) return true;
    state.set(node, 2);
    return false;
  };
  return [...adjacency.keys()].sort(compareOrdinal).some(visit);
};

const validateLocalization = (
  document: ParsedGateContent,
  options: GateValidationOptions,
  problems: Problem[],
  warnings: Problem[],
): void => {
  if (!options.localization) return;
  const language = options.language || options.localization.fallbackLanguage;
  const fallbackLanguage = options.fallbackLanguage || options.localization.fallbackLanguage;
  const references: Array<{ reference: GateLocalizationReference; pointer: string }> = [
    { reference: document.gate.nameKey, pointer: '/payload/nameKey' },
    { reference: document.gate.descriptionKey, pointer: '/payload/descriptionKey' },
  ];
  document.gate.chapters.forEach((chapter, index) => {
    references.push({ reference: chapter.descriptionKey, pointer: `/payload/chapters/${index}/descriptionKey` });
    if (chapter.nameKey) references.push({ reference: chapter.nameKey, pointer: `/payload/chapters/${index}/nameKey` });
    if (chapter.duel?.playerNameKey) references.push({ reference: chapter.duel.playerNameKey, pointer: `/payload/chapters/${index}/duel/playerNameKey` });
    if (chapter.duel?.cpuNameKey) references.push({ reference: chapter.duel.cpuNameKey, pointer: `/payload/chapters/${index}/duel/cpuNameKey` });
  });
  references.forEach(({ reference, pointer: refPointer }) => {
    const result = resolveLocalization(options.localization as LocalizationCatalog, { ...reference, language }, { fallbackLanguage });
    result.problems.forEach((problem) => {
      const adjusted = { ...problem, sourcePath: document.sourcePath || problem.sourcePath, path: document.sourcePath || problem.path, jsonPointer: refPointer };
      if (adjusted.severity === 'warning') warnings.push(adjusted);
      else problems.push(adjusted);
    });
  });
};

const validateDeckReferences = (
  document: ParsedGateContent,
  options: GateValidationOptions,
  problems: Problem[],
): void => {
  if (!options.deckReferences) return;
  const known = new Set(options.deckReferences.map((entry) => entry.replace(/\\/gu, '/')));
  document.gate.chapters.forEach((chapter, index) => {
    const refs = [chapter.duel?.cpuDeck, chapter.duel?.rentalDeck, chapter.duel?.playerDeck].filter((entry): entry is string => Boolean(entry));
    refs.forEach((ref) => {
      if (!known.has(ref)) problems.push(diagnostic(GATE_CONTENT_CODES.DECK_REFERENCE_MISSING, `Deck reference does not resolve: ${ref}`, document.sourcePath, `/payload/chapters/${index}/duel`));
    });
  });
};

export const validateGateContent = (
  input: unknown,
  options: GateValidationOptions = {},
): GateValidationResult => {
  const collected = collectDocuments(input, options);
  const problems = [...collected.problems];
  const warnings: Problem[] = [];
  const documents = collected.documents;
  const gates = documents.map((document) => document.gate);
  const documentByGate = new Map<GateDefinition, ParsedGateContent>(documents.map((document) => [document.gate, document]));
  const gateById = new Map<string, GateDefinition>();
  const gateIds = knownReferenceSet(options.knownGateIds, 'gate');
  for (const gate of gates) {
    if (gateById.has(gate.id)) problems.push(diagnostic(GATE_CONTENT_CODES.ID_DUPLICATE, `Duplicate symbolic Gate key: ${gate.id}`, undefined, '/payload/id'));
    else gateById.set(gate.id, gate);
    gateIds.add(gate.id);
  }
  const chaptersById = new Map<string, { gate: GateDefinition; chapter: GateChapterDefinition }>();
  const chapterIds = knownReferenceSet(options.knownChapterIds, 'chapter');
  const parentEdges: GraphEdge[] = [];
  const unlockEdges: GraphEdge[] = [];
  const combinedEdges: GraphEdge[] = [];
  for (const gate of gates) {
    if (gate.parent) {
      if (gate.parent === gate.id) problems.push(diagnostic(GATE_CONTENT_CODES.PARENT_CYCLE, 'Gate cannot parent itself'));
      else if (!gateIds.has(gate.parent)) problems.push(diagnostic(GATE_CONTENT_CODES.PARENT_ORPHAN, `Gate parent does not exist: ${gate.parent}`));
      else {
        parentEdges.push({ from: gate.id, to: gate.parent });
        combinedEdges.push({ from: gate.id, to: gate.parent });
      }
    }
    if (gate.view && !gateIds.has(gate.view)) problems.push(diagnostic(GATE_CONTENT_CODES.VIEW_ORPHAN, `Gate view reference does not exist: ${gate.view}`));
    gate.chapters.forEach((chapter) => {
      if (chaptersById.has(chapter.id)) problems.push(diagnostic(GATE_CONTENT_CODES.CHAPTER_ID_DUPLICATE, `Duplicate symbolic chapter key: ${chapter.id}`));
      else chaptersById.set(chapter.id, { gate, chapter });
      chapterIds.add(chapter.id);
    });
  }
  for (const gate of gates) {
    if (gate.goal) {
      const goal = chaptersById.get(gate.goal);
      if (!goal) problems.push(diagnostic(GATE_CONTENT_CODES.GOAL_ORPHAN, `Gate goal chapter does not exist: ${gate.goal}`));
      else if (goal.gate.id !== gate.id) problems.push(diagnostic(GATE_CONTENT_CODES.GOAL_INVALID, `Gate goal must belong to the same Gate: ${gate.goal}`));
    } else problems.push(diagnostic(GATE_CONTENT_CODES.GOAL_MISSING, `Gate ${gate.id} requires a goal chapter`, undefined, '/payload/goal'));
    for (const chapter of gate.chapters) {
      const node = chapter.id;
      if (chapter.parent) {
        if (!chapterIds.has(chapter.parent)) problems.push(diagnostic(GATE_CONTENT_CODES.CHAPTER_PARENT_ORPHAN, `Chapter parent does not exist: ${chapter.parent}`));
        else if (!chaptersById.get(chapter.parent) || chaptersById.get(chapter.parent)?.gate.id !== gate.id) problems.push(diagnostic(GATE_CONTENT_CODES.CHAPTER_PARENT_ORPHAN, `Chapter parent must belong to the same Gate: ${chapter.parent}`));
        else {
          parentEdges.push({ from: node, to: chapter.parent });
          combinedEdges.push({ from: node, to: chapter.parent });
        }
      }
      for (const reference of chapter.unlock?.chapterRefs || []) {
        if (!chapterIds.has(reference)) problems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_REF_ORPHAN, `Unlock chapter does not exist: ${reference}`));
        else {
          unlockEdges.push({ from: node, to: reference });
          combinedEdges.push({ from: node, to: reference });
        }
      }
      for (const reference of chapter.unlock?.packRefs || []) problems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_SECRET_UNSUPPORTED, `Pack unlock is unsupported: ${reference}`));
    }
    for (const reference of gate.unlock?.chapterRefs || []) {
      if (!chapterIds.has(reference)) problems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_REF_ORPHAN, `Gate unlock chapter does not exist: ${reference}`));
      else {
        unlockEdges.push({ from: gate.id, to: reference });
        combinedEdges.push({ from: gate.id, to: reference });
      }
    }
    for (const reference of gate.unlock?.packRefs || []) problems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_SECRET_UNSUPPORTED, `Pack unlock is unsupported: ${reference}`));
    const document = documentByGate.get(gate);
    if (document) {
      validateLocalization(document, options, problems, warnings);
      validateDeckReferences(document, options, problems);
    }
  }
  validateDuelDeckProjections(gates, options.deckProjections, problems);
  if (detectCycle(parentEdges)) problems.push(diagnostic(GATE_CONTENT_CODES.PARENT_CYCLE, 'Gate/chapter parent graph contains a cycle'));
  if (detectCycle(unlockEdges)) problems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_GRAPH_CYCLE, 'Unlock graph contains a cycle'));
  if (detectCycle(combinedEdges)) problems.push(diagnostic(GATE_CONTENT_CODES.PARENT_UNLOCK_CYCLE, 'Combined parent and unlock graph contains a cycle'));
  for (const gate of gates) {
    const chapters = gate.chapters;
    const starts = chapters.filter((chapter) => chapter.entry).map((chapter) => chapter.id);
    const roots = starts.length ? starts : chapters.slice().sort((left, right) => compareOrdinal(left.id, right.id)).slice(0, 1).map((chapter) => chapter.id);
    const adjacency = new Map<string, string[]>();
    chapters.forEach((chapter) => adjacency.set(chapter.id, []));
    chapters.forEach((chapter) => {
      if (chapter.parent && adjacency.has(chapter.parent)) adjacency.set(chapter.parent, [...(adjacency.get(chapter.parent) || []), chapter.id]);
      for (const required of chapter.unlock?.chapterRefs || []) if (adjacency.has(required)) adjacency.set(required, [...(adjacency.get(required) || []), chapter.id]);
    });
    const reachable = new Set<string>();
    const queue = [...roots];
    while (queue.length) {
      const node = queue.shift() as string;
      if (reachable.has(node)) continue;
      reachable.add(node);
      queue.push(...(adjacency.get(node) || []));
    }
    chapters.filter((chapter) => chapter.required && !reachable.has(chapter.id)).forEach((chapter) => {
      problems.push(diagnostic(GATE_CONTENT_CODES.REQUIRED_UNREACHABLE, `Required chapter is unreachable from the Gate entry graph: ${chapter.id}`));
    });
  }
  const errorProblems = problems.filter((problem) => problem.severity !== 'warning');
  return { ok: errorProblems.length === 0, documents, gates, problems: sortProblems(errorProblems), warnings: sortProblems(warnings) };
};

export const validateGateGraph = validateGateContent;
export const validateGate = validateGateContent;

const assignmentFor = (registry: IdRegistry, namespace: keyof IdRegistry['namespaces'], key: string): number | undefined =>
  registry.namespaces[namespace].assignments[key]?.id;

const assignmentKey = (value: string): string => referenceKey(value);

const mapLookup = (value: ReadonlyMap<string, number> | Record<string, number> | undefined, ref: string): number | undefined => {
  if (!value) return undefined;
  const key = assignmentKey(ref);
  if (value instanceof Map) return value.get(ref) ?? value.get(key) ?? value.get(ref.replace(/^[^:]+:/u, ''));
  const record = value as Record<string, number>;
  return record[ref] ?? record[key] ?? record[ref.replace(/^[^:]+:/u, '')];
};

const projectionLookup = (value: ReadonlyMap<string, DeckIR> | Record<string, DeckIR> | undefined, ref: string): DeckIR | undefined => {
  if (!value) return undefined;
  const key = assignmentKey(ref);
  if (value instanceof Map) return value.get(ref) ?? value.get(key) ?? value.get(ref.replace(/^[^:]+:/u, ''));
  const record = value as Record<string, DeckIR>;
  return record[ref] ?? record[key] ?? record[ref.replace(/^[^:]+:/u, '')];
};

const outputDeckReference = (
  value: ReadonlyMap<string, string> | Record<string, string> | undefined,
  ref: string,
): string => {
  if (!value) return ref;
  if (value instanceof Map) return value.get(ref) || ref;
  return (value as Record<string, string>)[ref] || ref;
};

const deckProjectionIssue = (projection: DeckIR | undefined): 'invalid' | 'empty' | 'length-mismatch' | undefined => {
  if (!projection || !isRecord(projection)) return 'invalid';
  const parts = ['m', 'e', 's'] as const;
  if (!parts.every((part) => {
    const value = projection[part];
    return isRecord(value)
      && Array.isArray(value.ids)
      && value.ids.every((id) => typeof id === 'number' && Number.isSafeInteger(id))
      && Array.isArray(value.r)
      && value.r.every((rarity) => typeof rarity === 'number' && Number.isSafeInteger(rarity));
  })) return 'invalid';
  if (parts.some((part) => projection[part].ids.length !== projection[part].r.length)) return 'length-mismatch';
  return projection.m.ids.length > 0 ? undefined : 'empty';
};

const validateDuelDeckProjections = (
  gates: readonly GateDefinition[],
  projections: ReadonlyMap<string, DeckIR> | Record<string, DeckIR> | undefined,
  problems: Problem[],
): void => {
  const check = (
    chapter: GateChapterDefinition,
    reference: string | undefined,
    role: 'cpu' | 'rental' | 'player',
  ): void => {
    if (!reference) return;
    const projection = projectionLookup(projections, reference);
    if (!projection) {
      const code = role === 'cpu'
        ? GATE_CONTENT_CODES.DUEL_CPU_DECK_PROJECTION_MISSING
        : role === 'rental'
          ? GATE_CONTENT_CODES.DUEL_RENTAL_DECK_PROJECTION_MISSING
          : GATE_CONTENT_CODES.DUEL_PLAYER_DECK_PROJECTION_MISSING;
      problems.push(diagnostic(code, `Duel ${role} deck requires a resolved DeckIR projection: ${reference}`, undefined, `/payload/chapters/${chapter.sourceIndex}/duel`));
    } else if (deckProjectionIssue(projection) === 'length-mismatch') {
      problems.push(diagnostic(GATE_CONTENT_CODES.DUEL_DECK_PROJECTION_LENGTH_MISMATCH, `Duel ${role} deck projection ids and r arrays must have equal lengths: ${reference}`, undefined, `/payload/chapters/${chapter.sourceIndex}/duel`));
    } else if (deckProjectionIssue(projection)) {
      problems.push(diagnostic(GATE_CONTENT_CODES.DUEL_DECK_PROJECTION_EMPTY, `Duel ${role} deck projection is empty or malformed: ${reference}`, undefined, `/payload/chapters/${chapter.sourceIndex}/duel`));
    }
  };
  for (const gate of gates) {
    for (const chapter of gate.chapters) {
      if (chapter.kind !== 'duel' || !chapter.duel) continue;
      check(chapter, chapter.duel.cpuDeck, 'cpu');
      if (chapter.duel.playerMode === 'rental' || chapter.duel.playerMode === 'both') check(chapter, chapter.duel.rentalDeck, 'rental');
      if (chapter.duel.playerDeck) check(chapter, chapter.duel.playerDeck, 'player');
    }
  }
};

const targetNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const deckPartFromProjection = (projection: DeckIR | undefined, short: 'm' | 'e' | 's'): JsonObject => {
  const part = projection?.[short] || { ids: [], r: [] };
  return { CardIds: [...part.ids], Rare: [...part.r] };
};

const mergeTarget = (
  base: JsonObject,
  extension: GateTargetExtension | undefined,
): JsonObject => {
  const merged = extension ? { ...base, ...clone(extension.ygomaster) } : base;
  // `begin_sn` is reserved for authored Scenario scripts.  The current
  // compiler has no Scenario chapter kind, so every generated chapter must
  // remain non-Scenario even if an unvalidated IR object carries an override.
  if (Object.prototype.hasOwnProperty.call(base, 'begin_sn')) merged.begin_sn = '';
  return merged;
};

// YgoMaster's client groups Solo gates by this field.  The upstream server
// backfills category=1 when it is absent, but the client-facing runtime
// contract treats a missing category as an invisible gate.  Keep generated
// output explicit and allow an authored target extension to override it (for
// example, category=2 for the Challenges/Training tab used by other mods).
const SOLO_STORIES_CATEGORY = 1;
const SOLO_OPEN_DATE_EPOCH = -2208988800;

const localizationText = (
  reference: GateLocalizationReference | undefined,
  options: GateCompileOptions,
): { value: string; problems: Problem[]; warnings: Problem[] } => {
  if (!reference) return { value: '', problems: [], warnings: [] };
  if (!options.localization) return { value: reference.key, problems: [], warnings: [] };
  const result = resolveLocalization(options.localization, { ...reference, language: reference.language || options.language }, { fallbackLanguage: options.fallbackLanguage || options.localization.fallbackLanguage });
  return {
    value: result.value || '',
    problems: result.problems.filter((problem) => problem.severity !== 'warning'),
    warnings: result.problems.filter((problem) => problem.severity === 'warning'),
  };
};

const buildAllocationRequests = (
  gates: readonly GateDefinition[],
): { requests: { namespace: 'gate' | 'chapter' | 'reward' | 'unlock' | 'structure'; key: string; gateKey?: string }[]; rewardKeys: Map<string, string>; unlockKeys: Map<string, string> } => {
  const requests: { namespace: 'gate' | 'chapter' | 'reward' | 'unlock' | 'structure'; key: string; gateKey?: string }[] = [];
  const rewardKeys = new Map<string, string>();
  const unlockKeys = new Map<string, string>();
  gates.forEach((gate) => requests.push({ namespace: 'gate', key: gate.key }));
  gates.forEach((gate) => {
    gate.chapters.slice().sort((left, right) => compareOrdinal(left.key, right.key)).forEach((chapter) => {
      requests.push({ namespace: 'chapter', key: chapter.key, gateKey: gate.key });
      if (chapter.rewards.length) {
        const explicit = chapter.rewards.find((reward) => reward.rewardKey)?.rewardKey;
        const key = explicit || `${gate.key}.${chapter.key}.reward`;
        rewardKeys.set(chapter.id, key);
        requests.push({ namespace: 'reward', key });
        for (const reward of chapter.rewards) {
          if (reward.kind === 'structure' && reward.ref) {
            requests.push({ namespace: 'structure', key: assignmentKey(reward.ref) });
          }
        }
      }
      if (chapter.unlock?.chapterRefs.length) {
        const key = `${gate.key}.${chapter.key}.unlock`;
        unlockKeys.set(chapter.id, key);
        requests.push({ namespace: 'unlock', key });
      }
    });
    if (gate.unlock?.chapterRefs.length) {
      const key = `${gate.key}.unlock`;
      unlockKeys.set(gate.id, key);
      requests.push({ namespace: 'unlock', key });
    }
  });
  return { requests, rewardKeys, unlockKeys };
};

const rewardItemTarget = (
  reward: GateRewardDefinition,
  options: GateCompileOptions,
  registry: IdRegistry,
  sourcePath?: string,
  jsonPointer = '',
): { item?: GateRewardTargetItem; problem?: Problem } => {
  if (reward.kind === 'gem') return { item: { category: 1, id: 1, count: reward.amount } };
  if (!reward.ref) return { problem: diagnostic(GATE_CONTENT_CODES.REWARD_REF_MISSING, `Reward ${reward.kind} requires a symbolic ref`, sourcePath, jsonPointer) };
  if (reward.kind === 'card') {
    const id = mapLookup(options.cardIds, reward.ref);
    if (targetNumber(id) === undefined) return { problem: diagnostic(GATE_CONTENT_CODES.CARD_REWARD_TARGET_ID_MISSING, `No card catalog target ID was supplied for ${reward.ref}`, sourcePath, jsonPointer) };
    return { item: { category: 2, id: id as number, count: reward.amount } };
  }
  if (reward.kind === 'structure') {
    const key = assignmentKey(reward.ref);
    const id = mapLookup(options.structureIds, reward.ref) ?? assignmentFor(registry, 'structure', key);
    if (targetNumber(id) === undefined) return { problem: diagnostic(GATE_CONTENT_CODES.STRUCTURE_REWARD_TARGET_ID_MISSING, `No structure target ID was supplied for ${reward.ref}`, sourcePath, jsonPointer) };
    return { item: { category: 12, id: id as number, count: reward.amount } };
  }
  return { problem: diagnostic(GATE_CONTENT_CODES.UNLOCK_SECRET_UNSUPPORTED, `Pack reward is unsupported: ${reward.ref || 'pack'}`, sourcePath, jsonPointer) };
};

const buildUnlockTarget = (
  unlock: GateUnlockDefinition | undefined,
  chapterAssignments: Map<string, number>,
): JsonObject | undefined => {
  if (!unlock || !unlock.chapterRefs.length) return undefined;
  const type = unlock.mode === 'and' ? 4 : 2;
  const ids = unlock.chapterRefs.map((reference) => chapterAssignments.get(reference)).filter((id): id is number => id !== undefined);
  return { [String(type)]: ids };
};

const sourceChapterParentLocal = (chapter: GateChapterDefinition, gate: GateDefinition, chapterAssignments: Map<string, number>): number => {
  if (!chapter.parent) return 0;
  const full = chapterAssignments.get(chapter.parent);
  if (full === undefined) return 0;
  const gateId = assignmentKey(gate.id);
  void gateId;
  return full % 10000;
};

export const compileGateContent = (
  input: unknown,
  options: GateCompileOptions = {},
): GateCompileResult => {
  let registry: IdRegistry;
  try {
    registry = options.registry ? parseRegistry(options.registry) : createEmptyRegistry();
  } catch (error) {
    const problems = error instanceof GateContentError
      ? error.problems
      : error && typeof error === 'object' && 'problems' in error && Array.isArray(error.problems)
        ? error.problems as Problem[]
        : [diagnostic(GATE_CONTENT_CODES.ID_REGISTRY_INVALID, error instanceof Error ? error.message : String(error))];
    return {
      ok: false,
      documents: [],
      gates: [],
      problems: sortProblems(problems),
      warnings: [],
      targetCapability: { status: 'confirmed' },
    };
  }
  const knownGateIds = [
    ...(options.knownGateIds || []),
    ...Object.keys(registry.namespaces.gate.assignments).map((key) => `gate:${key}`),
  ];
  const validation = validateGateContent(input, { ...options, knownGateIds });
  const targetCapability = validation.problems.some((entry) => entry.code === GATE_CONTENT_CODES.UNLOCK_SECRET_UNSUPPORTED)
    ? { status: 'blocked' as const, blockingCode: GATE_CONTENT_CODES.UNLOCK_SECRET_UNSUPPORTED }
    : { status: 'confirmed' as const };
  if (!validation.ok) return { ...validation, registry, targetCapability };
  const allocation = buildAllocationRequests(validation.gates);
  let plan: RegistryPlan;
  try {
    if (options.requireExistingIds && allocation.requests.some((request) => registry.namespaces[request.namespace].assignments[request.key] === undefined)) {
      return {
        ...validation,
        registry,
        targetCapability,
        problems: sortProblems([...validation.problems, diagnostic(GATE_CONTENT_CODES.TARGET_ID_MISSING, 'Compilation requires existing ID-registry assignments')]),
        ok: false,
      };
    }
    plan = planRegistry(registry, allocation.requests, options.registryOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : GATE_CONTENT_CODES.ID_REGISTRY_ALLOCATION_FAILED;
    return {
      ...validation,
      registry,
      targetCapability,
      problems: sortProblems([...validation.problems, diagnostic(code, message)]),
      ok: false,
    };
  }
  const planned = plan.registry;
  const gateAssignments = new Map(validation.gates.map((gate) => [gate.id, assignmentFor(planned, 'gate', gate.key) as number]));
  const chapterAssignments = new Map<string, number>();
  validation.gates.forEach((gate) => gate.chapters.forEach((chapter) => {
    const id = assignmentFor(planned, 'chapter', chapter.key);
    if (id !== undefined) chapterAssignments.set(chapter.id, id);
  }));
  const rewardItems: Record<string, GateRewardTargetItem[]> = {};
  const rewardTable: Record<string, JsonObject> = {};
  const unlockTable: Record<string, JsonObject> = {};
  const unlockItemTable: Record<string, JsonObject> = {};
  const compileProblems: Problem[] = [];
  const compileWarnings: Problem[] = [...validation.warnings];
  const duels: Record<string, JsonObject> = {};
  const targetGates: Record<string, JsonObject> = {};
  const targetChapters: Record<string, Record<string, JsonObject>> = {};
  const sourceFiles: Record<string, JsonObject> = {};
  for (const gate of validation.gates.slice().sort((left, right) => compareOrdinal(left.key, right.key))) {
    const gateId = gateAssignments.get(gate.id);
    if (gateId === undefined) {
      compileProblems.push(diagnostic(GATE_CONTENT_CODES.TARGET_ID_MISSING, `No target ID assigned for ${gate.id}`));
      continue;
    }
    const parentId = gate.parent ? gateAssignments.get(gate.parent) || assignmentFor(planned, 'gate', assignmentKey(gate.parent)) || 0 : 0;
    const viewId = gate.view ? gateAssignments.get(gate.view) || assignmentFor(planned, 'gate', assignmentKey(gate.view)) || 0 : 0;
    const goalId = gate.goal ? chapterAssignments.get(gate.goal) : undefined;
    if (!gate.goal) compileProblems.push(diagnostic(GATE_CONTENT_CODES.GOAL_MISSING, `Gate ${gate.id} requires a goal chapter`));
    else if (goalId === undefined) {
      compileProblems.push(diagnostic(GATE_CONTENT_CODES.GOAL_ORPHAN, `No target chapter ID assigned for Gate goal ${gate.goal}`));
      compileProblems.push(diagnostic(GATE_CONTENT_CODES.CLEAR_CHAPTER_ZERO_FORBIDDEN, `Gate ${gate.id} cannot generate clear_chapter 0`));
    }
    const gateText = localizationText(gate.nameKey, options);
    const gateDescription = localizationText(gate.descriptionKey, options);
    compileProblems.push(...gateText.problems, ...gateDescription.problems);
    compileWarnings.push(...gateText.warnings, ...gateDescription.warnings);
    const gateRecord = mergeTarget({
      id: gateId,
      parent_gate: parentId,
      view_gate: viewId,
      priority: gate.priority,
      clear_chapter: goalId || 0,
      category: SOLO_STORIES_CATEGORY,
      open_date: SOLO_OPEN_DATE_EPOCH,
      name: gateText.value,
      description: gateDescription.value,
    }, gate.target);
    const gateUnlockKey = allocation.unlockKeys.get(gate.id);
    const gateUnlockId = gateUnlockKey ? assignmentFor(planned, 'unlock', gateUnlockKey) : undefined;
    if (gateUnlockId !== undefined) {
      gateRecord.unlock_id = gateUnlockId;
      const target = buildUnlockTarget(gate.unlock, chapterAssignments);
      if (target) unlockTable[String(gateUnlockId)] = target;
    }
    targetGates[String(gateId)] = gateRecord;
    const chaptersForGate: Record<string, JsonObject> = {};
    const sourceChapters: JsonValue[] = [];
    for (const chapter of gate.chapters.slice().sort((left, right) => compareOrdinal(left.key, right.key))) {
      const chapterId = chapterAssignments.get(chapter.id);
      if (chapterId === undefined) {
        compileProblems.push(diagnostic(GATE_CONTENT_CODES.TARGET_ID_MISSING, `No target ID assigned for ${chapter.id}`));
        continue;
      }
      const rewardKey = allocation.rewardKeys.get(chapter.id);
      const rewardId = rewardKey ? assignmentFor(planned, 'reward', rewardKey) : undefined;
      if (rewardId !== undefined && chapter.rewards.length) {
        const items: GateRewardTargetItem[] = [];
        chapter.rewards.forEach((reward, index) => {
          const target = rewardItemTarget(reward, options, planned, undefined, `/payload/chapters/${chapter.sourceIndex}/rewards/${index}`);
          if (target.problem) compileProblems.push(target.problem);
          else if (target.item) items.push(target.item);
        });
        rewardItems[String(rewardId)] = items;
        const categories: Record<string, Record<string, number>> = {};
        items.forEach((item) => {
          const category = categories[String(item.category)] || (categories[String(item.category)] = {});
          category[String(item.id)] = (category[String(item.id)] || 0) + item.count;
        });
        rewardTable[String(rewardId)] = categories;
      }
      const chapterUnlockKey = allocation.unlockKeys.get(chapter.id);
      const chapterUnlockId = chapterUnlockKey ? assignmentFor(planned, 'unlock', chapterUnlockKey) : undefined;
      if (chapterUnlockId !== undefined) {
        const target = buildUnlockTarget(chapter.unlock, chapterAssignments);
        if (target) unlockTable[String(chapterUnlockId)] = target;
      }
      const chapterText = localizationText(chapter.descriptionKey, options);
      compileProblems.push(...chapterText.problems);
      compileWarnings.push(...chapterText.warnings);
      const chapterRecord = mergeTarget({
        parent_chapter: chapter.parent ? chapterAssignments.get(chapter.parent) || 0 : 0,
        mydeck_set_id: chapter.kind === 'duel' && (chapter.duel?.playerMode === 'mydeck' || chapter.duel?.playerMode === 'both') ? rewardId || 0 : 0,
        set_id: chapter.kind === 'duel' && (chapter.duel?.playerMode === 'rental' || chapter.duel?.playerMode === 'both') ? rewardId || 0 : chapter.kind === 'reward' ? rewardId || 0 : 0,
        unlock_id: chapterUnlockId || 0,
        begin_sn: '',
        npc_id: chapter.kind === 'duel' ? 1 : 0,
      }, chapter.target);
      const unlockSecretIds = (chapter.unlockSecrets || []).map((reference) => mapLookup(options.shopIds, reference));
      if (unlockSecretIds.some((id) => targetNumber(id) === undefined)) {
        compileProblems.push(diagnostic(GATE_CONTENT_CODES.UNLOCK_SECRET_TARGET_ID_MISSING, `No Shop target ID was supplied for ${chapter.unlockSecrets?.find((_, index) => targetNumber(unlockSecretIds[index]) === undefined) || 'unlock secret'}`));
      } else if (unlockSecretIds.length) {
        chapterRecord.unlock_secret = (unlockSecretIds as number[]).join(' ');
      }
      chaptersForGate[String(chapterId)] = chapterRecord;
      const sourceChapter = mergeTarget({
        id: chapterId % 10000,
        parent_id: sourceChapterParentLocal(chapter, gate, chapterAssignments),
        type: chapter.kind === 'duel' ? 'Duel' : chapter.kind === 'reward' ? 'Reward' : 'Unlock',
        description: chapterText.value,
        begin_sn: '',
      }, chapter.target);
      if (chapter.duel?.target) {
        Object.assign(sourceChapter, clone(chapter.duel.target.ygomaster));
        // Keep the source adapter input non-Scenario even for a manually
        // constructed IR that bypassed parser diagnostics.
        sourceChapter.begin_sn = '';
      }
      if (chapter.duel) {
        sourceChapter.cpu_deck = outputDeckReference(options.deckOutputReferences, chapter.duel.cpuDeck);
        if (chapter.duel.rentalDeck) sourceChapter.rental_deck = outputDeckReference(options.deckOutputReferences, chapter.duel.rentalDeck);
      }
      if (unlockSecretIds.length && unlockSecretIds.every((id) => targetNumber(id) !== undefined)) sourceChapter.unlock_secret = (unlockSecretIds as number[]).join(' ');
      if (chapter.unlock?.chapterRefs.length) {
        sourceChapter.unlock = chapter.unlock.chapterRefs.map((reference) => ({
          type: chapter.unlock?.mode === 'and' ? 4 : 2,
          gateId: chapterAssignments.get(reference) ? Math.floor((chapterAssignments.get(reference) as number) / 10000) : 0,
          chapterId: chapterAssignments.get(reference) || 0,
        }));
      }
      if (rewardId !== undefined && rewardItems[String(rewardId)]?.length) {
        const sourceRewards = rewardItems[String(rewardId)].map((item) => ({ category: item.category, id: item.id, counts: item.count }));
        if (chapter.kind === 'duel' && chapter.duel?.playerMode === 'mydeck') {
          sourceChapter.mydeck_reward = sourceRewards;
        } else if (chapter.kind === 'duel' && chapter.duel?.playerMode === 'both') {
          sourceChapter.mydeck_reward = sourceRewards;
          sourceChapter.rental_reward = sourceRewards;
        } else {
          sourceChapter.reward = sourceRewards;
        }
      }
      sourceChapters.push(sourceChapter);
      if (chapter.kind === 'duel' && chapter.duel) {
        const cpuProjection = projectionLookup(options.deckProjections, chapter.duel.cpuDeck);
        const playerProjection = chapter.duel.playerDeck
          ? projectionLookup(options.deckProjections, chapter.duel.playerDeck)
          : chapter.duel.rentalDeck
            ? projectionLookup(options.deckProjections, chapter.duel.rentalDeck)
            : cpuProjection;
        const playerName = localizationText(chapter.duel.playerNameKey, options);
        const cpuName = localizationText(chapter.duel.cpuNameKey, options);
        compileProblems.push(...playerName.problems, ...cpuName.problems);
        compileWarnings.push(...playerName.warnings, ...cpuName.warnings);
        const duelPayload: JsonObject = {
          chapter: chapterId,
          name: [playerName.value, cpuName.value || 'CPU'],
          cpu: 98,
          cpuflag: 'None',
          Deck: [
            { Main: deckPartFromProjection(playerProjection, 'm'), Extra: deckPartFromProjection(playerProjection, 'e'), Side: deckPartFromProjection(playerProjection, 's') },
            { Main: deckPartFromProjection(cpuProjection, 'm'), Extra: deckPartFromProjection(cpuProjection, 'e'), Side: deckPartFromProjection(cpuProjection, 's') },
          ],
        };
        const targetDuel = chapter.duel.target?.ygomaster;
        const generatedDuel = targetDuel ? { ...duelPayload, ...clone(targetDuel) } : duelPayload;
        // Parser validation rejects this generated field, and this second
        // guard keeps manually constructed IR fail-closed as well.
        delete generatedDuel.begin_sn;
        duels[String(chapterId)] = { Duel: generatedDuel };
      }
    }
    const sourceGate = mergeTarget({
      id: gateId,
      parent_id: parentId,
      view_gate: viewId,
      priority: gate.priority,
      // The Data materializer interprets a numeric clear_chapter as a
      // gate-local chapter number; the direct IR above remains composite.
      clear_chapter: goalId ? goalId % 10000 : 0,
      category: SOLO_STORIES_CATEGORY,
      open_date: SOLO_OPEN_DATE_EPOCH,
      name: gateText.value,
      description: gateDescription.value,
      chapters: sourceChapters,
    }, gate.target);
    if (gate.unlock?.chapterRefs.length) sourceGate.unlock = gate.unlock.chapterRefs.map((reference) => ({ type: gate.unlock?.mode === 'and' ? 4 : 2, gateId: chapterAssignments.get(reference) ? Math.floor((chapterAssignments.get(reference) as number) / 10000) : 0, chapterId: chapterAssignments.get(reference) || 0 }));
    sourceFiles[`gate/${gate.key}.json`] = sourceGate;
    targetChapters[String(gateId)] = chaptersForGate;
  }
  const errorProblems = [...validation.problems, ...compileProblems].filter((problem) => problem.severity !== 'warning');
  if (errorProblems.length || targetCapability.status === 'blocked') {
    return {
      ...validation,
      ok: false,
      problems: sortProblems(errorProblems.length ? errorProblems : [diagnostic(GATE_CONTENT_CODES.IR_BLOCKED, 'Gate IR is blocked by target capability')]),
      warnings: sortProblems(compileWarnings),
      registry: planned,
      registryPlan: plan,
      targetCapability,
    };
  }
  const ir: GateCompileIR = {
    formatVersion: GATE_CONTENT_FORMAT_VERSION,
    kind: 'gate-ir',
    targetContractVersion: YGOMASTER_TARGET_CONTRACT_VERSION,
    registryGeneration: planned.generation,
    solo: {
      gate: targetGates,
      chapter: targetChapters,
      unlock: unlockTable,
      unlock_item: unlockItemTable,
      reward: rewardTable,
    },
    duels,
    sourceFiles,
    rewardItems,
  };
  return {
    ...validation,
    ok: true,
    problems: [],
    warnings: sortProblems(compileWarnings),
    ir,
    registry: planned,
    registryPlan: plan,
    targetCapability,
  };
};

export const compileGate = compileGateContent;
export const compileGateDocument = compileGateContent;
export const compileGateChapterContent = compileGateContent;
export const gateContentToIr = compileGateContent;
export const gateContentToIR = compileGateContent;

export const assertGateCompilation = (result: GateCompileResult): GateCompileIR => {
  if (!result.ok || !result.ir) {
    const first = result.problems[0];
    throw new GateContentError(first?.code || GATE_CONTENT_CODES.IR_BLOCKED, first?.message || 'Gate IR is blocked by content diagnostics', result.problems);
  }
  return clone(result.ir);
};

export const assertGateCompile = assertGateCompilation;

export const gateIrSemanticEqual = (left: unknown, right: unknown): boolean => {
  if (!isRecord(left) || !isRecord(right)) return false;
  try {
    return semanticEqual(left as JsonValue, right as JsonValue);
  } catch {
    return false;
  }
};

export const GATE_TARGET_CAPABILITY = Object.freeze({ status: 'confirmed' as const, targetContractVersion: YGOMASTER_TARGET_CONTRACT_VERSION });
