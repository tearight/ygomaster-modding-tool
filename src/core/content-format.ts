import * as fs from 'node:fs/promises';

import { atomicWriteJson } from './fs';
import { cloneJson } from './json';
import { JsonObject, JsonValue, Problem, problem } from './types';

export const CONTENT_FORMAT_VERSION = 1 as const;
export const SECTIONED_PARSER_VERSION = 1 as const;

export interface SourcePosition {
  line: number;
  column: number;
}

/** Positions are one-based and `end` is exclusive. */
export interface SourceSpan extends SourcePosition {
  endLine: number;
  endColumn: number;
  sourcePath?: string;
}

export interface DiagnosticOptions {
  code: string;
  message: string;
  sourcePath?: string;
  span?: SourceSpan;
  jsonPointer?: string;
  severity?: 'error' | 'warning';
  suggestion?: string;
}

export const contentDiagnostic = ({
  code,
  message,
  sourcePath,
  span,
  jsonPointer,
  severity = 'error',
  suggestion,
}: DiagnosticOptions): Problem => {
  const resolvedPath = sourcePath || span?.sourcePath;
  const resolvedSpan = span
    ? { ...span, ...(resolvedPath ? { sourcePath: resolvedPath } : {}) }
    : undefined;
  return {
    code,
    message,
    ...(resolvedPath ? { path: resolvedPath, sourcePath: resolvedPath } : {}),
    ...(resolvedSpan
      ? {
          line: resolvedSpan.line,
          column: resolvedSpan.column,
          endLine: resolvedSpan.endLine,
          endColumn: resolvedSpan.endColumn,
          end: { line: resolvedSpan.endLine, column: resolvedSpan.endColumn },
          sourceSpan: resolvedSpan,
        }
      : {}),
    ...(jsonPointer !== undefined ? { jsonPointer } : {}),
    ...(suggestion ? { suggestion } : {}),
    severity,
  };
};

export const toJsonPointer = (segments: readonly (string | number)[]): string =>
  segments.length
    ? `/${segments.map((segment) => String(segment).replace(/~/gu, '~0').replace(/\//gu, '~1')).join('/')}`
    : '';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry));
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => isJsonValue(entry));
};

const lineSpan = (sourcePath: string | undefined, line: number, text: string, start = 1, end = text.length + 1): SourceSpan => ({
  ...(sourcePath ? { sourcePath } : {}),
  line,
  column: start,
  endLine: line,
  endColumn: Math.max(start, end),
});

const jsonParsePosition = (message: string): number | undefined => {
  const match = /(?:position|character)\s+(\d+)/i.exec(message);
  return match ? Number(match[1]) : undefined;
};

const positionAt = (text: string, offset: number): SourcePosition => {
  const bounded = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < bounded; index += 1) {
    const char = text[index];
    if (char === '\r') {
      if (text[index + 1] === '\n' && index + 1 < bounded) index += 1;
      line += 1;
      lineStart = index + 1;
    } else if (char === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: bounded - lineStart + 1 };
};

export class ContentFormatError extends Error {
  readonly problems: Problem[];

  constructor(problems: Problem[], message?: string) {
    super(message || problems.map((entry) => `${entry.code}: ${entry.message}`).join('; ') || 'Content format error');
    this.name = 'ContentFormatError';
    this.problems = problems;
  }
}

export interface ContentEnvelope<T extends JsonValue = JsonObject> {
  formatVersion: number;
  kind: string;
  payload: T;
  [key: string]: JsonValue | undefined;
}

export interface ContentEnvelopeOptions {
  supportedVersion?: number;
  sourcePath?: string;
  /** Allows a caller to use a domain-specific payload key while normalizing to payload. */
  payloadKeys?: readonly string[];
}

export interface ParsedContentEnvelope<T extends JsonValue = JsonObject> {
  envelope: ContentEnvelope<T>;
  raw: JsonObject;
  payloadKey: string;
}

const parseStrictJson = (text: string, sourcePath?: string): unknown => {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(withoutBom) as unknown;
  } catch (error) {
    const offset = jsonParsePosition(String(error)) ?? withoutBom.length;
    const start = positionAt(withoutBom, offset);
    const endOffset = offset < withoutBom.length ? offset + 1 : offset;
    const end = positionAt(withoutBom, endOffset);
    const span: SourceSpan = {
      ...(sourcePath ? { sourcePath } : {}),
      ...start,
      endLine: end.line,
      endColumn: end.column,
    };
    throw new ContentFormatError([
      contentDiagnostic({
        code: 'CONTENT_JSON_MALFORMED',
        message: String(error),
        sourcePath,
        span,
        jsonPointer: '',
      }),
    ]);
  }
};

const contentEnvelopePayloadKeys = (options: ContentEnvelopeOptions): readonly string[] =>
  options.payloadKeys || ['payload', 'content', 'data'];

export const validateContentEnvelope = (
  value: unknown,
  options: ContentEnvelopeOptions = {},
): Problem[] => {
  const sourcePath = options.sourcePath;
  const supportedVersion = options.supportedVersion ?? CONTENT_FORMAT_VERSION;
  if (!isRecord(value)) {
    return [contentDiagnostic({
      code: 'CONTENT_ENVELOPE_INVALID',
      message: 'Content document must be a JSON object',
      sourcePath,
      jsonPointer: '',
    })];
  }

  const problems: Problem[] = [];
  const version = value.formatVersion;
  if (!Number.isInteger(version) || (version as number) < 1) {
    problems.push(contentDiagnostic({
      code: 'CONTENT_FORMAT_VERSION_INVALID',
      message: 'formatVersion must be a positive integer',
      sourcePath,
      jsonPointer: '/formatVersion',
    }));
  } else if ((version as number) > supportedVersion) {
    problems.push(contentDiagnostic({
      code: 'CONTENT_FORMAT_VERSION_FUTURE',
      message: `formatVersion ${String(version)} is newer than supported version ${supportedVersion}`,
      sourcePath,
      jsonPointer: '/formatVersion',
      suggestion: 'Upgrade the content parser before reading this document.',
    }));
  } else if ((version as number) < supportedVersion) {
    problems.push(contentDiagnostic({
      code: 'CONTENT_FORMAT_VERSION_OLD',
      message: `formatVersion ${String(version)} requires migration to ${supportedVersion}`,
      sourcePath,
      jsonPointer: '/formatVersion',
    }));
  }

  const kind = value.kind ?? value.type ?? value.contentType;
  if (typeof kind !== 'string' || !kind.trim()) {
    problems.push(contentDiagnostic({
      code: 'CONTENT_ENVELOPE_KIND_MISSING',
      message: 'Content envelope kind is required',
      sourcePath,
      jsonPointer: '/kind',
    }));
  }

  const payloadKeys = contentEnvelopePayloadKeys(options);
  const presentPayloadKeys = payloadKeys.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (!presentPayloadKeys.length) {
    problems.push(contentDiagnostic({
      code: 'CONTENT_ENVELOPE_PAYLOAD_MISSING',
      message: `Content envelope must contain one of: ${payloadKeys.join(', ')}`,
      sourcePath,
      jsonPointer: '',
    }));
  } else if (presentPayloadKeys.length > 1) {
    problems.push(contentDiagnostic({
      code: 'CONTENT_ENVELOPE_PAYLOAD_AMBIGUOUS',
      message: `Content envelope contains multiple payload keys: ${presentPayloadKeys.join(', ')}`,
      sourcePath,
      jsonPointer: '',
    }));
  }
  return problems;
};

export const createContentEnvelope = <T extends JsonValue>(
  kind: string,
  payload: T,
  formatVersion = CONTENT_FORMAT_VERSION,
  extra: JsonObject = {},
): ContentEnvelope<T> => {
  const envelope = { ...extra, formatVersion, kind, payload } as ContentEnvelope<T>;
  const problems = validateContentEnvelope(envelope);
  if (problems.length) throw new ContentFormatError(problems);
  return envelope;
};

export const parseContentEnvelopeWithSource = <T extends JsonValue = JsonObject>(
  input: unknown,
  options: ContentEnvelopeOptions = {},
): ParsedContentEnvelope<T> => {
  const value = typeof input === 'string' ? parseStrictJson(input, options.sourcePath) : input;
  const problems = validateContentEnvelope(value, options);
  if (problems.length) throw new ContentFormatError(problems);
  const raw = cloneJson(value as JsonObject);
  const kind = (raw.kind ?? raw.type ?? raw.contentType) as string;
  const payloadKey = contentEnvelopePayloadKeys(options).find((key) => Object.prototype.hasOwnProperty.call(raw, key)) as string;
  const envelope = {
    ...raw,
    kind,
    payload: raw[payloadKey] as T,
  } as ContentEnvelope<T>;
  return { envelope, raw, payloadKey };
};

export const parseContentEnvelope = <T extends JsonValue = JsonObject>(
  input: unknown,
  options: ContentEnvelopeOptions = {},
): ContentEnvelope<T> => parseContentEnvelopeWithSource<T>(input, options).envelope;

export const parseContentDocument = parseContentEnvelope;
export const validateContentDocument = validateContentEnvelope;
export const createContentDocument = createContentEnvelope;

export const readContentEnvelope = async <T extends JsonValue = JsonObject>(
  filePath: string,
  options: Omit<ContentEnvelopeOptions, 'sourcePath'> = {},
): Promise<ContentEnvelope<T>> => parseContentEnvelope<T>(await fs.readFile(filePath, 'utf8'), { ...options, sourcePath: filePath });

export const writeContentEnvelope = async <T extends JsonValue>(
  filePath: string,
  envelope: ContentEnvelope<T>,
  replace = true,
): Promise<void> => {
  const parsed = parseContentEnvelope<T>(envelope);
  await atomicWriteJson(filePath, parsed, replace);
};

export const normalizeSymbolicKey = (value: string): string => {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[-_]+|[-_]+$/gu, '');
  if (!normalized) {
    throw new ContentFormatError([problem('SYMBOLIC_KEY_EMPTY', 'Symbolic key cannot be empty')]);
  }
  return normalized;
};

export const normalizeSymbolicId = normalizeSymbolicKey;

export interface NormalizedSymbolicReference {
  raw: string;
  namespace?: string;
  key: string;
  normalized: string;
}

export const normalizeSymbolicReference = (value: string): NormalizedSymbolicReference => {
  const raw = value;
  const trimmed = value.normalize('NFKC').trim();
  if (!trimmed) throw new ContentFormatError([problem('SYMBOLIC_REFERENCE_EMPTY', 'Symbolic reference cannot be empty')]);
  const separator = trimmed.indexOf(':');
  const namespacePart = separator > 0 ? trimmed.slice(0, separator) : undefined;
  const keyPart = separator > 0 ? trimmed.slice(separator + 1) : trimmed;
  const key = normalizeSymbolicKey(keyPart);
  const namespace = namespacePart ? normalizeSymbolicKey(namespacePart) : undefined;
  return {
    raw,
    ...(namespace ? { namespace } : {}),
    key,
    normalized: namespace ? `${namespace}:${key}` : key,
  };
};

export const parseSymbolicReference = normalizeSymbolicReference;

export type SectionedLineKind = 'blank' | 'comment' | 'section' | 'entry' | 'invalid';

export interface SectionedLexedLine {
  line: number;
  /** Exact source line without its line terminator. A leading BOM is retained here. */
  raw: string;
  original: string;
  /** Text used by the parser after removing the optional first-line BOM. */
  text: string;
  lineEnding: string;
  content: string;
  comment?: string;
  span: SourceSpan;
}

export interface SectionedLexResult {
  sourcePath?: string;
  originalText: string;
  hadBom: boolean;
  lines: SectionedLexedLine[];
  diagnostics: Problem[];
}

export interface NormalizedSectionedLine {
  kind: SectionedLineKind;
  section?: string;
  value?: string;
  tokens?: string[];
  comment?: string;
}

export interface SectionedLineAst extends SectionedLexedLine {
  normalized: NormalizedSectionedLine;
  normalizedText?: string;
}

export interface SectionedEntry {
  line: number;
  section?: string;
  raw: string;
  value: string;
  tokens: string[];
  span: SourceSpan;
}

export interface SectionedSection {
  line: number;
  raw: string;
  name: string;
  normalizedName: string;
  entries: SectionedEntry[];
  span: SourceSpan;
}

export interface SectionedDocument {
  parserVersion: typeof SECTIONED_PARSER_VERSION;
  sourcePath?: string;
  originalText: string;
  hadBom: boolean;
  lines: SectionedLineAst[];
  sections: SectionedSection[];
  entries: SectionedEntry[];
  diagnostics: Problem[];
}

export interface SectionedParserOptions {
  sourcePath?: string;
}

const optionsWithPath = (sourcePathOrOptions?: string | SectionedParserOptions): SectionedParserOptions =>
  typeof sourcePathOrOptions === 'string' ? { sourcePath: sourcePathOrOptions } : (sourcePathOrOptions || {});

const splitSourceLines = (text: string): Array<{ raw: string; lineEnding: string }> => {
  const lines: Array<{ raw: string; lineEnding: string }> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '\r' && char !== '\n') continue;
    const lineEnding = char === '\r' && text[index + 1] === '\n' ? '\r\n' : char;
    lines.push({ raw: text.slice(start, index), lineEnding });
    index += lineEnding.length - 1;
    start = index + 1;
  }
  if (start < text.length || !lines.length || !text.endsWith('\n') && !text.endsWith('\r')) {
    lines.push({ raw: text.slice(start), lineEnding: '' });
  }
  return lines;
};

interface CommentSplit {
  content: string;
  comment?: string;
  commentColumn?: number;
}

const stripLineComment = (text: string): CommentSplit => {
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    const atBoundary = index === 0 || /\s/u.test(text[index - 1]);
    const markerLength = char === '/' && text[index + 1] === '/' ? 2 : 1;
    if (atBoundary && (char === '#' || char === ';' || markerLength === 2)) {
      return {
        content: text.slice(0, index).replace(/\s+$/u, ''),
        comment: text.slice(index + markerLength).replace(/^\s+/u, ''),
        commentColumn: index + 1,
      };
    }
  }
  return { content: text };
};

export const lexSectionedLines = (
  source: string,
  sourcePathOrOptions?: string | SectionedParserOptions,
): SectionedLexResult => {
  const options = optionsWithPath(sourcePathOrOptions);
  const hadBom = source.charCodeAt(0) === 0xfeff;
  const split = splitSourceLines(source);
  const lines: SectionedLexedLine[] = [];
  const diagnostics: Problem[] = [];
  split.forEach(({ raw, lineEnding }, index) => {
    const line = index + 1;
    const text = line === 1 && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const commentSplit = stripLineComment(text);
    const content = commentSplit.content;
    const span = lineSpan(options.sourcePath, line, text);
    const lineRecord: SectionedLexedLine = {
      line,
      raw,
      original: raw,
      text,
      lineEnding,
      content,
      ...(commentSplit.comment !== undefined ? { comment: commentSplit.comment } : {}),
      span,
    };
    if (text.includes('\0')) {
      const indexOfNull = text.indexOf('\0');
      diagnostics.push(contentDiagnostic({
        code: 'CONTENT_LINE_CONTROL_CHARACTER',
        message: 'NUL is not allowed in a sectioned content line',
        sourcePath: options.sourcePath,
        span: lineSpan(options.sourcePath, line, text, indexOfNull + 1, indexOfNull + 2),
      }));
    }
    lines.push(lineRecord);
  });
  return { ...options, originalText: source, hadBom, lines, diagnostics };
};

interface TokenResult {
  tokens: string[];
  problems: Problem[];
}

const tokenizeLine = (value: string, line: number, sourcePath?: string, columnOffset = 1): TokenResult => {
  const tokens: string[] = [];
  const problems: Problem[] = [];
  let token = '';
  let quote: string | undefined;
  let escaped = false;
  let quoteStart = 0;
  const flush = () => {
    if (token) tokens.push(token.normalize('NFC'));
    token = '';
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (escaped) {
        token += char;
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      } else {
        token += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      quoteStart = index + 1;
    } else if (/\s/u.test(char)) {
      flush();
    } else {
      token += char;
    }
  }
  if (quote) {
    problems.push(contentDiagnostic({
      code: 'CONTENT_LINE_UNTERMINATED_QUOTE',
      message: 'Sectioned content entry has an unterminated quote',
      sourcePath,
      span: lineSpan(sourcePath, line, value, quoteStart + columnOffset - 1, value.length + columnOffset),
    }));
  }
  if (escaped) token += '\\';
  flush();
  return { tokens, problems };
};

const sectionHeader = (value: string): { name?: string; problems: Problem[] } => {
  const problems: Problem[] = [];
  const close = value.indexOf(']');
  if (close < 0) return { problems: [problem('CONTENT_LINE_UNTERMINATED_SECTION', 'Section header is missing ]')] };
  const trailing = value.slice(close + 1).trim();
  if (trailing) problems.push(problem('CONTENT_LINE_SECTION_TRAILING_TEXT', 'Section header has trailing text'));
  const name = value.slice(1, close).trim();
  if (!name) problems.push(problem('CONTENT_LINE_EMPTY_SECTION', 'Section name cannot be empty'));
  return { ...(name ? { name } : {}), problems };
};

export const parseSectionedLines = (
  source: string,
  sourcePathOrOptions?: string | SectionedParserOptions,
): SectionedDocument => {
  const options = optionsWithPath(sourcePathOrOptions);
  const lexed = lexSectionedLines(source, options);
  const diagnostics = [...lexed.diagnostics];
  const sections: SectionedSection[] = [];
  const entries: SectionedEntry[] = [];
  const lines: SectionedLineAst[] = [];
  let currentSection: string | undefined;

  for (const line of lexed.lines) {
    const trimmed = line.content.trim();
    const base = {
      ...line,
      normalized: {
        kind: (trimmed ? 'entry' : line.comment !== undefined ? 'comment' : 'blank') as SectionedLineKind,
        ...(line.comment !== undefined ? { comment: line.comment } : {}),
      },
      normalizedText: trimmed.normalize('NFC').replace(/\s+/gu, ' '),
    } as SectionedLineAst;
    if (!trimmed) {
      lines.push(base);
      continue;
    }
    if (trimmed.startsWith('[')) {
      const header = sectionHeader(trimmed);
      if (header.problems.length || !header.name) {
        const span = lineSpan(options.sourcePath, line.line, line.text);
        for (const headerProblem of header.problems) {
          diagnostics.push(contentDiagnostic({
            code: headerProblem.code,
            message: headerProblem.message,
            sourcePath: options.sourcePath,
            span,
          }));
        }
        lines.push({ ...base, normalized: { kind: 'invalid', ...(line.comment !== undefined ? { comment: line.comment } : {}) } });
        continue;
      }
      let normalizedName: string;
      try {
        normalizedName = normalizeSymbolicKey(header.name);
      } catch (error) {
        const problems = error instanceof ContentFormatError ? error.problems : [problem('SYMBOLIC_KEY_INVALID', String(error))];
        diagnostics.push(...problems.map((entry) => contentDiagnostic({
          code: entry.code,
          message: entry.message,
          sourcePath: options.sourcePath,
          span: lineSpan(options.sourcePath, line.line, line.text),
        })));
        lines.push({ ...base, normalized: { kind: 'invalid' } });
        continue;
      }
      currentSection = normalizedName;
      const section: SectionedSection = {
        line: line.line,
        raw: line.raw,
        name: header.name,
        normalizedName,
        entries: [],
        span: line.span,
      };
      sections.push(section);
      lines.push({
        ...base,
        normalized: { kind: 'section', section: normalizedName, value: header.name },
        normalizedText: `[${normalizedName}]`,
      });
      continue;
    }

    const tokenResult = tokenizeLine(trimmed, line.line, options.sourcePath, line.content.indexOf(trimmed) + 1);
    diagnostics.push(...tokenResult.problems);
    const value = trimmed.normalize('NFC').replace(/\s+/gu, ' ');
    const invalid = tokenResult.problems.length > 0 || line.text.includes('\0');
    const entry: SectionedEntry = {
      line: line.line,
      ...(currentSection ? { section: currentSection } : {}),
      raw: line.raw,
      value,
      tokens: tokenResult.tokens,
      span: line.span,
    };
    if (!invalid) {
      entries.push(entry);
      const section = currentSection
        ? [...sections].reverse().find((candidate) => candidate.normalizedName === currentSection)
        : undefined;
      section?.entries.push(entry);
    }
    lines.push({
      ...base,
      normalized: {
        kind: invalid ? 'invalid' : 'entry',
        ...(currentSection ? { section: currentSection } : {}),
        value,
        tokens: tokenResult.tokens,
        ...(line.comment !== undefined ? { comment: line.comment } : {}),
      },
      normalizedText: value,
    });
  }

  return {
    parserVersion: SECTIONED_PARSER_VERSION,
    ...options,
    originalText: source,
    hadBom: lexed.hadBom,
    lines,
    sections,
    entries,
    diagnostics,
  };
};

export const parseSectionedText = parseSectionedLines;
export const parseSectionedDocument = parseSectionedLines;
export const lexSectionedText = lexSectionedLines;
export const parseSectioned = parseSectionedLines;

export interface MigrationContext {
  fromVersion: number;
  toVersion: number;
  stepIndex: number;
  sourcePath?: string;
}

export type MigrationTransform = (value: JsonValue, context: MigrationContext) => JsonValue;

export interface MigrationStep {
  fromVersion: number;
  toVersion: number;
  id?: string;
  migrate: MigrationTransform;
}

export interface MigrationRunResult {
  fromVersion: number;
  toVersion: number;
  document: JsonValue;
  changed: boolean;
  steps: string[];
}

const migrationProblem = (code: string, message: string, sourcePath?: string): ContentFormatError =>
  new ContentFormatError([contentDiagnostic({ code, message, sourcePath })]);

const semanticNormalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map((entry) => semanticNormalize(entry));
  if (!isRecord(value)) return value;
  const sorted: JsonObject = {};
  for (const key of Object.keys(value).sort()) sorted[key] = semanticNormalize(value[key] as JsonValue);
  return sorted;
};

export const semanticEqual = (left: JsonValue, right: JsonValue): boolean =>
  JSON.stringify(semanticNormalize(left)) === JSON.stringify(semanticNormalize(right));

export class MigrationRegistry {
  private readonly stepsByVersion = new Map<number, MigrationStep>();

  register(step: MigrationStep): this;
  register(fromVersion: number, toVersion: number, migrate: MigrationTransform, id?: string): this;
  register(
    stepOrFromVersion: MigrationStep | number,
    toVersion?: number,
    migrate?: MigrationTransform,
    id?: string,
  ): this {
    const step: MigrationStep = typeof stepOrFromVersion === 'number'
      ? { fromVersion: stepOrFromVersion, toVersion: toVersion as number, migrate: migrate as MigrationTransform, ...(id ? { id } : {}) }
      : stepOrFromVersion;
    if (!Number.isInteger(step.fromVersion) || step.fromVersion < 1 || !Number.isInteger(step.toVersion) || step.toVersion !== step.fromVersion + 1 || typeof step.migrate !== 'function') {
      throw migrationProblem('MIGRATION_STEP_INVALID', 'Migration steps must be callable and advance exactly one version');
    }
    if (this.stepsByVersion.has(step.fromVersion)) {
      throw migrationProblem('MIGRATION_STEP_DUPLICATE', `Migration from v${step.fromVersion} is already registered`);
    }
    this.stepsByVersion.set(step.fromVersion, step);
    return this;
  }

  has(fromVersion: number): boolean {
    return this.stepsByVersion.has(fromVersion);
  }

  get(fromVersion: number): MigrationStep | undefined {
    return this.stepsByVersion.get(fromVersion);
  }

  private path(fromVersion: number, toVersion: number, sourcePath?: string): MigrationStep[] {
    if (!Number.isInteger(fromVersion) || fromVersion < 1 || !Number.isInteger(toVersion) || toVersion < 1) {
      throw migrationProblem('MIGRATION_VERSION_INVALID', 'Migration versions must be positive integers', sourcePath);
    }
    if (fromVersion > toVersion) throw migrationProblem('MIGRATION_REVERSE_UNSUPPORTED', `Cannot migrate backwards from v${fromVersion} to v${toVersion}`, sourcePath);
    const steps: MigrationStep[] = [];
    for (let version = fromVersion; version < toVersion; version += 1) {
      const step = this.stepsByVersion.get(version);
      if (!step) throw migrationProblem('MIGRATION_PATH_MISSING', `No migration registered from v${version} to v${version + 1}`, sourcePath);
      steps.push(step);
    }
    return steps;
  }

  run(value: JsonValue, fromVersion: number, toVersion: number, sourcePath?: string): MigrationRunResult {
    const steps = this.path(fromVersion, toVersion, sourcePath);
    let document = cloneJson(value);
    const stepIds: string[] = [];
    steps.forEach((step, index) => {
      let next: JsonValue;
      try {
        next = step.migrate(document, { fromVersion: step.fromVersion, toVersion: step.toVersion, stepIndex: index, sourcePath });
      } catch (error) {
        if (error instanceof ContentFormatError) throw error;
        throw migrationProblem('MIGRATION_FAILED', String(error), sourcePath);
      }
      if (!isJsonValue(next)) throw migrationProblem('MIGRATION_OUTPUT_INVALID', `Migration v${step.fromVersion} output is not JSON`, sourcePath);
      if (!isRecord(next) || next.formatVersion !== step.toVersion) {
        throw migrationProblem('MIGRATION_OUTPUT_VERSION_MISMATCH', `Migration v${step.fromVersion} must produce formatVersion ${step.toVersion}`, sourcePath);
      }
      document = cloneJson(next);
      stepIds.push(step.id || `v${step.fromVersion}-to-v${step.toVersion}`);
    });
    return { fromVersion, toVersion, document, changed: !semanticEqual(value, document), steps: stepIds };
  }

  preview(value: JsonValue, fromVersion: number, toVersion: number, sourcePath?: string): MigrationRunResult {
    return this.run(value, fromVersion, toVersion, sourcePath);
  }

  apply(value: JsonValue, fromVersion: number, toVersion: number, sourcePath?: string): MigrationRunResult {
    return this.run(value, fromVersion, toVersion, sourcePath);
  }
}

export const createMigrationRegistry = (steps: MigrationStep[] = []): MigrationRegistry => {
  const registry = new MigrationRegistry();
  for (const step of steps) registry.register(step);
  return registry;
};

export const registerMigration = (
  registry: MigrationRegistry,
  fromVersion: number,
  toVersion: number,
  migrate: MigrationTransform,
  id?: string,
): MigrationRegistry => registry.register(fromVersion, toVersion, migrate, id);

export const registerMigrationStep = registerMigration;

const documentVersion = (value: JsonValue, sourcePath?: string): number => {
  if (!isRecord(value) || !Number.isInteger(value.formatVersion)) {
    throw migrationProblem('MIGRATION_SOURCE_VERSION_MISSING', 'Migration source must contain an integer formatVersion', sourcePath);
  }
  return value.formatVersion as number;
};

export const previewContentMigration = async (
  filePath: string,
  registry: MigrationRegistry,
  targetVersion: number,
): Promise<MigrationRunResult> => {
  const source = parseStrictJson(await fs.readFile(filePath, 'utf8'), filePath) as JsonValue;
  return registry.preview(source, documentVersion(source, filePath), targetVersion, filePath);
};

export const applyContentMigration = async (
  filePath: string,
  registry: MigrationRegistry,
  targetVersion: number,
  replace = true,
): Promise<MigrationRunResult> => {
  const source = parseStrictJson(await fs.readFile(filePath, 'utf8'), filePath) as JsonValue;
  const result = registry.apply(source, documentVersion(source, filePath), targetVersion, filePath);
  if (result.changed) await atomicWriteJson(filePath, result.document, replace);
  return result;
};

export const previewMigrationFile = previewContentMigration;
export const applyMigrationFile = applyContentMigration;
export const migrateContent = (value: JsonValue, registry: MigrationRegistry, targetVersion: number, sourcePath?: string): MigrationRunResult => {
  const fromVersion = documentVersion(value, sourcePath);
  return registry.apply(value, fromVersion, targetVersion, sourcePath);
};

export const previewMigration = (value: JsonValue, registry: MigrationRegistry, targetVersion: number, sourcePath?: string): MigrationRunResult => {
  const fromVersion = documentVersion(value, sourcePath);
  return registry.preview(value, fromVersion, targetVersion, sourcePath);
};

export const applyMigration = migrateContent;
