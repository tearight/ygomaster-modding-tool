import { CardNameResolver, CardResolution, CardResolutionLock } from './card-resolver';
import {
  ContentFormatError,
  ParsedContentEnvelope,
  SectionedDocument,
  SectionedEntry,
  SourceSpan,
  contentDiagnostic,
  normalizeSymbolicKey,
  normalizeSymbolicReference,
  parseContentEnvelopeWithSource,
  parseSectionedDocument,
} from './content-format';
import type { IdRegistry } from './id-registry';
import { validateRegistry } from './id-registry';
import type { JsonObject, JsonValue, Problem } from './types';

/** The authored Shop source is intentionally separate from the target overlay. */
export const SHOP_CONTENT_FORMAT_VERSION = 1 as const;
export const SHOP_PACK_METADATA_KIND = 'shop-pack' as const;
export const SHOP_ODDS_KIND = 'shop-odds' as const;
export const SHOP_CAPABILITY_KIND = 'shop-capability' as const;
/**
 * The Shop projection is deliberately versioned independently from the
 * workspace's v1 target matrix.  Collection integration can opt into this
 * narrow, fixture-backed subset without making arbitrary Shop overlays legal.
 */
export const SHOP_TARGET_CONTRACT_VERSION = 'ygomaster-campaign-target/v2' as const;
export const SHOP_TARGET_SUPPORTED_SUBSET = 'official-example-pack' as const;

export const SHOP_CONTENT_CODES = Object.freeze({
  ENVELOPE_INVALID: 'SHOP_ENVELOPE_INVALID',
  KIND_INVALID: 'SHOP_KIND_INVALID',
  METADATA_INVALID: 'SHOP_METADATA_INVALID',
  SHOP_ID_MISSING: 'SHOP_ID_MISSING',
  SHOP_ID_SYMBOLIC_REQUIRED: 'SHOP_ID_SYMBOLIC_REQUIRED',
  SHOP_ID_NAMESPACE_INVALID: 'SHOP_ID_NAMESPACE_INVALID',
  SHOP_ID_REGISTRY_INVALID: 'SHOP_ID_REGISTRY_INVALID',
  SHOP_ID_REGISTRY_MISSING: 'SHOP_ID_REGISTRY_MISSING',
  SHOP_ID_UNREGISTERED: 'SHOP_ID_UNREGISTERED',
  PACK_NAME_MISSING: 'SHOP_PACK_NAME_MISSING',
  PACK_PRICE_INVALID: 'SHOP_PACK_PRICE_INVALID',
  PACK_AVAILABILITY_INVALID: 'SHOP_PACK_AVAILABILITY_INVALID',
  PACKLIST_REF_MISSING: 'SHOP_PACKLIST_REF_MISSING',
  ODDS_REF_MISSING: 'SHOP_ODDS_REF_MISSING',
  CONTENT_REF_INVALID: 'SHOP_CONTENT_REF_INVALID',
  PACKLIST_MISSING: 'SHOP_PACKLIST_MISSING',
  PACKLIST_RARITY_MISSING: 'SHOP_PACKLIST_RARITY_MISSING',
  PACKLIST_RARITY_INVALID: 'SHOP_PACKLIST_RARITY_INVALID',
  PACKLIST_CARD_MISSING: 'SHOP_PACKLIST_CARD_MISSING',
  PACKLIST_WEIGHT_INVALID: 'SHOP_PACKLIST_WEIGHT_INVALID',
  PACKLIST_VARIANT_INVALID: 'SHOP_PACKLIST_VARIANT_INVALID',
  PACKLIST_RARITY_CONFLICT: 'SHOP_PACKLIST_RARITY_CONFLICT',
  PACKLIST_EMPTY: 'SHOP_PACKLIST_EMPTY',
  EMPTY_RARITY: 'SHOP_EMPTY_RARITY',
  DUPLICATE_MEMBERSHIP: 'SHOP_DUPLICATE_MEMBERSHIP',
  RESOLVER_REQUIRED: 'SHOP_CARD_RESOLVER_REQUIRED',
  ODDS_MISSING: 'SHOP_ODDS_MISSING',
  ODDS_INVALID: 'SHOP_ODDS_INVALID',
  ODDS_SLOT_MISSING: 'SHOP_ODDS_SLOT_MISSING',
  ODDS_SLOT_INVALID: 'SHOP_ODDS_SLOT_INVALID',
  ODDS_SLOT_DUPLICATE: 'SHOP_ODDS_SLOT_DUPLICATE',
  ODDS_RARITY_MISSING: 'SHOP_ODDS_RARITY_MISSING',
  ODDS_RARITY_INVALID: 'SHOP_ODDS_RARITY_INVALID',
  ODDS_RARITY_DUPLICATE: 'SHOP_ODDS_RARITY_DUPLICATE',
  PROBABILITY_INVALID: 'SHOP_PROBABILITY_INVALID',
  PROBABILITY_SUM_INVALID: 'SHOP_PROBABILITY_SUM_INVALID',
  COLLATION_MISSING: 'SHOP_COLLATION_MISSING',
  COLLATION_INVALID: 'SHOP_COLLATION_INVALID',
  COLLATION_SLOT_UNKNOWN: 'SHOP_COLLATION_SLOT_UNKNOWN',
  COLLATION_SLOT_DUPLICATE: 'SHOP_COLLATION_SLOT_DUPLICATE',
  COLLATION_COUNT_INVALID: 'SHOP_COLLATION_COUNT_INVALID',
  COLLATION_SIZE_MISMATCH: 'SHOP_COLLATION_SIZE_MISMATCH',
  RARITY_ODDS_MISSING: 'SHOP_RARITY_ODDS_MISSING',
  ODDS_RARITY_UNKNOWN: 'SHOP_ODDS_RARITY_UNKNOWN',
  UNLOCK_REF_MISSING: 'SHOP_UNLOCK_REF_MISSING',
  UNLOCK_REF_INVALID: 'SHOP_UNLOCK_REF_INVALID',
  UNLOCK_TARGETS_REQUIRED: 'SHOP_UNLOCK_TARGETS_REQUIRED',
  UNLOCK_REF_UNKNOWN: 'SHOP_UNLOCK_REF_UNKNOWN',
  UNLOCK_SECRET_UNSUPPORTED: 'UNLOCK_SECRET_UNSUPPORTED',
  RARITY_UNSUPPORTED: 'SHOP_RARITY_UNSUPPORTED',
  PACK_SIZE_UNSUPPORTED: 'SHOP_PACK_SIZE_UNSUPPORTED',
  IMAGE_KEY_INVALID: 'SHOP_IMAGE_KEY_INVALID',
  COVER_INVALID: 'SHOP_COVER_INVALID',
  ODDS_NAME_INVALID: 'SHOP_ODDS_NAME_INVALID',
  PACKLIST_WEIGHT_TARGET_IGNORED: 'SHOP_PACKLIST_WEIGHT_TARGET_IGNORED',
  PACKLIST_VARIANT_TARGET_IGNORED: 'SHOP_PACKLIST_VARIANT_TARGET_IGNORED',
  TARGET_UNSUPPORTED: 'SHOP_TARGET_UNSUPPORTED',
} as const);

export type ShopContentCode = (typeof SHOP_CONTENT_CODES)[keyof typeof SHOP_CONTENT_CODES];

export type ShopPackAvailability = 'always' | 'unlock';

export interface ShopPackMetadata {
  shopId: string;
  /** Canonical symbolic reference; it is not a deployed numeric ID. */
  normalizedShopId: string;
  name: string;
  price: number;
  availability: ShopPackAvailability;
  packlist: string;
  odds: string;
  /** Stable named profile emitted into the target odds collection. */
  oddsName?: string;
  unlockRef?: string;
  packSize?: number;
  imageKey?: string;
  /** English cover card name; target projection resolves it to iconMrk. */
  cover?: string;
  [key: string]: unknown;
}

export interface ParsedShopPackMetadata {
  envelope: ParsedContentEnvelope<JsonObject>;
  metadata: ShopPackMetadata;
  sourcePath?: string;
}

export interface ShopPackMetadataParseResult {
  document?: ParsedShopPackMetadata;
  problems: Problem[];
}

export interface PackListEntry {
  rarity: string;
  cardName: string;
  normalizedCardName?: string;
  runtimeId?: number;
  weight?: number;
  variant?: string;
  line: number;
  sourcePath?: string;
  sourceSpan: SourceSpan;
  /** The original normalized sectioned line, retained for diagnostics and review. */
  raw: string;
}

export interface ParsedShopPackList {
  parserVersion: number;
  sourcePath?: string;
  originalText: string;
  entries: PackListEntry[];
  rarities: string[];
  diagnostics: Problem[];
}

export interface ShopPackListParseResult {
  document: ParsedShopPackList;
  problems: Problem[];
}

export interface ShopOddsEntry {
  rarity: string;
  probability: number;
  sourcePointer?: string;
}

export interface ShopOddsSlot {
  name: string;
  count: number;
  entries: ShopOddsEntry[];
  sourcePointer?: string;
}

export interface ShopCollationEntry {
  slot: string;
  count: number;
  sourcePointer?: string;
}

export interface ParsedShopOdds {
  envelope: ParsedContentEnvelope<JsonObject>;
  slots: ShopOddsSlot[];
  collation: ShopCollationEntry[];
  sourcePath?: string;
}

export interface ShopOddsParseResult {
  document?: ParsedShopOdds;
  problems: Problem[];
}

export interface ShopContentSources {
  metadata: unknown;
  packList?: string;
  /** Compatibility spelling for callers that use the authored file name. */
  packlist?: string;
  odds: unknown;
  metadataSourcePath?: string;
  packListSourcePath?: string;
  oddsSourcePath?: string;
  resolver?: CardNameResolver;
}

export interface ShopContentValidationOptions {
  resolver?: CardNameResolver;
  /** Existing ID registry is read-only input; this module never allocates or writes it. */
  registry?: IdRegistry;
  requireRegistryAssignment?: boolean;
  /** Any of these names may be used by callers; all represent known content targets. */
  knownContentTargets?: readonly string[];
  contentTargets?: readonly string[];
  unlockTargets?: readonly string[];
}

export interface ShopContentValidationResult {
  ok: boolean;
  metadata?: ParsedShopPackMetadata;
  packList?: ParsedShopPackList;
  odds?: ParsedShopOdds;
  resolutions: CardResolution[];
  coverResolution?: CardResolution;
  resolutionLock?: CardResolutionLock;
  problems: Problem[];
  warnings: Problem[];
}

export interface ShopOddsTargetEntry extends JsonObject {
  /** Collection-facing unique name, also referenced by Shop.pack.oddsName. */
  name: string;
  gachaType: 1;
  packTypes: [1];
  cardRateList: JsonObject[];
  premiereRateList: JsonObject[];
  /** Kept for collection integration; the deploy writer may omit this field. */
  packShopIds: [number];
}

export interface ShopPackTargetEntry extends JsonObject {
  packId: number;
  productType: 1;
  packType: 1;
  secretType: 0 | 4;
  unlockSecrets: [];
  nameTextId: string;
  descGenerated: true;
  pack_card_num: number;
  subCategory: 1;
  iconMrk: number;
  iconType: 2;
  cardList: Record<string, number>;
  price: number;
  oddsName: string;
  [key: string]: JsonValue;
}

export interface ShopTargetProjection {
  /** Numeric ID assigned by the read-only input registry. */
  shopId: number;
  symbolicShopId: string;
  shopEntry: ShopPackTargetEntry;
  oddsEntry: ShopOddsTargetEntry;
  /** A shop:* unlock is reversed by the collection compiler. */
  predecessorRef?: string;
}

export interface ShopTargetCompileResult extends ShopContentValidationResult {
  deployable: boolean;
  projection?: ShopTargetProjection;
  targetCapability: {
    status: 'assumed';
    contractVersion: typeof SHOP_TARGET_CONTRACT_VERSION;
    supportedSubset: typeof SHOP_TARGET_SUPPORTED_SUBSET;
    evidence: 'official-example';
    projectApproval: 'SHP-002';
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const compareOrdinal = (left: string, right: string): number => {
  if (left === right) return 0;
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftCode = leftPoints[index]?.codePointAt(0) || 0;
    const rightCode = rightPoints[index]?.codePointAt(0) || 0;
    if (leftCode !== rightCode) return leftCode - rightCode;
  }
  return leftPoints.length - rightPoints.length;
};

const problemSort = (left: Problem, right: Problem): number =>
  compareOrdinal(left.sourcePath || left.path || '', right.sourcePath || right.path || '')
  || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
  || (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER)
  || compareOrdinal(left.jsonPointer || '', right.jsonPointer || '')
  || compareOrdinal(left.code, right.code);

const sortedProblems = (problems: readonly Problem[]): Problem[] => [...problems].sort(problemSort);

const diagnostic = (
  code: ShopContentCode,
  message: string,
  sourcePath?: string,
  span?: SourceSpan,
  jsonPointer?: string,
): Problem => contentDiagnostic({ code, message, sourcePath, span, jsonPointer });

const parseEnvelope = (
  input: unknown,
  sourcePath: string | undefined,
  expectedKind: string,
): { parsed?: ParsedContentEnvelope<JsonObject>; problems: Problem[] } => {
  try {
    const parsed = parseContentEnvelopeWithSource<JsonObject>(input, { sourcePath });
    const problems: Problem[] = [];
    if (parsed.envelope.formatVersion !== SHOP_CONTENT_FORMAT_VERSION) {
      problems.push(diagnostic(
        SHOP_CONTENT_CODES.ENVELOPE_INVALID,
        `Shop content formatVersion must be ${SHOP_CONTENT_FORMAT_VERSION}`,
        sourcePath,
        undefined,
        '/formatVersion',
      ));
    }
    if (parsed.envelope.kind !== expectedKind) {
      problems.push(diagnostic(
        SHOP_CONTENT_CODES.KIND_INVALID,
        `Shop content kind must be ${expectedKind}`,
        sourcePath,
        undefined,
        '/kind',
      ));
    }
    return { parsed, problems };
  } catch (error) {
    if (error instanceof ContentFormatError) return { problems: sortedProblems(error.problems) };
    return {
      problems: [diagnostic(SHOP_CONTENT_CODES.ENVELOPE_INVALID, String(error), sourcePath, undefined, '')],
    };
  }
};

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const normalizedPathReference = (value: unknown): string | undefined => {
  if (!nonEmptyString(value)) return undefined;
  const candidate = value.trim().replace(/\\/gu, '/');
  if (candidate.startsWith('/') || /^[A-Za-z]:\//u.test(candidate)) return undefined;
  const segments = candidate.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return undefined;
  return segments.join('/');
};

const normalizeShopId = (
  value: unknown,
  sourcePath?: string,
): { value?: string; problems: Problem[] } => {
  if (!nonEmptyString(value)) {
    return { problems: [diagnostic(SHOP_CONTENT_CODES.SHOP_ID_MISSING, 'Pack metadata requires a symbolic shopId', sourcePath, undefined, '/payload/shopId')] };
  }
  const raw = value.trim();
  if (/^\d+$/u.test(raw)) {
    return { problems: [diagnostic(SHOP_CONTENT_CODES.SHOP_ID_SYMBOLIC_REQUIRED, 'shopId must be a symbolic reference, not a numeric target ID', sourcePath, undefined, '/payload/shopId')] };
  }
  try {
    const reference = normalizeSymbolicReference(raw);
    if (reference.namespace && reference.namespace !== 'shop') {
      return {
        problems: [diagnostic(
          SHOP_CONTENT_CODES.SHOP_ID_NAMESPACE_INVALID,
          `shopId namespace must be shop, received ${reference.namespace}`,
          sourcePath,
          undefined,
          '/payload/shopId',
        )],
      };
    }
    return { value: reference.namespace ? reference.normalized : `shop:${reference.key}`, problems: [] };
  } catch (error) {
    const details = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
    return { problems: [diagnostic(SHOP_CONTENT_CODES.SHOP_ID_SYMBOLIC_REQUIRED, details || 'Invalid symbolic shopId', sourcePath, undefined, '/payload/shopId')] };
  }
};

const parseUnlockReference = (
  payload: Record<string, unknown>,
  sourcePath?: string,
): { value?: string; present: boolean; problems: Problem[] } => {
  const hasUnlock = Object.prototype.hasOwnProperty.call(payload, 'unlock');
  const hasUnlockRef = Object.prototype.hasOwnProperty.call(payload, 'unlockRef');
  if (!hasUnlock && !hasUnlockRef) return { present: false, problems: [] };
  if (hasUnlock && hasUnlockRef) {
    return {
      present: true,
      problems: [diagnostic(SHOP_CONTENT_CODES.UNLOCK_REF_INVALID, 'Use either unlock or unlockRef, not both', sourcePath, undefined, '/payload/unlock')],
    };
  }
  const raw = hasUnlockRef ? payload.unlockRef : payload.unlock;
  const value = isRecord(raw) ? raw.ref ?? raw.target : raw;
  const pointer = hasUnlockRef ? '/payload/unlockRef' : '/payload/unlock';
  if (!nonEmptyString(value) || /^\d+$/u.test(value.trim())) {
    return {
      present: true,
      problems: [diagnostic(SHOP_CONTENT_CODES.UNLOCK_REF_INVALID, 'unlock must contain a symbolic content reference', sourcePath, undefined, pointer)],
    };
  }
  try {
    const normalized = normalizeSymbolicReference(value).normalized;
    return { present: true, value: normalized, problems: [] };
  } catch (error) {
    const details = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
    return { present: true, problems: [diagnostic(SHOP_CONTENT_CODES.UNLOCK_REF_INVALID, details || 'Invalid unlock reference', sourcePath, undefined, pointer)] };
  }
};

const metadataField = (payload: Record<string, unknown>, primary: string, alias: string): { value: unknown; conflict: boolean } => {
  const hasPrimary = Object.prototype.hasOwnProperty.call(payload, primary);
  const hasAlias = Object.prototype.hasOwnProperty.call(payload, alias);
  return {
    value: hasPrimary ? payload[primary] : payload[alias],
    conflict: hasPrimary && hasAlias && payload[primary] !== payload[alias],
  };
};

export const parseShopPackMetadata = (
  input: unknown,
  sourcePath?: string,
): ShopPackMetadataParseResult => {
  const envelopeResult = parseEnvelope(input, sourcePath, SHOP_PACK_METADATA_KIND);
  if (!envelopeResult.parsed) return { problems: envelopeResult.problems };
  const { parsed } = envelopeResult;
  const problems = [...envelopeResult.problems];
  const payload = parsed.envelope.payload;
  const source = sourcePath;
  if (!isRecord(payload)) {
    problems.push(diagnostic(SHOP_CONTENT_CODES.METADATA_INVALID, 'Shop pack metadata payload must be an object', source, undefined, '/payload'));
    return { problems: sortedProblems(problems) };
  }

  const shopId = normalizeShopId(payload.shopId, source);
  problems.push(...shopId.problems);
  if (!nonEmptyString(payload.name)) problems.push(diagnostic(SHOP_CONTENT_CODES.PACK_NAME_MISSING, 'Pack metadata requires a non-empty name', source, undefined, '/payload/name'));
  if (typeof payload.price !== 'number' || !Number.isSafeInteger(payload.price) || payload.price < 0) {
    problems.push(diagnostic(SHOP_CONTENT_CODES.PACK_PRICE_INVALID, 'Pack price must be a non-negative integer', source, undefined, '/payload/price'));
  }
  const availability = payload.availability;
  if (availability !== undefined && availability !== 'always' && availability !== 'unlock') {
    problems.push(diagnostic(SHOP_CONTENT_CODES.PACK_AVAILABILITY_INVALID, 'Pack availability must be always or unlock', source, undefined, '/payload/availability'));
  }
  const packlist = metadataField(payload, 'packlist', 'pool');
  const odds = metadataField(payload, 'odds', 'oddsRef');
  if (packlist.conflict) problems.push(diagnostic(SHOP_CONTENT_CODES.METADATA_INVALID, 'packlist and pool references disagree', source, undefined, '/payload'));
  if (odds.conflict) problems.push(diagnostic(SHOP_CONTENT_CODES.METADATA_INVALID, 'odds and oddsRef references disagree', source, undefined, '/payload'));
  const packlistRef = normalizedPathReference(packlist.value);
  const oddsRef = normalizedPathReference(odds.value);
  if (!packlistRef) problems.push(diagnostic(SHOP_CONTENT_CODES.PACKLIST_REF_MISSING, 'Pack metadata requires a safe relative .packlist reference', source, undefined, '/payload/packlist'));
  else if (!packlistRef.toLowerCase().endsWith('.packlist')) problems.push(diagnostic(SHOP_CONTENT_CODES.CONTENT_REF_INVALID, 'packlist reference must end in .packlist', source, undefined, '/payload/packlist'));
  if (!oddsRef) problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_REF_MISSING, 'Pack metadata requires a safe relative odds JSON reference', source, undefined, '/payload/odds'));
  else if (!oddsRef.toLowerCase().endsWith('.json')) problems.push(diagnostic(SHOP_CONTENT_CODES.CONTENT_REF_INVALID, 'odds reference must end in .json', source, undefined, '/payload/odds'));

  const unlock = parseUnlockReference(payload, source);
  problems.push(...unlock.problems);
  const resolvedAvailability: ShopPackAvailability = availability === 'unlock' ? 'unlock' : 'always';
  if (resolvedAvailability === 'unlock' && !unlock.value) problems.push(diagnostic(SHOP_CONTENT_CODES.UNLOCK_REF_MISSING, 'Unlock availability requires a symbolic unlock reference', source, undefined, '/payload/unlock'));
  if (unlock.value && availability === 'always') problems.push(diagnostic(SHOP_CONTENT_CODES.PACK_AVAILABILITY_INVALID, 'A pack with an unlock reference must use availability unlock', source, undefined, '/payload/availability'));

  let packSize: number | undefined;
  if (payload.packSize !== undefined || payload.cardsPerPack !== undefined) {
    const rawPackSize = payload.packSize ?? payload.cardsPerPack;
    if (typeof rawPackSize !== 'number' || !Number.isSafeInteger(rawPackSize) || rawPackSize <= 0) {
      problems.push(diagnostic(SHOP_CONTENT_CODES.METADATA_INVALID, 'packSize must be a positive integer', source, undefined, '/payload/packSize'));
    } else packSize = rawPackSize;
  }

  const oddsNameValue = payload.oddsName ?? payload.oddsProfile;
  if (oddsNameValue !== undefined && !nonEmptyString(oddsNameValue)) {
    problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_NAME_INVALID, 'oddsName must be a non-empty string when supplied', source, undefined, '/payload/oddsName'));
  }
  const imageKeyValue = payload.imageKey ?? payload.packImage ?? payload.iconData;
  if (imageKeyValue !== undefined && (!nonEmptyString(imageKeyValue) || imageKeyValue.includes('\0'))) {
    problems.push(diagnostic(SHOP_CONTENT_CODES.IMAGE_KEY_INVALID, 'imageKey must be a non-empty string without NUL characters when supplied', source, undefined, '/payload/imageKey'));
  }
  const coverValue = payload.cover ?? payload.coverCard;
  if (coverValue !== undefined && !nonEmptyString(coverValue)) {
    problems.push(diagnostic(SHOP_CONTENT_CODES.COVER_INVALID, 'cover must be a non-empty English card name when supplied', source, undefined, '/payload/cover'));
  }

  if (!shopId.value || !nonEmptyString(payload.name) || typeof payload.price !== 'number' || !Number.isSafeInteger(payload.price) || payload.price < 0 || !packlistRef || !oddsRef) {
    return { problems: sortedProblems(problems) };
  }
  const metadata: ShopPackMetadata = {
    ...payload,
    shopId: payload.shopId as string,
    normalizedShopId: shopId.value,
    name: payload.name,
    price: payload.price,
    availability: resolvedAvailability,
    packlist: packlistRef,
    odds: oddsRef,
    ...(unlock.value ? { unlockRef: unlock.value } : {}),
    ...(packSize !== undefined ? { packSize } : {}),
    ...(nonEmptyString(oddsNameValue) ? { oddsName: oddsNameValue.trim() } : {}),
    ...(nonEmptyString(imageKeyValue) && !imageKeyValue.includes('\0') ? { imageKey: imageKeyValue.trim() } : {}),
    ...(nonEmptyString(coverValue) ? { cover: coverValue.trim() } : {}),
  };
  return {
    document: { envelope: parsed, metadata, ...(source ? { sourcePath: source } : {}) },
    problems: sortedProblems(problems),
  };
};

export const parsePackMetadata = parseShopPackMetadata;
export const parseShopMetadata = parseShopPackMetadata;

const genericPackSections = new Set(['pack', 'pool', 'cards', 'entries']);
const knownRarityTokens = new Set([
  'common', 'normal', 'rare', 'super', 'super-rare', 'sr', 'ultra', 'ultra-rare', 'ur', 'secret', 'prismatic',
  'ultimate', 'ghost', 'starlight', 'foil', 'premium', 'short-print',
]);

/** Rarity codes are the small, explicitly approved subset of Shop.json. */
export const SHOP_TARGET_RARITY_CODES = Object.freeze({
  common: 1,
  normal: 1,
  rare: 2,
  super: 3,
  'super-rare': 3,
  sr: 3,
  ultra: 4,
  'ultra-rare': 4,
  ur: 4,
  secret: 4,
} as const);

const targetRarityCode = (rarity: string): number | undefined => SHOP_TARGET_RARITY_CODES[rarity as keyof typeof SHOP_TARGET_RARITY_CODES];

const entryDiagnostic = (code: ShopContentCode, message: string, entry: SectionedEntry, pointer?: string): Problem =>
  diagnostic(code, message, entry.span.sourcePath, entry.span, pointer);

const packListEntryDiagnostic = (code: ShopContentCode, message: string, entry: PackListEntry, pointer?: string): Problem =>
  diagnostic(code, message, entry.sourcePath, entry.sourceSpan, pointer);

const normalizeRarityToken = (token: string, entry: SectionedEntry): { value?: string; problems: Problem[] } => {
  const trimmed = token.trim().replace(/:$/u, '');
  if (!trimmed) return { problems: [entryDiagnostic(SHOP_CONTENT_CODES.PACKLIST_RARITY_MISSING, 'Packlist entry requires a rarity token', entry)] };
  try {
    const value = normalizeSymbolicKey(trimmed);
    return { value, problems: [] };
  } catch (error) {
    const details = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
    return { problems: [entryDiagnostic(SHOP_CONTENT_CODES.PACKLIST_RARITY_INVALID, details || 'Invalid rarity token', entry)] };
  }
};

const parsePackEntry = (entry: SectionedEntry, index: number): { value?: PackListEntry; problems: Problem[] } => {
  let tokens = [...entry.tokens];
  let rarityToken = entry.section && !genericPackSections.has(entry.section) ? entry.section : undefined;
  if (!rarityToken && tokens[0]) {
    const first = tokens[0] as string;
    const rarityDirective = /^rarity(?:=|:)(.+)$/iu.exec(first);
    const normalizedFirst = first.toLocaleLowerCase('en-US').replace(/:$/u, '');
    if (rarityDirective || !entry.section || genericPackSections.has(entry.section) || knownRarityTokens.has(normalizedFirst)) {
      rarityToken = rarityDirective?.[1] || first;
      tokens = tokens.slice(1);
    }
  }
  if (!rarityToken && tokens[0]) {
    const rarityDirective = /^(?:rarity=|rarity:)(.+)$/iu.exec(tokens[0]);
    if (rarityDirective) {
      rarityToken = rarityDirective[1];
      tokens = tokens.slice(1);
    }
  }
  if (!rarityToken) return { problems: [entryDiagnostic(SHOP_CONTENT_CODES.PACKLIST_RARITY_MISSING, 'Packlist entry requires a rarity token or rarity section', entry, `/entries/${index}`)] };
  const rarity = normalizeRarityToken(rarityToken, entry);
  const problems = [...rarity.problems];
  if (!rarity.value) return { problems };

  let weight: number | undefined;
  let variant: string | undefined;
  while (tokens.length) {
    const token = tokens[0] as string;
    const weightDirective = /^weight=(.*)$/iu.exec(token);
    const variantDirective = /^(?:variant=|variant:)(.*)$/iu.exec(token);
    if (weightDirective || (!weight && /^\d+(?:\.\d+)?$/u.test(token))) {
      tokens = tokens.slice(1);
      const rawWeight = weightDirective?.[1] || token;
      const parsedWeight = Number(rawWeight);
      if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) problems.push(entryDiagnostic(SHOP_CONTENT_CODES.PACKLIST_WEIGHT_INVALID, 'Packlist weight must be a finite positive number', entry, `/entries/${index}/weight`));
      else weight = parsedWeight;
      continue;
    }
    if (variantDirective || token.startsWith('@')) {
      tokens = tokens.slice(1);
      const rawVariant = variantDirective?.[1] || token.slice(1);
      if (!rawVariant.trim()) problems.push(entryDiagnostic(SHOP_CONTENT_CODES.PACKLIST_VARIANT_INVALID, 'Packlist variant cannot be empty', entry, `/entries/${index}/variant`));
      else {
        try {
          variant = normalizeSymbolicKey(rawVariant);
        } catch (error) {
          const details = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
          problems.push(entryDiagnostic(SHOP_CONTENT_CODES.PACKLIST_VARIANT_INVALID, details || 'Invalid packlist variant', entry, `/entries/${index}/variant`));
        }
      }
      continue;
    }
    break;
  }
  const cardName = tokens.join(' ').trim();
  if (!cardName) problems.push(entryDiagnostic(SHOP_CONTENT_CODES.PACKLIST_CARD_MISSING, 'Packlist entry requires a card name', entry, `/entries/${index}/cardName`));
  if (problems.length) return { problems };
  return {
    value: {
      rarity: rarity.value,
      cardName,
      ...(weight !== undefined ? { weight } : {}),
      ...(variant !== undefined ? { variant } : {}),
      line: entry.line,
      ...(entry.span.sourcePath ? { sourcePath: entry.span.sourcePath } : {}),
      sourceSpan: entry.span,
      raw: entry.raw,
    },
    problems,
  };
};

export const parseShopPackList = (
  source: string,
  sourcePath?: string,
): ShopPackListParseResult => {
  if (typeof source !== 'string') {
    return {
      document: {
        parserVersion: 1,
        ...(sourcePath ? { sourcePath } : {}),
        originalText: '',
        entries: [],
        rarities: [],
        diagnostics: [],
      },
      problems: [diagnostic(SHOP_CONTENT_CODES.PACKLIST_MISSING, 'Packlist source must be text', sourcePath, undefined, '')],
    };
  }
  const document: SectionedDocument = parseSectionedDocument(source, sourcePath);
  const problems = [...document.diagnostics];
  const entries: PackListEntry[] = [];
  document.entries.forEach((entry, index) => {
    const parsed = parsePackEntry(entry, index);
    problems.push(...parsed.problems);
    if (parsed.value) entries.push(parsed.value);
  });
  const raritySet = new Set(entries.map((entry) => entry.rarity));
  for (const section of document.sections) {
    if (!genericPackSections.has(section.normalizedName) && section.entries.length === 0) {
      problems.push(diagnostic(SHOP_CONTENT_CODES.EMPTY_RARITY, `Rarity section ${section.normalizedName} has no valid card members`, sourcePath, section.span, `/sections/${section.normalizedName}`));
    }
  }
  if (!entries.length) problems.push(diagnostic(SHOP_CONTENT_CODES.PACKLIST_EMPTY, 'Packlist contains no valid card members', sourcePath, undefined, ''));
  const parsedDocument: ParsedShopPackList = {
    parserVersion: document.parserVersion,
    ...(sourcePath ? { sourcePath } : {}),
    originalText: document.originalText,
    entries,
    rarities: [...raritySet].sort(compareOrdinal),
    diagnostics: sortedProblems(document.diagnostics),
  };
  return { document: parsedDocument, problems: sortedProblems(problems) };
};

export const parsePackList = parseShopPackList;
export const parseShopPool = parseShopPackList;

const parseOddsEntries = (raw: unknown, slotPointer: string, problems: Problem[], sourcePath?: string): ShopOddsEntry[] => {
  const entries: ShopOddsEntry[] = [];
  if (Array.isArray(raw)) {
    raw.forEach((value, index) => {
      const pointer = `${slotPointer}/entries/${index}`;
      if (!isRecord(value)) {
        problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_RARITY_INVALID, 'Odds entry must be an object', sourcePath, undefined, pointer));
        return;
      }
      const rarity = value.rarity ?? value.token;
      if (!nonEmptyString(rarity)) {
        problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_RARITY_MISSING, 'Odds entry requires a rarity token', sourcePath, undefined, `${pointer}/rarity`));
        return;
      }
      const rawProbability = value.probability ?? value.weight;
      if (typeof rawProbability !== 'number' || !Number.isFinite(rawProbability)) {
        problems.push(diagnostic(SHOP_CONTENT_CODES.PROBABILITY_INVALID, 'Odds probability must be a finite number', sourcePath, undefined, `${pointer}/probability`));
        return;
      }
      let normalizedRarity: string;
      try {
        normalizedRarity = normalizeSymbolicKey(rarity);
      } catch (error) {
        const details = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
        problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_RARITY_INVALID, details || 'Invalid odds rarity', sourcePath, undefined, `${pointer}/rarity`));
        return;
      }
      entries.push({ rarity: normalizedRarity, probability: rawProbability, sourcePointer: pointer });
    });
    return entries;
  }
  if (isRecord(raw)) {
    for (const [rarity, probability] of Object.entries(raw)) {
      const pointer = `${slotPointer}/probabilities/${rarity}`;
      if (typeof probability !== 'number' || !Number.isFinite(probability)) {
        problems.push(diagnostic(SHOP_CONTENT_CODES.PROBABILITY_INVALID, 'Odds probability must be a finite number', sourcePath, undefined, pointer));
        continue;
      }
      try {
        entries.push({ rarity: normalizeSymbolicKey(rarity), probability, sourcePointer: pointer });
      } catch (error) {
        const details = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
        problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_RARITY_INVALID, details || 'Invalid odds rarity', sourcePath, undefined, pointer));
      }
    }
    return entries;
  }
  problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_RARITY_INVALID, 'Odds slot requires entries or probabilities', sourcePath, undefined, slotPointer));
  return entries;
};

const parseSlotArray = (raw: unknown, problems: Problem[], sourcePath?: string): ShopOddsSlot[] => {
  const slots: ShopOddsSlot[] = [];
  const values: Array<{ value: unknown; name?: string; pointer: string }> = [];
  if (Array.isArray(raw)) raw.forEach((value, index) => values.push({ value, pointer: `/payload/slots/${index}` }));
  else if (isRecord(raw)) Object.entries(raw).forEach(([name, value]) => values.push({ value, name, pointer: `/payload/slots/${name}` }));
  else {
    problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_SLOT_MISSING, 'Odds payload requires a slots array or object', sourcePath, undefined, '/payload/slots'));
    return slots;
  }
  if (!values.length) problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_SLOT_MISSING, 'Odds payload must define at least one slot', sourcePath, undefined, '/payload/slots'));
  values.forEach(({ value, name, pointer }) => {
    if (!isRecord(value)) {
      problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_SLOT_INVALID, 'Odds slot must be an object', sourcePath, undefined, pointer));
      return;
    }
    const slotName = value.name ?? value.id ?? name;
    if (!nonEmptyString(slotName)) {
      problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_SLOT_INVALID, 'Odds slot requires a name', sourcePath, undefined, `${pointer}/name`));
      return;
    }
    const countValue = value.count ?? value.cards ?? 1;
    if (typeof countValue !== 'number' || !Number.isSafeInteger(countValue) || countValue <= 0) {
      problems.push(diagnostic(SHOP_CONTENT_CODES.COLLATION_COUNT_INVALID, 'Odds slot count must be a positive integer', sourcePath, undefined, `${pointer}/count`));
      return;
    }
    const rawEntries = value.entries ?? value.rarities ?? value.probabilities;
    const slotEntries = parseOddsEntries(rawEntries, pointer, problems, sourcePath);
    try {
      slots.push({ name: normalizeSymbolicKey(slotName), count: countValue, entries: slotEntries, sourcePointer: pointer });
    } catch (error) {
      const details = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
      problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_SLOT_INVALID, details || 'Invalid odds slot name', sourcePath, undefined, `${pointer}/name`));
    }
  });
  return slots;
};

const parseCollation = (raw: unknown, problems: Problem[], sourcePath?: string): ShopCollationEntry[] => {
  if (raw === undefined) {
    problems.push(diagnostic(SHOP_CONTENT_CODES.COLLATION_MISSING, 'Odds payload requires a collation definition', sourcePath, undefined, '/payload/collation'));
    return [];
  }
  const values: Array<{ slot: string; count: unknown; pointer: string }> = [];
  if (Array.isArray(raw)) {
    raw.forEach((value, index) => {
      if (!isRecord(value)) {
        problems.push(diagnostic(SHOP_CONTENT_CODES.COLLATION_INVALID, 'Collation entry must be an object', sourcePath, undefined, `/payload/collation/${index}`));
        return;
      }
      values.push({ slot: String(value.slot ?? value.slotId ?? ''), count: value.count ?? value.cards, pointer: `/payload/collation/${index}` });
    });
  } else if (isRecord(raw)) {
    Object.entries(raw).forEach(([slot, count]) => values.push({ slot, count, pointer: `/payload/collation/${slot}` }));
  } else {
    problems.push(diagnostic(SHOP_CONTENT_CODES.COLLATION_INVALID, 'Collation must be an array or object', sourcePath, undefined, '/payload/collation'));
    return [];
  }
  if (!values.length) problems.push(diagnostic(SHOP_CONTENT_CODES.COLLATION_INVALID, 'Collation must define at least one slot count', sourcePath, undefined, '/payload/collation'));
  return values.flatMap(({ slot, count, pointer }) => {
    if (!nonEmptyString(slot)) {
      problems.push(diagnostic(SHOP_CONTENT_CODES.COLLATION_INVALID, 'Collation entry requires a slot', sourcePath, undefined, `${pointer}/slot`));
      return [];
    }
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
      problems.push(diagnostic(SHOP_CONTENT_CODES.COLLATION_COUNT_INVALID, 'Collation count must be a positive integer', sourcePath, undefined, `${pointer}/count`));
      return [];
    }
    try {
      return [{ slot: normalizeSymbolicKey(slot), count, sourcePointer: pointer }];
    } catch (error) {
      const details = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
      problems.push(diagnostic(SHOP_CONTENT_CODES.COLLATION_INVALID, details || 'Invalid collation slot', sourcePath, undefined, `${pointer}/slot`));
      return [];
    }
  });
};

export const parseShopOdds = (input: unknown, sourcePath?: string): ShopOddsParseResult => {
  if (input === undefined) {
    return { problems: [diagnostic(SHOP_CONTENT_CODES.ODDS_MISSING, 'Shop content requires a versioned odds JSON source', sourcePath, undefined, '')] };
  }
  const envelopeResult = parseEnvelope(input, sourcePath, SHOP_ODDS_KIND);
  if (!envelopeResult.parsed) return { problems: envelopeResult.problems };
  const problems = [...envelopeResult.problems];
  const payload = envelopeResult.parsed.envelope.payload;
  if (!isRecord(payload)) {
    problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_INVALID, 'Shop odds payload must be an object', sourcePath, undefined, '/payload'));
    return { problems: sortedProblems(problems) };
  }
  const slots = parseSlotArray(payload.slots ?? payload.slotOdds, problems, sourcePath);
  const duplicateSlots = new Set<string>();
  for (const slot of slots) {
    if (duplicateSlots.has(slot.name)) problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_SLOT_DUPLICATE, `Odds slot ${slot.name} is declared more than once`, sourcePath, undefined, slot.sourcePointer));
    duplicateSlots.add(slot.name);
  }
  const collation = parseCollation(payload.collation, problems, sourcePath);
  const document: ParsedShopOdds = {
    envelope: envelopeResult.parsed,
    slots,
    collation,
    ...(sourcePath ? { sourcePath } : {}),
  };
  return { document, problems: sortedProblems(problems) };
};

export const parseOdds = parseShopOdds;
export const parseShopOddsContent = parseShopOdds;

const extractResolver = (
  input: ShopContentSources,
  options: ShopContentValidationOptions | CardNameResolver | undefined,
): { resolver?: CardNameResolver; options: ShopContentValidationOptions } => {
  if (options instanceof CardNameResolver) return { resolver: options, options: {} };
  const normalizedOptions = options || {};
  return { resolver: normalizedOptions.resolver || input.resolver, options: normalizedOptions };
};

const knownTargets = (options: ShopContentValidationOptions): Set<string> | undefined => {
  const values = options.knownContentTargets ?? options.contentTargets ?? options.unlockTargets;
  if (values === undefined) return undefined;
  const result = new Set<string>();
  for (const value of values) {
    try { result.add(normalizeSymbolicReference(value).normalized); } catch { /* reported when content reference itself is parsed */ }
  }
  return result;
};

const validateRegistryInput = (
  metadata: ParsedShopPackMetadata | undefined,
  options: ShopContentValidationOptions,
): Problem[] => {
  if (!options.registry) {
    return options.requireRegistryAssignment
      ? [diagnostic(SHOP_CONTENT_CODES.SHOP_ID_REGISTRY_MISSING, 'A registry input is required when registry assignment is explicitly requested')]
      : [];
  }
  const registryProblems = validateRegistry(options.registry);
  if (registryProblems.length) {
    return [diagnostic(SHOP_CONTENT_CODES.SHOP_ID_REGISTRY_INVALID, 'Shop ID registry input is invalid; allocation is outside Shop content validation', undefined, undefined, '')];
  }
  if (!metadata || !options.requireRegistryAssignment) return [];
  const key = metadata.metadata.normalizedShopId.replace(/^shop:/u, '');
  const assignment = options.registry.namespaces.shop.assignments[key];
  return assignment
    ? []
    : [diagnostic(SHOP_CONTENT_CODES.SHOP_ID_UNREGISTERED, `Symbolic shop ID is not registered: ${metadata.metadata.normalizedShopId}`, metadata.sourcePath, undefined, '/payload/shopId')];
};

const validateUnlockTarget = (
  metadata: ParsedShopPackMetadata | undefined,
  options: ShopContentValidationOptions,
): Problem[] => {
  const unlockRef = metadata?.metadata.unlockRef;
  if (!unlockRef) return [];
  const suppliedTargets = options.knownContentTargets ?? options.contentTargets ?? options.unlockTargets;
  if (suppliedTargets === undefined) {
    return [diagnostic(
      SHOP_CONTENT_CODES.UNLOCK_TARGETS_REQUIRED,
      'Unlock validation requires knownContentTargets, contentTargets, or unlockTargets; deployment capability is not inferred',
      metadata?.sourcePath,
      undefined,
      '/payload/unlock',
    )];
  }
  const targets = knownTargets(options);
  if (targets?.has(unlockRef)) return [];
  return [diagnostic(SHOP_CONTENT_CODES.UNLOCK_REF_UNKNOWN, `Unlock reference does not resolve to a known content target: ${unlockRef}`, metadata?.sourcePath, undefined, '/payload/unlock')];
};

const validateOddsSemantics = (
  odds: ParsedShopOdds | undefined,
  packList: ParsedShopPackList | undefined,
  metadata: ParsedShopPackMetadata | undefined,
): Problem[] => {
  if (!odds) return [];
  const problems: Problem[] = [];
  const slotByName = new Map<string, ShopOddsSlot>();
  for (const slot of odds.slots) {
    slotByName.set(slot.name, slot);
    if (!slot.entries.length) problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_RARITY_MISSING, `Odds slot ${slot.name} has no rarity probabilities`, odds.sourcePath, undefined, slot.sourcePointer));
    const raritySet = new Set<string>();
    let sum = 0;
    for (const entry of slot.entries) {
      if (raritySet.has(entry.rarity)) problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_RARITY_DUPLICATE, `Odds slot ${slot.name} repeats rarity ${entry.rarity}`, odds.sourcePath, undefined, entry.sourcePointer));
      raritySet.add(entry.rarity);
      if (!Number.isFinite(entry.probability) || entry.probability <= 0 || entry.probability > 1) problems.push(diagnostic(SHOP_CONTENT_CODES.PROBABILITY_INVALID, `Probability for ${slot.name}/${entry.rarity} must be greater than 0 and at most 1`, odds.sourcePath, undefined, entry.sourcePointer));
      sum += entry.probability;
    }
    if (slot.entries.length && Math.abs(sum - 1) > 1e-9) problems.push(diagnostic(SHOP_CONTENT_CODES.PROBABILITY_SUM_INVALID, `Probabilities for slot ${slot.name} must sum to 1 (received ${String(sum)})`, odds.sourcePath, undefined, slot.sourcePointer));
  }
  const collationSlots = new Set<string>();
  let collationSize = 0;
  for (const collation of odds.collation) {
    if (collationSlots.has(collation.slot)) problems.push(diagnostic(SHOP_CONTENT_CODES.COLLATION_SLOT_DUPLICATE, `Collation repeats slot ${collation.slot}`, odds.sourcePath, undefined, collation.sourcePointer));
    collationSlots.add(collation.slot);
    if (!slotByName.has(collation.slot)) problems.push(diagnostic(SHOP_CONTENT_CODES.COLLATION_SLOT_UNKNOWN, `Collation references unknown slot ${collation.slot}`, odds.sourcePath, undefined, collation.sourcePointer));
    const slot = slotByName.get(collation.slot);
    if (slot && slot.count !== collation.count) problems.push(diagnostic(SHOP_CONTENT_CODES.COLLATION_SIZE_MISMATCH, `Collation count for ${collation.slot} is ${String(collation.count)} but the slot declares ${String(slot.count)}`, odds.sourcePath, undefined, collation.sourcePointer));
    collationSize += collation.count;
  }
  for (const slot of odds.slots) {
    if (!collationSlots.has(slot.name)) problems.push(diagnostic(SHOP_CONTENT_CODES.COLLATION_SLOT_UNKNOWN, `Odds slot ${slot.name} is not present in collation`, odds.sourcePath, undefined, slot.sourcePointer));
  }
  if (metadata?.metadata.packSize !== undefined && collationSize !== metadata.metadata.packSize) {
    problems.push(diagnostic(SHOP_CONTENT_CODES.COLLATION_SIZE_MISMATCH, `Collation contains ${String(collationSize)} cards but packSize is ${String(metadata.metadata.packSize)}`, metadata.sourcePath, undefined, '/payload/packSize'));
  }
  if (packList) {
    const poolRarities = new Set(packList.rarities);
    const activeRarities = new Set<string>();
    for (const collation of odds.collation) {
      const slot = slotByName.get(collation.slot);
      slot?.entries.forEach((entry) => activeRarities.add(entry.rarity));
    }
    for (const rarity of poolRarities) if (!activeRarities.has(rarity)) problems.push(diagnostic(SHOP_CONTENT_CODES.RARITY_ODDS_MISSING, `Pack rarity ${rarity} has no probability in a collated slot`, packList.sourcePath));
    for (const rarity of activeRarities) if (!poolRarities.has(rarity)) problems.push(diagnostic(SHOP_CONTENT_CODES.ODDS_RARITY_UNKNOWN, `Odds references rarity ${rarity}, but the packlist has no such rarity`, odds.sourcePath));
  }
  return problems;
};

const validateCardMembership = (
  packList: ParsedShopPackList | undefined,
  resolver: CardNameResolver | undefined,
): { resolutions: CardResolution[]; resolutionLock?: CardResolutionLock; problems: Problem[] } => {
  if (!packList) return { resolutions: [], problems: [] };
  if (!resolver) return { resolutions: [], problems: [diagnostic(SHOP_CONTENT_CODES.RESOLVER_REQUIRED, 'Shop content validation requires the shared CardNameResolver')] };
  const problems: Problem[] = [];
  const resolutions: CardResolution[] = [];
  const byRuntimeId = new Map<number, PackListEntry>();
  const byNormalizedName = new Map<string, PackListEntry>();
  for (const entry of packList.entries) {
    const resolution = resolver.resolve({
      sourceName: entry.cardName,
      sourcePath: entry.sourcePath,
      sourceSpan: entry.sourceSpan,
      jsonPointer: `/entries/${entry.line}/cardName`,
    });
    resolutions.push(resolution);
    problems.push(...resolution.problems);
    if (!resolution.ok || resolution.runtimeId === undefined) continue;
    entry.normalizedCardName = resolution.normalizedName;
    entry.runtimeId = resolution.runtimeId;
    const previousRuntime = byRuntimeId.get(resolution.runtimeId);
    if (previousRuntime) {
      problems.push(packListEntryDiagnostic(
        SHOP_CONTENT_CODES.DUPLICATE_MEMBERSHIP,
        `Card ${entry.cardName} is already a member of rarity ${previousRuntime.rarity}; a card may belong to only one rarity`,
        entry,
        `/entries/${entry.line}/cardName`,
      ));
    } else byRuntimeId.set(resolution.runtimeId, entry);
    if (resolution.normalizedName) {
      const previousName = byNormalizedName.get(resolution.normalizedName);
      if (previousName && previousName !== previousRuntime) {
        problems.push(packListEntryDiagnostic(
          SHOP_CONTENT_CODES.DUPLICATE_MEMBERSHIP,
          `Normalized card name ${resolution.normalizedName} occurs in multiple rarity memberships`,
          entry,
          `/entries/${entry.line}/cardName`,
        ));
      } else byNormalizedName.set(resolution.normalizedName, entry);
    }
  }
  let resolutionLock: CardResolutionLock | undefined;
  if (resolutions.length && resolutions.every((resolution) => resolution.ok)) {
    const batch = resolver.resolveBatch(packList.entries.map((entry) => ({
      sourceName: entry.cardName,
      sourcePath: entry.sourcePath,
      sourceSpan: entry.sourceSpan,
      jsonPointer: `/entries/${entry.line}/cardName`,
    })));
    resolutionLock = batch.lock;
  }
  return { resolutions, ...(resolutionLock ? { resolutionLock } : {}), problems };
};

const validateCoverCard = (
  metadata: ParsedShopPackMetadata | undefined,
  resolver: CardNameResolver | undefined,
): { resolution?: CardResolution; problems: Problem[] } => {
  const cover = metadata?.metadata.cover;
  if (!cover) return { problems: [] };
  if (!resolver) return {
    problems: [diagnostic(SHOP_CONTENT_CODES.RESOLVER_REQUIRED, 'Shop cover validation requires the shared CardNameResolver', metadata?.sourcePath, undefined, '/payload/cover')],
  };
  const resolution = resolver.resolve({
    sourceName: cover,
    sourcePath: metadata?.sourcePath,
    jsonPointer: '/payload/cover',
  });
  return { resolution, problems: resolution.problems };
};

const emptyPackList = (sourcePath?: string): ShopPackListParseResult => ({
  document: {
    parserVersion: 1,
    ...(sourcePath ? { sourcePath } : {}),
    originalText: '',
    entries: [],
    rarities: [],
    diagnostics: [],
  },
  problems: [diagnostic(SHOP_CONTENT_CODES.PACKLIST_MISSING, 'Shop content requires a .packlist source', sourcePath, undefined, '')],
});

export function validateShopContent(
  input: ShopContentSources,
  options?: ShopContentValidationOptions | CardNameResolver,
): ShopContentValidationResult {
  const extracted = extractResolver(input, options);
  const resolver = extracted.resolver;
  const normalizedOptions = extracted.options;
  const metadataResult = parseShopPackMetadata(input.metadata, input.metadataSourcePath);
  const packListSource = input.packList ?? input.packlist;
  const packListResult = packListSource === undefined
    ? emptyPackList(input.packListSourcePath)
    : parseShopPackList(packListSource, input.packListSourcePath);
  const oddsResult = parseShopOdds(input.odds, input.oddsSourcePath);
  const problems = [
    ...metadataResult.problems,
    ...packListResult.problems,
    ...oddsResult.problems,
    ...validateRegistryInput(metadataResult.document, normalizedOptions),
    ...validateUnlockTarget(metadataResult.document, normalizedOptions),
  ];
  const cardMembership = validateCardMembership(packListResult.document, resolver);
  problems.push(...cardMembership.problems);
  const cover = validateCoverCard(metadataResult.document, resolver);
  problems.push(...cover.problems);
  problems.push(...validateOddsSemantics(oddsResult.document, packListResult.document, metadataResult.document));
  return {
    ok: problems.length === 0,
    ...(metadataResult.document ? { metadata: metadataResult.document } : {}),
    packList: packListResult.document,
    ...(oddsResult.document ? { odds: oddsResult.document } : {}),
    resolutions: [...cardMembership.resolutions, ...(cover.resolution ? [cover.resolution] : [])],
    ...(cover.resolution ? { coverResolution: cover.resolution } : {}),
    ...(cardMembership.resolutionLock ? { resolutionLock: cardMembership.resolutionLock } : {}),
    problems: sortedProblems(problems),
    warnings: [],
  };
}

export const validateShopPackContent = validateShopContent;
export const validateShop = validateShopContent;

const registryShopTargets = (registry: IdRegistry | undefined): string[] | undefined => {
  if (!registry) return undefined;
  const assignments = registry.namespaces.shop.assignments;
  return Object.keys(assignments).sort(compareOrdinal).map((key) => `shop:${key}`);
};

const compileOptions = (
  input: ShopContentSources,
  options: ShopContentValidationOptions | CardNameResolver | undefined,
): ShopContentValidationOptions => {
  const extracted = extractResolver(input, options);
  const normalized: ShopContentValidationOptions = {
    ...extracted.options,
    ...(extracted.resolver ? { resolver: extracted.resolver } : {}),
    requireRegistryAssignment: true,
  };
  const hasExplicitTargets = normalized.knownContentTargets !== undefined
    || normalized.contentTargets !== undefined
    || normalized.unlockTargets !== undefined;
  if (!hasExplicitTargets && normalized.registry) {
    const targets = registryShopTargets(normalized.registry);
    if (targets) normalized.knownContentTargets = targets;
  }
  return normalized;
};

const targetRarityProblems = (
  packList: ParsedShopPackList | undefined,
  odds: ParsedShopOdds | undefined,
): Problem[] => {
  const problems: Problem[] = [];
  for (const entry of packList?.entries || []) {
    if (targetRarityCode(entry.rarity) === undefined) {
      problems.push(packListEntryDiagnostic(
        SHOP_CONTENT_CODES.RARITY_UNSUPPORTED,
        `Shop target rarity is unsupported: ${entry.rarity}`,
        entry,
        `/entries/${entry.line}/rarity`,
      ));
    }
  }
  for (const slot of odds?.slots || []) {
    for (const entry of slot.entries) {
      if (targetRarityCode(entry.rarity) === undefined) {
        problems.push(diagnostic(
          SHOP_CONTENT_CODES.RARITY_UNSUPPORTED,
          `Shop target rarity is unsupported: ${entry.rarity}`,
          odds?.sourcePath,
          undefined,
          `${entry.sourcePointer || `/payload/slots/${slot.name}`}/rarity`,
        ));
      }
    }
  }
  return problems;
};

const targetWarnings = (packList: ParsedShopPackList | undefined): Problem[] => {
  const warnings: Problem[] = [];
  for (const entry of packList?.entries || []) {
    if (entry.weight !== undefined) warnings.push({
      ...packListEntryDiagnostic(
        SHOP_CONTENT_CODES.PACKLIST_WEIGHT_TARGET_IGNORED,
        'Packlist weight is authored metadata; the approved Shop target subset emits one rarity code per card',
        entry,
        `/entries/${entry.line}/weight`,
      ),
      severity: 'warning',
    });
    if (entry.variant !== undefined) warnings.push({
      ...packListEntryDiagnostic(
        SHOP_CONTENT_CODES.PACKLIST_VARIANT_TARGET_IGNORED,
        'Packlist variant is authored metadata; the approved Shop target subset has no variant field',
        entry,
        `/entries/${entry.line}/variant`,
      ),
      severity: 'warning',
    });
  }
  return warnings;
};

const targetPackSize = (
  metadata: ParsedShopPackMetadata | undefined,
  odds: ParsedShopOdds | undefined,
): number | undefined => metadata?.metadata.packSize
  ?? (odds?.collation.reduce((total, entry) => total + entry.count, 0) || undefined);

const targetPackSizeProblems = (
  metadata: ParsedShopPackMetadata | undefined,
  odds: ParsedShopOdds | undefined,
): Problem[] => {
  const packSize = targetPackSize(metadata, odds);
  if (packSize !== undefined && packSize > 8) {
    return [diagnostic(
      SHOP_CONTENT_CODES.PACK_SIZE_UNSUPPORTED,
      `Shop target packs may contain at most 8 cards (received ${String(packSize)})`,
      metadata?.sourcePath,
      undefined,
      '/payload/packSize',
    )];
  }
  return [];
};

const targetUnlockProblems = (metadata: ParsedShopPackMetadata | undefined): Problem[] => {
  const unlockRef = metadata?.metadata.unlockRef;
  if (!unlockRef || unlockRef.startsWith('shop:')) return [];
  return [diagnostic(
    SHOP_CONTENT_CODES.UNLOCK_SECRET_UNSUPPORTED,
    `Shop target progression only supports shop:* predecessor references; ${unlockRef} is not a Shop pack`,
    metadata?.sourcePath,
    undefined,
    '/payload/unlock',
  )];
};

const deterministicOddsName = (metadata: ShopPackMetadata): string => {
  const key = metadata.normalizedShopId.replace(/^shop:/u, '');
  const safeKey = key.replace(/[^A-Za-z0-9_-]/gu, '-');
  return metadata.oddsName ? `${metadata.oddsName}:${key}` : `shop-${safeKey}-odds`;
};

const percentage = (value: number): string => (value * 100).toFixed(2);

const makeOddsTargetEntry = (
  odds: ParsedShopOdds,
  shopId: number,
  oddsName: string,
): ShopOddsTargetEntry => {
  let cursor = 1;
  const cardRateList: JsonObject[] = [];
  const slots = new Map(odds.slots.map((slot) => [slot.name, slot]));
  for (const collation of odds.collation) {
    const slot = slots.get(collation.slot);
    if (!slot) continue;
    const rateByCode = new Map<number, number>();
    for (const entry of slot.entries) {
      const code = targetRarityCode(entry.rarity);
      if (code !== undefined) rateByCode.set(code, (rateByCode.get(code) || 0) + entry.probability);
    }
    const rate = Object.fromEntries(
      [...rateByCode.entries()]
        .sort(([left], [right]) => left - right)
        .map(([code, probability]) => [String(code), { rate: percentage(probability) }]),
    ) as JsonObject;
    cardRateList.push({
      start_num: cursor,
      end_num: cursor + collation.count - 1,
      standard: false,
      rate,
    });
    cursor += collation.count;
  }
  return {
    name: oddsName,
    gachaType: 1,
    packTypes: [1],
    cardRateList,
    premiereRateList: [],
    packShopIds: [shopId],
  };
};

const makePackTargetEntry = (
  metadata: ParsedShopPackMetadata,
  packList: ParsedShopPackList,
  validation: ShopContentValidationResult,
  shopId: number,
  oddsName: string,
  packSize: number,
): ShopPackTargetEntry => {
  const orderedEntries = [...packList.entries].sort((left, right) => (left.runtimeId || Number.MAX_SAFE_INTEGER) - (right.runtimeId || Number.MAX_SAFE_INTEGER) || compareOrdinal(left.cardName, right.cardName));
  const cardList = Object.fromEntries(orderedEntries.map((entry) => [
    String(entry.runtimeId),
    targetRarityCode(entry.rarity) as number,
  ]));
  const coverId = validation.coverResolution?.runtimeId || orderedEntries[0]?.runtimeId;
  const imageKey = metadata.metadata.imageKey;
  return {
    packId: shopId,
    productType: 1,
    packType: 1,
    secretType: metadata.metadata.availability === 'unlock' ? 4 : 0,
    unlockSecrets: [],
    nameTextId: metadata.metadata.name,
    descGenerated: true,
    pack_card_num: packSize,
    subCategory: 1,
    iconMrk: coverId as number,
    iconType: 2,
    ...(imageKey ? {
      iconData: imageKey,
      preview: [{ type: 3, path: imageKey }],
      packImage: imageKey,
    } : {}),
    cardList,
    price: metadata.metadata.price,
    oddsName,
  };
};

/**
 * Compile the explicitly approved official-example Shop subset.  The result
 * is a pure projection; collection/deployment owns overlay merge and writes.
 */
export const compileShopContent = (
  input: ShopContentSources,
  options?: ShopContentValidationOptions | CardNameResolver,
): ShopTargetCompileResult => {
  const normalizedOptions = compileOptions(input, options);
  const validation = validateShopContent(input, normalizedOptions);
  const targetProblems = [
    ...targetRarityProblems(validation.packList, validation.odds),
    ...targetPackSizeProblems(validation.metadata, validation.odds),
    ...targetUnlockProblems(validation.metadata),
  ];
  const warnings = [...validation.warnings, ...targetWarnings(validation.packList)];
  const problems = sortedProblems([...validation.problems, ...targetProblems]);
  let projection: ShopTargetProjection | undefined;
  if (!problems.length && validation.metadata && validation.packList && validation.odds) {
    const key = validation.metadata.metadata.normalizedShopId.replace(/^shop:/u, '');
    const assignment = normalizedOptions.registry?.namespaces.shop.assignments[key];
    const packSize = targetPackSize(validation.metadata, validation.odds);
    if (assignment && packSize !== undefined) {
      const oddsName = deterministicOddsName(validation.metadata.metadata);
      projection = {
        shopId: assignment.id,
        symbolicShopId: validation.metadata.metadata.normalizedShopId,
        shopEntry: makePackTargetEntry(validation.metadata, validation.packList, validation, assignment.id, oddsName, packSize),
        oddsEntry: makeOddsTargetEntry(validation.odds, assignment.id, oddsName),
        ...(validation.metadata.metadata.unlockRef ? { predecessorRef: validation.metadata.metadata.unlockRef } : {}),
      };
    }
  }
  const ok = problems.length === 0 && projection !== undefined;
  return {
    ...validation,
    ok,
    deployable: ok,
    ...(projection ? { projection } : {}),
    targetCapability: {
      status: 'assumed',
      contractVersion: SHOP_TARGET_CONTRACT_VERSION,
      supportedSubset: SHOP_TARGET_SUPPORTED_SUBSET,
      evidence: 'official-example',
      projectApproval: 'SHP-002',
    },
    problems,
    warnings,
  };
};

export const compileShopContentTarget = compileShopContent;
export const compileShop = compileShopContent;

export const shopCapabilityGolden = (): JsonObject => ({
  formatVersion: SHOP_CONTENT_FORMAT_VERSION,
  kind: SHOP_CAPABILITY_KIND,
  payload: {
    family: 'shop',
    status: 'assumed',
    targetContractVersion: SHOP_TARGET_CONTRACT_VERSION,
    supportedSubset: [SHOP_TARGET_SUPPORTED_SUBSET],
    evidence: 'official-example',
    projectApproval: 'SHP-002',
  },
});
