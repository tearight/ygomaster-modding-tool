import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  ContentEnvelope,
  ContentFormatError,
  ParsedContentEnvelope,
  SourceSpan,
  contentDiagnostic,
  createContentEnvelope,
  normalizeSymbolicKey,
  parseContentEnvelopeWithSource,
} from './content-format';
import type { JsonObject, Problem } from './types';
import {
  DeckCompileResult,
  DeckIR,
  DeckIRPart,
  DeckResolutionOptions,
  compileDecklist,
  parseDecklist,
} from './deck-content';
import { resolveInside } from './fs';
import {
  AllocationRequest,
  IdRegistry,
  IdRegistryError,
  RegistryAllocationOptions,
  RegistryPlan,
  planRegistry,
} from './id-registry';
import { cardReferenceRequest } from './card-resolver';
import type { CardNameResolver, CardReferenceInput, CardReferenceSelector } from './card-resolver';
import {
  LocalizationCatalog,
  normalizeLocalizationKey,
  resolveLocalization,
} from './localization-content';
import { validateTargetCapability } from './target-contract';

export const STRUCTURE_CONTENT_FORMAT_VERSION = 1 as const;
export const STRUCTURE_CONTENT_KIND = 'structure' as const;
export const STRUCTURE_TARGET_DIRECTORY = 'Data/StructureDecks' as const;
export const STRUCTURE_DEFAULT_FOCUS_MAX = 3 as const;
export const STRUCTURE_DEFAULT_RARITY = 1 as const;

export const STRUCTURE_CODES = Object.freeze({
  ENVELOPE_INVALID: 'STRUCTURE_ENVELOPE_INVALID',
  KIND_INVALID: 'STRUCTURE_KIND_INVALID',
  PAYLOAD_INVALID: 'STRUCTURE_PAYLOAD_INVALID',
  KEY_INVALID: 'STRUCTURE_KEY_INVALID',
  KEY_DUPLICATE: 'STRUCTURE_KEY_DUPLICATE',
  ID_REGISTRY_REQUIRED: 'STRUCTURE_ID_REGISTRY_REQUIRED',
  ID_REGISTRY_INVALID: 'STRUCTURE_ID_REGISTRY_INVALID',
  ID_CONFLICT: 'STRUCTURE_ID_CONFLICT',
  DECK_MISSING: 'STRUCTURE_DECK_MISSING',
  DECK_REFERENCE_INVALID: 'STRUCTURE_DECK_REFERENCE_INVALID',
  DECK_ARRAY_FORBIDDEN: 'STRUCTURE_CARD_ARRAY_FORBIDDEN',
  DECK_COMPILE_BLOCKED: 'STRUCTURE_DECK_COMPILE_BLOCKED',
  LOCALIZATION_MISSING: 'STRUCTURE_LOCALIZATION_MISSING',
  ACCESSORY_MISSING: 'STRUCTURE_ACCESSORY_MISSING',
  ACCESSORY_INVALID: 'STRUCTURE_ACCESSORY_INVALID',
  FOCUS_MISSING: 'STRUCTURE_FOCUS_MISSING',
  FOCUS_MAX: 'STRUCTURE_FOCUS_MAX',
  FOCUS_DUPLICATE: 'STRUCTURE_FOCUS_DUPLICATE',
  FOCUS_NOT_IN_DECK: 'STRUCTURE_FOCUS_NOT_IN_DECK',
  FOCUS_RARITY_INVALID: 'STRUCTURE_FOCUS_RARITY_INVALID',
  REWARD_ORPHAN: 'STRUCTURE_REWARD_ORPHAN',
  REWARD_QUANTITY_INVALID: 'STRUCTURE_REWARD_QUANTITY_INVALID',
  REWARD_ONE_COPY_INVALID: 'STRUCTURE_REWARD_ONE_COPY_INVALID',
  REWARD_ONE_COPY_ASSUMED: 'STRUCTURE_REWARD_ONE_COPY_ASSUMED',
  TARGET_UNVERIFIED: 'STRUCTURE_TARGET_UNVERIFIED',
  TARGET_PROJECTION_INVALID: 'STRUCTURE_TARGET_PROJECTION_INVALID',
} as const);

export type StructureCode = (typeof STRUCTURE_CODES)[keyof typeof STRUCTURE_CODES];

export interface StructureAccessory extends JsonObject {
  box: number;
  sleeve: number;
}

export interface StructureReward {
  quantity?: number;
  oneCopy?: boolean;
  structureKey?: string;
  structureId?: number;
  [key: string]: unknown;
}

/** The authored structure document is symbolic; deck cards never live here. */
export interface StructureDefinition {
  key?: string;
  structureKey?: string;
  nameKey?: string;
  nameRef?: string;
  descriptionKey?: string;
  descriptionRef?: string;
  localization?: JsonObject;
  deck?: string;
  deckRef?: string;
  decklist?: string;
  decklistRef?: string;
  focus?: CardReferenceInput | CardReferenceInput[];
  focusCard?: CardReferenceInput | CardReferenceInput[];
  focusCardName?: CardReferenceInput | CardReferenceInput[];
  focusCards?: CardReferenceInput | CardReferenceInput[];
  accessory?: string | StructureAccessory | JsonObject;
  accessoryRef?: string;
  focusRarity?: number;
  reward?: StructureReward;
  targetId?: number;
  structureId?: number;
  id?: number;
  [key: string]: unknown;
}

export interface ParsedStructureContent {
  envelope: ContentEnvelope<JsonObject>;
  raw: JsonObject;
  payloadKey: string;
  payload: StructureDefinition;
  sourcePath?: string;
}

export interface StructureRewardReference {
  structureKey?: string;
  structureId?: number;
  quantity?: number;
  oneCopy?: boolean;
  sourcePath?: string;
  sourceSpan?: SourceSpan;
}

export interface StructureAccessoryCatalog {
  [reference: string]: StructureAccessory;
}

export interface StructureCompileOptions {
  sourcePath?: string;
  registry?: IdRegistry;
  idRegistry?: IdRegistry;
  registryOptions?: RegistryAllocationOptions;
  /** Deprecated compatibility option; Structure is confirmed by upstream extraction docs in target v2. */
  allowAssumed?: boolean;
  /** Explicitly verified adapter evidence is equivalent to allowAssumed. */
  verifiedAdapter?: boolean;
  deckSource?: string;
  deckSources?: Record<string, string>;
  deckRoot?: string;
  deckOptions?: DeckResolutionOptions;
  extraDeckCardIds?: DeckResolutionOptions['extraDeckCardIds'];
  isExtraDeckCard?: DeckResolutionOptions['isExtraDeckCard'];
  localization?: LocalizationCatalog;
  localizationKeys?: Iterable<string>;
  accessories?: StructureAccessoryCatalog;
  accessoryCatalog?: StructureAccessoryCatalog;
  accessoryReferences?: Iterable<string>;
  accessoryResolver?: (reference: string) => StructureAccessory | undefined;
  focusMax?: number;
  focusRarity?: number;
  knownStructureKeys?: Iterable<string>;
  knownStructureIds?: Iterable<number>;
  rewardReferences?: readonly StructureRewardReference[];
}

export interface StructureTargetProjection {
  structure_id: number;
  accessory: StructureAccessory;
  focus: DeckIRPart;
  contents: DeckIR;
  [key: string]: unknown;
}

export interface StructureProjection {
  path: string;
  document: StructureTargetProjection;
}

export interface StructureLocalizationResolution {
  nameKey?: string;
  descriptionKey?: string;
  name?: string;
  description?: string;
}

export interface StructureFocusResolution {
  sourceName: string;
  sourceIndex?: number;
  normalizedName?: string;
  runtimeId?: number;
  matchKind?: 'exact' | 'alias';
  selector?: CardReferenceSelector;
}

export interface StructureTargetCapability {
  status: 'assumed';
  allowed: boolean;
  blockingCode?: string;
}

export interface StructureCompileResult {
  ok: boolean;
  contentOk: boolean;
  sourcePath?: string;
  parsed?: ParsedStructureContent;
  definition?: StructureDefinition;
  key?: string;
  structureId?: number;
  registry?: IdRegistry;
  registryPlan?: RegistryPlan;
  deck?: DeckCompileResult;
  deckIr?: DeckIR;
  focus?: StructureFocusResolution[];
  localization?: StructureLocalizationResolution;
  accessory?: StructureAccessory;
  target?: StructureTargetProjection;
  projection?: StructureProjection;
  targetCapability: StructureTargetCapability;
  warnings: Problem[];
  problems: Problem[];
}

export interface StructureCollectionResult {
  ok: boolean;
  structures: StructureCompileResult[];
  registry?: IdRegistry;
  registryPlan?: RegistryPlan;
  warnings: Problem[];
  problems: Problem[];
}

export class StructureContentError extends Error {
  readonly problems: Problem[];

  constructor(problems: Problem[], message?: string) {
    super(message || problems.map((entry) => `${entry.code}: ${entry.message}`).join('; ') || 'Structure content error');
    this.name = 'StructureContentError';
    this.problems = problems;
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

const compareProblems = (left: Problem, right: Problem): number =>
  compareOrdinal(left.sourcePath || left.path || '', right.sourcePath || right.path || '')
  || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
  || (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER)
  || compareOrdinal(left.code, right.code)
  || compareOrdinal(left.message, right.message);

const diagnostic = (
  code: string,
  message: string,
  sourcePath?: string,
  sourceSpan?: SourceSpan,
  jsonPointer?: string,
  severity: 'error' | 'warning' = 'error',
): Problem => contentDiagnostic({ code, message, sourcePath, span: sourceSpan, jsonPointer, severity });

const normalizeKind = (value: string): string => value.normalize('NFKC').trim().toLowerCase();

const structureFailure = (
  problems: Problem[],
  options: StructureCompileOptions,
  extras: Partial<StructureCompileResult> = {},
): StructureCompileResult => {
  const sorted = [...problems].sort(compareProblems);
  const warnings = sorted.filter((entry) => entry.severity === 'warning');
  return {
    ok: false,
    contentOk: false,
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    ...extras,
    targetCapability: {
      status: 'assumed',
      allowed: false,
      blockingCode: STRUCTURE_CODES.TARGET_UNVERIFIED,
    },
    warnings,
    problems: sorted,
  };
};

export const createStructureEnvelope = (
  payload: StructureDefinition,
  extra: JsonObject = {},
): ContentEnvelope<JsonObject> =>
  createContentEnvelope<JsonObject>(STRUCTURE_CONTENT_KIND, payload as unknown as JsonObject, STRUCTURE_CONTENT_FORMAT_VERSION, extra);

/** Parse the symbolic structure envelope while retaining the original wrapper. */
export const parseStructureContent = (
  input: unknown,
  sourcePath?: string,
): ParsedStructureContent => {
  try {
    const parsed: ParsedContentEnvelope<JsonObject> = parseContentEnvelopeWithSource<JsonObject>(input, {
      sourcePath,
      supportedVersion: STRUCTURE_CONTENT_FORMAT_VERSION,
    });
    if (normalizeKind(parsed.envelope.kind) !== STRUCTURE_CONTENT_KIND) {
      throw new StructureContentError([
        diagnostic(STRUCTURE_CODES.KIND_INVALID, `Structure content kind must be ${STRUCTURE_CONTENT_KIND}`, sourcePath, undefined, '/kind'),
      ]);
    }
    if (!isRecord(parsed.envelope.payload)) {
      throw new StructureContentError([
        diagnostic(STRUCTURE_CODES.PAYLOAD_INVALID, 'Structure content payload must be an object', sourcePath, undefined, '/payload'),
      ]);
    }
    return {
      envelope: parsed.envelope,
      raw: parsed.raw,
      payloadKey: parsed.payloadKey,
      payload: parsed.envelope.payload as unknown as StructureDefinition,
      ...(sourcePath ? { sourcePath } : {}),
    };
  } catch (error) {
    if (error instanceof StructureContentError) throw error;
    if (error instanceof ContentFormatError) throw new StructureContentError(error.problems);
    throw new StructureContentError([
      diagnostic(STRUCTURE_CODES.ENVELOPE_INVALID, String(error), sourcePath),
    ]);
  }
};

export const parseStructureDocument = parseStructureContent;
export const parseStructure = parseStructureContent;

export const readStructureContent = async (
  filePath: string,
): Promise<ParsedStructureContent> => parseStructureContent(await fs.readFile(filePath, 'utf8'), filePath);

export const readStructureDocument = readStructureContent;

const asParsed = (input: unknown, sourcePath?: string): ParsedStructureContent => {
  if (isRecord(input)
    && isRecord(input.envelope)
    && isRecord(input.raw)
    && typeof input.payloadKey === 'string'
    && isRecord(input.payload)) {
    return input as unknown as ParsedStructureContent;
  }
  return parseStructureContent(input, sourcePath);
};

const firstString = (...values: unknown[]): string | undefined =>
  values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();

const structureKeyOf = (definition: StructureDefinition): string | undefined =>
  firstString(definition.key, definition.structureKey);

const deckReferenceOf = (definition: StructureDefinition): string | undefined =>
  firstString(definition.deck, definition.deckRef, definition.decklist, definition.decklistRef);

const localizationReferenceOf = (
  definition: StructureDefinition,
  field: 'name' | 'description',
): string | undefined => {
  const localization = isRecord(definition.localization) ? definition.localization : {};
  return field === 'name'
    ? firstString(definition.nameKey, definition.nameRef, localization.nameKey, localization.nameRef, localization.name)
    : firstString(definition.descriptionKey, definition.descriptionRef, localization.descriptionKey, localization.descriptionRef, localization.description);
};

type StructureFocusField = 'focus' | 'focusCard' | 'focusCardName' | 'focusCards';

interface StructureFocusInput {
  field: StructureFocusField;
  count: number;
  entries: Array<{ sourceName: string; sourceIndex: number; selector?: CardReferenceSelector }>;
}

const focusNamesOf = (definition: StructureDefinition): StructureFocusInput => {
  const fields: StructureFocusField[] = ['focus', 'focusCard', 'focusCardName', 'focusCards'];
  const field = fields.find((candidate) => definition[candidate] !== undefined) || 'focus';
  const value = definition[field];
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  if (values.length) {
    return {
      field,
      count: values.length,
      entries: values.map((entry, sourceIndex) => {
        const request = cardReferenceRequest(entry as CardReferenceInput);
        return {
          sourceName: request.sourceName || '',
          sourceIndex,
          ...(request.selector ? { selector: request.selector } : {}),
        };
      }),
    };
  }
  return { field, count: 0, entries: [] };
};

const accessoryValueOf = (definition: StructureDefinition): unknown => definition.accessoryRef ?? definition.accessory;

const targetPinOf = (definition: StructureDefinition): unknown =>
  definition.targetId ?? definition.structureId ?? definition.id;

const knownStructureFields = new Set([
  'key', 'structureKey', 'nameKey', 'nameRef', 'descriptionKey', 'descriptionRef', 'localization',
  'deck', 'deckRef', 'decklist', 'decklistRef', 'focus', 'focusCard', 'focusCardName', 'focusCards',
  'focusRarity', 'accessory', 'accessoryRef', 'reward', 'targetId', 'structureId', 'id',
  'cards', 'cardIds', 'cardList', 'contents',
]);

const opaquePayloadFields = (definition: StructureDefinition): JsonObject => {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(definition)) {
    if (!knownStructureFields.has(key)) result[key] = clone(value) as never;
  }
  return result;
};

const isSafeDeckReference = (value: string): boolean => {
  const normalized = value.replace(/\\/gu, '/');
  return !path.isAbsolute(value)
    && !/^[A-Za-z]:\//u.test(normalized)
    && !normalized.split('/').includes('..')
    && !normalized.includes('\0')
    && normalized.trim().length > 0;
};

interface ResolvedDeckSource {
  source: string;
  sourcePath: string;
}

const resolveDeckSource = async (
  reference: string,
  options: StructureCompileOptions,
): Promise<ResolvedDeckSource | undefined> => {
  if (options.deckSource !== undefined) return { source: options.deckSource, sourcePath: reference };
  const normalized = reference.replace(/\\/gu, '/');
  if (options.deckSources) {
    const exact = options.deckSources[reference] ?? options.deckSources[normalized];
    if (exact !== undefined) return { source: exact, sourcePath: reference };
    const basename = path.posix.basename(normalized);
    const matches = Object.entries(options.deckSources)
      .filter(([key]) => path.posix.basename(key.replace(/\\/gu, '/')) === basename);
    if (matches.length === 1) return { source: matches[0]?.[1] as string, sourcePath: matches[0]?.[0] as string };
  }
  if (!options.deckRoot) return undefined;
  try {
    const root = path.resolve(options.deckRoot);
    const filePath = resolveInside(root, normalized);
    return { source: await fs.readFile(filePath, 'utf8'), sourcePath: filePath };
  } catch {
    return undefined;
  }
};

const structureAccessory = (
  value: unknown,
  options: StructureCompileOptions,
): { value?: StructureAccessory; problem?: Problem } => {
  let resolved = value;
  let reference: string | undefined;
  if (typeof resolved === 'string') reference = resolved.trim();
  else if (isRecord(resolved) && typeof resolved.ref === 'string') reference = resolved.ref.trim();
  if (reference) {
    const resolverValue = options.accessoryResolver?.(reference)
      || options.accessories?.[reference]
      || options.accessoryCatalog?.[reference];
    if (resolverValue) resolved = resolverValue;
    else if (options.accessoryReferences && [...options.accessoryReferences].includes(reference)) resolved = { box: 0, sleeve: 0 };
    else return { problem: diagnostic(STRUCTURE_CODES.ACCESSORY_MISSING, `Accessory reference does not resolve: ${reference}`, options.sourcePath, undefined, '/payload/accessory') };
  }
  if (!isRecord(resolved)) return { problem: diagnostic(STRUCTURE_CODES.ACCESSORY_MISSING, 'Structure requires an accessory reference or object', options.sourcePath, undefined, '/payload/accessory') };
  if (!Object.prototype.hasOwnProperty.call(resolved, 'box') && !Object.prototype.hasOwnProperty.call(resolved, 'sleeve')) {
    return { problem: diagnostic(STRUCTURE_CODES.ACCESSORY_INVALID, 'Structure accessory object must declare box or sleeve', options.sourcePath, undefined, '/payload/accessory') };
  }
  const box = resolved.box === undefined ? 0 : resolved.box;
  const sleeve = resolved.sleeve === undefined ? 0 : resolved.sleeve;
  if (![box, sleeve].every((entry) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0)) {
    return { problem: diagnostic(STRUCTURE_CODES.ACCESSORY_INVALID, 'Structure accessory box/sleeve IDs must be non-negative integers', options.sourcePath, undefined, '/payload/accessory') };
  }
  return { value: { ...clone(resolved) as StructureAccessory, box: box as number, sleeve: sleeve as number } };
};

const resolveLocalizationFields = (
  definition: StructureDefinition,
  options: StructureCompileOptions,
  problems: Problem[],
): StructureLocalizationResolution => {
  const output: StructureLocalizationResolution = {};
  const keys = options.localizationKeys ? new Set([...options.localizationKeys].map((entry) => {
    try { return normalizeLocalizationKey(entry); } catch { return entry; }
  })) : undefined;
  for (const field of ['name', 'description'] as const) {
    const key = localizationReferenceOf(definition, field);
    if (!key) {
      problems.push(diagnostic(STRUCTURE_CODES.LOCALIZATION_MISSING, `Structure ${field} requires a localization key`, options.sourcePath, undefined, `/payload/${field}Key`));
      continue;
    }
    let normalizedKey: string;
    try {
      normalizedKey = normalizeLocalizationKey(key);
    } catch {
      problems.push(diagnostic(STRUCTURE_CODES.LOCALIZATION_MISSING, `Invalid structure ${field} localization key: ${key}`, options.sourcePath, undefined, `/payload/${field}Key`));
      continue;
    }
    if (field === 'name') output.nameKey = normalizedKey;
    else output.descriptionKey = normalizedKey;
    if (options.localization) {
      const resolved = resolveLocalization(options.localization, { key: normalizedKey, language: options.localization.fallbackLanguage, sourcePath: options.sourcePath }, { fallbackLanguage: options.localization.fallbackLanguage });
      problems.push(...resolved.problems);
      if (resolved.value !== undefined) {
        if (field === 'name') output.name = resolved.value;
        else output.description = resolved.value;
      } else {
        problems.push(diagnostic(
          STRUCTURE_CODES.LOCALIZATION_MISSING,
          `Localization key does not resolve: ${normalizedKey}`,
          options.sourcePath,
          undefined,
          `/payload/${field}Key`,
        ));
      }
    } else if (!keys?.has(normalizedKey)) {
      problems.push(diagnostic(STRUCTURE_CODES.LOCALIZATION_MISSING, `Localization key does not resolve: ${normalizedKey}`, options.sourcePath, undefined, `/payload/${field}Key`));
    }
  }
  return output;
};

const structureDeckOptions = (options: StructureCompileOptions): DeckResolutionOptions => ({
  ...(options.deckOptions || {}),
  ...(options.extraDeckCardIds !== undefined ? { extraDeckCardIds: options.extraDeckCardIds } : {}),
  ...(options.isExtraDeckCard ? { isExtraDeckCard: options.isExtraDeckCard } : {}),
});

const focusRarityOf = (definition: StructureDefinition, options: StructureCompileOptions): number =>
  definition.focusRarity ?? options.focusRarity ?? STRUCTURE_DEFAULT_RARITY;

const validateReward = (
  reward: unknown,
  key: string,
  structureId: number | undefined,
  options: StructureCompileOptions,
  problems: Problem[],
): void => {
  if (reward === undefined) return;
  if (!isRecord(reward)) {
    problems.push(diagnostic(STRUCTURE_CODES.REWARD_QUANTITY_INVALID, 'Structure reward must be an object', options.sourcePath, undefined, '/payload/reward'));
    return;
  }
  const quantity = reward.quantity === undefined ? 1 : reward.quantity;
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1) {
    problems.push(diagnostic(STRUCTURE_CODES.REWARD_QUANTITY_INVALID, 'Structure reward quantity must be a positive safe integer', options.sourcePath, undefined, '/payload/reward/quantity'));
  }
  if (Object.prototype.hasOwnProperty.call(reward, 'oneCopy') && typeof reward.oneCopy !== 'boolean') {
    problems.push(diagnostic(STRUCTURE_CODES.REWARD_ONE_COPY_INVALID, 'Structure reward oneCopy must be boolean when present', options.sourcePath, undefined, '/payload/reward/oneCopy'));
  }
  problems.push(diagnostic(
    STRUCTURE_CODES.REWARD_ONE_COPY_ASSUMED,
    `Structure reward quantity/one-copy behavior is a compatibility assumption for ${key}`,
    options.sourcePath,
    undefined,
    '/payload/reward',
    'warning',
  ));
  const referenceKey = firstString(reward.structureKey, reward.structureRef);
  const referenceId = reward.structureId;
  const knownKeys = new Set([key, ...(options.knownStructureKeys ? [...options.knownStructureKeys] : [])]);
  const knownIds = new Set([...(structureId === undefined ? [] : [structureId]), ...(options.knownStructureIds ? [...options.knownStructureIds] : [])]);
  if (referenceKey) {
    let normalized = referenceKey;
    try { normalized = normalizeSymbolicKey(referenceKey); } catch { /* reported as orphan below */ }
    if (!knownKeys.has(normalized)) problems.push(diagnostic(STRUCTURE_CODES.REWARD_ORPHAN, `Structure reward references an unknown structure: ${referenceKey}`, options.sourcePath, undefined, '/payload/reward/structureKey'));
  } else if (referenceId !== undefined && (typeof referenceId !== 'number' || !knownIds.has(referenceId))) {
    problems.push(diagnostic(STRUCTURE_CODES.REWARD_ORPHAN, `Structure reward references an unknown structure ID: ${String(referenceId)}`, options.sourcePath, undefined, '/payload/reward/structureId'));
  }
};

const validateRewardReferences = (
  references: readonly StructureRewardReference[] | undefined,
  keys: Iterable<string>,
  ids: Iterable<number>,
  problems: Problem[],
): void => {
  if (!references) return;
  const knownKeys = new Set(keys);
  const knownIds = new Set(ids);
  for (const [index, reference] of references.entries()) {
    const sourcePath = reference.sourcePath;
    const pointer = `/rewards/${index}`;
    const quantity = reference.quantity === undefined ? 1 : reference.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1) problems.push(diagnostic(STRUCTURE_CODES.REWARD_QUANTITY_INVALID, 'Structure reward quantity must be a positive safe integer', sourcePath, reference.sourceSpan, `${pointer}/quantity`));
    if (reference.oneCopy !== undefined && typeof reference.oneCopy !== 'boolean') problems.push(diagnostic(STRUCTURE_CODES.REWARD_ONE_COPY_INVALID, 'Structure reward oneCopy must be boolean when present', sourcePath, reference.sourceSpan, `${pointer}/oneCopy`));
    problems.push(diagnostic(STRUCTURE_CODES.REWARD_ONE_COPY_ASSUMED, 'Structure reward quantity/one-copy behavior is a compatibility assumption', sourcePath, reference.sourceSpan, pointer, 'warning'));
    let resolvedKey: string | undefined;
    if (reference.structureKey) {
      try { resolvedKey = normalizeSymbolicKey(reference.structureKey); } catch { resolvedKey = undefined; }
    }
    const keyOk = resolvedKey !== undefined && knownKeys.has(resolvedKey);
    const idOk = reference.structureId !== undefined && knownIds.has(reference.structureId);
    if (!keyOk && !idOk) problems.push(diagnostic(STRUCTURE_CODES.REWARD_ORPHAN, `Structure reward target does not resolve: ${reference.structureKey || String(reference.structureId)}`, sourcePath, reference.sourceSpan, pointer));
  }
};

const mapRegistryError = (error: unknown): { code: string; message: string } => {
  if (error instanceof IdRegistryError) {
    const conflictCodes = new Set(['ID_REGISTRY_COLLISION', 'ID_REGISTRY_RUNTIME_COLLISION', 'ID_REGISTRY_TOMBSTONE_REUSE', 'ID_REGISTRY_PIN_INVALID']);
    return { code: conflictCodes.has(error.code) ? STRUCTURE_CODES.ID_CONFLICT : error.code, message: error.message };
  }
  return { code: STRUCTURE_CODES.ID_REGISTRY_INVALID, message: String(error) };
};

const targetProjection = (
  definition: StructureDefinition,
  structureId: number,
  accessory: StructureAccessory,
  focusIds: number[],
  focusRarity: number,
  deckIr: DeckIR,
): StructureTargetProjection => ({
  ...opaquePayloadFields(definition),
  structure_id: structureId,
  accessory: clone(accessory),
  focus: { ids: [...focusIds], r: focusIds.map(() => focusRarity) },
  contents: clone(deckIr),
} as StructureTargetProjection);

const compileParsedStructure = async (
  parsed: ParsedStructureContent,
  resolver: CardNameResolver,
  options: StructureCompileOptions,
): Promise<StructureCompileResult> => {
  const problems: Problem[] = [];
  const definition = parsed.payload;
  const sourcePath = options.sourcePath || parsed.sourcePath;
  const baseExtras = { sourcePath, parsed, definition };
  const rawKey = structureKeyOf(definition);
  let key: string | undefined;
  if (!rawKey) problems.push(diagnostic(STRUCTURE_CODES.KEY_INVALID, 'Structure requires a symbolic key', sourcePath, undefined, '/payload/key'));
  else {
    try { key = normalizeSymbolicKey(rawKey); } catch { problems.push(diagnostic(STRUCTURE_CODES.KEY_INVALID, `Invalid structure key: ${rawKey}`, sourcePath, undefined, '/payload/key')); }
  }
  const inlineCardField = ['cards', 'cardIds', 'cardList', 'contents']
    .find((field) => definition[field] !== undefined);
  if (inlineCardField) {
    problems.push(diagnostic(STRUCTURE_CODES.DECK_ARRAY_FORBIDDEN, 'Structure cards must come from a DCK-001 decklist reference, not an inline card array', sourcePath, undefined, '/payload/cards'));
  }
  const capabilityProblems = validateTargetCapability('structure', sourcePath, options.allowAssumed === true || options.verifiedAdapter === true);
  problems.push(...capabilityProblems);
  const targetCapability: StructureTargetCapability = {
    status: 'assumed',
    allowed: capabilityProblems.length === 0,
    ...(capabilityProblems[0]?.code ? { blockingCode: capabilityProblems[0].code } : {}),
  };
  const localizationProblems: Problem[] = [];
  const localization = resolveLocalizationFields(definition, options, localizationProblems);
  problems.push(...localizationProblems);
  const accessoryResult = structureAccessory(accessoryValueOf(definition), options);
  if (accessoryResult.problem) problems.push(accessoryResult.problem);
  const accessory = accessoryResult.value;
  const registry = options.registry || options.idRegistry;
  let registryPlan: RegistryPlan | undefined;
  let structureId: number | undefined;
  if (!registry) {
    problems.push(diagnostic(STRUCTURE_CODES.ID_REGISTRY_REQUIRED, 'Structure compilation requires an explicit ID registry', sourcePath, undefined, '/registry'));
  } else if (key) {
    const pinValue = targetPinOf(definition);
    if (pinValue !== undefined && (typeof pinValue !== 'number' || !Number.isSafeInteger(pinValue))) {
      problems.push(diagnostic(STRUCTURE_CODES.ID_CONFLICT, `Structure target ID pin must be an integer: ${String(pinValue)}`, sourcePath, undefined, '/payload/targetId'));
    } else {
      const request: AllocationRequest = {
        namespace: 'structure',
        key,
        ...(pinValue === undefined ? {} : { pin: pinValue as number }),
      };
      try {
        registryPlan = planRegistry(registry, [request], options.registryOptions);
        structureId = registryPlan.registry.namespaces.structure.assignments[key]?.id;
      } catch (error) {
        const mapped = mapRegistryError(error);
        problems.push(diagnostic(mapped.code, mapped.message, sourcePath, undefined, '/registry'));
      }
    }
  }
  const rewardProblems: Problem[] = [];
  validateReward(definition.reward, key || rawKey || '', structureId, options, rewardProblems);
  problems.push(...rewardProblems);

  let deck: DeckCompileResult | undefined;
  let deckIr: DeckIR | undefined;
  const deckReference = deckReferenceOf(definition);
  if (!deckReference) {
    problems.push(diagnostic(STRUCTURE_CODES.DECK_MISSING, 'Structure requires a decklist reference', sourcePath, undefined, '/payload/deck'));
  } else if (!isSafeDeckReference(deckReference)) {
    problems.push(diagnostic(STRUCTURE_CODES.DECK_REFERENCE_INVALID, `Structure deck reference must stay inside the authored source: ${deckReference}`, sourcePath, undefined, '/payload/deck'));
  } else {
    const deckSource = await resolveDeckSource(deckReference, options);
    if (!deckSource) {
      problems.push(diagnostic(STRUCTURE_CODES.DECK_MISSING, `Structure deck reference does not resolve: ${deckReference}`, sourcePath, undefined, '/payload/deck'));
    } else {
      const deckDocument = parseDecklist(deckSource.source, { sourcePath: deckSource.sourcePath });
      deck = compileDecklist(deckDocument, resolver, structureDeckOptions(options));
      problems.push(...deck.problems);
      if (deck.ok && deck.ir) deckIr = clone(deck.ir);
      else problems.push(diagnostic(STRUCTURE_CODES.DECK_COMPILE_BLOCKED, 'Structure deck IR is blocked by deck diagnostics', deckSource.sourcePath));
    }
  }

  const focusInput = focusNamesOf(definition);
  const focusNames = focusInput.entries;
  const focusMax = options.focusMax ?? STRUCTURE_DEFAULT_FOCUS_MAX;
  const focusRarity = focusRarityOf(definition, options);
  const focus: StructureFocusResolution[] = [];
  const focusIds: number[] = [];
  if (!focusNames.length) problems.push(diagnostic(STRUCTURE_CODES.FOCUS_MISSING, 'Structure requires at least one focus card English name', sourcePath, undefined, `/payload/${focusInput.field}`));
  if (!Number.isSafeInteger(focusMax) || focusMax < 1) problems.push(diagnostic(STRUCTURE_CODES.FOCUS_MAX, 'Structure focus max must be a positive integer', sourcePath, undefined, `/payload/${focusInput.field}`));
  else if (focusInput.count > focusMax) problems.push(diagnostic(STRUCTURE_CODES.FOCUS_MAX, `Structure focus supports at most ${focusMax} cards`, sourcePath, undefined, `/payload/${focusInput.field}`));
  if (!Number.isSafeInteger(focusRarity) || focusRarity < 0) problems.push(diagnostic(STRUCTURE_CODES.FOCUS_RARITY_INVALID, 'Structure focus rarity must be a non-negative safe integer', sourcePath, undefined, '/payload/focusRarity'));
  const seenFocusIds = new Set<number>();
  for (const { sourceName, sourceIndex, selector } of focusNames) {
    const focusPointer = `/payload/${focusInput.field}/${sourceIndex}`;
    const resolution = resolver.resolve({ sourceName, sourcePath, jsonPointer: focusPointer, ...(selector ? { selector } : {}) });
    problems.push(...resolution.problems);
    if (!resolution.ok || resolution.runtimeId === undefined) continue;
    if (seenFocusIds.has(resolution.runtimeId)) {
      problems.push(diagnostic(STRUCTURE_CODES.FOCUS_DUPLICATE, `Structure focus card is duplicated after resolution: ${sourceName}`, sourcePath, undefined, focusPointer));
      continue;
    }
    seenFocusIds.add(resolution.runtimeId);
    focusIds.push(resolution.runtimeId);
    focus.push({
      sourceName,
      sourceIndex,
      ...(resolution.normalizedName ? { normalizedName: resolution.normalizedName } : {}),
      runtimeId: resolution.runtimeId,
      ...(resolution.lockEntry?.matchKind ? { matchKind: resolution.lockEntry.matchKind } : {}),
      ...(resolution.lockEntry?.selector ? { selector: clone(resolution.lockEntry.selector) } : {}),
    });
  }
  if (deckIr) {
    const deckIds = new Set([...deckIr.m.ids, ...deckIr.e.ids, ...deckIr.s.ids]);
    focus.forEach((entry) => {
      if (entry.runtimeId !== undefined && !deckIds.has(entry.runtimeId)) {
        problems.push(diagnostic(STRUCTURE_CODES.FOCUS_NOT_IN_DECK, `Focus card is not present in the referenced deck: ${entry.sourceName}`, sourcePath, undefined, `/payload/${focusInput.field}/${entry.sourceIndex ?? 0}`));
      }
    });
  }

  const errors = problems.filter((entry) => entry.severity !== 'warning');
  const canBuildTarget = errors.length === 0 && targetCapability.allowed && structureId !== undefined && accessory !== undefined && deckIr !== undefined;
  let target: StructureTargetProjection | undefined;
  let projection: StructureProjection | undefined;
  if (canBuildTarget) {
    target = targetProjection(definition, structureId as number, accessory as StructureAccessory, focusIds, focusRarity, deckIr as DeckIR);
    projection = { path: `${STRUCTURE_TARGET_DIRECTORY}/${String(structureId)}.json`, document: target };
  }
  const sorted = problems.sort(compareProblems);
  const warnings = sorted.filter((entry) => entry.severity === 'warning');
  return {
    ok: canBuildTarget,
    contentOk: errors.every((entry) => entry.code !== STRUCTURE_CODES.TARGET_UNVERIFIED),
    ...baseExtras,
    ...(key ? { key } : {}),
    ...(structureId === undefined ? {} : { structureId }),
    ...(registryPlan ? { registry: registryPlan.registry, registryPlan } : {}),
    ...(deck ? { deck } : {}),
    ...(deckIr ? { deckIr } : {}),
    focus,
    localization,
    ...(accessory ? { accessory } : {}),
    ...(target ? { target, projection } : {}),
    targetCapability,
    warnings,
    problems: sorted,
  };
};

export const compileStructureContent = async (
  input: unknown,
  resolver: CardNameResolver,
  options: StructureCompileOptions = {},
): Promise<StructureCompileResult> => {
  try {
    const parsed = asParsed(input, options.sourcePath);
    return compileParsedStructure(parsed, resolver, options);
  } catch (error) {
    const problems = error instanceof StructureContentError
      ? error.problems
      : [diagnostic(STRUCTURE_CODES.ENVELOPE_INVALID, String(error), options.sourcePath)];
    return structureFailure(problems, options);
  }
};

export const compileStructure = compileStructureContent;
export const resolveStructureContent = compileStructureContent;
export const structureToTarget = compileStructureContent;
export const projectStructure = compileStructureContent;
export const projectStructureTarget = compileStructureContent;
export const generateStructureProjection = compileStructureContent;

/** Compile a deterministic set of structures against one registry plan. */
export const compileStructureCollection = async (
  inputs: readonly unknown[],
  resolver: CardNameResolver,
  options: StructureCompileOptions = {},
): Promise<StructureCollectionResult> => {
  const problems: Problem[] = [];
  const parsed: ParsedStructureContent[] = [];
  for (const input of inputs) {
    try {
      parsed.push(asParsed(input, options.sourcePath));
    } catch (error) {
      problems.push(...(error instanceof StructureContentError ? error.problems : [diagnostic(STRUCTURE_CODES.ENVELOPE_INVALID, String(error), options.sourcePath)]));
    }
  }
  const keys: string[] = [];
  const keySeen = new Set<string>();
  for (const document of parsed) {
    const raw = structureKeyOf(document.payload);
    if (!raw) continue;
    try {
      const key = normalizeSymbolicKey(raw);
      if (keySeen.has(key)) problems.push(diagnostic(STRUCTURE_CODES.KEY_DUPLICATE, `Duplicate structure key: ${key}`, document.sourcePath || options.sourcePath, undefined, '/payload/key'));
      keySeen.add(key);
      keys.push(key);
    } catch {
      problems.push(diagnostic(STRUCTURE_CODES.KEY_INVALID, `Invalid structure key: ${raw}`, document.sourcePath || options.sourcePath, undefined, '/payload/key'));
    }
  }
  const registry = options.registry || options.idRegistry;
  let registryPlan: RegistryPlan | undefined;
  const knownIds = new Set<number>(options.knownStructureIds ? [...options.knownStructureIds] : []);
  if (registry && keys.length) {
    const requests: AllocationRequest[] = parsed.flatMap((document) => {
      const keyRaw = structureKeyOf(document.payload);
      if (!keyRaw) return [];
      let key: string;
      try { key = normalizeSymbolicKey(keyRaw); } catch { return []; }
      const pin = targetPinOf(document.payload);
      return [{ namespace: 'structure', key, ...(pin === undefined ? {} : { pin: pin as number }) }];
    });
    try {
      registryPlan = planRegistry(registry, requests, options.registryOptions);
      for (const assignment of Object.values(registryPlan.registry.namespaces.structure.assignments)) knownIds.add(assignment.id);
    } catch (error) {
      const mapped = mapRegistryError(error);
      problems.push(diagnostic(mapped.code, mapped.message, options.sourcePath, undefined, '/registry'));
    }
  } else if (!registry) {
    problems.push(diagnostic(STRUCTURE_CODES.ID_REGISTRY_REQUIRED, 'Structure collection requires an explicit ID registry', options.sourcePath, undefined, '/registry'));
  }
  validateRewardReferences(options.rewardReferences, keys, knownIds, problems);
  const structures: StructureCompileResult[] = [];
  for (const document of parsed) {
    const child = await compileParsedStructure(document, resolver, {
      ...options,
      ...(registryPlan ? { registry: registryPlan.registry, idRegistry: undefined } : {}),
      knownStructureKeys: keys,
      knownStructureIds: knownIds,
      rewardReferences: undefined,
    });
    structures.push(child);
  }
  problems.push(...structures.flatMap((entry) => entry.problems));
  const sorted = problems.sort(compareProblems);
  const warnings = sorted.filter((entry) => entry.severity === 'warning');
  const errors = sorted.filter((entry) => entry.severity !== 'warning');
  return {
    ok: errors.length === 0 && structures.length === inputs.length && structures.every((entry) => entry.ok),
    structures,
    ...(registryPlan ? { registry: registryPlan.registry, registryPlan } : {}),
    warnings,
    problems: sorted,
  };
};

export const compileStructures = compileStructureCollection;
export const projectStructures = compileStructureCollection;
export const validateStructureRewards = (
  references: readonly StructureRewardReference[],
  knownStructureKeys: Iterable<string>,
  knownStructureIds: Iterable<number> = [],
): Problem[] => {
  const problems: Problem[] = [];
  validateRewardReferences(references, knownStructureKeys, knownStructureIds, problems);
  return problems.sort(compareProblems);
};
