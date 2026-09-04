import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertRealPathInside,
  pathInside,
  resolveInside,
} from './fs';
import {
  createLocalizationCatalog,
  validateAssetManifest,
  type AssetManifest,
  type LocalizationCatalog,
  type LocalizationEntry,
} from './localization-content';
import type { GateBackgroundAsset } from './gate-background-assets';
import {
  discoverContentSnapshot,
  type IrSnapshot,
  type IrSnapshotResult,
} from './ir-snapshot';
import type { ContentManifest } from './layers';
import type { JsonObject, Problem } from './types';
import { validateRuntimePolicyPatch, type RuntimePolicyFamily } from './runtime-policy';
import type { CardReferenceInput } from './card-resolver';
import {
  DECK_FOLDER_CATALOG_FILE,
  parseDeckFolderCatalog,
  resolveDeckIdentity,
  type DeckFolderCatalog,
} from './deck-organization';

export const CONTENT_BUNDLE_CODES = Object.freeze({
  OPTIONS_INVALID: 'CONTENT_BUNDLE_OPTIONS_INVALID',
  ROOT_INVALID: 'CONTENT_BUNDLE_ROOT_INVALID',
  ROOT_FORBIDDEN: 'CONTENT_BUNDLE_FORBIDDEN_INPUT',
  SNAPSHOT_REQUIRED: 'CONTENT_BUNDLE_SNAPSHOT_REQUIRED',
  SNAPSHOT_ROOT_MISMATCH: 'CONTENT_BUNDLE_SNAPSHOT_ROOT_MISMATCH',
  SNAPSHOT_PATH_INVALID: 'CONTENT_BUNDLE_SNAPSHOT_PATH_INVALID',
  SNAPSHOT_FILE_MISSING: 'CONTENT_BUNDLE_SNAPSHOT_FILE_MISSING',
  SNAPSHOT_BYTES_MISMATCH: 'CONTENT_BUNDLE_SNAPSHOT_BYTES_MISMATCH',
  SYMLINK_FORBIDDEN: 'CONTENT_BUNDLE_SYMLINK_FORBIDDEN',
  MANIFEST_INVALID: 'CONTENT_BUNDLE_MANIFEST_INVALID',
  DIRECTORY_INVALID: 'CONTENT_BUNDLE_DIRECTORY_INVALID',
  JSON_INVALID: 'CONTENT_BUNDLE_JSON_INVALID',
  GATE_INVALID: 'CONTENT_BUNDLE_GATE_INVALID',
  STRUCTURE_INVALID: 'CONTENT_BUNDLE_STRUCTURE_INVALID',
  DECK_INVALID: 'CONTENT_BUNDLE_DECK_INVALID',
  DECK_DUPLICATE: 'CONTENT_BUNDLE_DECK_DUPLICATE',
  DECK_OUTPUT_DUPLICATE: 'CONTENT_BUNDLE_DECK_OUTPUT_DUPLICATE',
  DECK_IDENTITY_INVALID: 'CONTENT_BUNDLE_DECK_IDENTITY_INVALID',
  DECK_SIDECAR_MISSING: 'CONTENT_BUNDLE_DECK_SIDECAR_MISSING',
  DECK_SIDECAR_AMBIGUOUS: 'CONTENT_BUNDLE_DECK_SIDECAR_AMBIGUOUS',
  DECK_PATH_COLLISION: 'CONTENT_BUNDLE_DECK_PATH_COLLISION',
  SIDECAR_INVALID: 'CONTENT_BUNDLE_DECK_SIDECAR_INVALID',
  SIDECAR_ORPHAN: 'CONTENT_BUNDLE_DECK_SIDECAR_ORPHAN',
  DECK_FOLDER_CATALOG_INVALID: 'CONTENT_BUNDLE_DECK_FOLDER_CATALOG_INVALID',
  REGULATION_INVALID: 'CONTENT_BUNDLE_REGULATION_INVALID',
  REGULATION_DUPLICATE: 'CONTENT_BUNDLE_REGULATION_DUPLICATE',
  REGULATION_RULES_MISSING: 'CONTENT_BUNDLE_REGULATION_RULES_MISSING',
  LOCALIZATION_INVALID: 'CONTENT_BUNDLE_LOCALIZATION_INVALID',
  ASSET_INVALID: 'CONTENT_BUNDLE_ASSET_INVALID',
  CARD_REFERENCES_INVALID: 'CONTENT_BUNDLE_CARD_REFERENCES_INVALID',
  SHOP_INVALID: 'CONTENT_BUNDLE_SHOP_INVALID',
  SHOP_REFERENCE_INVALID: 'CONTENT_BUNDLE_SHOP_REFERENCE_INVALID',
  SHOP_REFERENCE_MISSING: 'CONTENT_BUNDLE_SHOP_REFERENCE_MISSING',
  RUNTIME_POLICY_INVALID: 'CONTENT_BUNDLE_RUNTIME_POLICY_INVALID',
  RELEASE_PRODUCT_INVALID: 'CONTENT_BUNDLE_RELEASE_PRODUCT_INVALID',
} as const);

export type ContentBundleCode = (typeof CONTENT_BUNDLE_CODES)[keyof typeof CONTENT_BUNDLE_CODES];

export interface BundleJsonSource<T = unknown> {
  sourcePath: string;
  /** Exact bytes verified against the supplied content snapshot. */
  bytes: Uint8Array;
  value: T;
}

export interface CampaignDeckBundle {
  /** Compatibility key retained for callers; based on stable identity, not source path. */
  key: string;
  reference: string;
  adapterPath: string;
  identityOrigin: 'explicit' | 'legacy-flat';
  aliases: string[];
  source: BundleJsonSource<string>;
  sidecar?: BundleJsonSource<JsonObject>;
  metadata?: JsonObject;
  regulation?: string;
}

export interface CampaignRegulationBundle {
  key: string;
  metadata: BundleJsonSource<JsonObject>;
  rules: BundleJsonSource<string>;
}

export interface CampaignShopBundle {
  metadata: BundleJsonSource<JsonObject>;
  packList: BundleJsonSource<string>;
  odds: BundleJsonSource<JsonObject>;
}

export interface DiscoveredCampaignIrBundle {
  contentRoot: string;
  manifest: ContentManifest;
  snapshot: IrSnapshot;
  gates: BundleJsonSource<JsonObject>[];
  structures: BundleJsonSource<JsonObject>[];
  decks: Record<string, CampaignDeckBundle>;
  deckFolderSource?: BundleJsonSource<JsonObject>;
  deckFolderCatalog?: DeckFolderCatalog;
  regulations: Record<string, CampaignRegulationBundle>;
  shops: CampaignShopBundle[];
  releaseGraphs: BundleJsonSource<JsonObject>[];
  /** Campaign-owned, allowlisted patches for runtime baseline files. */
  runtimePolicy?: Record<string, JsonObject>;
  localization?: LocalizationCatalog;
  accessories?: BundleJsonSource<JsonObject>;
  gateBackgrounds: GateBackgroundAsset[];
  cardReferences: Record<string, CardReferenceInput>;
  /** Inputs deliberately left for compiler capability/partial-publish checks. */
  unconsumedPaths: string[];
  /** Compatibility spelling used by compiler callers. */
  unconsumed: string[];
  consumedPaths: string[];
}

export interface ContentBundleLoadResult {
  ok: boolean;
  bundle?: DiscoveredCampaignIrBundle;
  problems: Problem[];
}

export interface LoadCampaignIrBundleOptions {
  contentRoot: string;
  snapshot?: IrSnapshot | IrSnapshotResult;
}

type SnapshotInput = IrSnapshot | IrSnapshotResult | undefined;

interface LoadedSource {
  path: string;
  bytes: Uint8Array;
  hash: string;
  size: number;
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

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const diagnostic = (code: string, message: string, sourcePath?: string, jsonPointer?: string): Problem => ({
  code,
  message,
  ...(sourcePath ? { sourcePath, path: sourcePath } : {}),
  ...(jsonPointer ? { jsonPointer } : {}),
});

const problemSort = (left: Problem, right: Problem): number =>
  compareOrdinal(left.sourcePath || left.path || '', right.sourcePath || right.path || '')
  || compareOrdinal(left.jsonPointer || '', right.jsonPointer || '')
  || compareOrdinal(left.code, right.code)
  || compareOrdinal(left.message, right.message);

const sortedProblems = (problems: readonly Problem[]): Problem[] => [...problems].sort(problemSort);

const safeRelative = (value: string): boolean => {
  if (!value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== '.' && !normalized.split('/').some((part) => !part || part === '..');
};

const normalizePath = (value: string): string => value.replace(/\\/gu, '/');

const forbiddenPathSegment = (value: string): boolean =>
  value.split(/[\\/]+/u).some((part) => ['source', 'source-legacy', 'generated', 'external'].includes(part.toLowerCase()));

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const decodeText = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

const parseStrictJson = (source: LoadedSource, problems: Problem[]): unknown | undefined => {
  try {
    return JSON.parse(decodeText(source.bytes).replace(/^\uFEFF/u, '')) as unknown;
  } catch (error) {
    problems.push(diagnostic(CONTENT_BUNDLE_CODES.JSON_INVALID, `Invalid JSON: ${errorMessage(error)}`, source.path));
    return undefined;
  }
};

const sourceDirectory = (
  manifest: ContentManifest,
  name: keyof NonNullable<ContentManifest['directories']>,
  fallback: string,
  root: string,
  problems: Problem[],
): string => {
  const raw = manifest.directories?.[name] || fallback;
  if (typeof raw !== 'string' || !safeRelative(raw)) {
    problems.push(diagnostic(CONTENT_BUNDLE_CODES.DIRECTORY_INVALID, `Manifest directory ${name} is not a safe relative POSIX path`, `manifest.json:/directories/${name}`));
    return fallback;
  }
  try {
    const absolute = resolveInside(root, raw);
    if (!pathInside(root, absolute)) throw new Error('resolved directory escapes content root');
    return raw;
  } catch (error) {
    problems.push(diagnostic(CONTENT_BUNDLE_CODES.DIRECTORY_INVALID, `Manifest directory ${name} is unsafe: ${errorMessage(error)}`, `manifest.json:/directories/${name}`));
    return fallback;
  }
};

const directFiles = (
  files: readonly string[],
  directory: string,
  extension: string,
): string[] => {
  const prefix = `${directory}/`;
  return files
    .filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/') && file.toLowerCase().endsWith(extension.toLowerCase()))
    .sort(compareOrdinal);
};

const sourceStem = (relative: string, extension: string): string => relative.slice(0, -extension.length);

const asJsonObject = (value: unknown): JsonObject | undefined => isRecord(value) ? value as JsonObject : undefined;

const sourceHashProblem = (source: LoadedSource, expected: { hash: string; size: number }): Problem | undefined => {
  const actualHash = sha256(source.bytes);
  if (actualHash !== expected.hash || source.size !== expected.size) {
    return diagnostic(
      CONTENT_BUNDLE_CODES.SNAPSHOT_BYTES_MISMATCH,
      `Source bytes changed after snapshot for ${source.path}`,
      source.path,
    );
  }
  return undefined;
};

const snapshotFromInput = (input: SnapshotInput): { snapshot?: IrSnapshot; problems: Problem[] } => {
  if (!input) return { problems: [diagnostic(CONTENT_BUNDLE_CODES.SNAPSHOT_REQUIRED, 'A successful discoverContentSnapshot result is required')] };
  if ('ok' in input) return input.ok && input.snapshot ? { snapshot: input.snapshot, problems: [] } : { problems: input.problems.length ? input.problems : [diagnostic(CONTENT_BUNDLE_CODES.SNAPSHOT_REQUIRED, 'Content snapshot discovery failed')] };
  return { snapshot: input, problems: [] };
};

const loadAllSources = async (
  root: string,
  snapshot: IrSnapshot,
  problems: Problem[],
): Promise<Map<string, LoadedSource>> => {
  const expected = new Map<string, { hash: string; size: number }>();
  for (const entry of snapshot.files) {
    const relative = normalizePath(entry.path);
    if (!safeRelative(relative) || forbiddenPathSegment(relative)) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.SNAPSHOT_PATH_INVALID, `Snapshot source path is not safe: ${entry.path}`, entry.path));
      continue;
    }
    if (expected.has(relative)) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.SNAPSHOT_PATH_INVALID, `Snapshot source path is duplicated: ${relative}`, relative));
      continue;
    }
    expected.set(relative, { hash: entry.hash, size: entry.size });
  }
  const loaded = new Map<string, LoadedSource>();
  for (const relative of [...expected.keys()].sort(compareOrdinal)) {
    let target: string;
    try {
      target = resolveInside(root, relative);
      await assertRealPathInside(root, target);
      const stats = await fs.lstat(target);
      if (stats.isSymbolicLink()) throw new Error('symlink or junction is forbidden');
      if (!stats.isFile()) throw new Error('source is not a regular file');
    } catch (error) {
      const code = errorMessage(error).toLowerCase().includes('symlink')
        ? CONTENT_BUNDLE_CODES.SYMLINK_FORBIDDEN
        : CONTENT_BUNDLE_CODES.SNAPSHOT_FILE_MISSING;
      problems.push(diagnostic(code, `Snapshot source cannot be safely read: ${relative} (${errorMessage(error)})`, relative));
      continue;
    }
    try {
      const bytes = await fs.readFile(target);
      const source: LoadedSource = { path: relative, bytes, hash: sha256(bytes), size: bytes.byteLength };
      const mismatch = sourceHashProblem(source, expected.get(relative) as { hash: string; size: number });
      if (mismatch) problems.push(mismatch);
      loaded.set(relative, source);
    } catch (error) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.SNAPSHOT_FILE_MISSING, `Snapshot source cannot be read: ${relative} (${errorMessage(error)})`, relative));
    }
  }
  return loaded;
};

const languageEntries = (
  value: unknown,
  language: string,
  sourcePath: string,
  problems: Problem[],
): LocalizationEntry[] => {
  if (!isRecord(value)) {
    problems.push(diagnostic(CONTENT_BUNDLE_CODES.LOCALIZATION_INVALID, 'Localization JSON must be an object', sourcePath));
    return [];
  }
  const entries: LocalizationEntry[] = [];
  for (const [key, text] of Object.entries(value).sort(([left], [right]) => compareOrdinal(left, right))) {
    if (typeof text !== 'string') {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.LOCALIZATION_INVALID, `Localization value must be text: ${key}`, sourcePath, `/` + key));
      continue;
    }
    entries.push({ key, language, value: text, sourcePath });
  }
  return entries;
};

const catalogEntries = (
  value: unknown,
  sourcePath: string,
  problems: Problem[],
): LocalizationEntry[] => {
  if (!isRecord(value)) {
    problems.push(diagnostic(CONTENT_BUNDLE_CODES.LOCALIZATION_INVALID, 'Localization catalog JSON must be an object', sourcePath));
    return [];
  }
  const languageMap = isRecord(value.languages) ? value.languages : value;
  const entries: LocalizationEntry[] = [];
  for (const [language, values] of Object.entries(languageMap).sort(([left], [right]) => compareOrdinal(left, right))) {
    if (!isRecord(values)) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.LOCALIZATION_INVALID, `Localization language must map to an object: ${language}`, sourcePath, `/languages/${language}`));
      continue;
    }
    entries.push(...languageEntries(values, language, sourcePath, problems));
  }
  return entries;
};

const bundleRoot = (
  contentRootInput: string | LoadCampaignIrBundleOptions,
  snapshotInput: SnapshotInput,
): { root?: string; snapshotInput?: SnapshotInput; problems: Problem[] } => {
  if (typeof contentRootInput === 'string') return { root: path.resolve(contentRootInput), snapshotInput, problems: [] };
  if (!contentRootInput || typeof contentRootInput.contentRoot !== 'string') return { problems: [diagnostic(CONTENT_BUNDLE_CODES.OPTIONS_INVALID, 'contentRoot is required')] };
  return { root: path.resolve(contentRootInput.contentRoot), snapshotInput: contentRootInput.snapshot, problems: [] };
};

/** Load convention-based authored content into one compiler bundle without writing or merging generated files. */
export const loadCampaignIrBundle = async (
  contentRootInput: string | LoadCampaignIrBundleOptions,
  snapshotInput?: SnapshotInput,
): Promise<ContentBundleLoadResult> => {
  const rootResult = bundleRoot(contentRootInput, snapshotInput);
  if (!rootResult.root) return { ok: false, problems: sortedProblems(rootResult.problems) };
  const root = rootResult.root;
  const snapshotResult = snapshotFromInput(rootResult.snapshotInput);
  if (snapshotResult.problems.length) return { ok: false, problems: sortedProblems(snapshotResult.problems) };
  const snapshot = snapshotResult.snapshot as IrSnapshot;
  const snapshotRoot = path.resolve(snapshot.root);
  if (snapshotRoot.toLowerCase() !== root.toLowerCase()) {
    return { ok: false, problems: [diagnostic(CONTENT_BUNDLE_CODES.SNAPSHOT_ROOT_MISMATCH, 'Snapshot root does not match contentRoot', root)] };
  }
  if (forbiddenPathSegment(root)) return { ok: false, problems: [diagnostic(CONTENT_BUNDLE_CODES.ROOT_FORBIDDEN, 'source, source-legacy, generated, and external are not content inputs', root)] };

  const problems: Problem[] = [];
  const sources = await loadAllSources(root, snapshot, problems);
  const consumed = new Set<string>();
  const manifestSource = sources.get('manifest.json');
  let manifest: ContentManifest = snapshot.manifest;
  if (!manifestSource) problems.push(diagnostic(CONTENT_BUNDLE_CODES.MANIFEST_INVALID, 'Snapshot does not contain manifest.json', 'manifest.json'));
  else {
    consumed.add('manifest.json');
    const parsed = parseStrictJson(manifestSource, problems);
    if (isRecord(parsed)) manifest = parsed as ContentManifest;
    else problems.push(diagnostic(CONTENT_BUNDLE_CODES.MANIFEST_INVALID, 'Content manifest must be a JSON object', 'manifest.json'));
  }

  const gateDirectory = sourceDirectory(manifest, 'gates', 'gates', root, problems);
  const structureDirectory = sourceDirectory(manifest, 'structures', 'structures', root, problems);
  const deckDirectory = sourceDirectory(manifest, 'decks', 'decks', root, problems);
  const regulationDirectory = sourceDirectory(manifest, 'regulations', 'regulations', root, problems);
  const localizationDirectory = sourceDirectory(manifest, 'localization', 'localization', root, problems);
  const assetsDirectory = sourceDirectory(manifest, 'assets', 'assets', root, problems);
  const shopDirectory = sourceDirectory(manifest, 'shop', 'shop', root, problems);
  const targetDirectory = sourceDirectory(manifest, 'target', 'target/ygomaster', root, problems);
  const runtimePolicyDirectory = sourceDirectory(manifest, 'runtimePolicy', 'runtime-policy', root, problems);
  const releaseDirectory = sourceDirectory(manifest, 'releases', 'releases', root, problems);
  void targetDirectory;

  const releaseGraphs: BundleJsonSource<JsonObject>[] = [];
  for (const relative of directFiles([...sources.keys()], releaseDirectory, '.json')) {
    const source = sources.get(relative) as LoadedSource;
    const value = parseStrictJson(source, problems);
    consumed.add(relative);
    const document = asJsonObject(value);
    if (!document) problems.push(diagnostic(CONTENT_BUNDLE_CODES.RELEASE_PRODUCT_INVALID, 'Release/product graph must be a JSON object', relative));
    else releaseGraphs.push({ sourcePath: relative, bytes: new Uint8Array(source.bytes), value: document });
  }

  const runtimePolicy: Record<string, JsonObject> = {};
  const runtimePolicyFiles: Record<string, string> = {
    settings: `${runtimePolicyDirectory}/settings.json`,
    shop: `${runtimePolicyDirectory}/shop.json`,
    client: `${runtimePolicyDirectory}/client.json`,
  };
  // This is authored documentation for the policy family, not an executable
  // compiler input. Mark it consumed so the fail-closed untracked-input gate
  // remains useful for actual policy files.
  if (sources.has(`${runtimePolicyDirectory}/README.md`)) consumed.add(`${runtimePolicyDirectory}/README.md`);
  for (const [key, relative] of Object.entries(runtimePolicyFiles)) {
    const source = sources.get(relative);
    if (!source) continue;
    const value = parseStrictJson(source, problems);
    const document = asJsonObject(value);
    consumed.add(relative);
    if (!document) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.RUNTIME_POLICY_INVALID, 'Runtime policy document must be a JSON object', relative));
      continue;
    }
    const payload = isRecord(document.payload) ? document.payload : document;
    if (!isRecord(payload)) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.RUNTIME_POLICY_INVALID, 'Runtime policy payload must be a JSON object', relative, '/payload'));
      continue;
    }
    problems.push(...validateRuntimePolicyPatch(key as RuntimePolicyFamily, payload, relative)
      .filter((entry) => entry.severity !== 'warning')
      .map((entry) => ({ ...entry, code: entry.code === 'RUNTIME_POLICY_KEY_UNSUPPORTED' ? CONTENT_BUNDLE_CODES.RUNTIME_POLICY_INVALID : entry.code })));
    runtimePolicy[key] = payload as JsonObject;
  }

  const gates: BundleJsonSource<JsonObject>[] = [];
  for (const relative of directFiles([...sources.keys()], gateDirectory, '.json')) {
    const source = sources.get(relative) as LoadedSource;
    const value = parseStrictJson(source, problems);
    const document = asJsonObject(value);
    if (!document) problems.push(diagnostic(CONTENT_BUNDLE_CODES.GATE_INVALID, 'Gate source must be a JSON object', relative));
    else gates.push({ sourcePath: relative, bytes: new Uint8Array(source.bytes), value: document });
    consumed.add(relative);
  }

  const structures: BundleJsonSource<JsonObject>[] = [];
  for (const relative of directFiles([...sources.keys()], structureDirectory, '.json')) {
    const source = sources.get(relative) as LoadedSource;
    const value = parseStrictJson(source, problems);
    const document = asJsonObject(value);
    if (!document) problems.push(diagnostic(CONTENT_BUNDLE_CODES.STRUCTURE_INVALID, 'Structure source must be a JSON object', relative));
    else structures.push({ sourcePath: relative, bytes: new Uint8Array(source.bytes), value: document });
    consumed.add(relative);
  }

  const shops: CampaignShopBundle[] = [];
  for (const relative of directFiles([...sources.keys()], `${shopDirectory}/packs`, '.json')) {
    const source = sources.get(relative) as LoadedSource;
    const value = parseStrictJson(source, problems);
    const metadata = asJsonObject(value);
    consumed.add(relative);
    if (!metadata) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.SHOP_INVALID, 'Shop pack metadata must be a JSON object', relative));
      continue;
    }
    const payload = isRecord(metadata.payload) ? metadata.payload : metadata;
    const packListRef = payload.packlist;
    const oddsRef = payload.odds;
    const resolveShopReference = (reference: unknown, field: 'packlist' | 'odds'): LoadedSource | undefined => {
      if (typeof reference !== 'string' || !safeRelative(reference)) {
        problems.push(diagnostic(CONTENT_BUNDLE_CODES.SHOP_REFERENCE_INVALID, `Shop ${field} must be a safe path relative to ${shopDirectory}`, relative, `/payload/${field}`));
        return undefined;
      }
      const target = `${shopDirectory}/${reference}`;
      const linked = sources.get(target);
      if (!linked) problems.push(diagnostic(CONTENT_BUNDLE_CODES.SHOP_REFERENCE_MISSING, `Shop ${field} source is missing: ${target}`, relative, `/payload/${field}`));
      return linked;
    };
    const packListSource = resolveShopReference(packListRef, 'packlist');
    const oddsSource = resolveShopReference(oddsRef, 'odds');
    if (!packListSource || !oddsSource) continue;
    const oddsValue = parseStrictJson(oddsSource, problems);
    const odds = asJsonObject(oddsValue);
    if (!odds) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.SHOP_INVALID, 'Shop odds source must be a JSON object', oddsSource.path));
      continue;
    }
    consumed.add(packListSource.path);
    consumed.add(oddsSource.path);
    shops.push({
      metadata: { sourcePath: relative, bytes: new Uint8Array(source.bytes), value: metadata },
      packList: { sourcePath: packListSource.path, bytes: new Uint8Array(packListSource.bytes), value: decodeText(packListSource.bytes) },
      odds: { sourcePath: oddsSource.path, bytes: new Uint8Array(oddsSource.bytes), value: odds },
    });
  }

  const decks: Record<string, CampaignDeckBundle> = {};
  const deckFolderPath = `${deckDirectory}/${DECK_FOLDER_CATALOG_FILE}`;
  const deckFolderSource = sources.get(deckFolderPath);
  let deckFolderDocument: BundleJsonSource<JsonObject> | undefined;
  let deckFolderCatalog: DeckFolderCatalog | undefined;
  if (deckFolderSource) {
    const value = parseStrictJson(deckFolderSource, problems);
    const document = asJsonObject(value);
    consumed.add(deckFolderPath);
    if (!document) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.DECK_FOLDER_CATALOG_INVALID, 'Deck folder catalog must be a JSON object', deckFolderPath));
    } else {
      deckFolderDocument = { sourcePath: deckFolderPath, bytes: new Uint8Array(deckFolderSource.bytes), value: document };
      const parsed = parseDeckFolderCatalog(document, deckFolderPath);
      problems.push(...parsed.problems);
      deckFolderCatalog = parsed.catalog;
    }
  }
  const deckFiles = directFiles([...sources.keys()], deckDirectory, '.decklist');
  const deckSidecarFiles = directFiles([...sources.keys()], deckDirectory, '.json')
    .filter((relative) => relative !== deckFolderPath);
  const sidecarsByPortableStem = new Map<string, string[]>();
  for (const sidecarPath of deckSidecarFiles) {
    const portable = sourceStem(sidecarPath, '.json').normalize('NFKC').toLocaleLowerCase('en-US');
    sidecarsByPortableStem.set(portable, [...(sidecarsByPortableStem.get(portable) || []), sidecarPath].sort(compareOrdinal));
  }
  const deckKeys = new Set<string>();
  const adapterPaths = new Set<string>();
  const pairedSidecars = new Set<string>();
  for (const relative of deckFiles) {
    const source = sources.get(relative) as LoadedSource;
    const stem = sourceStem(relative, '.decklist');
    const sidecarPath = `${stem}.json`;
    const sidecarCandidates = sidecarsByPortableStem.get(stem.normalize('NFKC').toLocaleLowerCase('en-US')) || [];
    if (sidecarCandidates.length > 1) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.DECK_SIDECAR_AMBIGUOUS, `Deck sidecar pairing is ambiguous: ${sidecarCandidates.join(', ')}`, relative));
      consumed.add(relative);
      for (const candidate of sidecarCandidates) consumed.add(candidate);
      continue;
    }
    const sidecarSource = sources.get(sidecarPath);
    consumed.add(relative);
    let sidecar: JsonObject | undefined;
    let metadata: JsonObject | undefined;
    let regulation: string | undefined;
    if (sidecarSource) {
      pairedSidecars.add(sidecarPath);
      consumed.add(sidecarPath);
      const value = parseStrictJson(sidecarSource, problems);
      sidecar = asJsonObject(value);
      if (!sidecar) problems.push(diagnostic(CONTENT_BUNDLE_CODES.SIDECAR_INVALID, 'Deck sidecar must be a JSON object', sidecarPath));
      else {
        const document = typeof sidecar.code === 'number' && isRecord(sidecar.res) ? sidecar.res as JsonObject : sidecar;
        metadata = isRecord(document.metadata) ? document.metadata as JsonObject : document;
        const rawRegulation = document.regulation ?? (isRecord(document.payload) ? document.payload.regulation : undefined);
        if (rawRegulation !== undefined) {
          if (typeof rawRegulation !== 'string' || !rawRegulation.trim()) problems.push(diagnostic(CONTENT_BUNDLE_CODES.SIDECAR_INVALID, 'Deck sidecar regulation must be a non-empty string', sidecarPath, '/regulation'));
          else regulation = rawRegulation;
        }
      }
    }
    const relativeWithinDecks = relative.slice(deckDirectory.length + 1);
    const legacyFlatStem = path.posix.basename(relativeWithinDecks, '.decklist');
    const identity = resolveDeckIdentity(metadata, { sourcePath: sidecarSource ? sidecarPath : relative, ...(legacyFlatStem ? { legacyFlatStem } : {}) });
    if (identity.problems.length) {
      problems.push(...identity.problems.map((entry) => ({ ...entry, code: CONTENT_BUNDLE_CODES.DECK_IDENTITY_INVALID })));
      continue;
    }
    const identityKey = (identity.key as string).normalize('NFKC').toLocaleLowerCase('en-US');
    if (deckKeys.has(identityKey)) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.DECK_DUPLICATE, `Duplicate stable Deck identity: ${identity.reference}`, relative));
      continue;
    }
    deckKeys.add(identityKey);
    const adapterIdentity = (identity.adapterPath as string).normalize('NFKC').toLocaleLowerCase('en-US');
    if (adapterPaths.has(adapterIdentity)) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.DECK_OUTPUT_DUPLICATE, `Duplicate generated Deck adapter output: ${identity.adapterPath}`, relative));
      continue;
    }
    adapterPaths.add(adapterIdentity);
    const key = `${identity.key}.decklist`;
    const deck: CampaignDeckBundle = {
      key,
      reference: identity.reference as string,
      adapterPath: identity.adapterPath as string,
      identityOrigin: identity.origin as 'explicit' | 'legacy-flat',
      aliases: [...new Set([
        key,
        relative,
        relativeWithinDecks,
        sourceStem(relativeWithinDecks, '.decklist'),
        `${deckDirectory}/${identity.key}.json`,
      ])].sort(compareOrdinal),
      source: { sourcePath: relative, bytes: new Uint8Array(source.bytes), value: decodeText(source.bytes) },
      ...(sidecar && sidecarSource ? { sidecar: { sourcePath: sidecarPath, bytes: new Uint8Array(sidecarSource.bytes), value: sidecar } } : {}),
      ...(metadata ? { metadata } : {}),
      ...(regulation ? { regulation } : {}),
    };
    decks[key] = deck;
  }
  for (const sidecarPath of deckSidecarFiles) {
    if (!pairedSidecars.has(sidecarPath)) {
      consumed.add(sidecarPath);
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.SIDECAR_ORPHAN, `Deck sidecar has no uniquely paired .decklist source: ${sidecarPath}`, sidecarPath));
    }
  }

  const regulations: Record<string, CampaignRegulationBundle> = {};
  const regulationMetadataFiles = directFiles([...sources.keys()], regulationDirectory, '.json');
  const regulationKeys = new Set<string>();
  for (const relative of regulationMetadataFiles) {
    const source = sources.get(relative) as LoadedSource;
    const value = parseStrictJson(source, problems);
    const metadata = asJsonObject(value);
    consumed.add(relative);
    if (!metadata) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.REGULATION_INVALID, 'Regulation metadata must be a JSON object', relative));
      continue;
    }
    const payload = isRecord(metadata.payload) ? metadata.payload : metadata;
    const key = typeof payload.regulationId === 'string' && payload.regulationId.trim() ? payload.regulationId.trim() : undefined;
    if (!key) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.REGULATION_INVALID, 'Regulation metadata requires payload.regulationId', relative, '/payload/regulationId'));
      continue;
    }
    const rulesPath = `${sourceStem(relative, '.json')}.regulation`;
    const rulesSource = sources.get(rulesPath);
    if (!rulesSource) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.REGULATION_RULES_MISSING, `Regulation rules pair is missing: ${rulesPath}`, relative));
      continue;
    }
    if (regulationKeys.has(key)) {
      problems.push(diagnostic(CONTENT_BUNDLE_CODES.REGULATION_DUPLICATE, `Duplicate regulation key: ${key}`, relative));
      continue;
    }
    regulationKeys.add(key);
    consumed.add(rulesPath);
    regulations[key] = {
      key,
      metadata: { sourcePath: relative, bytes: new Uint8Array(source.bytes), value: metadata },
      rules: { sourcePath: rulesPath, bytes: new Uint8Array(rulesSource.bytes), value: decodeText(rulesSource.bytes) },
    };
  }

  let localization: LocalizationCatalog | undefined;
  const localizationEntries: LocalizationEntry[] = [];
  for (const relative of directFiles([...sources.keys()], localizationDirectory, '.json')) {
    const source = sources.get(relative) as LoadedSource;
    const value = parseStrictJson(source, problems);
    if (path.posix.basename(relative).toLowerCase() === 'catalog.json') {
      localizationEntries.push(...catalogEntries(value, relative, problems));
    } else {
      const language = path.posix.basename(relative, path.posix.extname(relative));
      localizationEntries.push(...languageEntries(value, language, relative, problems));
    }
    consumed.add(relative);
  }
  if (localizationEntries.length) {
    localization = createLocalizationCatalog(localizationEntries, {
      fallbackLanguage: isRecord(manifest.authoring) && typeof manifest.authoring.language === 'string' ? manifest.authoring.language : undefined,
    });
    problems.push(...localization.diagnostics);
  }

  let accessories: BundleJsonSource<JsonObject> | undefined;
  const accessoriesPath = `${assetsDirectory}/accessories.json`;
  const accessoriesSource = sources.get(accessoriesPath);
  if (accessoriesSource) {
    const value = parseStrictJson(accessoriesSource, problems);
    const document = asJsonObject(value);
    if (!document) problems.push(diagnostic(CONTENT_BUNDLE_CODES.ASSET_INVALID, 'assets/accessories.json must contain a JSON object', accessoriesPath));
    else accessories = { sourcePath: accessoriesPath, bytes: new Uint8Array(accessoriesSource.bytes), value: document };
    consumed.add(accessoriesPath);
  }

  const gateBackgrounds: GateBackgroundAsset[] = [];
  const assetManifestPath = `${assetsDirectory}/manifest.json`;
  const assetManifestSource = sources.get(assetManifestPath);
  if (assetManifestSource) {
    const value = parseStrictJson(assetManifestSource, problems);
    const manifestProblems = validateAssetManifest(value, {
      sourcePath: assetManifestPath,
      confirmedRoles: ['solo-gate-background'],
    });
    problems.push(...manifestProblems);
    consumed.add(assetManifestPath);
    if (manifestProblems.length === 0) {
      for (const asset of (value as AssetManifest).assets) {
        const normalizedRole = asset.role.trim().toLowerCase().replace(/[_ ]/gu, '-');
        if (normalizedRole !== 'solo-gate-background' && normalizedRole !== 'gate-background') continue;
        const gateRefs = Array.isArray(asset.gateRefs) && asset.gateRefs.every((entry) => typeof entry === 'string')
          ? asset.gateRefs as string[]
          : undefined;
        if (!gateRefs?.length) {
          problems.push(diagnostic(CONTENT_BUNDLE_CODES.ASSET_INVALID, `Solo Gate background ${asset.key} requires non-empty gateRefs`, assetManifestPath));
          continue;
        }
        const sourcePath = asset.source.replace(/\\/gu, '/');
        const source = sources.get(sourcePath);
        if (!source) {
          problems.push(diagnostic(CONTENT_BUNDLE_CODES.ASSET_INVALID, `Asset source is missing from the content snapshot: ${sourcePath}`, assetManifestPath));
          continue;
        }
        gateBackgrounds.push({
          key: asset.key,
          sourcePath,
          manifestSourcePath: assetManifestPath,
          gateRefs: [...gateRefs],
          bytes: new Uint8Array(source.bytes),
        });
        consumed.add(sourcePath);
      }
    }
  }

  const rawCardReferences = manifest.cardReferences;
  const cardReferences: Record<string, CardReferenceInput> = {};
  if (rawCardReferences !== undefined) {
    if (!isRecord(rawCardReferences)) problems.push(diagnostic(CONTENT_BUNDLE_CODES.CARD_REFERENCES_INVALID, 'manifest.cardReferences must be a card-reference map', 'manifest.json', '/cardReferences'));
    else {
      for (const [key, value] of Object.entries(rawCardReferences).sort(([left], [right]) => compareOrdinal(left, right))) {
        const validString = typeof value === 'string' && value.trim().length > 0;
        const validObject = isRecord(value) && typeof value.name === 'string' && value.name.trim().length > 0 && isRecord(value.selector);
        if (!validString && !validObject) problems.push(diagnostic(CONTENT_BUNDLE_CODES.CARD_REFERENCES_INVALID, `Card reference must be a non-empty name or { name, selector }: ${key}`, 'manifest.json', `/cardReferences/${key}`));
        else cardReferences[key] = value as CardReferenceInput;
      }
    }
  }

  const unconsumedPaths = [...sources.keys()].filter((relative) => !consumed.has(relative)).sort(compareOrdinal);
  const consumedPaths = [...consumed].sort(compareOrdinal);
  const bundle: DiscoveredCampaignIrBundle = {
    contentRoot: root,
    manifest,
    snapshot,
    gates: gates.sort((left, right) => compareOrdinal(left.sourcePath, right.sourcePath)),
    structures: structures.sort((left, right) => compareOrdinal(left.sourcePath, right.sourcePath)),
    decks: Object.fromEntries(Object.entries(decks).sort(([left], [right]) => compareOrdinal(left, right))),
    ...(deckFolderDocument ? { deckFolderSource: deckFolderDocument } : {}),
    ...(deckFolderCatalog ? { deckFolderCatalog } : {}),
    regulations: Object.fromEntries(Object.entries(regulations).sort(([left], [right]) => compareOrdinal(left, right))),
    shops: shops.sort((left, right) => compareOrdinal(left.metadata.sourcePath, right.metadata.sourcePath)),
    releaseGraphs: releaseGraphs.sort((left, right) => compareOrdinal(left.sourcePath, right.sourcePath)),
    ...(Object.keys(runtimePolicy).length ? { runtimePolicy } : {}),
    ...(localization ? { localization } : {}),
    ...(accessories ? { accessories } : {}),
    gateBackgrounds: gateBackgrounds.sort((left, right) => compareOrdinal(left.key, right.key)),
    cardReferences,
    unconsumedPaths,
    unconsumed: [...unconsumedPaths],
    consumedPaths,
  };
  return { ok: problems.length === 0, ...(problems.length ? {} : { bundle }), problems: sortedProblems(problems) };
};

export const loadContentBundle = loadCampaignIrBundle;
export const buildCampaignIrBundle = loadCampaignIrBundle;
export const discoverCampaignIrBundle = async (
  contentRoot: string,
): Promise<ContentBundleLoadResult> => {
  const snapshot = await discoverContentSnapshot(contentRoot);
  return loadCampaignIrBundle(contentRoot, snapshot);
};
