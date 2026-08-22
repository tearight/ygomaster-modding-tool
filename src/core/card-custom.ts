import * as fs from 'node:fs/promises';
import path from 'node:path';

import { resolveWorkspaceDataRoot } from './project-root';
import {
  JsonObject,
  JsonValue,
  OperationResult,
  Problem,
  failure,
  problem,
  result,
} from './types';

export const CUSTOM_CARD_DATABASE_DIRECTORY = 'card-db';
export const CUSTOM_CARD_DATABASE_SCHEMA_VERSION = 1;

export interface CustomCardLayer {
  id: string;
  priority: number;
  kind: 'generated' | 'reviewed';
  directory: string;
}

export interface CustomCardDatabaseManifest {
  schemaVersion: 1;
  revision: number;
  layers: CustomCardLayer[];
}

export interface CustomCardClaim {
  path: string;
  confidence?: number;
  source: {
    kind: string;
    reference: string;
  };
  [key: string]: JsonValue | undefined;
}

export interface CustomCardRecord {
  schemaVersion: 1;
  cardId: number;
  revision: number;
  operation?: 'merge' | 'tombstone';
  searchTerms?: string[];
  facets?: JsonObject;
  extensions?: JsonObject;
  claims?: CustomCardClaim[];
  [key: string]: JsonValue | CustomCardClaim[] | undefined;
}

export interface MaterializedCustomCard {
  cardId: number;
  searchTerms: string[];
  facets: JsonObject;
  extensions: JsonObject;
  claims: CustomCardClaim[];
  appliedLayers: string[];
}

export interface CustomCardDatabaseReport {
  root: string;
  manifest: CustomCardDatabaseManifest;
  files: string[];
  sourceRecordCount: number;
  materializedCards: MaterializedCustomCard[];
  errorCount: number;
  warningCount: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const deepMerge = (base: JsonObject, patchValue: JsonObject): JsonObject => {
  const output = cloneJson(base);
  Object.entries(patchValue).forEach(([key, value]) => {
    const existing = output[key];
    output[key] = isRecord(existing) && isRecord(value)
      ? deepMerge(existing as JsonObject, value as JsonObject)
      : cloneJson(value as JsonValue);
  });
  return output;
};

const safeRelativeDirectory = (value: string): boolean => {
  if (!value || path.isAbsolute(value) || value.includes('\\') || value.includes('\0')) return false;
  const normalized = path.posix.normalize(value);
  return normalized !== '..' && !normalized.startsWith('../');
};

const listJsonFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.json')) files.push(entryPath);
    }
  };
  try {
    await visit(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return files.sort((left, right) => left.localeCompare(right));
};

const readStrictJson = async (filePath: string): Promise<unknown> =>
  JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;

export const customCardDatabaseRoot = (projectRoot: string, sourceRoot?: string): string =>
  path.resolve(sourceRoot || path.join(resolveWorkspaceDataRoot(projectRoot), 'campaign', 'source'), CUSTOM_CARD_DATABASE_DIRECTORY);

export const customCardDatabaseExists = async (projectRoot: string, sourceRoot?: string): Promise<boolean> => {
  try {
    await fs.access(path.join(customCardDatabaseRoot(projectRoot, sourceRoot), 'manifest.json'));
    return true;
  } catch {
    return false;
  }
};

export const migrateCustomCardRecord = (value: unknown): { record?: CustomCardRecord; migratedFrom?: number; problem?: Problem } => {
  if (!isRecord(value)) return { problem: problem('CUSTOM_CARD_INVALID', 'Custom card record must be a JSON object') };
  if (value.schemaVersion === 1) return { record: value as unknown as CustomCardRecord };
  if (value.schemaVersion === 0 && Number.isInteger(value.id)) {
    const legacyExtensions = isRecord(value.custom) ? value.custom as JsonObject : {};
    const tags = Array.isArray(value.tags) ? value.tags.filter((entry): entry is string => typeof entry === 'string') : [];
    const record: CustomCardRecord = {
      schemaVersion: 1,
      cardId: value.id as number,
      revision: Number.isInteger(value.revision) ? value.revision as number : 1,
      ...(tags.length ? { searchTerms: tags } : {}),
      ...(Object.keys(legacyExtensions).length ? { extensions: { 'org.ygomastersolo.legacy/v1': cloneJson(legacyExtensions) } } : {}),
    };
    return { record, migratedFrom: 0 };
  }
  return { problem: problem('CUSTOM_CARD_SCHEMA_UNSUPPORTED', `Unsupported custom card schemaVersion ${String(value.schemaVersion)}`) };
};

const validateRecord = (
  value: unknown,
  filePath: string,
  runtimeIds: ReadonlySet<number> | undefined,
): { record?: CustomCardRecord; problems: Problem[]; warnings: Problem[] } => {
  const problems: Problem[] = [];
  const warnings: Problem[] = [];
  const migrated = migrateCustomCardRecord(value);
  if (migrated.problem || !migrated.record) return { problems: [{ ...(migrated.problem as Problem), path: filePath }], warnings };
  const record = migrated.record;
  if (migrated.migratedFrom !== undefined) warnings.push(problem('CUSTOM_CARD_MIGRATION_AVAILABLE', `Record can be migrated from schema v${migrated.migratedFrom} to v1`, filePath, 'warning'));
  if (!Number.isInteger(record.cardId) || record.cardId <= 0) problems.push(problem('CUSTOM_CARD_ID_INVALID', 'cardId must be a positive integer', filePath));
  else if (runtimeIds && !runtimeIds.has(record.cardId)) problems.push(problem('CUSTOM_CARD_ID_UNKNOWN', `cardId ${record.cardId} is not present in the YgoMaster catalog`, filePath));
  if (!Number.isInteger(record.revision) || record.revision <= 0) problems.push(problem('CUSTOM_CARD_REVISION_INVALID', 'revision must be a positive integer', filePath));
  if (record.operation !== undefined && record.operation !== 'merge' && record.operation !== 'tombstone') problems.push(problem('CUSTOM_CARD_OPERATION_INVALID', 'operation must be merge or tombstone', filePath));

  const reserved = ['id', 'ydkId', 'original', 'stats', 'autoTags', 'availability', 'names', 'texts'];
  reserved.filter((key) => key in record).forEach((key) => problems.push(problem('CUSTOM_CARD_RESERVED_FIELD', `Custom records cannot override base field ${key}`, filePath)));
  if (record.searchTerms && (!Array.isArray(record.searchTerms) || record.searchTerms.some((entry) => typeof entry !== 'string'))) problems.push(problem('CUSTOM_CARD_SEARCH_TERMS_INVALID', 'searchTerms must be strings', filePath));
  if (record.facets !== undefined && !isRecord(record.facets)) problems.push(problem('CUSTOM_CARD_FACETS_INVALID', 'facets must be an object', filePath));
  if (record.extensions !== undefined && !isRecord(record.extensions)) problems.push(problem('CUSTOM_CARD_EXTENSIONS_INVALID', 'extensions must be an object', filePath));
  if (record.extensions && isRecord(record.extensions)) {
    Object.keys(record.extensions).forEach((namespace) => {
      if (!/^[a-z0-9][a-z0-9.-]+\/[vV][1-9][0-9]*$/.test(namespace)) problems.push(problem('CUSTOM_CARD_NAMESPACE_INVALID', `Extension namespace must end in /vN: ${namespace}`, filePath));
    });
  }
  if (record.claims !== undefined && !Array.isArray(record.claims)) problems.push(problem('CUSTOM_CARD_CLAIMS_INVALID', 'claims must be an array', filePath));
  (Array.isArray(record.claims) ? record.claims : []).forEach((claim, index) => {
    if (!isRecord(claim) || typeof claim.path !== 'string' || !isRecord(claim.source) || typeof claim.source.kind !== 'string' || typeof claim.source.reference !== 'string') {
      problems.push(problem('CUSTOM_CARD_CLAIM_INVALID', `claims[${index}] requires path and source kind/reference`, filePath));
    }
    if (typeof claim.confidence === 'number' && (claim.confidence < 0 || claim.confidence > 1)) problems.push(problem('CUSTOM_CARD_CONFIDENCE_INVALID', `claims[${index}].confidence must be between 0 and 1`, filePath));
  });
  return { record, problems, warnings };
};

export const validateCustomCardDatabase = async (
  projectRoot: string,
  sourceRoot?: string,
  runtimeIds?: ReadonlySet<number>,
): Promise<OperationResult<CustomCardDatabaseReport>> => {
  const root = customCardDatabaseRoot(projectRoot, sourceRoot);
  const manifestPath = path.join(root, 'manifest.json');
  const problems: Problem[] = [];
  const warnings: Problem[] = [];
  let manifest: CustomCardDatabaseManifest;
  try {
    const value = await readStrictJson(manifestPath);
    if (!isRecord(value) || value.schemaVersion !== CUSTOM_CARD_DATABASE_SCHEMA_VERSION || !Number.isInteger(value.revision) || Number(value.revision) <= 0 || !Array.isArray(value.layers)) {
      throw new Error('manifest requires schemaVersion 1, positive revision, and layers');
    }
    manifest = value as unknown as CustomCardDatabaseManifest;
  } catch (error) {
    return failure([problem('CUSTOM_CARD_MANIFEST_INVALID', String(error), manifestPath)]);
  }

  const layerIds = new Set<string>();
  const priorities = new Set<number>();
  manifest.layers.forEach((layer, index) => {
    if (!layer || typeof layer.id !== 'string' || !layer.id.trim() || !Number.isInteger(layer.priority) || (layer.kind !== 'generated' && layer.kind !== 'reviewed') || typeof layer.directory !== 'string' || !safeRelativeDirectory(layer.directory)) {
      problems.push(problem('CUSTOM_CARD_LAYER_INVALID', `Invalid layer at index ${index}`, manifestPath));
      return;
    }
    if (layerIds.has(layer.id)) problems.push(problem('CUSTOM_CARD_LAYER_DUPLICATE', `Duplicate layer id ${layer.id}`, manifestPath));
    if (priorities.has(layer.priority)) problems.push(problem('CUSTOM_CARD_LAYER_PRIORITY_CONFLICT', `Duplicate layer priority ${layer.priority}`, manifestPath));
    layerIds.add(layer.id);
    priorities.add(layer.priority);
  });

  const materialized = new Map<number, MaterializedCustomCard>();
  const files: string[] = [];
  let sourceRecordCount = 0;
  for (const layer of [...manifest.layers].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))) {
    if (!safeRelativeDirectory(layer.directory)) continue;
    const layerRoot = path.resolve(root, ...path.posix.normalize(layer.directory).split('/'));
    if (layerRoot !== root && !layerRoot.startsWith(`${root}${path.sep}`)) {
      problems.push(problem('CUSTOM_CARD_LAYER_PATH_ESCAPE', `Layer ${layer.id} escapes the card database root`, manifestPath));
      continue;
    }
    const layerFiles = await listJsonFiles(layerRoot);
    const seenInLayer = new Set<number>();
    for (const filePath of layerFiles) {
      files.push(path.relative(root, filePath).split(path.sep).join('/'));
      sourceRecordCount += 1;
      let value: unknown;
      try {
        value = await readStrictJson(filePath);
      } catch (error) {
        problems.push(problem('CUSTOM_CARD_JSON_INVALID', String(error), filePath));
        continue;
      }
      const checked = validateRecord(value, filePath, runtimeIds);
      problems.push(...checked.problems);
      warnings.push(...checked.warnings);
      const record = checked.record;
      if (!record || checked.problems.length) continue;
      if (seenInLayer.has(record.cardId)) {
        problems.push(problem('CUSTOM_CARD_LAYER_CARD_DUPLICATE', `Layer ${layer.id} contains cardId ${record.cardId} more than once`, filePath));
        continue;
      }
      seenInLayer.add(record.cardId);
      if (record.operation === 'tombstone') {
        materialized.delete(record.cardId);
        continue;
      }
      const current = materialized.get(record.cardId) || {
        cardId: record.cardId,
        searchTerms: [],
        facets: {},
        extensions: {},
        claims: [],
        appliedLayers: [],
      };
      materialized.set(record.cardId, {
        cardId: record.cardId,
        searchTerms: [...new Set([...current.searchTerms, ...(record.searchTerms || [])])].sort(),
        facets: deepMerge(current.facets, record.facets || {}),
        extensions: deepMerge(current.extensions, record.extensions || {}),
        claims: [...current.claims, ...(record.claims || []).map((claim) => cloneJson(claim))],
        appliedLayers: [...current.appliedLayers, layer.id],
      });
    }
  }

  const report: CustomCardDatabaseReport = {
    root,
    manifest,
    files: files.sort(),
    sourceRecordCount,
    materializedCards: [...materialized.values()].sort((left, right) => left.cardId - right.cardId),
    errorCount: problems.length,
    warningCount: warnings.length,
  };
  return problems.length ? failure(problems, 'COMMAND_FAILED', warnings) : result(report, warnings);
};
