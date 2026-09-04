import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';

import { catalogCachePaths } from './catalog';
import { contentDiagnostic, SourceSpan } from './content-format';
import { CatalogCard, Problem } from './types';

export const CARD_RESOLVER_SCHEMA_VERSION = 1 as const;
export const CARD_RESOLVER_VERSION = 'ygomaster-card-resolver/v1' as const;

// YGOPro/OCG card type bits retained by the catalog. Pendulum is deliberately
// absent: it starts in Main and can later become face-up Extra during a duel.
export const EXTRA_DECK_CARD_TYPE_MASK = 0x40 | 0x2000 | 0x800000 | 0x4000000;

export const catalogCardRequiresExtraDeck = (card: Pick<CatalogCard, 'stats'>): boolean =>
  typeof card.stats.type === 'number' && (card.stats.type & EXTRA_DECK_CARD_TYPE_MASK) !== 0;

export const CARD_RESOLVER_CODES = Object.freeze({
  NAME_INVALID: 'CARD_NAME_INVALID',
  NAME_UNRESOLVED: 'CARD_NAME_UNRESOLVED',
  NAME_AMBIGUOUS: 'CARD_NAME_AMBIGUOUS',
  SELECTOR_INVALID: 'CARD_SELECTOR_INVALID',
  SELECTOR_TARGET_MISSING: 'CARD_SELECTOR_TARGET_MISSING',
  SELECTOR_NAME_MISMATCH: 'CARD_SELECTOR_NAME_MISMATCH',
  RUNTIME_UNAVAILABLE: 'CARD_RUNTIME_UNAVAILABLE',
  ALIAS_UNREVIEWED: 'CARD_ALIAS_UNREVIEWED',
  CATALOG_INVALID: 'CARD_CATALOG_INVALID',
  CATALOG_DUPLICATE_ID: 'CARD_CATALOG_DUPLICATE_ID',
  ALIAS_INVALID: 'CARD_ALIAS_INVALID',
  ALIAS_TARGET_MISSING: 'CARD_ALIAS_TARGET_MISSING',
  LOCK_INVALID: 'CARD_LOCK_INVALID',
  LOCK_UNRESOLVED: 'CARD_LOCK_UNRESOLVED',
  LOCK_STALE_GENERATION: 'CARD_LOCK_STALE_GENERATION',
  LOCK_RESOLVER_VERSION: 'CARD_LOCK_RESOLVER_VERSION',
  LOCK_RESOLUTION_CHANGED: 'CARD_LOCK_RESOLUTION_CHANGED',
  LOCK_RUNTIME_UNAVAILABLE: 'CARD_LOCK_RUNTIME_UNAVAILABLE',
} as const);

export type CardResolverCode = (typeof CARD_RESOLVER_CODES)[keyof typeof CARD_RESOLVER_CODES];

/**
 * Name matching is intentionally narrow and documented:
 *
 * 1. Unicode NFKC folds compatibility forms (for example full-width digits).
 * 2. Unicode punctuation and symbols become a single ASCII space. This makes
 *    hyphen, dash, quote and colon variants equivalent without concatenating
 *    adjacent words.
 * 3. Unicode whitespace is collapsed, surrounding whitespace is removed, and
 *    the result is lower-cased with the stable en-US locale.
 *
 * The resolver never strips letters or digits and never interprets a numeric
 * name as a runtime ID. A runtime ID can only come from a CatalogCard match.
 */
export const normalizeCardName = (value: string): string => {
  if (typeof value !== 'string') throw new TypeError('Card name must be a string');
  return value
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/[\s\p{Z}]+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
};

export interface ReviewedCardAlias {
  name: string;
  runtimeId: number;
  /** Only reviewed aliases enter the success index. */
  reviewed?: boolean;
  source?: string;
  [key: string]: unknown;
}

export interface CardResolverOptions {
  /** Explicit generation from the catalog build; otherwise a stable identity hash is used. */
  catalogGeneration?: string;
  aliases?: readonly ReviewedCardAlias[];
  /** When supplied, IDs outside this set report CARD_RUNTIME_UNAVAILABLE. */
  runtimeIds?: Iterable<number>;
  fuzzyLimit?: number;
}

export interface CardNameRequest {
  /** `sourceName` is preferred; `name` is accepted for ergonomic content callers. */
  sourceName?: string;
  name?: string;
  sourcePath?: string;
  span?: SourceSpan;
  sourceSpan?: SourceSpan;
  jsonPointer?: string;
  selector?: CardReferenceSelector;
}

/** A reviewed, catalog-bound escape hatch for same-name runtime variants. */
export interface CardReferenceSelector {
  runtimeId: number;
  /** Human-reviewable evidence; never interpreted as another ID namespace. */
  provenance: string;
  /** Optional artwork/print label preserved in the resolution lock. */
  variant?: string;
}

export interface AuthoredCardReference {
  name: string;
  selector?: CardReferenceSelector;
}

export type CardReferenceInput = string | AuthoredCardReference;

export interface CardCandidate {
  runtimeId: number;
  name: string;
  normalizedName: string;
  kind: 'official' | 'alias';
  available: boolean;
  aliasOf?: string;
  /** Provenance recorded for a reviewed alias, when supplied by the author. */
  aliasProvenance?: string;
}

export type CardResolutionMatchKind = 'exact' | 'alias';

export interface CardResolutionLockEntry {
  sourceName: string;
  normalizedName: string;
  runtimeId: number;
  catalogGeneration: string;
  resolverVersion: typeof CARD_RESOLVER_VERSION;
  sourcePath?: string;
  sourceSpan?: SourceSpan;
  jsonPointer?: string;
  /** `exact` means the official English catalog name; `alias` is reviewed. */
  matchKind: CardResolutionMatchKind;
  /** Alias target/provenance are absent for exact official-name matches. */
  aliasOf?: string;
  aliasProvenance?: string;
  selector?: CardReferenceSelector;
}

export interface CardResolutionLock {
  schemaVersion: typeof CARD_RESOLVER_SCHEMA_VERSION;
  resolverVersion: typeof CARD_RESOLVER_VERSION;
  catalogGeneration: string;
  entries: CardResolutionLockEntry[];
}

export interface CardResolution {
  ok: boolean;
  sourceName: string;
  normalizedName?: string;
  runtimeId?: number;
  catalogGeneration: string;
  resolverVersion: typeof CARD_RESOLVER_VERSION;
  match?: CardCandidate;
  candidates: CardCandidate[];
  /** Suggestions never produce runtimeId or a lock entry. */
  suggestions: CardCandidate[];
  problems: Problem[];
  lockEntry?: CardResolutionLockEntry;
}

export interface CardBatchResolution {
  ok: boolean;
  resolutions: CardResolution[];
  problems: Problem[];
  lock?: CardResolutionLock;
}

export class CardResolverError extends Error {
  readonly code: string;
  readonly problems: Problem[];

  constructor(code: string, message: string, problems: Problem[] = []) {
    super(message);
    this.name = 'CardResolverError';
    this.code = code;
    this.problems = problems.length ? problems : [contentDiagnostic({ code, message })];
  }
}

interface IndexedCandidate extends CardCandidate {
  key: string;
}

interface RejectedAlias {
  name: string;
  normalizedName: string;
  runtimeId: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Compare strings by Unicode code point, independent of host locale settings. */
const compareOrdinal = (left: string, right: string): number => {
  if (left === right) return 0;
  const leftCodePoints = Array.from(left);
  const rightCodePoints = Array.from(right);
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftCodePoints[index]?.codePointAt(0) || 0;
    const rightCodePoint = rightCodePoints[index]?.codePointAt(0) || 0;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
  }
  return leftCodePoints.length - rightCodePoints.length;
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(compareOrdinal)
      .map((key) => [key, stableValue(value[key])]),
  );
};

const stableStringify = (value: unknown): string => JSON.stringify(stableValue(value));

const validRuntimeId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const validSourceName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const compareOptional = (left: string | undefined, right: string | undefined): number =>
  compareOrdinal(left || '', right || '') || Number(left !== undefined) - Number(right !== undefined);

const candidateCompare = (left: CardCandidate, right: CardCandidate): number =>
  left.runtimeId - right.runtimeId
  || compareOrdinal(left.normalizedName, right.normalizedName)
  || compareOrdinal(left.name, right.name)
  || compareOrdinal(left.kind, right.kind)
  || Number(left.available) - Number(right.available)
  || compareOptional(left.aliasOf, right.aliasOf)
  || compareOptional(left.aliasProvenance, right.aliasProvenance);

const candidateKey = (candidate: CardCandidate): string =>
  `${candidate.runtimeId}\u0000${candidate.kind}\u0000${candidate.normalizedName}\u0000${candidate.name}\u0000${candidate.aliasOf || ''}\u0000${candidate.aliasProvenance || ''}`;

const sourceSpanFor = (request: CardNameRequest): SourceSpan | undefined => request.sourceSpan || request.span;

const requestName = (request: CardNameRequest): string | undefined => request.sourceName ?? request.name;

export const cardReferenceRequest = (
  input: CardReferenceInput,
  context: Omit<CardNameRequest, 'sourceName' | 'name' | 'selector'> = {},
): CardNameRequest => typeof input === 'string'
  ? { ...context, sourceName: input }
  : { ...context, sourceName: input?.name, ...(input?.selector === undefined ? {} : { selector: input.selector }) };

/**
 * Line formats use a terminal selector suffix so the reviewed choice remains
 * authored text: `Dark Magician @runtime=4041 @provenance=ocg-db:4041`.
 */
export const parseCardReferenceText = (value: string): AuthoredCardReference => {
  const tokens = value.trim().split(/\s+/u);
  const selectorTokens: Record<string, string> = {};
  while (tokens.length && /^@(runtime|provenance|variant)=/u.test(tokens[tokens.length - 1] || '')) {
    const token = tokens.pop() as string;
    const separator = token.indexOf('=');
    selectorTokens[token.slice(1, separator)] = token.slice(separator + 1);
  }
  if (!Object.keys(selectorTokens).length) return { name: value.trim() };
  return {
    name: tokens.join(' ').trim(),
    selector: {
      runtimeId: Number(selectorTokens.runtime),
      provenance: selectorTokens.provenance || '',
      ...(selectorTokens.variant ? { variant: selectorTokens.variant } : {}),
    },
  };
};

const requestSourcePath = (request: CardNameRequest): string => request.sourcePath || sourceSpanFor(request)?.sourcePath || '';

const diagnosticFor = (
  code: string,
  message: string,
  request: CardNameRequest,
  suggestion?: string,
): Problem => contentDiagnostic({
  code,
  message,
  sourcePath: request.sourcePath,
  span: sourceSpanFor(request),
  jsonPointer: request.jsonPointer,
  suggestion,
});

const diagnosticSort = (left: Problem, right: Problem): number => {
  const leftPath = left.sourcePath || left.path || '';
  const rightPath = right.sourcePath || right.path || '';
  return compareOrdinal(leftPath, rightPath)
    || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
    || (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER)
    || (left.endLine ?? Number.MAX_SAFE_INTEGER) - (right.endLine ?? Number.MAX_SAFE_INTEGER)
    || (left.endColumn ?? Number.MAX_SAFE_INTEGER) - (right.endColumn ?? Number.MAX_SAFE_INTEGER)
    || compareOrdinal(left.jsonPointer || '', right.jsonPointer || '')
    || compareOrdinal(left.code, right.code)
    || compareOrdinal(left.message, right.message)
    || compareOrdinal(left.suggestion || '', right.suggestion || '')
    || compareOrdinal(left.severity || '', right.severity || '');
};

const requestSort = (left: { request: CardNameRequest; index: number }, right: { request: CardNameRequest; index: number }): number => {
  const leftSpan = sourceSpanFor(left.request);
  const rightSpan = sourceSpanFor(right.request);
  return compareOrdinal(requestSourcePath(left.request), requestSourcePath(right.request))
    || (leftSpan?.line ?? Number.MAX_SAFE_INTEGER) - (rightSpan?.line ?? Number.MAX_SAFE_INTEGER)
    || (leftSpan?.column ?? Number.MAX_SAFE_INTEGER) - (rightSpan?.column ?? Number.MAX_SAFE_INTEGER)
    || (leftSpan?.endLine ?? Number.MAX_SAFE_INTEGER) - (rightSpan?.endLine ?? Number.MAX_SAFE_INTEGER)
    || (leftSpan?.endColumn ?? Number.MAX_SAFE_INTEGER) - (rightSpan?.endColumn ?? Number.MAX_SAFE_INTEGER)
    || compareOrdinal(requestName(left.request) || '', requestName(right.request) || '')
  || compareOrdinal(left.request.jsonPointer || '', right.request.jsonPointer || '')
    || (left.request.selector?.runtimeId ?? Number.MAX_SAFE_INTEGER) - (right.request.selector?.runtimeId ?? Number.MAX_SAFE_INTEGER)
    || compareOrdinal(left.request.selector?.provenance || '', right.request.selector?.provenance || '')
    || compareOrdinal(left.request.selector?.variant || '', right.request.selector?.variant || '')
    || left.index - right.index;
};

const formatCandidates = (candidates: readonly CardCandidate[]): string => candidates
  .slice(0, 12)
  .map((candidate) => `${candidate.name} [${candidate.runtimeId}]`)
  .join(', ');

const levenshtein = (left: string, right: string): number => {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
};

const uniqueCandidates = (candidates: Iterable<CardCandidate>): CardCandidate[] => {
  const seen = new Set<string>();
  return [...candidates]
    .filter((candidate) => {
      const key = candidateKey(candidate);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(candidateCompare);
};

const lockEntryCompare = (left: CardResolutionLockEntry, right: CardResolutionLockEntry): number =>
  compareOrdinal(left.sourcePath || left.sourceSpan?.sourcePath || '', right.sourcePath || right.sourceSpan?.sourcePath || '')
  || (left.sourceSpan?.line ?? Number.MAX_SAFE_INTEGER) - (right.sourceSpan?.line ?? Number.MAX_SAFE_INTEGER)
  || (left.sourceSpan?.column ?? Number.MAX_SAFE_INTEGER) - (right.sourceSpan?.column ?? Number.MAX_SAFE_INTEGER)
  || (left.sourceSpan?.endLine ?? Number.MAX_SAFE_INTEGER) - (right.sourceSpan?.endLine ?? Number.MAX_SAFE_INTEGER)
  || (left.sourceSpan?.endColumn ?? Number.MAX_SAFE_INTEGER) - (right.sourceSpan?.endColumn ?? Number.MAX_SAFE_INTEGER)
  || compareOrdinal(left.normalizedName, right.normalizedName)
  || left.runtimeId - right.runtimeId
  || compareOrdinal(left.sourceName, right.sourceName)
  || compareOrdinal(left.matchKind, right.matchKind)
  || compareOptional(left.aliasOf, right.aliasOf)
  || compareOptional(left.aliasProvenance, right.aliasProvenance)
  || (left.selector?.runtimeId ?? Number.MAX_SAFE_INTEGER) - (right.selector?.runtimeId ?? Number.MAX_SAFE_INTEGER)
  || compareOrdinal(left.selector?.provenance || '', right.selector?.provenance || '')
  || compareOrdinal(left.selector?.variant || '', right.selector?.variant || '')
  || compareOrdinal(left.jsonPointer || '', right.jsonPointer || '');

export const computeCardCatalogGeneration = (cards: readonly CatalogCard[]): string => {
  const identity = [...cards]
    .map((card) => ({
      id: card.id,
      ydkId: card.ydkId,
      english: card.names.english || '',
      type: card.stats.type ?? null,
    }))
    .sort((left, right) => left.id - right.id || left.ydkId - right.ydkId || compareOrdinal(left.english, right.english));
  const digest = createHash('sha256').update(stableStringify(identity)).digest('hex');
  return `ygomaster-catalog-${digest.slice(0, 24)}`;
};

export class CardNameResolver {
  readonly cards: readonly CatalogCard[];
  readonly catalogGeneration: string;
  readonly resolverVersion = CARD_RESOLVER_VERSION;
  readonly runtimeIds: ReadonlySet<number>;

  private readonly byNormalizedName = new Map<string, IndexedCandidate[]>();
  private readonly rejectedAliases = new Map<string, RejectedAlias[]>();
  private readonly allCandidates: CardCandidate[];
  private readonly cardsById = new Map<number, CatalogCard>();
  private readonly fuzzyLimit: number;

  constructor(cards: readonly CatalogCard[], options: CardResolverOptions = {}) {
    const problems: Problem[] = [];
    const rawCards: unknown[] = Array.isArray(cards) ? [...cards] : [];
    if (!Array.isArray(cards)) {
      problems.push(contentDiagnostic({ code: CARD_RESOLVER_CODES.CATALOG_INVALID, message: 'Card catalog must be an array' }));
    }
    rawCards.forEach((rawCard, index) => {
      if (!isRecord(rawCard)) {
        problems.push(contentDiagnostic({ code: CARD_RESOLVER_CODES.CATALOG_INVALID, message: `Catalog card at index ${index} must be an object` }));
        return;
      }
      if (!validRuntimeId(rawCard.id)) {
        problems.push(contentDiagnostic({ code: CARD_RESOLVER_CODES.CATALOG_INVALID, message: `Catalog card at index ${index} must contain a non-negative integer id` }));
      }
      if (!isRecord(rawCard.names) || typeof rawCard.names.english !== 'string' || !rawCard.names.english.trim()) {
        problems.push(contentDiagnostic({ code: CARD_RESOLVER_CODES.CATALOG_INVALID, message: `Catalog card at index ${index} must contain a non-empty names.english value` }));
      }
    });
    if (problems.length) {
      const sorted = problems.sort(diagnosticSort);
      throw new CardResolverError(sorted[0]?.code || CARD_RESOLVER_CODES.CATALOG_INVALID, sorted[0]?.message || 'Invalid card resolver input', sorted);
    }
    const sortedCards = (rawCards as CatalogCard[]).sort((left, right) =>
      left.id - right.id
      || left.ydkId - right.ydkId
      || compareOrdinal(left.names.english || '', right.names.english || ''));
    this.cards = sortedCards;
    for (const card of sortedCards) {
      if (this.cardsById.has(card.id)) {
        problems.push(contentDiagnostic({ code: CARD_RESOLVER_CODES.CATALOG_DUPLICATE_ID, message: `Catalog contains duplicate runtime ID ${card.id}` }));
        continue;
      }
      this.cardsById.set(card.id, card);
      const officialName = card.names.english;
      if (!officialName) continue;
      const normalizedName = normalizeCardName(officialName);
      if (!normalizedName) {
        problems.push(contentDiagnostic({ code: CARD_RESOLVER_CODES.CATALOG_INVALID, message: `English name for runtime ID ${card.id} normalizes to empty` }));
        continue;
      }
      this.addCandidate({
        runtimeId: card.id,
        name: officialName,
        normalizedName,
        kind: 'official',
        available: true,
        key: `${card.id}\u0000official\u0000${normalizedName}\u0000${officialName}`,
      });
    }

    for (const alias of options.aliases || []) {
      if (!isRecord(alias) || typeof alias.name !== 'string' || !validRuntimeId(alias.runtimeId)) {
        problems.push(contentDiagnostic({ code: CARD_RESOLVER_CODES.ALIAS_INVALID, message: 'Card alias must contain name and non-negative integer runtimeId' }));
        continue;
      }
      const normalizedName = normalizeCardName(alias.name);
      if (!normalizedName) {
        problems.push(contentDiagnostic({ code: CARD_RESOLVER_CODES.ALIAS_INVALID, message: 'Card alias normalizes to empty' }));
        continue;
      }
      if (!this.cardsById.has(alias.runtimeId)) {
        problems.push(contentDiagnostic({ code: CARD_RESOLVER_CODES.ALIAS_TARGET_MISSING, message: `Reviewed alias ${alias.name} targets missing runtime ID ${alias.runtimeId}` }));
        continue;
      }
      if (alias.reviewed !== true) {
        const rejected = this.rejectedAliases.get(normalizedName) || [];
        rejected.push({ name: alias.name, normalizedName, runtimeId: alias.runtimeId });
        this.rejectedAliases.set(normalizedName, rejected);
        continue;
      }
      this.addCandidate({
        runtimeId: alias.runtimeId,
        name: alias.name,
        normalizedName,
        kind: 'alias',
        available: true,
        aliasOf: this.cardsById.get(alias.runtimeId)?.names.english,
        ...(typeof alias.source === 'string' ? { aliasProvenance: alias.source } : {}),
        key: `${alias.runtimeId}\u0000alias\u0000${normalizedName}\u0000${alias.name}`,
      });
    }

    if (problems.length) {
      const sorted = problems.sort(diagnosticSort);
      throw new CardResolverError(sorted[0]?.code || CARD_RESOLVER_CODES.CATALOG_INVALID, sorted[0]?.message || 'Invalid card resolver input', sorted);
    }

    this.catalogGeneration = options.catalogGeneration?.trim() || computeCardCatalogGeneration(sortedCards);
    this.fuzzyLimit = Math.max(1, Math.min(20, Math.trunc(options.fuzzyLimit ?? 5)));
    const configuredRuntimeIds = options.runtimeIds === undefined
      ? [...this.cardsById.keys()]
      : [...options.runtimeIds];
    if (configuredRuntimeIds.some((id) => !validRuntimeId(id))) {
      throw new CardResolverError(CARD_RESOLVER_CODES.CATALOG_INVALID, 'runtimeIds must contain only non-negative safe integers');
    }
    this.runtimeIds = new Set(configuredRuntimeIds);
    this.allCandidates = uniqueCandidates([...this.byNormalizedName.values()].flat().map((candidate) => ({
      ...candidate,
      available: this.runtimeIds.has(candidate.runtimeId),
    })));
    for (const candidates of this.byNormalizedName.values()) {
      candidates.forEach((candidate) => { candidate.available = this.runtimeIds.has(candidate.runtimeId); });
      candidates.sort(candidateCompare);
    }
    for (const aliases of this.rejectedAliases.values()) aliases.sort((left, right) => left.runtimeId - right.runtimeId || compareOrdinal(left.name, right.name));
  }

  private addCandidate(candidate: IndexedCandidate): void {
    const candidates = this.byNormalizedName.get(candidate.normalizedName) || [];
    candidates.push(candidate);
    this.byNormalizedName.set(candidate.normalizedName, candidates);
  }

  private candidatesFor(normalizedName: string): CardCandidate[] {
    return uniqueCandidates(this.byNormalizedName.get(normalizedName) || []);
  }

  /** Catalog-driven modern deck placement; Ritual (0x80) remains a Main card. */
  isExtraDeckCard(runtimeId: number): boolean {
    const card = this.cardsById.get(runtimeId);
    return card ? catalogCardRequiresExtraDeck(card) : false;
  }

  /** Fuzzy search is deliberately a suggestion API and cannot create a lock. */
  suggestCardNames(name: string, limit = this.fuzzyLimit): CardCandidate[] {
    const normalizedName = normalizeCardName(name);
    if (!normalizedName) return [];
    const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
    const maxDistance = Math.max(2, Math.floor(normalizedName.length * 0.4));
    const scored = this.allCandidates.map((candidate) => {
      const normalized = candidate.normalizedName;
      const starts = normalized.startsWith(normalizedName);
      const contains = normalized.includes(normalizedName) || normalizedName.includes(normalized);
      const distance = levenshtein(normalizedName, normalized);
      return { candidate, starts, contains, distance };
    }).filter((entry) => entry.starts || entry.contains || entry.distance <= maxDistance)
      .sort((left, right) => Number(right.starts) - Number(left.starts)
        || Number(right.contains) - Number(left.contains)
        || left.distance - right.distance
        || candidateCompare(left.candidate, right.candidate));
    const result: CardCandidate[] = [];
    const seenIds = new Set<number>();
    for (const entry of scored) {
      if (seenIds.has(entry.candidate.runtimeId)) continue;
      seenIds.add(entry.candidate.runtimeId);
      result.push(entry.candidate);
      if (result.length >= safeLimit) break;
    }
    return result.sort((left, right) => {
      const leftScore = scored.find((entry) => entry.candidate.runtimeId === left.runtimeId);
      const rightScore = scored.find((entry) => entry.candidate.runtimeId === right.runtimeId);
      return (leftScore?.distance ?? Number.MAX_SAFE_INTEGER) - (rightScore?.distance ?? Number.MAX_SAFE_INTEGER)
        || candidateCompare(left, right);
    });
  }

  resolve(request: CardNameRequest): CardResolution {
    const sourceName = requestName(request) || '';
    const base = {
      sourceName,
      catalogGeneration: this.catalogGeneration,
      resolverVersion: CARD_RESOLVER_VERSION,
      candidates: [] as CardCandidate[],
      suggestions: [] as CardCandidate[],
      problems: [] as Problem[],
    };
    if (!validSourceName(sourceName)) {
      return { ...base, ok: false, problems: [diagnosticFor(CARD_RESOLVER_CODES.NAME_INVALID, 'Card source name must be a non-empty string', request)] };
    }
    const normalizedName = normalizeCardName(sourceName);
    if (!normalizedName) {
      return { ...base, ok: false, normalizedName, problems: [diagnosticFor(CARD_RESOLVER_CODES.NAME_INVALID, 'Card source name normalizes to empty', request)] };
    }
    const candidates = this.candidatesFor(normalizedName);
    const selector = request.selector;
    if (selector !== undefined && (!isRecord(selector)
      || !validRuntimeId(selector.runtimeId)
      || typeof selector.provenance !== 'string'
      || !selector.provenance.trim()
      || (selector.variant !== undefined && (typeof selector.variant !== 'string' || !selector.variant.trim())))) {
      return {
        ...base,
        ok: false,
        normalizedName,
        candidates,
        problems: [diagnosticFor(CARD_RESOLVER_CODES.SELECTOR_INVALID, 'Card selector requires a non-negative runtimeId and non-empty provenance; variant must be non-empty when present', request)],
      };
    }
    const suggestions = candidates.length ? [] : this.suggestCardNames(sourceName);
    if (selector !== undefined) {
      const selectedCatalogCard = this.cardsById.get(selector.runtimeId);
      if (!selectedCatalogCard) {
        return {
          ...base,
          ok: false,
          normalizedName,
          candidates,
          suggestions,
          problems: [diagnosticFor(CARD_RESOLVER_CODES.SELECTOR_TARGET_MISSING, `Card selector runtime ID ${selector.runtimeId} is absent from catalog generation ${this.catalogGeneration}`, request)],
        };
      }
      const selected = candidates.filter((candidate) => candidate.runtimeId === selector.runtimeId);
      if (!selected.length) {
        return {
          ...base,
          ok: false,
          normalizedName,
          candidates,
          suggestions,
          problems: [diagnosticFor(CARD_RESOLVER_CODES.SELECTOR_NAME_MISMATCH, `Card selector runtime ID ${selector.runtimeId} does not match source name ${sourceName}; catalog name is ${selectedCatalogCard.names.english}`, request)],
        };
      }
      if (!this.runtimeIds.has(selector.runtimeId)) {
        return {
          ...base,
          ok: false,
          normalizedName,
          runtimeId: selector.runtimeId,
          candidates,
          suggestions: [],
          problems: [diagnosticFor(CARD_RESOLVER_CODES.RUNTIME_UNAVAILABLE, `Selected runtime card ID ${selector.runtimeId} is unavailable in the selected runtime`, request)],
        };
      }
      const match = selected.find((candidate) => candidate.kind === 'official') || selected[0];
      const lockEntry: CardResolutionLockEntry = {
        sourceName,
        normalizedName,
        runtimeId: selector.runtimeId,
        catalogGeneration: this.catalogGeneration,
        resolverVersion: CARD_RESOLVER_VERSION,
        ...(request.sourcePath ? { sourcePath: request.sourcePath } : {}),
        ...(sourceSpanFor(request) ? { sourceSpan: clone(sourceSpanFor(request)) } : {}),
        ...(request.jsonPointer ? { jsonPointer: request.jsonPointer } : {}),
        matchKind: match.kind === 'alias' ? 'alias' : 'exact',
        ...(match.kind === 'alias' && match.aliasOf !== undefined ? { aliasOf: match.aliasOf } : {}),
        ...(match.kind === 'alias' && match.aliasProvenance !== undefined ? { aliasProvenance: match.aliasProvenance } : {}),
        selector: clone(selector),
      };
      return { ...base, ok: true, normalizedName, runtimeId: selector.runtimeId, match, candidates, suggestions: [], problems: [], lockEntry };
    }
    if (!candidates.length) {
      const rejected = this.rejectedAliases.get(normalizedName);
      const code = rejected?.length ? CARD_RESOLVER_CODES.ALIAS_UNREVIEWED : CARD_RESOLVER_CODES.NAME_UNRESOLVED;
      const message = rejected?.length
        ? `Card name matches an unreviewed alias and cannot be resolved: ${sourceName}`
        : `No official English name or reviewed alias matches: ${sourceName}`;
      const suggestion = suggestions.length ? `Suggestions: ${formatCandidates(suggestions)}` : undefined;
      return { ...base, ok: false, normalizedName, candidates, suggestions, problems: [diagnosticFor(code, message, request, suggestion)] };
    }
    const ids = [...new Set(candidates.map((candidate) => candidate.runtimeId))].sort((left, right) => left - right);
    if (ids.length > 1) {
      return {
        ...base,
        ok: false,
        normalizedName,
        candidates,
        problems: [diagnosticFor(CARD_RESOLVER_CODES.NAME_AMBIGUOUS, `Normalized card name is ambiguous: ${sourceName}; candidates: ${formatCandidates(candidates)}`, request)],
      };
    }
    const runtimeId = ids[0] as number;
    if (!this.runtimeIds.has(runtimeId)) {
      return {
        ...base,
        ok: false,
        normalizedName,
        runtimeId,
        candidates,
        problems: [diagnosticFor(CARD_RESOLVER_CODES.RUNTIME_UNAVAILABLE, `Runtime card ID ${runtimeId} is unavailable in the selected runtime`, request)],
      };
    }
    const match = candidates.find((candidate) => candidate.kind === 'official') || candidates[0];
    const lockEntry: CardResolutionLockEntry = {
      sourceName,
      normalizedName,
      runtimeId,
      catalogGeneration: this.catalogGeneration,
      resolverVersion: CARD_RESOLVER_VERSION,
      ...(request.sourcePath ? { sourcePath: request.sourcePath } : {}),
      ...(sourceSpanFor(request) ? { sourceSpan: clone(sourceSpanFor(request)) } : {}),
      ...(request.jsonPointer ? { jsonPointer: request.jsonPointer } : {}),
      matchKind: match.kind === 'alias' ? 'alias' : 'exact',
      ...(match.kind === 'alias' && match.aliasOf !== undefined ? { aliasOf: match.aliasOf } : {}),
      ...(match.kind === 'alias' && match.aliasProvenance !== undefined ? { aliasProvenance: match.aliasProvenance } : {}),
    };
    return { ...base, ok: true, normalizedName, runtimeId, match, candidates, suggestions: [], problems: [], lockEntry };
  }

  resolveBatch(requests: readonly CardNameRequest[]): CardBatchResolution {
    const ordered = requests.map((request, index) => ({ request, index })).sort(requestSort);
    const resolutions = ordered.map(({ request }) => this.resolve(request));
    const problems = resolutions.flatMap((resolution) => resolution.problems).sort(diagnosticSort);
    const entries = resolutions
      .map((resolution) => resolution.lockEntry)
      .filter((entry): entry is CardResolutionLockEntry => Boolean(entry))
      .sort(lockEntryCompare)
      .map(clone);
    const ok = resolutions.every((resolution) => resolution.ok) && problems.length === 0;
    return {
      ok,
      resolutions,
      problems,
      ...(ok ? {
        lock: {
          schemaVersion: CARD_RESOLVER_SCHEMA_VERSION,
          resolverVersion: CARD_RESOLVER_VERSION,
          catalogGeneration: this.catalogGeneration,
          entries,
        },
      } : {}),
    };
  }

  resolveMany(requests: readonly CardNameRequest[]): CardBatchResolution {
    return this.resolveBatch(requests);
  }
}

export const createCardResolver = (cards: readonly CatalogCard[], options: CardResolverOptions = {}): CardNameResolver =>
  new CardNameResolver(cards, options);

export const createCardNameResolver = createCardResolver;
export const resolveCardName = (resolver: CardNameResolver, request: CardNameRequest): CardResolution => resolver.resolve(request);
export const resolveCardNames = (resolver: CardNameResolver, requests: readonly CardNameRequest[]): CardBatchResolution => resolver.resolveBatch(requests);

const lockDiagnostic = (code: string, message: string, entry?: CardResolutionLockEntry): Problem => contentDiagnostic({
  code,
  message,
  sourcePath: entry?.sourcePath,
  span: entry?.sourceSpan,
  jsonPointer: entry?.jsonPointer,
});

const lockMatchKind = (value: unknown): CardResolutionMatchKind | undefined => {
  if (value === 'exact' || value === 'alias') return value;
  // Accept locks emitted by the first draft, while all new locks use `exact`.
  if (value === 'official') return 'exact';
  return undefined;
};

const isLockEntry = (value: unknown): value is CardResolutionLockEntry =>
  isRecord(value)
  && validSourceName(value.sourceName)
  && typeof value.normalizedName === 'string'
  && validRuntimeId(value.runtimeId)
  && typeof value.catalogGeneration === 'string'
  && value.resolverVersion === CARD_RESOLVER_VERSION
  && lockMatchKind(value.matchKind) !== undefined
  && (value.aliasOf === undefined || typeof value.aliasOf === 'string')
  && (value.aliasProvenance === undefined || typeof value.aliasProvenance === 'string')
  && (value.selector === undefined || (isRecord(value.selector)
    && validRuntimeId(value.selector.runtimeId)
    && typeof value.selector.provenance === 'string'
    && value.selector.provenance.trim().length > 0
    && (value.selector.variant === undefined || (typeof value.selector.variant === 'string' && value.selector.variant.trim().length > 0))));

export const validateResolutionLock = (resolver: CardNameResolver, lock: unknown): Problem[] => {
  const problems: Problem[] = [];
  if (!isRecord(lock)) return [lockDiagnostic(CARD_RESOLVER_CODES.LOCK_INVALID, 'Resolution lock must be an object')];
  if (lock.schemaVersion !== CARD_RESOLVER_SCHEMA_VERSION) problems.push(lockDiagnostic(CARD_RESOLVER_CODES.LOCK_INVALID, `Resolution lock schemaVersion must be ${CARD_RESOLVER_SCHEMA_VERSION}`));
  if (lock.resolverVersion !== CARD_RESOLVER_VERSION) problems.push(lockDiagnostic(CARD_RESOLVER_CODES.LOCK_RESOLVER_VERSION, `Resolution lock resolverVersion must be ${CARD_RESOLVER_VERSION}`));
  if (lock.catalogGeneration !== resolver.catalogGeneration) problems.push(lockDiagnostic(CARD_RESOLVER_CODES.LOCK_STALE_GENERATION, `Resolution lock generation ${String(lock.catalogGeneration)} does not match catalog generation ${resolver.catalogGeneration}`));
  if (!Array.isArray(lock.entries)) return [...problems, lockDiagnostic(CARD_RESOLVER_CODES.LOCK_INVALID, 'Resolution lock entries must be an array')].sort(diagnosticSort);
  for (const rawEntry of lock.entries) {
    if (!isLockEntry(rawEntry)) {
      problems.push(lockDiagnostic(CARD_RESOLVER_CODES.LOCK_UNRESOLVED, 'Resolution lock contains an unresolved or malformed entry'));
      continue;
    }
    const entry = rawEntry;
    if (entry.catalogGeneration !== resolver.catalogGeneration) {
      problems.push(lockDiagnostic(CARD_RESOLVER_CODES.LOCK_STALE_GENERATION, `Lock entry for ${entry.sourceName} has a stale catalog generation`, entry));
      continue;
    }
    if (!resolver.runtimeIds.has(entry.runtimeId)) {
      problems.push(lockDiagnostic(CARD_RESOLVER_CODES.LOCK_RUNTIME_UNAVAILABLE, `Lock entry for ${entry.sourceName} references unavailable runtime ID ${entry.runtimeId}`, entry));
      continue;
    }
    const resolution = resolver.resolve({
      sourceName: entry.sourceName,
      sourcePath: entry.sourcePath,
      sourceSpan: entry.sourceSpan,
      jsonPointer: entry.jsonPointer,
      ...(entry.selector ? { selector: entry.selector } : {}),
    });
    if (!resolution.ok || resolution.runtimeId === undefined) {
      problems.push(lockDiagnostic(CARD_RESOLVER_CODES.LOCK_UNRESOLVED, `Lock entry could not be resolved: ${entry.sourceName}`, entry));
      continue;
    }
    const match = resolution.match;
    const expectedMatchKind: CardResolutionMatchKind | undefined = match?.kind === 'alias' ? 'alias' : match?.kind === 'official' ? 'exact' : undefined;
    const expectedAliasOf = match?.kind === 'alias' ? match.aliasOf : undefined;
    const expectedAliasProvenance = match?.kind === 'alias' ? match.aliasProvenance : undefined;
    if (
      resolution.runtimeId !== entry.runtimeId
      || resolution.normalizedName !== entry.normalizedName
      || lockMatchKind(entry.matchKind) !== expectedMatchKind
      || entry.aliasOf !== expectedAliasOf
      || entry.aliasProvenance !== expectedAliasProvenance
      || JSON.stringify(entry.selector) !== JSON.stringify(resolution.lockEntry?.selector)
    ) {
      problems.push(lockDiagnostic(CARD_RESOLVER_CODES.LOCK_RESOLUTION_CHANGED, `Lock entry changed resolution or match provenance: ${entry.sourceName}`, entry));
    }
  }
  return problems.sort(diagnosticSort);
};

export const assertResolutionLock = (resolver: CardNameResolver, lock: unknown): CardResolutionLock => {
  const problems = validateResolutionLock(resolver, lock);
  if (problems.length) throw new CardResolverError(problems[0]?.code || CARD_RESOLVER_CODES.LOCK_INVALID, problems[0]?.message || 'Resolution lock is not valid for compile', problems);
  return clone(lock as CardResolutionLock);
};

export const validateLockForCompile = validateResolutionLock;
export const assertLockForCompile = assertResolutionLock;
export const canCompileWithResolutionLock = (resolver: CardNameResolver, lock: unknown): boolean =>
  validateResolutionLock(resolver, lock).length === 0;

export interface LoadCardResolverOptions extends Omit<CardResolverOptions, 'runtimeIds'> {
  runtimeIds?: Iterable<number>;
}

/** Load only local JSON cache files. This function has no transport/network path. */
export const loadCardResolver = async (
  projectRoot: string,
  options: LoadCardResolverOptions = {},
): Promise<CardNameResolver> => {
  const paths = catalogCachePaths(projectRoot);
  try {
    const [catalogRaw, metadataRaw] = await Promise.all([
      fs.readFile(paths.catalogPath, 'utf8'),
      fs.readFile(paths.metadataPath, 'utf8'),
    ]);
    const catalog = JSON.parse(catalogRaw) as { schemaVersion?: number; cards?: CatalogCard[] };
    const metadata = JSON.parse(metadataRaw) as { schemaVersion?: number; missingRuntimeIds?: number[]; generation?: string };
    if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.cards) || metadata.schemaVersion !== 1) {
      throw new Error('Catalog and metadata cache must use schemaVersion 1');
    }
    const missing = new Set(metadata.missingRuntimeIds || []);
    const runtimeIds = options.runtimeIds || catalog.cards.map((card) => card.id).filter((id) => !missing.has(id));
    return createCardResolver(catalog.cards, {
      ...options,
      runtimeIds,
      ...(options.catalogGeneration || metadata.generation ? { catalogGeneration: options.catalogGeneration || metadata.generation } : {}),
    });
  } catch (error) {
    if (error instanceof CardResolverError) throw error;
    throw new CardResolverError(CARD_RESOLVER_CODES.CATALOG_INVALID, `Unable to load local card catalog: ${String(error)}`);
  }
};

export const loadCardNameResolver = loadCardResolver;
