import * as fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteText, assertRealPathInside, ensureDirectory, exists, listFiles, resolveInside } from './fs';
import { contentDiagnostic, type SourceSpan } from './content-format';
import type { Problem } from './types';
import { problem } from './types';

export const LOCALIZATION_FORMAT_VERSION = 1 as const;
export const SOLO_IDS_PATH = 'Data/ClientData/IDS/IDS_SOLO.txt' as const;
export const SOLO_GATE_CARDS_PATH = 'Data/ClientData/SoloGateCards.txt' as const;

export type LocalizationLanguage = string;

export interface LocalizationLine {
  line: number;
  raw: string;
  text: string;
  lineEnding: string;
  span: SourceSpan;
}

export interface LocalizationEntry {
  key: string;
  language: LocalizationLanguage;
  value: string;
  sourcePath?: string;
  line?: number;
  column?: number;
}

export interface LocalizationParseResult {
  formatVersion: 1;
  language: LocalizationLanguage;
  sourcePath?: string;
  originalText: string;
  lines: LocalizationLine[];
  entries: LocalizationEntry[];
  diagnostics: Problem[];
}

export interface LocalizationCatalog {
  formatVersion: 1;
  fallbackLanguage: LocalizationLanguage;
  /** Fast, stable value projection used by consumers. */
  languages: Record<LocalizationLanguage, Record<string, string>>;
  /** Source-aware entries retained for diagnostics and tooling. */
  entries: LocalizationEntry[];
  entriesByLanguage: Record<LocalizationLanguage, Record<string, LocalizationEntry>>;
  diagnostics: Problem[];
}

export interface LocalizationReference {
  key: string;
  language?: LocalizationLanguage;
  sourcePath?: string;
  line?: number;
  column?: number;
}

export interface LocalizationResolveResult {
  key: string;
  requestedLanguage: LocalizationLanguage;
  resolvedLanguage?: LocalizationLanguage;
  value?: string;
  usedFallback: boolean;
  problems: Problem[];
}

export class LocalizationContentError extends Error {
  public readonly problems: Problem[];

  public constructor(problems: Problem[], message?: string) {
    super(message || problems.map((entry) => `${entry.code}: ${entry.message}`).join('; ') || 'Localization content error');
    this.name = 'LocalizationContentError';
    this.problems = problems;
  }
}

const stableKeyPattern = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;

const localizationDiagnostic = (
  code: string,
  message: string,
  sourcePath?: string,
  span?: SourceSpan,
  severity: 'error' | 'warning' = 'error',
  suggestion?: string,
): Problem => contentDiagnostic({ code, message, sourcePath, span, severity, suggestion });

const lineSpan = (sourcePath: string | undefined, line: number, text: string, start = 1, end = text.length + 1): SourceSpan => ({
  ...(sourcePath ? { sourcePath } : {}),
  line,
  column: start,
  endLine: line,
  endColumn: Math.max(start, end),
});

const splitLines = (source: string): Array<{ raw: string; lineEnding: string }> => {
  const result: Array<{ raw: string; lineEnding: string }> = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char !== '\r' && char !== '\n') continue;
    const lineEnding = char === '\r' && source[index + 1] === '\n' ? '\r\n' : char;
    result.push({ raw: source.slice(start, index), lineEnding });
    index += lineEnding.length - 1;
    start = index + 1;
  }
  if (start < source.length || !result.length || (!source.endsWith('\n') && !source.endsWith('\r'))) {
    result.push({ raw: source.slice(start), lineEnding: '' });
  }
  return result;
};

/** Normalize a human-authored key into the stable symbolic key space. */
export const normalizeLocalizationKey = (value: string): string => {
  const normalized = value.normalize('NFC').trim().toLowerCase().replace(/\s+/gu, '-');
  if (!normalized || !stableKeyPattern.test(normalized)) {
    throw new LocalizationContentError([
      problem('LOCALIZATION_KEY_INVALID', `Invalid localization key: ${value}`),
    ]);
  }
  return normalized;
};

const keyMarker = (trimmed: string): { rawKey: string; inlineValue?: string } | undefined => {
  const section = /^\[([^\]]+)\]\s*$/u.exec(trimmed);
  if (section) return { rawKey: section[1] };
  const directive = /^@(?:key|loc)\s+(.+)$/iu.exec(trimmed);
  if (directive) return { rawKey: directive[1] };
  const heading = /^#\s+([^\s#][^\r\n]*)$/u.exec(trimmed);
  if (heading && stableKeyPattern.test(heading[1].trim().toLowerCase())) return { rawKey: heading[1] };
  const inline = /^([a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*)\s*:\s*(.*)$/iu.exec(trimmed);
  if (inline) return { rawKey: inline[1], inlineValue: inline[2] };
  return undefined;
};

/** Parse a language Markdown/text file while retaining every original line. */
export const parseLocalizationText = (
  source: string,
  language: LocalizationLanguage,
  sourcePath?: string,
): LocalizationParseResult => {
  const lines: LocalizationLine[] = splitLines(source).map(({ raw, lineEnding }, index) => ({
    line: index + 1,
    raw,
    text: index === 0 && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw,
    lineEnding,
    span: lineSpan(sourcePath, index + 1, raw),
  }));
  const diagnostics: Problem[] = [];
  const entries: LocalizationEntry[] = [];
  const seen = new Set<string>();
  let current: { key: string; line: LocalizationLine; values: string[] } | undefined;

  const finish = (): void => {
    if (!current) return;
    const value = current.values.join('\n').replace(/^\n+/u, '').replace(/\n+$/u, '');
    if (!value.trim()) {
      diagnostics.push(localizationDiagnostic(
        'LOCALIZATION_TEXT_BLANK',
        `Localization key ${current.key} has no text`,
        sourcePath,
        current.line.span,
      ));
    }
    if (seen.has(current.key)) {
      diagnostics.push(localizationDiagnostic(
        'LOCALIZATION_KEY_DUPLICATE',
        `Localization key ${current.key} is duplicated for ${language}`,
        sourcePath,
        current.line.span,
      ));
    } else {
      seen.add(current.key);
      entries.push({
        key: current.key,
        language,
        value,
        ...(sourcePath ? { sourcePath } : {}),
        line: current.line.line,
        column: current.line.span.column,
      });
    }
    current = undefined;
  };

  for (const line of lines) {
    const trimmed = line.text.trim();
    const marker = keyMarker(trimmed);
    if (marker) {
      finish();
      let normalizedKey: string;
      try {
        normalizedKey = normalizeLocalizationKey(marker.rawKey);
      } catch {
        diagnostics.push(localizationDiagnostic(
          'LOCALIZATION_KEY_INVALID',
          `Invalid localization key: ${marker.rawKey}`,
          sourcePath,
          line.span,
        ));
        continue;
      }
      current = { key: normalizedKey, line, values: marker.inlineValue === undefined ? [] : [marker.inlineValue] };
      continue;
    }
    if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) continue;
    if (!current) {
      if (trimmed) {
        diagnostics.push(localizationDiagnostic(
          'LOCALIZATION_TEXT_WITHOUT_KEY',
          'Localization text must follow a stable key declaration',
          sourcePath,
          line.span,
        ));
      }
      continue;
    }
    current.values.push(line.text);
  }
  finish();
  return {
    formatVersion: 1,
    language,
    ...(sourcePath ? { sourcePath } : {}),
    originalText: source,
    lines,
    entries,
    diagnostics,
  };
};

export const parseLocalizationFileText = parseLocalizationText;
export const parseLocalizationDocument = parseLocalizationText;
export const parseLocalization = parseLocalizationText;

const parseLanguagePath = (root: string, filePath: string, languageHint?: string): string => {
  if (languageHint) return normalizeLanguage(languageHint);
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  const parts = relative.split('/');
  if (parts.length > 1 && parts[0]) return normalizeLanguage(parts[0]);
  const basename = path.basename(filePath);
  const extension = path.extname(basename);
  const stem = extension ? basename.slice(0, -extension.length) : basename;
  const languageSuffix = /\.([a-z]{2,})$/iu.exec(stem)?.[1];
  const candidate = languageSuffix || (/^[a-z]{2,3}(?:-[a-z0-9]+)*$/iu.test(stem) ? stem : 'en');
  return normalizeLanguage(candidate);
};

const normalizeLanguage = (value: string): string => {
  const normalized = value.normalize('NFC').trim().toLowerCase().replace(/_/gu, '-');
  if (!normalized || !/^[a-z]{2,}(?:-[a-z0-9]+)*$/u.test(normalized)) {
    throw new LocalizationContentError([problem('LOCALIZATION_LANGUAGE_INVALID', `Invalid language: ${value}`)]);
  }
  return normalized;
};

export interface LoadLocalizationOptions {
  fallbackLanguage?: LocalizationLanguage;
  language?: LocalizationLanguage;
  extensions?: readonly string[];
}

/** Load `root/<language>/*.(md|markdown|txt)` files in deterministic order. */
export const loadLocalizationDirectory = async (
  root: string,
  options: LoadLocalizationOptions = {},
): Promise<LocalizationCatalog> => {
  const resolvedRoot = path.resolve(root);
  const files = (await listFiles(resolvedRoot)).filter((filePath) => {
    const extension = path.extname(filePath).toLowerCase();
    return (options.extensions ?? ['.md', '.markdown', '.txt']).includes(extension);
  });
  const parsed: LocalizationParseResult[] = [];
  for (const filePath of files) {
    const language = parseLanguagePath(resolvedRoot, filePath, options.language);
    parsed.push(parseLocalizationText(await fs.readFile(filePath, 'utf8'), language, path.relative(resolvedRoot, filePath).split(path.sep).join('/')));
  }
  return createLocalizationCatalog(parsed, options);
};

export const loadLocalization = loadLocalizationDirectory;

const entryFromValue = (value: LocalizationEntry | string, language: string, key: string): LocalizationEntry =>
  typeof value === 'string' ? { key, language, value } : value;

export const createLocalizationCatalog = (
  sources: readonly (LocalizationParseResult | LocalizationEntry)[] | Record<LocalizationLanguage, Record<string, string>>,
  options: { fallbackLanguage?: LocalizationLanguage } = {},
): LocalizationCatalog => {
  const diagnostics: Problem[] = [];
  const entries: LocalizationEntry[] = [];
  const entriesByLanguage: Record<string, Record<string, LocalizationEntry>> = {};
  const normalizedSources: readonly (LocalizationParseResult | LocalizationEntry)[] = Array.isArray(sources)
    ? sources
    : Object.entries(sources).flatMap(([language, values]) => Object.entries(values).map(([key, value]) => ({ key, value, language })));
  for (const source of normalizedSources) {
    if ('diagnostics' in source) diagnostics.push(...source.diagnostics);
    const sourceEntries = 'entries' in source ? source.entries : [source];
    for (const input of sourceEntries) {
      let key: string;
      try {
        key = normalizeLocalizationKey(input.key);
      } catch {
        diagnostics.push(localizationDiagnostic('LOCALIZATION_KEY_INVALID', `Invalid localization key: ${input.key}`, input.sourcePath));
        continue;
      }
      const language = normalizeLanguage(input.language);
      const table = entriesByLanguage[language] || (entriesByLanguage[language] = {});
      if (table[key]) {
        diagnostics.push(localizationDiagnostic(
          'LOCALIZATION_KEY_DUPLICATE',
          `Localization key ${key} is duplicated for ${language}`,
          input.sourcePath,
        ));
        continue;
      }
      const entry = entryFromValue(input, language, key);
      const normalizedEntry = { ...entry, key, language };
      table[key] = normalizedEntry;
      entries.push(normalizedEntry);
    }
  }
  entries.sort((left, right) => left.language.localeCompare(right.language) || left.key.localeCompare(right.key));
  const languages: Record<string, Record<string, string>> = {};
  for (const language of Object.keys(entriesByLanguage).sort()) {
    languages[language] = {};
    for (const key of Object.keys(entriesByLanguage[language]).sort()) languages[language][key] = entriesByLanguage[language][key].value;
  }
  const requestedFallback = options.fallbackLanguage ? normalizeLanguage(options.fallbackLanguage) : undefined;
  const fallbackLanguage = requestedFallback && entriesByLanguage[requestedFallback]
    ? requestedFallback
    : Object.keys(entriesByLanguage).sort()[0] || requestedFallback || 'en';
  return {
    formatVersion: 1,
    fallbackLanguage,
    languages,
    entries,
    entriesByLanguage,
    diagnostics,
  };
};

const refSpan = (reference: LocalizationReference): SourceSpan | undefined =>
  reference.line === undefined
    ? undefined
    : {
        ...(reference.sourcePath ? { sourcePath: reference.sourcePath } : {}),
        line: reference.line,
        column: reference.column ?? 1,
        endLine: reference.line,
        endColumn: (reference.column ?? 1) + reference.key.length,
      };

const normalizeReference = (reference: LocalizationReference | string, fallbackLanguage: string): LocalizationReference =>
  typeof reference === 'string' ? { key: reference, language: fallbackLanguage } : { ...reference, language: reference.language || fallbackLanguage };

/** Resolve a key with explicit language then catalog fallback. */
export const resolveLocalization = (
  catalog: LocalizationCatalog,
  reference: LocalizationReference | string,
  options: { fallbackLanguage?: LocalizationLanguage } | LocalizationLanguage = {},
): LocalizationResolveResult => {
  const resolveOptions = typeof options === 'string' ? { fallbackLanguage: options } : options;
  const normalized = normalizeReference(reference, resolveOptions.fallbackLanguage || catalog.fallbackLanguage);
  const requestedLanguage = normalizeLanguage(normalized.language || catalog.fallbackLanguage);
  let key: string;
  try {
    key = normalizeLocalizationKey(normalized.key);
  } catch {
    return {
      key: normalized.key,
      requestedLanguage,
      usedFallback: false,
      problems: [localizationDiagnostic('LOCALIZATION_KEY_INVALID', `Invalid localization key: ${normalized.key}`, normalized.sourcePath, refSpan(normalized))],
    };
  }
  const requested = catalog.entriesByLanguage[requestedLanguage]?.[key] ||
    (catalog.languages[requestedLanguage]?.[key] !== undefined
      ? { key, language: requestedLanguage, value: catalog.languages[requestedLanguage][key] }
      : undefined);
  if (requested) return { key, requestedLanguage, resolvedLanguage: requestedLanguage, value: requested.value, usedFallback: false, problems: [] };
  const fallbackLanguage = normalizeLanguage(resolveOptions.fallbackLanguage || catalog.fallbackLanguage);
  const fallback = catalog.entriesByLanguage[fallbackLanguage]?.[key] ||
    (catalog.languages[fallbackLanguage]?.[key] !== undefined
      ? { key, language: fallbackLanguage, value: catalog.languages[fallbackLanguage][key] }
      : undefined);
  if (fallback) {
    return {
      key,
      requestedLanguage,
      resolvedLanguage: fallbackLanguage,
      value: fallback.value,
      usedFallback: true,
      problems: [localizationDiagnostic(
        'LOCALIZATION_FALLBACK_USED',
        `Localization key ${key} fell back from ${requestedLanguage} to ${fallbackLanguage}`,
        normalized.sourcePath,
        refSpan(normalized),
        'warning',
      )],
    };
  }
  return {
    key,
    requestedLanguage,
    usedFallback: false,
    problems: [localizationDiagnostic(
      'LOCALIZATION_REFERENCE_MISSING',
      `Localization key ${key} is missing for ${requestedLanguage} and fallback ${fallbackLanguage}`,
      normalized.sourcePath,
      refSpan(normalized),
    )],
  };
};

export const resolveLocalizationReference = resolveLocalization;
export const resolveLocalizedText = resolveLocalization;

export const validateLocalizationReferences = (
  catalogOrReferences: LocalizationCatalog | readonly (LocalizationReference | string)[],
  referencesOrCatalog: readonly (LocalizationReference | string)[] | LocalizationCatalog,
  options: { fallbackLanguage?: LocalizationLanguage } = {},
): Problem[] => {
  const catalog = (Array.isArray(catalogOrReferences)
    ? referencesOrCatalog
    : catalogOrReferences) as LocalizationCatalog;
  const references = Array.isArray(catalogOrReferences)
    ? catalogOrReferences
    : referencesOrCatalog as readonly (LocalizationReference | string)[];
  return references.flatMap((reference) => resolveLocalization(catalog, reference, options).problems);
};

export const validateLocalizationCatalog = (catalog: LocalizationCatalog): Problem[] => [
  ...catalog.diagnostics,
  ...(catalog.languages[catalog.fallbackLanguage]
    ? []
    : [problem('LOCALIZATION_FALLBACK_LANGUAGE_MISSING', `Fallback language is missing: ${catalog.fallbackLanguage}`)]),
];

export interface AssetTargetMapping {
  path: string;
  role?: string;
  [key: string]: unknown;
}

export interface AssetReference {
  key: string;
  source: string;
  role: string;
  provenance?: string;
  license?: string;
  target?: string | AssetTargetMapping;
  confirmed?: boolean;
  [key: string]: unknown;
}

export interface AssetManifest {
  formatVersion: 1;
  assets: AssetReference[];
  [key: string]: unknown;
}

export interface AssetValidationOptions {
  root?: string;
  sourcePath?: string;
  confirmedRoles?: readonly string[];
}

export interface AssetValidationResult {
  manifest?: AssetManifest;
  problems: Problem[];
}

const isCredentialedUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
};

const isUrl = (value: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//iu.test(value);

const isAbsolutePath = (value: string): boolean =>
  value.startsWith('/') || value.startsWith('\\') || /^([a-z]:[\\/]|~[\\/])/iu.test(value);

const safeAssetRelative = (value: string): string | undefined => {
  if (!value || isAbsolutePath(value) || isUrl(value)) return undefined;
  const normalized = value.replace(/\\/gu, '/');
  const parts = normalized.split('/');
  if (parts.includes('..') || normalized.includes('\0')) return undefined;
  return parts.filter(Boolean).join('/');
};

const assetProblem = (code: string, message: string, sourcePath?: string, severity: 'error' | 'warning' = 'error'): Problem =>
  problem(code, message, sourcePath, severity);

const targetPathOf = (target: AssetReference['target']): string | undefined =>
  typeof target === 'string' ? target : target?.path;

const unsupportedAssetRole = (role: string): boolean => {
  const normalized = role.trim().toLowerCase().replace(/[_ ]/gu, '-');
  return normalized === 'background'
    || normalized === 'background-asset'
    || normalized === 'backgroundasset'
    || normalized === 'general'
    || normalized === 'general-asset'
    || normalized === 'generalasset';
};

const supportedAssetRole = (role: string): boolean => {
  const normalized = role.trim().toLowerCase().replace(/[_ ]/gu, '-');
  return normalized === 'gate-card'
    || normalized === 'gatecard'
    || normalized === 'solo-gate-card'
    || normalized === 'sologatecard'
    || normalized === 'gate-background'
    || normalized === 'solo-gate-background'
    || normalized === 'card';
};

const manifestRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Synchronous schema/path/collision validation for asset references. */
export const validateAssetManifest = (
  value: unknown,
  options: AssetValidationOptions = {},
): Problem[] => {
  const problems: Problem[] = [];
  const record = manifestRecord(value);
  if (!record) return [assetProblem('ASSET_MANIFEST_INVALID', 'Asset manifest must be an object', options.sourcePath)];
  if (record.formatVersion !== LOCALIZATION_FORMAT_VERSION) {
    problems.push(assetProblem(
      record.formatVersion && Number(record.formatVersion) > 1 ? 'ASSET_MANIFEST_VERSION_FUTURE' : 'ASSET_MANIFEST_VERSION_INVALID',
      `Asset manifest formatVersion must be ${LOCALIZATION_FORMAT_VERSION}`,
      options.sourcePath,
    ));
  }
  if (!Array.isArray(record.assets)) return [...problems, assetProblem('ASSET_MANIFEST_ASSETS_INVALID', 'Asset manifest assets must be an array', options.sourcePath)];
  const keys = new Set<string>();
  const targets = new Map<string, string>();
  for (const [index, raw] of record.assets.entries()) {
    const sourcePath = options.sourcePath ? `${options.sourcePath}#/assets/${index}` : `assets[${index}]`;
    const entry = manifestRecord(raw);
    if (!entry) {
      problems.push(assetProblem('ASSET_REFERENCE_INVALID', `Asset reference ${index} must be an object`, sourcePath));
      continue;
    }
    const key = typeof entry.key === 'string' ? entry.key : '';
    const role = typeof entry.role === 'string' ? entry.role : '';
    const source = typeof entry.source === 'string' ? entry.source : typeof entry.path === 'string' ? entry.path : '';
    let normalizedKey = '';
    try {
      normalizedKey = normalizeLocalizationKey(key);
    } catch {
      problems.push(assetProblem('ASSET_KEY_INVALID', `Invalid asset key: ${key}`, sourcePath));
    }
    if (normalizedKey && keys.has(normalizedKey)) problems.push(assetProblem('ASSET_KEY_DUPLICATE', `Asset key is duplicated: ${normalizedKey}`, sourcePath));
    if (normalizedKey) keys.add(normalizedKey);
    if (!role) problems.push(assetProblem('ASSET_ROLE_MISSING', `Asset ${key || index} requires a role`, sourcePath));
    if (!source) {
      problems.push(assetProblem('ASSET_SOURCE_MISSING', `Asset ${key || index} requires a source path`, sourcePath));
    } else {
      if (isCredentialedUrl(source)) problems.push(assetProblem('ASSET_CREDENTIAL_URL_FORBIDDEN', `Credentialed asset URL is forbidden: ${key || index}`, sourcePath));
      if (isAbsolutePath(source)) problems.push(assetProblem('ASSET_PATH_ABSOLUTE', `Asset source cannot be an absolute path: ${source}`, sourcePath));
      if (!safeAssetRelative(source)) problems.push(assetProblem('ASSET_PATH_INVALID', `Asset source must be a relative path: ${source}`, sourcePath));
    }
    if (typeof entry.provenance !== 'string' || !entry.provenance.trim()) problems.push(assetProblem('ASSET_PROVENANCE_MISSING', `Asset ${key || index} requires provenance`, sourcePath));
    if (typeof entry.license !== 'string' || !entry.license.trim()) problems.push(assetProblem('ASSET_LICENSE_MISSING', `Asset ${key || index} requires a license`, sourcePath));
    for (const metadata of [entry.provenance, entry.license]) {
      if (typeof metadata === 'string' && isCredentialedUrl(metadata)) problems.push(assetProblem('ASSET_CREDENTIAL_URL_FORBIDDEN', `Credentialed asset metadata URL is forbidden: ${key || index}`, sourcePath));
      if (typeof metadata === 'string' && isAbsolutePath(metadata)) problems.push(assetProblem('ASSET_METADATA_PATH_FORBIDDEN', `Asset metadata cannot contain an absolute personal path: ${key || index}`, sourcePath));
    }
    const target = targetPathOf(entry.target as AssetReference['target']);
    if (target !== undefined) {
      if (isCredentialedUrl(target)) problems.push(assetProblem('ASSET_CREDENTIAL_URL_FORBIDDEN', `Credentialed asset target URL is forbidden: ${key || index}`, sourcePath));
      const safeTarget = safeAssetRelative(target);
      if (!safeTarget) problems.push(assetProblem('ASSET_TARGET_PATH_INVALID', `Asset target must be a relative path: ${target}`, sourcePath));
      else {
        const collisionKey = safeTarget.toLowerCase();
        if (targets.has(collisionKey)) problems.push(assetProblem('ASSET_TARGET_COLLISION', `Asset target ${safeTarget} collides with ${targets.get(collisionKey)}`, sourcePath));
        else targets.set(collisionKey, key || String(index));
      }
    }
    const confirmedRoles = options.confirmedRoles?.map((entry) => entry.trim().toLowerCase().replace(/[_ ]/gu, '-')) || [];
    const normalizedRole = role.trim().toLowerCase().replace(/[_ ]/gu, '-');
    if (unsupportedAssetRole(role) && !entry.confirmed && !confirmedRoles.includes(normalizedRole)) {
      problems.push(assetProblem('CLIENT_ASSET_UNSUPPORTED', `Asset role ${role} is not supported by the current target contract`, sourcePath));
    } else if (!supportedAssetRole(role) && !unsupportedAssetRole(role) && role) {
      problems.push(assetProblem('CLIENT_ASSET_UNSUPPORTED', `Asset role ${role} has no supported target projection`, sourcePath));
    }
  }
  return problems;
};

/** Validate schema plus source-file existence inside an explicit content root. */
export const validateAssetManifestFiles = async (
  value: unknown,
  options: AssetValidationOptions = {},
): Promise<Problem[]> => {
  const problems = validateAssetManifest(value, options);
  const record = manifestRecord(value);
  if (!record || !Array.isArray(record.assets) || !options.root) return problems;
  const root = path.resolve(options.root);
  for (const [index, raw] of record.assets.entries()) {
    const entry = manifestRecord(raw);
    const source = typeof entry?.source === 'string' ? entry.source : typeof entry?.path === 'string' ? entry.path : undefined;
    const relative = source ? safeAssetRelative(source) : undefined;
    if (!relative) continue;
    try {
      const sourceFile = resolveInside(root, relative);
      await assertRealPathInside(root, sourceFile);
      if (!(await exists(sourceFile))) problems.push(assetProblem('ASSET_SOURCE_FILE_MISSING', `Asset source file is missing: ${relative}`, options.sourcePath ? `${options.sourcePath}#/assets/${index}` : `assets[${index}]`));
    } catch {
      problems.push(assetProblem('ASSET_PATH_INVALID', `Asset source escapes its content root: ${source}`, options.sourcePath ? `${options.sourcePath}#/assets/${index}` : `assets[${index}]`));
    }
  }
  return problems;
};

export const parseAssetManifest = (value: unknown, options: AssetValidationOptions = {}): AssetManifest => {
  const problems = validateAssetManifest(value, options);
  if (problems.some((entry) => entry.severity !== 'warning')) throw new LocalizationContentError(problems);
  return value as AssetManifest;
};

export const loadAssetManifest = async (
  filePath: string,
  options: Omit<AssetValidationOptions, 'sourcePath'> = {},
): Promise<AssetValidationResult> => {
  let value: unknown;
  try {
    value = JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/u, '')) as unknown;
  } catch (error) {
    return { problems: [assetProblem('ASSET_MANIFEST_JSON_INVALID', String(error), filePath)] };
  }
  const problems = await validateAssetManifestFiles(value, { ...options, sourcePath: filePath, root: options.root || path.dirname(filePath) });
  return { manifest: problems.some((entry) => entry.severity !== 'warning') ? undefined : value as AssetManifest, problems };
};

export const validateAssetReferences = validateAssetManifestFiles;
export const parseAssetReferences = parseAssetManifest;

export interface SoloChapterLocalizationInput {
  id: number;
  descriptionKey?: string;
  descriptionRef?: string;
  description?: string;
  localizationKey?: string;
}

export interface SoloGateLocalizationInput {
  id: number;
  nameKey?: string;
  nameRef?: string;
  descriptionKey?: string;
  descriptionRef?: string;
  name?: string;
  description?: string;
  localizationKey?: string;
  cardId?: number;
  illustrationId?: number;
  illustId?: number;
  illust_id?: number;
  card?: { id?: number; y?: number; x?: number };
  cardY?: number;
  cardX?: number;
  yOffset?: number;
  xOffset?: number;
  illustY?: number;
  illustX?: number;
  chapters?: SoloChapterLocalizationInput[];
}

export interface SoloLocalizationProjectionInput {
  gates: SoloGateLocalizationInput[] | Record<string, SoloGateLocalizationInput>;
  language?: LocalizationLanguage;
  fallbackLanguage?: LocalizationLanguage;
}

export interface SoloLocalizationProjection {
  files: Record<string, string>;
  problems: Problem[];
}

const asGates = (value: SoloLocalizationProjectionInput['gates']): SoloGateLocalizationInput[] =>
  Array.isArray(value) ? [...value] : Object.values(value);

const numeric = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const keyFor = (value: { nameKey?: string; nameRef?: string; name?: string; descriptionKey?: string; descriptionRef?: string; description?: string; localizationKey?: string }, field: 'name' | 'description'): string | undefined =>
  field === 'name'
    ? value.nameKey || value.nameRef || value.name || (value.localizationKey ? `${value.localizationKey}.name` : undefined)
    : value.descriptionKey || value.descriptionRef || value.description || (value.localizationKey ? `${value.localizationKey}.description` : undefined);

const resolveProjectionText = (
  catalog: LocalizationCatalog,
  key: string | undefined,
  language: string,
  fallbackLanguage: string,
  sourcePath: string,
): { value: string; problems: Problem[] } => {
  if (!key) return { value: '', problems: [problem('LOCALIZATION_REFERENCE_MISSING', 'Projection requires a localization reference', sourcePath)] };
  const resolved = resolveLocalization(catalog, { key, language, sourcePath }, { fallbackLanguage });
  return { value: resolved.value || '', problems: resolved.problems };
};

const chapterRuntimeId = (gateId: number, chapterId: number): number =>
  chapterId > 0 && chapterId < 10000 ? gateId * 10000 + chapterId : chapterId;

/** Generate only the documented Solo localization/card target projections. */
export const generateSoloLocalizationProjection = (
  input: SoloLocalizationProjectionInput,
  catalog: LocalizationCatalog,
): SoloLocalizationProjection => {
  const language = normalizeLanguage(input.language || catalog.fallbackLanguage);
  const fallbackLanguage = normalizeLanguage(input.fallbackLanguage || catalog.fallbackLanguage);
  const problems: Problem[] = [];
  const idsLines: string[] = [];
  const cardLines: string[] = [];
  const gates = asGates(input.gates).sort((left, right) => numeric(left.id) - numeric(right.id));
  const seenGates = new Set<number>();
  for (const gate of gates) {
    const gateId = numeric(gate.id, NaN);
    const sourcePath = `gates.${String(gate.id)}`;
    if (!Number.isInteger(gateId) || gateId < 0) {
      problems.push(problem('SOLO_GATE_ID_INVALID', `Invalid gate id: ${String(gate.id)}`, sourcePath));
      continue;
    }
    if (seenGates.has(gateId)) {
      problems.push(problem('SOLO_GATE_ID_DUPLICATE', `Duplicate gate id: ${gateId}`, sourcePath));
      continue;
    }
    seenGates.add(gateId);
    const name = resolveProjectionText(catalog, keyFor(gate, 'name'), language, fallbackLanguage, `${sourcePath}.nameKey`);
    const description = resolveProjectionText(catalog, keyFor(gate, 'description'), language, fallbackLanguage, `${sourcePath}.descriptionKey`);
    problems.push(...name.problems, ...description.problems);
    const gateToken = String(gateId).padStart(3, '0');
    idsLines.push(`[IDS_SOLO.GATE${gateToken}]`, name.value, `[IDS_SOLO.GATE${gateToken}_EXPLANATION]`, description.value);
    const cardId = gate.cardId ?? gate.illustrationId ?? gate.illustId ?? gate.illust_id ?? gate.card?.id;
    if (cardId === undefined || !Number.isInteger(cardId) || cardId < 0) {
      problems.push(problem('SOLO_GATE_CARD_MISSING', `Gate ${gateId} requires a numeric cardId`, `${sourcePath}.cardId`));
    } else {
      const y = gate.cardY ?? gate.yOffset ?? gate.illustY ?? gate.card?.y ?? 0;
      const x = gate.cardX ?? gate.xOffset ?? gate.illustX ?? gate.card?.x ?? 0;
      cardLines.push(`${gateId},${cardId},${numeric(y)},${numeric(x)}`);
    }
    const chapters = [...(gate.chapters || [])].sort((left, right) => numeric(left.id) - numeric(right.id));
    const seenChapters = new Set<number>();
    for (const chapter of chapters) {
      const chapterId = chapterRuntimeId(gateId, numeric(chapter.id, NaN));
      const chapterPath = `${sourcePath}.chapters.${String(chapter.id)}`;
      if (!Number.isInteger(chapterId) || chapterId <= 0) {
        problems.push(problem('SOLO_CHAPTER_ID_INVALID', `Invalid chapter id: ${String(chapter.id)}`, chapterPath));
        continue;
      }
      if (seenChapters.has(chapterId)) {
        problems.push(problem('SOLO_CHAPTER_ID_DUPLICATE', `Duplicate chapter id: ${chapterId}`, chapterPath));
        continue;
      }
      seenChapters.add(chapterId);
      const text = resolveProjectionText(catalog, keyFor(chapter, 'description'), language, fallbackLanguage, `${chapterPath}.descriptionKey`);
      problems.push(...text.problems);
      idsLines.push(`[IDS_SOLO.CHAPTER${chapterId}_EXPLANATION]`, text.value);
    }
  }
  const ids = idsLines.length ? `${idsLines.join('\n')}\n` : '';
  const cards = cardLines.length ? `${cardLines.join('\n')}\n` : '';
  return {
    files: {
      [SOLO_IDS_PATH]: ids,
      [SOLO_GATE_CARDS_PATH]: cards,
    },
    problems,
  };
};

export const generateLocalizationProjection = generateSoloLocalizationProjection;
export const projectSoloLocalization = generateSoloLocalizationProjection;
export const generateSoloClientData = generateSoloLocalizationProjection;

export const writeSoloLocalizationProjection = async (
  root: string,
  projection: SoloLocalizationProjection,
): Promise<string[]> => {
  if (projection.problems.some((entry) => entry.severity !== 'warning')) throw new LocalizationContentError(projection.problems);
  const changed: string[] = [];
  for (const [relative, value] of Object.entries(projection.files).sort(([left], [right]) => left.localeCompare(right))) {
    const target = resolveInside(root, relative);
    await assertRealPathInside(root, target);
    await ensureDirectory(path.dirname(target));
    await atomicWriteText(target, value);
    changed.push(relative);
  }
  return changed;
};
