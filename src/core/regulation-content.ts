import { CardNameResolver, normalizeCardName } from './card-resolver';
import type { CardResolution, CardResolutionLock } from './card-resolver';
import {
  ContentFormatError,
  ParsedContentEnvelope,
  SectionedEntry,
  SourceSpan,
  contentDiagnostic,
  normalizeSymbolicReference,
  parseContentEnvelopeWithSource,
  parseSectionedDocument,
} from './content-format';
import type { DeckRegulationContext, DeckRegulationHook } from './deck-content';
import { validateTargetCapability } from './target-contract';
import type { JsonObject, Problem } from './types';

/** Regulation is authored content; YgoMaster's Regulation overlay remains closed. */
export const REGULATION_CONTENT_FORMAT_VERSION = 1 as const;
export const REGULATION_CONTENT_KIND = 'regulation' as const;
export const REGULATION_RULES_PARSER_VERSION = 1 as const;

export const REGULATION_CODES = Object.freeze({
  ENVELOPE_INVALID: 'REGULATION_ENVELOPE_INVALID',
  KIND_INVALID: 'REGULATION_KIND_INVALID',
  METADATA_INVALID: 'REGULATION_METADATA_INVALID',
  ID_MISSING: 'REGULATION_ID_MISSING',
  ID_INVALID: 'REGULATION_ID_INVALID',
  NAME_MISSING: 'REGULATION_NAME_MISSING',
  CUTOFF_MISSING: 'REGULATION_CUTOFF_MISSING',
  CUTOFF_INVALID: 'REGULATION_CUTOFF_INVALID',
  ALLOWED_REF_MISSING: 'REGULATION_ALLOWED_REF_MISSING',
  ALLOWED_REF_INVALID: 'REGULATION_ALLOWED_REF_INVALID',
  RULES_MISSING: 'REGULATION_RULES_MISSING',
  RULE_SECTION_UNKNOWN: 'REGULATION_RULE_SECTION_UNKNOWN',
  RULE_ENTRY_INVALID: 'REGULATION_RULE_ENTRY_INVALID',
  COPY_LIMIT_MISSING: 'REGULATION_COPY_LIMIT_MISSING',
  COPY_LIMIT_INVALID: 'REGULATION_COPY_LIMIT_INVALID',
  RULE_DUPLICATE: 'REGULATION_RULE_DUPLICATE',
  RULE_CONTRADICTORY: 'REGULATION_RULE_CONTRADICTORY',
  ALLOWED_LIST_MISSING: 'REGULATION_ALLOWED_LIST_MISSING',
  RESOLVER_REQUIRED: 'REGULATION_CARD_RESOLVER_REQUIRED',
  CARD_UNRESOLVED: 'CARD_NAME_UNRESOLVED',
  CARD_AMBIGUOUS: 'CARD_NAME_AMBIGUOUS',
  CARD_RUNTIME_UNAVAILABLE: 'CARD_RUNTIME_UNAVAILABLE',
  CARD_NOT_ALLOWED: 'REGULATION_CARD_NOT_ALLOWED',
  CARD_FORBIDDEN: 'REGULATION_CARD_FORBIDDEN',
  COPY_LIMIT_EXCEEDED: 'REGULATION_COPY_LIMIT_EXCEEDED',
  TARGET_UNSUPPORTED: 'REGULATION_TARGET_UNSUPPORTED',
} as const);

export type RegulationContentCode = (typeof REGULATION_CODES)[keyof typeof REGULATION_CODES];
export type RegulationRuleSection = 'allowed' | 'forbidden' | 'limited' | 'semi-limited';

export interface RegulationRule {
  section: RegulationRuleSection;
  sourceName: string;
  copyLimit: number;
  line: number;
  raw: string;
  sourcePath?: string;
  sourceSpan: SourceSpan;
  normalizedName?: string;
  runtimeId?: number;
}

export interface ParsedRegulationRules {
  parserVersion: typeof REGULATION_RULES_PARSER_VERSION;
  sourcePath?: string;
  originalText: string;
  entries: RegulationRule[];
  sections: Record<RegulationRuleSection, RegulationRule[]>;
  diagnostics: Problem[];
}

export interface RegulationMetadata {
  regulationId: string;
  normalizedRegulationId: string;
  name: string;
  cutoffRef: string;
  allowedRef: string;
  rulesRef?: string;
  [key: string]: unknown;
}

export interface ParsedRegulationMetadata {
  envelope: ParsedContentEnvelope<JsonObject>;
  metadata: RegulationMetadata;
  sourcePath?: string;
}

export interface RegulationContentSources {
  metadata: unknown;
  rules?: string;
  /** Compatibility spelling for callers that call the source a rules file. */
  rulesText?: string;
  metadataSourcePath?: string;
  rulesSourcePath?: string;
  resolver?: CardNameResolver;
}

export interface RegulationValidationOptions {
  resolver?: CardNameResolver;
}

export interface RegulationLimit {
  section: RegulationRuleSection;
  copyLimit: number;
  rule: RegulationRule;
}

export interface CampaignRegulation {
  metadata: RegulationMetadata;
  allowedRuntimeIds: ReadonlySet<number>;
  /** Whether an authored allowed list exists and must be enforced as a card pool. */
  enforceAllowed: boolean;
  limits: ReadonlyMap<number, RegulationLimit>;
  rules: readonly RegulationRule[];
}

export interface RegulationValidationResult {
  ok: boolean;
  metadata?: ParsedRegulationMetadata;
  rules: ParsedRegulationRules;
  entries: RegulationRule[];
  regulation?: CampaignRegulation;
  resolutions: CardResolution[];
  resolutionLock?: CardResolutionLock;
  problems: Problem[];
  warnings: Problem[];
}

export interface RegulationTargetCompileResult extends RegulationValidationResult {
  deployable: false;
  targetCapability: {
    status: 'unsupported';
    blockingCode: typeof REGULATION_CODES.TARGET_UNSUPPORTED;
  };
}

export class RegulationContentError extends Error {
  readonly code: string;
  readonly problems: Problem[];

  constructor(code: string, message: string, problems: Problem[] = []) {
    super(message);
    this.name = 'RegulationContentError';
    this.code = code;
    this.problems = problems.length ? problems : [contentDiagnostic({ code, message })];
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const compareOrdinal = (left: string, right: string): number => {
  if (left === right) return 0;
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftPoints[index]?.codePointAt(0) || 0;
    const rightCodePoint = rightPoints[index]?.codePointAt(0) || 0;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
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

const sortedProblems = (problems: readonly Problem[]): Problem[] => [...problems].sort(problemSort);

const diagnostic = (
  code: string,
  message: string,
  sourcePath?: string,
  span?: SourceSpan,
  jsonPointer?: string,
): Problem => contentDiagnostic({ code, message, sourcePath, span, jsonPointer });

const emptySections = (): Record<RegulationRuleSection, RegulationRule[]> => ({
  allowed: [],
  forbidden: [],
  limited: [],
  'semi-limited': [],
});

const sectionName = (value: string): RegulationRuleSection | undefined => {
  const normalized = value.trim().toLowerCase().replace(/_/gu, '-');
  if (normalized === 'allowed' || normalized === 'available' || normalized === 'card-pool') return 'allowed';
  if (normalized === 'forbidden' || normalized === 'banned' || normalized === 'ban') return 'forbidden';
  if (normalized === 'limited' || normalized === 'limit') return 'limited';
  if (normalized === 'semi-limited' || normalized === 'semilimited' || normalized === 'semi-limit') return 'semi-limited';
  return undefined;
};

const expectedLimit = (section: RegulationRuleSection): number | undefined => {
  if (section === 'forbidden') return 0;
  if (section === 'limited') return 1;
  if (section === 'semi-limited') return 2;
  return undefined;
};

const entryDiagnostic = (code: string, message: string, entry: SectionedEntry): Problem =>
  diagnostic(code, message, entry.span.sourcePath, entry.span);

const parseRuleEntry = (
  entry: SectionedEntry,
  section: RegulationRuleSection,
): { rule?: RegulationRule; problems: Problem[] } => {
  const tokens = [...entry.tokens];
  const countToken = tokens[0];
  if (!countToken || !/^\d+$/u.test(countToken)) {
    return {
      problems: [entryDiagnostic(REGULATION_CODES.COPY_LIMIT_MISSING, 'Regulation rule requires an explicit copy limit before the English card name', entry)],
    };
  }
  const copyLimit = Number(countToken);
  const cardName = tokens.slice(1).join(' ').trim();
  const problems: Problem[] = [];
  if (!cardName) problems.push(entryDiagnostic(REGULATION_CODES.RULE_ENTRY_INVALID, 'Regulation rule requires an English card name', entry));
  if (!Number.isSafeInteger(copyLimit) || copyLimit < 0 || copyLimit > 3) {
    problems.push(entryDiagnostic(REGULATION_CODES.COPY_LIMIT_INVALID, 'Regulation copy limit must be an integer from 0 through 3', entry));
  }
  const requiredLimit = expectedLimit(section);
  if (requiredLimit !== undefined && copyLimit !== requiredLimit) {
    problems.push(entryDiagnostic(
      REGULATION_CODES.RULE_CONTRADICTORY,
      `${section} rules must use an explicit copy limit of ${requiredLimit}`,
      entry,
    ));
  }
  if (section === 'allowed' && copyLimit === 0) {
    problems.push(entryDiagnostic(REGULATION_CODES.RULE_CONTRADICTORY, 'An allowed card must have a positive copy limit', entry));
  }
  if (problems.length || !cardName) return { problems };
  return {
    rule: {
      section,
      sourceName: cardName,
      copyLimit,
      line: entry.line,
      raw: entry.raw,
      ...(entry.span.sourcePath ? { sourcePath: entry.span.sourcePath } : {}),
      sourceSpan: entry.span,
    },
    problems,
  };
};

/** Parse the small, reviewable regulation list format used by campaign content. */
export const parseRegulationRules = (source: string, sourcePath?: string): ParsedRegulationRules => {
  const sectioned = parseSectionedDocument(source, { sourcePath });
  const diagnostics = [...sectioned.diagnostics];
  const sections = emptySections();
  const entries: RegulationRule[] = [];
  const seenSectionLines = new Set<number>();
  for (const section of sectioned.sections) {
    const name = sectionName(section.name);
    if (!name) {
      diagnostics.push(diagnostic(
        REGULATION_CODES.RULE_SECTION_UNKNOWN,
        `Unknown regulation rule section: ${section.name}`,
        sourcePath,
        section.span,
      ));
      section.entries.forEach((entry) => seenSectionLines.add(entry.line));
      continue;
    }
    for (const entry of section.entries) {
      seenSectionLines.add(entry.line);
      const parsed = parseRuleEntry(entry, name);
      diagnostics.push(...parsed.problems);
      if (parsed.rule) {
        sections[name].push(parsed.rule);
        entries.push(parsed.rule);
      }
    }
  }
  for (const entry of sectioned.entries) {
    if (!seenSectionLines.has(entry.line)) {
      diagnostics.push(entryDiagnostic(REGULATION_CODES.RULE_ENTRY_INVALID, 'Regulation rule must appear inside a supported section', entry));
    }
  }
  return {
    parserVersion: REGULATION_RULES_PARSER_VERSION,
    ...(sourcePath ? { sourcePath } : {}),
    originalText: source,
    entries,
    sections,
    diagnostics: sortedProblems(diagnostics),
  };
};

export const parseRegulationRuleList = parseRegulationRules;

const parseReference = (
  raw: unknown,
  codeMissing: string,
  codeInvalid: string,
  label: string,
  sourcePath?: string,
  pointer?: string,
): { value?: string; problems: Problem[] } => {
  if (!nonEmptyString(raw)) return { problems: [diagnostic(codeMissing, `${label} is required`, sourcePath, undefined, pointer)] };
  if (/^\d+$/u.test(raw.trim())) {
    return { problems: [diagnostic(codeInvalid, `${label} must be a symbolic reference`, sourcePath, undefined, pointer)] };
  }
  try {
    return { value: normalizeSymbolicReference(raw).normalized, problems: [] };
  } catch (error) {
    const details = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
    return { problems: [diagnostic(codeInvalid, details || `Invalid ${label}`, sourcePath, undefined, pointer)] };
  }
};

const parseEnvelope = (
  input: unknown,
  sourcePath?: string,
): { parsed?: ParsedContentEnvelope<JsonObject>; problems: Problem[] } => {
  try {
    const parsed = parseContentEnvelopeWithSource<JsonObject>(input, { sourcePath });
    const problems: Problem[] = [];
    if (parsed.envelope.formatVersion !== REGULATION_CONTENT_FORMAT_VERSION) {
      problems.push(diagnostic(
        REGULATION_CODES.ENVELOPE_INVALID,
        `Regulation formatVersion must be ${REGULATION_CONTENT_FORMAT_VERSION}`,
        sourcePath,
        undefined,
        '/formatVersion',
      ));
    }
    if (parsed.envelope.kind !== REGULATION_CONTENT_KIND) {
      problems.push(diagnostic(
        REGULATION_CODES.KIND_INVALID,
        `Regulation content kind must be ${REGULATION_CONTENT_KIND}`,
        sourcePath,
        undefined,
        '/kind',
      ));
    }
    return { parsed, problems };
  } catch (error) {
    if (error instanceof ContentFormatError) return { problems: sortedProblems(error.problems) };
    return { problems: [diagnostic(REGULATION_CODES.ENVELOPE_INVALID, String(error), sourcePath)] };
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

export interface RegulationMetadataParseResult {
  document?: ParsedRegulationMetadata;
  problems: Problem[];
}

export const parseRegulationMetadata = (
  input: unknown,
  sourcePath?: string,
): RegulationMetadataParseResult => {
  const envelopeResult = parseEnvelope(input, sourcePath);
  if (!envelopeResult.parsed) return { problems: envelopeResult.problems };
  const problems = [...envelopeResult.problems];
  const payload = envelopeResult.parsed.envelope.payload;
  if (!isRecord(payload)) {
    problems.push(diagnostic(REGULATION_CODES.METADATA_INVALID, 'Regulation metadata payload must be an object', sourcePath, undefined, '/payload'));
    return { problems: sortedProblems(problems) };
  }

  const idField = metadataField(payload, 'regulationId', 'id');
  if (idField.conflict) problems.push(diagnostic(REGULATION_CODES.METADATA_INVALID, 'regulationId and id references disagree', sourcePath, undefined, '/payload'));
  const id = idField.value;
  let normalizedRegulationId: string | undefined;
  if (!nonEmptyString(id)) {
    problems.push(diagnostic(REGULATION_CODES.ID_MISSING, 'Regulation metadata requires a symbolic regulationId', sourcePath, undefined, '/payload/regulationId'));
  } else if (/^\d+$/u.test(id.trim())) {
    problems.push(diagnostic(REGULATION_CODES.ID_INVALID, 'regulationId must be symbolic, not a numeric target ID', sourcePath, undefined, '/payload/regulationId'));
  } else {
    try {
      const reference = normalizeSymbolicReference(id);
      normalizedRegulationId = reference.namespace ? reference.normalized : `regulation:${reference.key}`;
    } catch (error) {
      const details = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
      problems.push(diagnostic(REGULATION_CODES.ID_INVALID, details || 'Invalid regulationId', sourcePath, undefined, '/payload/regulationId'));
    }
  }
  if (!nonEmptyString(payload.name)) problems.push(diagnostic(REGULATION_CODES.NAME_MISSING, 'Regulation metadata requires a non-empty name', sourcePath, undefined, '/payload/name'));

  const cutoff = metadataField(payload, 'cutoffRef', 'cutoff');
  const allowed = metadataField(payload, 'allowedRef', 'allowed');
  if (cutoff.conflict) problems.push(diagnostic(REGULATION_CODES.METADATA_INVALID, 'cutoffRef and cutoff references disagree', sourcePath, undefined, '/payload'));
  if (allowed.conflict) problems.push(diagnostic(REGULATION_CODES.METADATA_INVALID, 'allowedRef and allowed references disagree', sourcePath, undefined, '/payload'));
  const cutoffResult = parseReference(cutoff.value, REGULATION_CODES.CUTOFF_MISSING, REGULATION_CODES.CUTOFF_INVALID, 'cutoffRef', sourcePath, '/payload/cutoffRef');
  const allowedResult = parseReference(allowed.value, REGULATION_CODES.ALLOWED_REF_MISSING, REGULATION_CODES.ALLOWED_REF_INVALID, 'allowedRef', sourcePath, '/payload/allowedRef');
  problems.push(...cutoffResult.problems, ...allowedResult.problems);

  let rulesRef: string | undefined;
  if (payload.rulesRef !== undefined) {
    if (!nonEmptyString(payload.rulesRef)) problems.push(diagnostic(REGULATION_CODES.METADATA_INVALID, 'rulesRef must be a non-empty relative content reference', sourcePath, undefined, '/payload/rulesRef'));
    else if (payload.rulesRef.includes('..') || payload.rulesRef.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(payload.rulesRef)) {
      problems.push(diagnostic(REGULATION_CODES.METADATA_INVALID, 'rulesRef must remain inside the authored content root', sourcePath, undefined, '/payload/rulesRef'));
    } else rulesRef = payload.rulesRef.replace(/\\/gu, '/');
  }

  if (!normalizedRegulationId || !nonEmptyString(payload.name) || !cutoffResult.value || !allowedResult.value) {
    return { problems: sortedProblems(problems) };
  }
  const metadata: RegulationMetadata = {
    ...payload,
    regulationId: id as string,
    normalizedRegulationId,
    name: payload.name,
    cutoffRef: cutoffResult.value,
    allowedRef: allowedResult.value,
    ...(rulesRef ? { rulesRef } : {}),
  };
  return {
    document: {
      envelope: envelopeResult.parsed,
      metadata,
      ...(sourcePath ? { sourcePath } : {}),
    },
    problems: sortedProblems(problems),
  };
};

export const parseCampaignRegulationMetadata = parseRegulationMetadata;

const extractResolver = (
  input: RegulationContentSources,
  options: RegulationValidationOptions | CardNameResolver | undefined,
): { resolver?: CardNameResolver; options: RegulationValidationOptions } => {
  if (options instanceof CardNameResolver) return { resolver: options, options: {} };
  const normalizedOptions = options || {};
  return { resolver: normalizedOptions.resolver || input.resolver, options: normalizedOptions };
};

const regulationEntryPointer = (entry: RegulationRule): string => `/rules/${entry.section}/${entry.line}`;

const ruleIdentity = (entry: RegulationRule): string =>
  entry.runtimeId === undefined ? normalizeCardName(entry.sourceName) : `id:${entry.runtimeId}`;

const buildCampaignRegulation = (
  metadata: ParsedRegulationMetadata | undefined,
  entries: readonly RegulationRule[],
): CampaignRegulation | undefined => {
  if (!metadata) return undefined;
  const allowedRuntimeIds = new Set<number>();
  const limits = new Map<number, RegulationLimit>();
  for (const entry of entries) {
    if (entry.runtimeId === undefined) continue;
    const limit = { section: entry.section, copyLimit: entry.copyLimit, rule: entry };
    if (entry.section === 'allowed') {
      allowedRuntimeIds.add(entry.runtimeId);
      if (!limits.has(entry.runtimeId)) limits.set(entry.runtimeId, limit);
    } else {
      limits.set(entry.runtimeId, limit);
    }
  }
  return {
    metadata: metadata.metadata,
    allowedRuntimeIds,
    enforceAllowed: entries.some((entry) => entry.section === 'allowed'),
    limits,
    rules: entries,
  };
};

const validateRuleConsistency = (entries: readonly RegulationRule[]): Problem[] => {
  const problems: Problem[] = [];
  const bySection = new Map<string, RegulationRule>();
  const restricted = new Map<string, RegulationRule>();
  for (const entry of entries) {
    const identity = ruleIdentity(entry);
    const sectionKey = `${entry.section}:${identity}`;
    const previousSection = bySection.get(sectionKey);
    if (previousSection) {
      problems.push(diagnostic(
        REGULATION_CODES.RULE_DUPLICATE,
        `Regulation ${entry.section} rule is duplicated for ${entry.sourceName}; first declaration is line ${previousSection.line}`,
        entry.sourcePath,
        entry.sourceSpan,
        regulationEntryPointer(entry),
      ));
    } else bySection.set(sectionKey, entry);
    if (entry.section === 'allowed') continue;
    const previousRestricted = restricted.get(identity);
    if (previousRestricted) {
      const sameRule = previousRestricted.section === entry.section && previousRestricted.copyLimit === entry.copyLimit;
      problems.push(diagnostic(
        sameRule ? REGULATION_CODES.RULE_DUPLICATE : REGULATION_CODES.RULE_CONTRADICTORY,
        sameRule
          ? `Regulation rule is duplicated for ${entry.sourceName}; first declaration is line ${previousRestricted.line}`
          : `Regulation limits contradict for ${entry.sourceName}: ${previousRestricted.section} at ${previousRestricted.copyLimit} and ${entry.section} at ${entry.copyLimit}`,
        entry.sourcePath,
        entry.sourceSpan,
        regulationEntryPointer(entry),
      ));
    } else restricted.set(identity, entry);
  }
  return problems;
};

const emptyRules = (sourcePath?: string): ParsedRegulationRules => ({
  parserVersion: REGULATION_RULES_PARSER_VERSION,
  ...(sourcePath ? { sourcePath } : {}),
  originalText: '',
  entries: [],
  sections: emptySections(),
  diagnostics: [],
});

const sourceSpanForRule = (entry: RegulationRule): SourceSpan => entry.sourceSpan;

const normalizeSources = (
  input: RegulationContentSources,
): { rules?: string; rulesSourcePath?: string } => ({
  rules: input.rules ?? input.rulesText,
  rulesSourcePath: input.rulesSourcePath,
});

export function validateRegulationContent(
  input: RegulationContentSources,
  options?: RegulationValidationOptions | CardNameResolver,
): RegulationValidationResult {
  const extracted = extractResolver(input, options);
  const resolver = extracted.resolver;
  const metadataResult = parseRegulationMetadata(input.metadata, input.metadataSourcePath);
  const normalizedSource = normalizeSources(input);
  const rulesResult = normalizedSource.rules === undefined
    ? emptyRules(normalizedSource.rulesSourcePath)
    : parseRegulationRules(normalizedSource.rules, normalizedSource.rulesSourcePath);
  const problems = [...metadataResult.problems, ...rulesResult.diagnostics];
  if (normalizedSource.rules === undefined) problems.push(diagnostic(REGULATION_CODES.RULES_MISSING, 'Regulation content requires a versioned rules source', normalizedSource.rulesSourcePath));
  if (!rulesResult.entries.some((entry) => entry.section === 'allowed')) {
    problems.push(diagnostic(REGULATION_CODES.ALLOWED_LIST_MISSING, 'Regulation content requires at least one allowed card-pool rule', normalizedSource.rulesSourcePath));
  }

  const entries = rulesResult.entries.map((entry) => ({ ...entry }));
  const resolutions: CardResolution[] = [];
  if (entries.length && !resolver) {
    problems.push(diagnostic(REGULATION_CODES.RESOLVER_REQUIRED, 'Regulation content validation requires the shared CardNameResolver', normalizedSource.rulesSourcePath));
  } else if (resolver) {
    for (const entry of entries) {
      const resolution = resolver.resolve({
        sourceName: entry.sourceName,
        sourcePath: entry.sourcePath,
        sourceSpan: sourceSpanForRule(entry),
        jsonPointer: regulationEntryPointer(entry),
      });
      resolutions.push(resolution);
      problems.push(...resolution.problems);
      if (resolution.ok && resolution.runtimeId !== undefined) {
        entry.runtimeId = resolution.runtimeId;
        entry.normalizedName = resolution.normalizedName;
      }
    }
    if (resolutions.length && resolutions.every((resolution) => resolution.ok)) {
      const lock = resolver.resolveBatch(entries.map((entry) => ({
        sourceName: entry.sourceName,
        sourcePath: entry.sourcePath,
        sourceSpan: entry.sourceSpan,
        jsonPointer: regulationEntryPointer(entry),
      }))).lock;
      if (lock) {
        const regulation = buildCampaignRegulation(metadataResult.document, entries);
        const consistency = validateRuleConsistency(entries);
        problems.push(...consistency);
        const sorted = sortedProblems(problems);
        return {
          ok: sorted.every((problem) => problem.severity === 'warning'),
          ...(metadataResult.document ? { metadata: metadataResult.document } : {}),
          rules: rulesResult,
          entries,
          ...(regulation ? { regulation } : {}),
          resolutions,
          resolutionLock: lock,
          problems: sorted,
          warnings: sorted.filter((problem) => problem.severity === 'warning'),
        };
      }
    }
  }
  problems.push(...validateRuleConsistency(entries));
  const sorted = sortedProblems(problems);
  return {
    ok: sorted.every((problem) => problem.severity === 'warning'),
    ...(metadataResult.document ? { metadata: metadataResult.document } : {}),
    rules: rulesResult,
    entries,
    ...(buildCampaignRegulation(metadataResult.document, entries) ? { regulation: buildCampaignRegulation(metadataResult.document, entries) } : {}),
    resolutions,
    problems: sorted,
    warnings: sorted.filter((problem) => problem.severity === 'warning'),
  };
}

export const validateCampaignRegulation = validateRegulationContent;
export const validateRegulation = validateRegulationContent;

const violationProblems = (
  code: string,
  message: string,
  entry: DeckRegulationContext,
): Problem[] => entry.spans.map((span) => diagnostic(code, message, span.sourcePath, span));

/**
 * The hook is deliberately role-agnostic: player, CPU, rental, and structure
 * decks all pass the same resolved-card context through DeckRegulationHook.
 */
export const createDeckRegulationHook = (
  source: CampaignRegulation | RegulationValidationResult,
): DeckRegulationHook => {
  const regulation: CampaignRegulation | undefined = 'limits' in source ? source : source.regulation;
  if (!regulation) throw new RegulationContentError(REGULATION_CODES.METADATA_INVALID, 'Cannot create a regulation hook without a parsed regulation model');
  return (entry: DeckRegulationContext): readonly Problem[] => {
    const problems: Problem[] = [];
    if (regulation.enforceAllowed && !regulation.allowedRuntimeIds.has(entry.runtimeId)) {
      problems.push(...violationProblems(
        REGULATION_CODES.CARD_NOT_ALLOWED,
        `Card ${entry.sourceName} is outside the allowed card pool for ${regulation.metadata.normalizedRegulationId}`,
        entry,
      ));
    }
    const limit = regulation.limits.get(entry.runtimeId);
    if (!limit || entry.totalCopies <= limit.copyLimit) return problems;
    const code = limit.section === 'forbidden' ? REGULATION_CODES.CARD_FORBIDDEN : REGULATION_CODES.COPY_LIMIT_EXCEEDED;
    const message = limit.section === 'forbidden'
      ? `Card ${entry.sourceName} is forbidden by ${regulation.metadata.normalizedRegulationId}`
      : `Card ${entry.sourceName} exceeds the ${limit.section} limit of ${limit.copyLimit} (found ${entry.totalCopies}) under ${regulation.metadata.normalizedRegulationId}`;
    problems.push(...violationProblems(code, message, entry));
    return problems;
  };
};

export const createRegulationDeckHook = createDeckRegulationHook;
export const createRegulationHook = createDeckRegulationHook;

/**
 * Content legality is useful for review, but regulation overlay deployment is
 * intentionally blocked until the target contract is explicitly opened.
 */
export const compileRegulationContent = (
  input: RegulationContentSources,
  options?: RegulationValidationOptions | CardNameResolver,
): RegulationTargetCompileResult => {
  const validation = validateRegulationContent(input, options);
  const targetProblems = validateTargetCapability('regulationOverlay', input.metadataSourcePath);
  const blocking = targetProblems.length
    ? targetProblems
    : [diagnostic(REGULATION_CODES.TARGET_UNSUPPORTED, 'Regulation target deployment is unsupported under the campaign target contract', input.metadataSourcePath)];
  const problems = sortedProblems([...validation.problems, ...blocking]);
  return {
    ...validation,
    ok: false,
    deployable: false,
    targetCapability: {
      status: 'unsupported',
      blockingCode: REGULATION_CODES.TARGET_UNSUPPORTED,
    },
    problems,
  };
};

export const compileRegulationTarget = compileRegulationContent;
export const compileCampaignRegulation = compileRegulationContent;

export const regulationCapabilityGolden = (): JsonObject => ({
  formatVersion: REGULATION_CONTENT_FORMAT_VERSION,
  kind: 'regulation-capability',
  payload: {
    family: 'regulation',
    status: 'unsupported',
    blockingCode: REGULATION_CODES.TARGET_UNSUPPORTED,
    supportedSubset: [],
    evidence: 'target-contract-v1',
  },
});
