export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ExitName =
  | 'SUCCESS'
  | 'COMMAND_FAILED'
  | 'USAGE_ERROR'
  | 'PATH_ERROR'
  | 'INTERNAL_ERROR';

export const EXIT_CODES: Record<ExitName, number> = {
  SUCCESS: 0,
  COMMAND_FAILED: 1,
  USAGE_ERROR: 2,
  PATH_ERROR: 3,
  INTERNAL_ERROR: 4,
};

export interface Problem {
  code: string;
  message: string;
  path?: string;
  severity?: 'error' | 'warning';
}

export interface OperationResult<T = unknown> {
  ok: boolean;
  exitCode: number;
  exitName: ExitName;
  warnings: Problem[];
  problems: Problem[];
  data?: T;
}

export interface CoreLogger {
  info?: (...values: unknown[]) => void;
  warn?: (...values: unknown[]) => void;
  error?: (...values: unknown[]) => void;
}

export interface SourceManifest {
  formatVersion: number;
  campaign?: {
    name?: string;
    slug?: string;
    version?: string;
  };
  campaignId?: string;
  upstreamDocumentationRevision?: string;
  directories?: {
    gate?: string;
    deck?: string;
    structure?: string;
    overlay?: string;
    assets?: string;
  };
  authoring?: { language?: string };
  idPolicy?: { gatePrefix?: number; structurePrefix?: number };
  runtime?: {
    repository?: string;
    channel?: string;
    autoDownload?: boolean;
  };
  overlays?: string[];
  assets?: string[];
  [key: string]: JsonValue | undefined;
}

export type DocumentType = 'gate' | 'deck' | 'structure';

export interface ProjectConfig {
  gameRoot?: string;
  sourceRoot?: string;
}

export interface WorkspacePaths {
  projectRoot: string;
  sourceRoot: string;
  gateRoot: string;
  deckRoot: string;
  structureRoot: string;
  overlayRoot: string;
  assetsRoot: string;
  trashRoot: string;
}

export interface WorkspaceInspect {
  manifest: SourceManifest;
  sourceRoot: string;
  counts: Record<DocumentType, number>;
  paths: Pick<WorkspacePaths, 'gateRoot' | 'deckRoot' | 'structureRoot' | 'overlayRoot'>;
}

export interface PayloadSource<T extends object = JsonObject> {
  document: JsonObject;
  payloadKey: string;
  payload: T;
  shape: 'raw' | 'wrapped';
}

export interface ValidationReport {
  sourceRoot: string;
  files: string[];
  errorCount: number;
  warningCount: number;
}

export interface RuntimeRelease {
  tag: string;
  assetName: string;
  assetUrl: string;
  publishedAt?: string;
}

export interface RuntimeCacheEntry {
  tag: string;
  assetName: string;
  assetUrl: string;
  archivePath: string;
  runtimePath: string;
  valid: boolean;
  downloadedAt?: string;
}

export interface RuntimeStatus {
  cacheRoot: string;
  entries: RuntimeCacheEntry[];
}

export interface RuntimeTransport {
  getJson(url: string): Promise<unknown>;
  getBytes(url: string): Promise<Uint8Array>;
}

/**
 * A display-only card catalog. `id` is always the YgoMaster runtime ID; the
 * YDK/passcode bridge and the original language records are retained for
 * inspection, while generated search tags live separately in `autoTags`.
 */
export interface CatalogSourceRecord {
  id: number;
  name?: string;
  desc?: string;
  type?: number;
  attribute?: number;
  race?: number;
  level?: number;
  rank?: number;
  link?: number;
  scale?: number;
  atk?: number;
  def?: number;
  [key: string]: JsonValue | undefined;
}

export interface CatalogCard {
  /** YgoMaster's ID, never the external/YDK ID. */
  id: number;
  ydkId: number;
  names: {
    korean?: string;
    english?: string;
    display: string;
  };
  texts: {
    korean?: string;
    english?: string;
    display?: string;
  };
  /** Original display source records; never mixed with generated tags. */
  original: {
    korean?: CatalogSourceRecord;
    english?: CatalogSourceRecord;
  };
  stats: {
    type?: number;
    attribute?: number;
    race?: number;
    level?: number;
    rank?: number;
    link?: number;
    scale?: number;
    atk?: number;
    def?: number;
  };
  /** Deterministic tags generated from type/stats/text. */
  autoTags: string[];
  /** Availability/rarity value copied from YgoMaster CardList.json. */
  availability?: number;
}

export interface CatalogSourceDefinition {
  id: 'korean' | 'english' | string;
  language: 'korean' | 'english';
  url: string;
  /** JSON is useful for fixtures; sqlite is the normal cards.cdb format. */
  format?: 'sqlite' | 'json';
  revision?: string;
}

export interface CatalogTransport {
  getBytes(url: string): Promise<Uint8Array>;
  getText?(url: string): Promise<string>;
  /** Optional response metadata such as ETag or Last-Modified. */
  getBytesWithMetadata?(url: string): Promise<{ bytes: Uint8Array; revision?: string }>;
}

export interface CatalogCacheMetadata {
  schemaVersion: 1;
  generatedAt: string;
  cardCount: number;
  matchedRuntimeIdCount: number;
  missingRuntimeIds: number[];
  sources: Array<{
    id: string;
    language: 'korean' | 'english';
    url: string;
    format: 'sqlite' | 'json';
    path: string;
    usedFrom: 'local' | 'download';
    revision?: string;
    fetchedAt: string;
    recordCount: number;
  }>;
  ygoMaster: {
    runtimeTag?: string;
    cardListPath?: string;
    ydkIdsPath?: string;
    runtimeIdCount: number;
    bridgeCount: number;
  };
}

export interface CatalogStatus {
  cacheRoot: string;
  catalogPath: string;
  metadataPath: string;
  sourcePaths: Partial<Record<'korean' | 'english', string>>;
  valid: boolean;
  metadata?: CatalogCacheMetadata;
  cardCount: number;
  missingRuntimeIdCount: number;
  lastUpdated?: string;
}

export interface CatalogRefreshResult {
  status: CatalogStatus;
  cacheHit: boolean;
  sourceUsage: Partial<Record<'korean' | 'english', 'local' | 'download'>>;
  cards: CatalogCard[];
}

export interface CatalogSearchResult {
  query: string;
  total: number;
  cards: CatalogCard[];
}

export interface RuntimeEnsureResult {
  entry: RuntimeCacheEntry;
  cacheHit: boolean;
}

export interface DeploymentMetadata {
  campaign: {
    name: string;
    slug: string;
    version: string;
  };
  deployedAt: string;
  resolvedRuntimeTag: string;
  runtimeAsset: {
    name: string;
    url: string;
  };
  moddingToolVersion: string;
  contractVersion: number;
}

export interface DeploymentSummary {
  path: string;
  metadata: DeploymentMetadata;
}

export const result = <T>(
  data: T,
  warnings: Problem[] = [],
): OperationResult<T> => ({
  ok: true,
  exitCode: EXIT_CODES.SUCCESS,
  exitName: 'SUCCESS',
  warnings,
  problems: [],
  data,
});

export const failure = <T = never>(
  problems: Problem[],
  exitName: ExitName = 'COMMAND_FAILED',
  warnings: Problem[] = [],
): OperationResult<T> => ({
  ok: false,
  exitCode: EXIT_CODES[exitName],
  exitName,
  warnings,
  problems,
});

export const problem = (
  code: string,
  message: string,
  path?: string,
  severity: 'error' | 'warning' = 'error',
): Problem => ({ code, message, ...(path ? { path } : {}), severity });
