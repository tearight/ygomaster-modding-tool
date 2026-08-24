import * as fs from 'node:fs/promises';

import {
  CARD_RESOLVER_CODES,
  CardNameResolver,
  CardResolutionLock,
  normalizeCardName,
} from './card-resolver';
import {
  contentDiagnostic,
  parseSectionedLines,
  SectionedLineAst,
  SourceSpan,
} from './content-format';
import type { Problem } from './types';

export const DECK_CONTENT_VERSION = 1 as const;
export const DECK_PARSER_VERSION = 1 as const;
export const DECK_DEFAULT_RARITY = 1 as const;

export const DECK_SECTIONS = ['main', 'extra', 'side'] as const;
export type DeckSection = (typeof DECK_SECTIONS)[number];

export const DECK_LIMITS = Object.freeze({
  main: Object.freeze({ min: 40, max: 60 }),
  extra: Object.freeze({ min: 0, max: 15 }),
  side: Object.freeze({ min: 0, max: 15 }),
  copies: 3,
});

export const DECK_CODES = Object.freeze({
  SECTION_UNKNOWN: 'DECK_SECTION_UNKNOWN',
  UNKNOWN_SECTION: 'DECK_SECTION_UNKNOWN',
  SECTION_MISSING: 'DECK_SECTION_MISSING',
  MISSING_SECTION: 'DECK_SECTION_MISSING',
  SECTION_DUPLICATE: 'DECK_SECTION_DUPLICATE',
  ENTRY_OUTSIDE_SECTION: 'DECK_ENTRY_OUTSIDE_SECTION',
  COUNT_INVALID: 'DECK_COUNT_INVALID',
  INVALID_COUNT: 'DECK_COUNT_INVALID',
  NAME_INVALID: 'DECK_NAME_INVALID',
  NAME_MISSING: 'DECK_NAME_INVALID',
  RUNTIME_ID_FORBIDDEN: 'DECK_RUNTIME_ID_FORBIDDEN',
  MAIN_SIZE_INVALID: 'DECK_MAIN_SIZE_INVALID',
  MAIN_SIZE: 'DECK_MAIN_SIZE_INVALID',
  EXTRA_SIZE_INVALID: 'DECK_EXTRA_SIZE_INVALID',
  EXTRA_SIZE: 'DECK_EXTRA_SIZE_INVALID',
  SIDE_SIZE_INVALID: 'DECK_SIDE_SIZE_INVALID',
  SIDE_SIZE: 'DECK_SIDE_SIZE_INVALID',
  EXTRA_LEGALITY_UNAVAILABLE: 'DECK_EXTRA_LEGALITY_UNAVAILABLE',
  EXTRA_CARD_INVALID: 'DECK_EXTRA_CARD_INVALID',
  COPY_LIMIT: 'DECK_COPY_LIMIT',
  REGULATION_VIOLATION: 'DECK_REGULATION_VIOLATION',
  DEFAULT_RARITY_INVALID: 'DECK_DEFAULT_RARITY_INVALID',
  RARITY_INVALID: 'DECK_DEFAULT_RARITY_INVALID',
  CARD_UNRESOLVED: CARD_RESOLVER_CODES.NAME_UNRESOLVED,
  CARD_AMBIGUOUS: CARD_RESOLVER_CODES.NAME_AMBIGUOUS,
  CARD_RUNTIME_UNAVAILABLE: CARD_RESOLVER_CODES.RUNTIME_UNAVAILABLE,
  IR_BLOCKED: 'DECK_IR_BLOCKED',
  IR_INVALID: 'DECK_IR_INVALID',
  METADATA_INVALID: 'DECK_METADATA_INVALID',
  INTAKE_UNPARSED: 'DECK_INTAKE_UNPARSED',
} as const);

export interface DeckProvenance {
  source?: string;
  sourceUrl?: string;
  revision?: string;
  retrievedAt?: string;
  [key: string]: unknown;
}

/** Metadata is a separate authored JSON concern; it is never inferred from card lines. */
export interface DeckMetadata {
  name?: string;
  role?: string;
  provenance?: DeckProvenance;
  [key: string]: unknown;
}

export interface DeckParseOptions {
  sourcePath?: string;
  metadata?: DeckMetadata;
}

export interface DeckLineEntry {
  line: number;
  section: DeckSection;
  count: number;
  sourceName: string;
  /** Name after line whitespace normalization, before card catalog resolution. */
  value: string;
  raw: string;
  span: SourceSpan;
}

export interface DeckSectionDocument {
  name: DeckSection;
  line?: number;
  span?: SourceSpan;
  entries: DeckLineEntry[];
}

export type DeckSectionMap<T> = Record<DeckSection, T>;

export interface DeckDocument {
  formatVersion: typeof DECK_CONTENT_VERSION;
  parserVersion: typeof DECK_PARSER_VERSION;
  sourcePath?: string;
  originalText: string;
  metadata: DeckMetadata;
  lines: SectionedLineAst[];
  sections: DeckSectionMap<DeckSectionDocument>;
  entries: DeckLineEntry[];
  diagnostics: Problem[];
  ok: boolean;
}

export interface DeckIntakeEntry {
  line: number;
  section: DeckSection;
  count: number;
  original: string;
  sourceName: string;
  normalizedName: string;
  normalized: string;
  span: SourceSpan;
}

export interface DeckIntakeDiscardedLine {
  line: number;
  original: string;
  reason: 'blank' | 'comment';
  span: SourceSpan;
}

export interface DeckIntakeUnparsedLine {
  line: number;
  original: string;
  reason: string;
  span: SourceSpan;
}

export interface DeckIntakePreview {
  parserVersion: typeof DECK_PARSER_VERSION;
  sourcePath?: string;
  originalText: string;
  section: DeckSection;
  entries: DeckIntakeEntry[];
  parsed: DeckIntakeEntry[];
  discardedLines: DeckIntakeDiscardedLine[];
  discarded: DeckIntakeDiscardedLine[];
  unparsedLines: DeckIntakeUnparsedLine[];
  unparsed: DeckIntakeUnparsedLine[];
  diagnostics: Problem[];
  ok: boolean;
}

export interface ResolvedDeckCard {
  section: DeckSection;
  runtimeId: number;
  count: number;
  rarity: number;
  sourceName: string;
  normalizedName: string;
  sourceNames: string[];
  spans: SourceSpan[];
}

export interface DeckResolutionOptions {
  defaultRarity?: number;
  /** Explicit campaign policy for deciding whether a resolved card belongs in Extra. */
  extraDeckCardIds?: ReadonlySet<number> | readonly number[];
  /** Alternative campaign policy; this is intentionally not a global card ontology. */
  isExtraDeckCard?: (runtimeId: number) => boolean;
  regulation?: DeckRegulationHook;
  regulationHook?: DeckRegulationHook;
}

export interface DeckRegulationContext extends ResolvedDeckCard {
  totalCopies: number;
}

export type DeckRegulationHookResult =
  | void
  | boolean
  | string
  | Problem
  | readonly Problem[];

export type DeckRegulationHook = (entry: DeckRegulationContext) => DeckRegulationHookResult;

export interface DeckIRPart {
  ids: number[];
  r: number[];
}

/** The short m/e/s form is the shape consumed by the current overlay core. */
export interface DeckIR {
  m: DeckIRPart;
  e: DeckIRPart;
  s: DeckIRPart;
}

export interface DeckResolutionResult {
  ok: boolean;
  document: DeckDocument;
  sections: DeckSectionMap<ResolvedDeckCard[]>;
  entries: ResolvedDeckCard[];
  problems: Problem[];
  lock?: CardResolutionLock;
}

export interface DeckCompileResult extends DeckResolutionResult {
  ir?: DeckIR;
  metadata: DeckMetadata;
  defaultRarity: number;
}

export class DeckContentError extends Error {
  readonly code: string;
  readonly problems: Problem[];

  constructor(code: string, message: string, problems: Problem[] = []) {
    super(message);
    this.name = 'DeckContentError';
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

const compareProblems = (left: Problem, right: Problem): number =>
  compareOrdinal(left.sourcePath || left.path || '', right.sourcePath || right.path || '')
  || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
  || (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER)
  || compareOrdinal(left.code, right.code)
  || compareOrdinal(left.message, right.message);

const sourceSpanAt = (sourcePath: string | undefined, line: number, endColumn = 1): SourceSpan => ({
  ...(sourcePath ? { sourcePath } : {}),
  line,
  column: 1,
  endLine: line,
  endColumn,
});

const sectionRecord = (name: DeckSection): DeckSectionDocument => ({ name, entries: [] });

const emptySections = (): DeckSectionMap<DeckSectionDocument> => ({
  main: sectionRecord('main'),
  extra: sectionRecord('extra'),
  side: sectionRecord('side'),
});

const emptyResolvedSections = (): DeckSectionMap<ResolvedDeckCard[]> => ({ main: [], extra: [], side: [] });

const optionsWithPath = (sourcePathOrOptions?: string | DeckParseOptions): DeckParseOptions =>
  typeof sourcePathOrOptions === 'string' ? { sourcePath: sourcePathOrOptions } : (sourcePathOrOptions || {});

const parseCountAndName = (value: string): { count?: number; name?: string; code?: string; message?: string } => {
  const match = /^(\S+)(?:\s+)(.*)$/u.exec(value.trim());
  if (!match) {
    return {
      code: value.trim() ? DECK_CODES.COUNT_INVALID : DECK_CODES.NAME_INVALID,
      message: value.trim() ? 'Deck entry must start with a count followed by an English card name' : 'Deck card name is missing',
    };
  }
  const [, rawCount, rawName] = match;
  if (!/^\d+$/u.test(rawCount || '')) {
    return { code: DECK_CODES.COUNT_INVALID, message: `Deck count must be a positive integer: ${rawCount}` };
  }
  const count = Number(rawCount);
  if (!Number.isSafeInteger(count) || count < 1) {
    return { code: DECK_CODES.COUNT_INVALID, message: `Deck count must be between 1 and ${Number.MAX_SAFE_INTEGER}` };
  }
  const name = (rawName || '').trim();
  if (!name) return { code: DECK_CODES.NAME_INVALID, message: 'Deck card name is missing' };
  if (/^\d+$/u.test(name)) {
    return { code: DECK_CODES.RUNTIME_ID_FORBIDDEN, message: 'Authored decklists use English card names, not runtime IDs or passcodes' };
  }
  return { count, name };
};

const metadataCopy = (metadata: DeckMetadata | undefined, sourcePath?: string): { metadata: DeckMetadata; problems: Problem[] } => {
  if (metadata === undefined) return { metadata: {}, problems: [] };
  if (!isRecord(metadata)) {
    return {
      metadata: {},
      problems: [contentDiagnostic({ code: DECK_CODES.METADATA_INVALID, message: 'Deck metadata must be an object', sourcePath, jsonPointer: '' })],
    };
  }
  return { metadata: clone(metadata) as DeckMetadata, problems: [] };
};

/** Parse the authored [main]/[extra]/[side] line format without resolving names. */
export const parseDecklist = (
  source: string,
  sourcePathOrOptions?: string | DeckParseOptions,
): DeckDocument => {
  const options = optionsWithPath(sourcePathOrOptions);
  const sectioned = parseSectionedLines(source, options.sourcePath);
  const diagnostics = [...sectioned.diagnostics];
  const sections = emptySections();
  const { metadata, problems: metadataProblems } = metadataCopy(options.metadata, options.sourcePath);
  diagnostics.push(...metadataProblems);

  const seenSections = new Set<string>();
  for (const section of sectioned.sections) {
    const normalizedName = section.normalizedName;
    if (!DECK_SECTIONS.includes(normalizedName as DeckSection)) {
      diagnostics.push(contentDiagnostic({
        code: DECK_CODES.SECTION_UNKNOWN,
        message: `Deck section is not supported: ${section.name}`,
        sourcePath: options.sourcePath,
        span: section.span,
      }));
      continue;
    }
    const name = normalizedName as DeckSection;
    if (seenSections.has(name)) {
      diagnostics.push(contentDiagnostic({
        code: DECK_CODES.SECTION_DUPLICATE,
        message: `Deck section appears more than once: ${name}`,
        sourcePath: options.sourcePath,
        span: section.span,
      }));
      continue;
    }
    seenSections.add(name);
    sections[name].line = section.line;
    sections[name].span = section.span;
  }

  const entries: DeckLineEntry[] = [];
  for (const entry of sectioned.entries) {
    if (!entry.section || !DECK_SECTIONS.includes(entry.section as DeckSection)) {
      diagnostics.push(contentDiagnostic({
        code: DECK_CODES.ENTRY_OUTSIDE_SECTION,
        message: 'Deck card entry must appear after [main], [extra], or [side]',
        sourcePath: options.sourcePath,
        span: entry.span,
      }));
      continue;
    }
    const section = entry.section as DeckSection;
    if (!seenSections.has(section)) continue;
    const parsed = parseCountAndName(entry.value);
    if (parsed.code || parsed.count === undefined || parsed.name === undefined) {
      diagnostics.push(contentDiagnostic({
        code: parsed.code || DECK_CODES.NAME_INVALID,
        message: parsed.message || 'Invalid deck entry',
        sourcePath: options.sourcePath,
        span: entry.span,
      }));
      continue;
    }
    const deckEntry: DeckLineEntry = {
      line: entry.line,
      section,
      count: parsed.count,
      sourceName: parsed.name,
      value: entry.value,
      raw: entry.raw,
      span: entry.span,
    };
    entries.push(deckEntry);
    sections[section].entries.push(deckEntry);
  }

  for (const section of DECK_SECTIONS) {
    if (!seenSections.has(section)) {
      const firstSpan = sectioned.lines[0]?.span || sourceSpanAt(options.sourcePath, 1);
      diagnostics.push(contentDiagnostic({
        code: DECK_CODES.SECTION_MISSING,
        message: `Deck must declare [${section}] section`,
        sourcePath: options.sourcePath,
        span: firstSpan,
      }));
    }
  }

  const sortedDiagnostics = diagnostics.sort(compareProblems);
  return {
    formatVersion: DECK_CONTENT_VERSION,
    parserVersion: DECK_PARSER_VERSION,
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    originalText: source,
    metadata,
    lines: sectioned.lines,
    sections,
    entries,
    diagnostics: sortedDiagnostics,
    ok: sortedDiagnostics.every((problem) => problem.severity === 'warning'),
  };
};

export const parseLineDecklist = parseDecklist;
export const parseDeckContent = parseDecklist;

export const readDecklist = async (
  decklistPath: string,
  options: Omit<DeckParseOptions, 'sourcePath'> = {},
): Promise<DeckDocument> => parseDecklist(await fs.readFile(decklistPath, 'utf8'), { ...options, sourcePath: decklistPath });

export const readDeckContent = readDecklist;

const intakeDiagnostic = (sourcePath: string | undefined, span: SourceSpan, message: string): Problem =>
  contentDiagnostic({ code: DECK_CODES.INTAKE_UNPARSED, message, sourcePath, span, severity: 'warning' });

/** Preview generic count/name text before assigning it to an authored deck section. */
export const previewPlainTextDecklist = (
  source: string,
  options: { sourcePath?: string; section?: DeckSection } = {},
): DeckIntakePreview => {
  const section = options.section || 'main';
  const sectioned = parseSectionedLines(source, options.sourcePath);
  const diagnostics = [...sectioned.diagnostics];
  const entries: DeckIntakeEntry[] = [];
  const discarded: DeckIntakeDiscardedLine[] = [];
  const unparsed: DeckIntakeUnparsedLine[] = [];
  const existingDiagnosticLines = new Set(diagnostics.map((problem) => problem.line).filter((line): line is number => line !== undefined));

  for (const line of sectioned.lines) {
    const content = line.content.trim();
    if (!content) {
      discarded.push({
        line: line.line,
        original: line.original,
        reason: line.comment !== undefined ? 'comment' : 'blank',
        span: clone(line.span),
      });
      continue;
    }
    if (line.normalized.kind === 'section') {
      const item = { line: line.line, original: line.original, reason: 'section headers are not accepted by plain-text intake', span: clone(line.span) };
      unparsed.push(item);
      diagnostics.push(intakeDiagnostic(options.sourcePath, line.span, item.reason));
      continue;
    }
    if (line.normalized.kind === 'invalid') {
      const reason = 'Line could not be parsed by the sectioned lexer';
      const item = { line: line.line, original: line.original, reason, span: clone(line.span) };
      unparsed.push(item);
      if (!existingDiagnosticLines.has(line.line)) diagnostics.push(intakeDiagnostic(options.sourcePath, line.span, reason));
      continue;
    }
    const parsed = parseCountAndName(content);
    if (parsed.code || parsed.count === undefined || parsed.name === undefined) {
      const reason = parsed.message || 'Line does not match count + English card name';
      const item = { line: line.line, original: line.original, reason, span: clone(line.span) };
      unparsed.push(item);
      if (!existingDiagnosticLines.has(line.line)) diagnostics.push(intakeDiagnostic(options.sourcePath, line.span, reason));
      continue;
    }
    const normalizedName = normalizeCardName(parsed.name);
    if (!normalizedName) {
      const reason = 'Card name normalizes to empty';
      const item = { line: line.line, original: line.original, reason, span: clone(line.span) };
      unparsed.push(item);
      diagnostics.push(intakeDiagnostic(options.sourcePath, line.span, reason));
      continue;
    }
    entries.push({
      line: line.line,
      section,
      count: parsed.count,
      original: line.original,
      sourceName: parsed.name,
      normalizedName,
      normalized: `${parsed.count} ${normalizedName}`,
      span: clone(line.span),
    });
  }

  const sortedDiagnostics = diagnostics.sort(compareProblems);
  return {
    parserVersion: DECK_PARSER_VERSION,
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    originalText: source,
    section,
    entries,
    parsed: entries,
    discardedLines: discarded,
    discarded,
    unparsedLines: unparsed,
    unparsed,
    diagnostics: sortedDiagnostics,
    ok: unparsed.length === 0 && sortedDiagnostics.every((problem) => problem.severity === 'warning'),
  };
};

export const previewDeckIntake = previewPlainTextDecklist;
export const importPlainTextDecklist = previewPlainTextDecklist;

const addProblem = (problems: Problem[], problem: Problem, fallback: { sourcePath?: string; span?: SourceSpan }) => {
  if (problem.sourcePath || problem.path || problem.sourceSpan || problem.line !== undefined) {
    problems.push(problem);
    return;
  }
  problems.push(contentDiagnostic({
    code: problem.code,
    message: problem.message,
    sourcePath: fallback.sourcePath,
    span: fallback.span,
    severity: problem.severity,
    suggestion: problem.suggestion,
  }));
};

const validateRarity = (value: number): Problem[] => {
  if (Number.isSafeInteger(value) && value >= 0) return [];
  return [contentDiagnostic({
    code: DECK_CODES.DEFAULT_RARITY_INVALID,
    message: 'Default deck rarity must be a non-negative safe integer',
  })];
};

const hasExtraDeckPolicy = (options: DeckResolutionOptions): boolean =>
  typeof options.isExtraDeckCard === 'function' || options.extraDeckCardIds !== undefined;

const extraDeckCardAllowed = (runtimeId: number, options: DeckResolutionOptions): boolean => {
  if (typeof options.isExtraDeckCard === 'function') return options.isExtraDeckCard(runtimeId);
  if (options.extraDeckCardIds === undefined) return false;
  return Array.isArray(options.extraDeckCardIds)
    ? (options.extraDeckCardIds as readonly number[]).includes(runtimeId)
    : (options.extraDeckCardIds as ReadonlySet<number>).has(runtimeId);
};

const aggregateResolved = (
  document: DeckDocument,
  resolutions: ReturnType<CardNameResolver['resolveBatch']>['resolutions'],
  defaultRarity: number,
): { sections: DeckSectionMap<ResolvedDeckCard[]>; entries: ResolvedDeckCard[] } => {
  const sections = emptyResolvedSections();
  const bySection: DeckSectionMap<Map<number, ResolvedDeckCard>> = { main: new Map(), extra: new Map(), side: new Map() };
  const allEntries: ResolvedDeckCard[] = [];
  const orderedEntries = [...document.entries].sort((left, right) => left.line - right.line || compareOrdinal(left.sourceName, right.sourceName));
  const orderedResolutions = [...resolutions].sort((left, right) => {
    const leftLine = left.lockEntry?.sourceSpan?.line ?? Number.MAX_SAFE_INTEGER;
    const rightLine = right.lockEntry?.sourceSpan?.line ?? Number.MAX_SAFE_INTEGER;
    return leftLine - rightLine || compareOrdinal(left.sourceName, right.sourceName);
  });
  const resolutionBySourceLine = new Map<number, typeof orderedResolutions[number]>();
  orderedResolutions.forEach((resolution) => {
    const line = resolution.lockEntry?.sourceSpan?.line;
    if (line !== undefined) resolutionBySourceLine.set(line, resolution);
  });

  orderedEntries.forEach((entry, index) => {
    const resolution = resolutionBySourceLine.get(entry.line) || orderedResolutions[index];
    if (!resolution?.ok || resolution.runtimeId === undefined || !resolution.normalizedName) return;
    const sectionMap = bySection[entry.section];
    const current = sectionMap.get(resolution.runtimeId);
    if (current) {
      current.count += entry.count;
      current.sourceNames.push(entry.sourceName);
      current.spans.push(clone(entry.span));
      return;
    }
    const resolved: ResolvedDeckCard = {
      section: entry.section,
      runtimeId: resolution.runtimeId,
      count: entry.count,
      rarity: defaultRarity,
      sourceName: entry.sourceName,
      normalizedName: resolution.normalizedName,
      sourceNames: [entry.sourceName],
      spans: [clone(entry.span)],
    };
    sectionMap.set(resolution.runtimeId, resolved);
    sections[entry.section].push(resolved);
    allEntries.push(resolved);
  });
  return { sections, entries: allEntries };
};

const validateResolvedDeck = (
  sections: DeckSectionMap<ResolvedDeckCard[]>,
  options: DeckResolutionOptions,
  problems: Problem[],
): void => {
  const counts = new Map<number, number>();
  for (const section of DECK_SECTIONS) {
    const total = sections[section].reduce((sum, entry) => sum + entry.count, 0);
    const limit = DECK_LIMITS[section];
    if (total < limit.min || total > limit.max) {
      problems.push(contentDiagnostic({
        code: section === 'main' ? DECK_CODES.MAIN_SIZE_INVALID : section === 'extra' ? DECK_CODES.EXTRA_SIZE_INVALID : DECK_CODES.SIDE_SIZE_INVALID,
        message: `${section} deck must contain ${limit.min}-${limit.max} cards; found ${total}`,
        span: sections[section][0]?.spans[0],
      }));
    }
    for (const entry of sections[section]) counts.set(entry.runtimeId, (counts.get(entry.runtimeId) || 0) + entry.count);
  }
  for (const entry of sections.main.concat(sections.extra, sections.side)) {
    const totalCopies = counts.get(entry.runtimeId) || 0;
    if (totalCopies > DECK_LIMITS.copies) {
      problems.push(contentDiagnostic({
        code: DECK_CODES.COPY_LIMIT,
        message: `Card ${entry.sourceName} exceeds the ${DECK_LIMITS.copies}-copy deck limit: ${totalCopies}`,
        span: entry.spans[0],
      }));
    }
    if (entry.section === 'extra' && hasExtraDeckPolicy(options) && !extraDeckCardAllowed(entry.runtimeId, options)) {
      entry.spans.forEach((span, index) => {
        problems.push(contentDiagnostic({
          code: DECK_CODES.EXTRA_CARD_INVALID,
          message: `Card is not eligible for the Extra deck under the selected campaign policy: ${entry.sourceNames[index] || entry.sourceName}`,
          span,
        }));
      });
    }
    const hook = options.regulationHook || options.regulation;
    if (hook) {
      const result = hook({ ...entry, totalCopies });
      if (result === false) {
        problems.push(contentDiagnostic({
          code: DECK_CODES.REGULATION_VIOLATION,
          message: `Card is rejected by the selected regulation: ${entry.sourceName}`,
          span: entry.spans[0],
        }));
      } else if (typeof result === 'string') {
        problems.push(contentDiagnostic({ code: DECK_CODES.REGULATION_VIOLATION, message: result, span: entry.spans[0] }));
      } else if (Array.isArray(result)) {
        result.forEach((problem) => addProblem(problems, problem, { span: entry.spans[0] }));
      } else if (isRecord(result) && typeof result.code === 'string' && typeof result.message === 'string') {
        addProblem(problems, result as Problem, { span: entry.spans[0] });
      }
    }
  }
};

const resolveDocument = (
  document: DeckDocument,
  resolver: CardNameResolver,
  options: DeckResolutionOptions = {},
): DeckResolutionResult => {
  const problems = [...document.diagnostics];
  const defaultRarity = options.defaultRarity ?? DECK_DEFAULT_RARITY;
  problems.push(...validateRarity(defaultRarity));
  if (document.sections.extra.entries.length > 0 && !hasExtraDeckPolicy(options)) {
    problems.push(contentDiagnostic({
      code: DECK_CODES.EXTRA_LEGALITY_UNAVAILABLE,
      message: 'Extra deck entries require an explicit extraDeckCardIds or isExtraDeckCard policy',
      span: document.sections.extra.entries[0]?.span,
    }));
  }
  const requests = document.entries.map((entry) => ({
    sourceName: entry.sourceName,
    sourcePath: document.sourcePath,
    sourceSpan: entry.span,
    jsonPointer: `/sections/${entry.section}/lines/${entry.line}`,
  }));
  const batch = resolver.resolveBatch(requests);
  problems.push(...batch.problems);
  const aggregate = aggregateResolved(document, batch.resolutions, defaultRarity);
  validateResolvedDeck(aggregate.sections, options, problems);
  const sortedProblems = problems.sort(compareProblems);
  const ok = sortedProblems.length === 0 && batch.ok;
  return {
    ok,
    document,
    sections: aggregate.sections,
    entries: aggregate.entries,
    problems: sortedProblems,
    ...(ok && batch.lock ? { lock: clone(batch.lock) } : {}),
  };
};

export const resolveDecklist = (
  documentOrSource: DeckDocument | string,
  resolver: CardNameResolver,
  options: DeckResolutionOptions & DeckParseOptions = {},
): DeckResolutionResult => {
  const document = typeof documentOrSource === 'string'
    ? parseDecklist(documentOrSource, options)
    : documentOrSource;
  return resolveDocument(document, resolver, options);
};

export const resolveDeckContent = resolveDecklist;
export const resolveLineDecklist = resolveDecklist;

const partFromCards = (cards: readonly ResolvedDeckCard[]): DeckIRPart => {
  const ids: number[] = [];
  const r: number[] = [];
  for (const card of cards) {
    for (let index = 0; index < card.count; index += 1) {
      ids.push(card.runtimeId);
      r.push(card.rarity);
    }
  }
  return { ids, r };
};

const buildDeckIr = (sections: DeckSectionMap<ResolvedDeckCard[]>): DeckIR => ({
  m: partFromCards(sections.main),
  e: partFromCards(sections.extra),
  s: partFromCards(sections.side),
});

const invalidIr = (message: string): DeckContentError => new DeckContentError(
  DECK_CODES.IR_INVALID,
  message,
  [contentDiagnostic({ code: DECK_CODES.IR_INVALID, message })],
);

const readIrPart = (value: unknown, section: DeckSection): DeckIRPart => {
  if (!isRecord(value) || !Array.isArray(value.ids) || !Array.isArray(value.r)) throw invalidIr(`Deck IR ${section} part must contain ids and r arrays`);
  if (value.ids.length !== value.r.length) throw invalidIr(`Deck IR ${section} ids and r arrays must have equal lengths`);
  if (!value.ids.every((entry) => Number.isSafeInteger(entry) && (entry as number) >= 0)) throw invalidIr(`Deck IR ${section}.ids contains an invalid runtime ID`);
  if (!value.r.every((entry) => Number.isSafeInteger(entry) && (entry as number) >= 0)) throw invalidIr(`Deck IR ${section}.r contains an invalid rarity`);
  return { ids: [...value.ids] as number[], r: [...value.r] as number[] };
};

/** Validate and clone the m/e/s projection that the current overlay core consumes. */
export const reloadDeckIr = (value: unknown): DeckIR => {
  if (!isRecord(value)) throw invalidIr('Deck IR must be an object');
  return {
    m: readIrPart(value.m, 'main'),
    e: readIrPart(value.e, 'extra'),
    s: readIrPart(value.s, 'side'),
  };
};

export const reloadDeckProjection = reloadDeckIr;
export const reloadDeck = reloadDeckIr;

export const deckIrSemanticEqual = (left: unknown, right: unknown): boolean => {
  try {
    return JSON.stringify(reloadDeckIr(left)) === JSON.stringify(reloadDeckIr(right));
  } catch {
    return false;
  }
};

export const compileDecklist = (
  documentOrSource: DeckDocument | string,
  resolver: CardNameResolver,
  options: DeckResolutionOptions & DeckParseOptions = {},
): DeckCompileResult => {
  const resolution = resolveDecklist(documentOrSource, resolver, options);
  if (!resolution.ok) {
    return { ...resolution, metadata: resolution.document.metadata, defaultRarity: options.defaultRarity ?? DECK_DEFAULT_RARITY };
  }
  const ir = buildDeckIr(resolution.sections);
  reloadDeckIr(ir);
  return {
    ...resolution,
    ir,
    metadata: resolution.document.metadata,
    defaultRarity: options.defaultRarity ?? DECK_DEFAULT_RARITY,
  };
};

export const compileDeckContent = compileDecklist;
export const decklistToIr = compileDecklist;
export const decklistToIR = compileDecklist;

export const assertDeckCompilation = (result: DeckCompileResult): DeckIR => {
  if (!result.ok || !result.ir) {
    const first = result.problems[0];
    throw new DeckContentError(
      first?.code || DECK_CODES.IR_BLOCKED,
      first?.message || 'Deck IR is blocked by content diagnostics',
      result.problems.length ? result.problems : [contentDiagnostic({ code: DECK_CODES.IR_BLOCKED, message: 'Deck IR is blocked by content diagnostics' })],
    );
  }
  return clone(result.ir);
};

export const assertDeckCompile = assertDeckCompilation;
