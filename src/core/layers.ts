import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertRealPathInside,
  atomicWriteJson,
  ensureDirectory,
  exists,
  readJsonFile,
  resolveSafeInside,
} from './fs';
import { Problem, problem } from './types';

/**
 * The four logical layers are intentionally different from the existing
 * Modding Tool document types.  `source` is the compatibility path for the
 * compiler-owned IR; it is not another authored source.
 */
export type LayerId = 'design' | 'content' | 'ir' | 'generated';

export type LayerInputId = LayerId | 'source-legacy' | 'deploy' | 'external';

export type LayerPersistence = 'persistent' | 'managed' | 'disposable';

export type LayerRegeneration = 'never' | 'from-content' | 'from-ir';

export interface LayerContract {
  id: LayerId;
  /** Relative project path used by the default workspace layout. */
  path: string;
  role: 'intent' | 'authored-source' | 'managed-projection' | 'disposable-output';
  writeOwner: 'human-agent' | 'author' | 'compiler' | 'pipeline';
  /** `persistent` is authored, `managed` is persisted but compiler-owned. */
  persistence: LayerPersistence;
  persisted: boolean;
  regeneration: LayerRegeneration;
  sourceOfTruth: boolean;
  /** Layer ids and external roots which must not be used as this layer input. */
  forbiddenInputs: readonly LayerInputId[];
  /** The layer inputs allowed by the contract (services are external inputs). */
  allowedInputs: readonly LayerInputId[];
}

const layerContracts: Record<LayerId, LayerContract> = {
  design: {
    id: 'design',
    path: 'campaign/design',
    role: 'intent',
    writeOwner: 'human-agent',
    persistence: 'persistent',
    persisted: true,
    regeneration: 'never',
    sourceOfTruth: false,
    forbiddenInputs: ['ir', 'generated', 'source-legacy', 'deploy'],
    allowedInputs: ['design', 'external'],
  },
  content: {
    id: 'content',
    path: 'campaign/content',
    role: 'authored-source',
    writeOwner: 'author',
    persistence: 'persistent',
    persisted: true,
    regeneration: 'never',
    sourceOfTruth: true,
    forbiddenInputs: ['ir', 'generated', 'source-legacy', 'deploy'],
    allowedInputs: ['design', 'content', 'external'],
  },
  ir: {
    id: 'ir',
    path: 'campaign/source',
    role: 'managed-projection',
    writeOwner: 'compiler',
    persistence: 'managed',
    persisted: true,
    regeneration: 'from-content',
    sourceOfTruth: false,
    forbiddenInputs: ['design', 'ir', 'generated', 'source-legacy', 'deploy'],
    allowedInputs: ['content', 'external'],
  },
  generated: {
    id: 'generated',
    path: 'campaign/generated',
    role: 'disposable-output',
    writeOwner: 'pipeline',
    persistence: 'disposable',
    persisted: false,
    regeneration: 'from-ir',
    sourceOfTruth: false,
    forbiddenInputs: ['design', 'content', 'generated', 'source-legacy', 'deploy'],
    allowedInputs: ['ir', 'external'],
  },
};

/** Immutable-by-convention public view of the four layer contracts. */
export const LAYER_CONTRACTS: Readonly<Record<LayerId, LayerContract>> = layerContracts;

/** Alias kept short for callers which use the contract as a data table. */
export const layerContract = LAYER_CONTRACTS;

export const getLayerContract = (layer: LayerId): LayerContract => {
  const contract = LAYER_CONTRACTS[layer];
  if (!contract) throw new LayerContractError([problem('LAYER_UNKNOWN', `Unknown layer: ${String(layer)}`)]);
  return contract;
};

export const isForbiddenLayerInput = (target: LayerId, input: LayerInputId): boolean =>
  getLayerContract(target).forbiddenInputs.includes(input);

export const canUseLayerInput = (target: LayerId, input: LayerInputId): boolean =>
  getLayerContract(target).allowedInputs.includes(input) && !isForbiddenLayerInput(target, input);

export const validateLayerInput = (
  target: LayerId,
  input: LayerInputId,
  sourcePath?: string,
): Problem[] =>
  canUseLayerInput(target, input)
    ? []
    : [problem(
        'LAYER_INPUT_FORBIDDEN',
        `${input} is not an allowed input for the ${target} layer`,
        sourcePath,
      )];

export const assertLayerInputAllowed = (
  target: LayerId,
  input: LayerInputId,
  sourcePath?: string,
): void => {
  const problems = validateLayerInput(target, input, sourcePath);
  if (problems.length) throw new LayerContractError(problems);
};

export interface LayerPathOverrides {
  design?: string;
  content?: string;
  ir?: string;
  generated?: string;
  /** Reference-only legacy root; it is never an active compiler input. */
  legacy?: string;
  designRoot?: string;
  contentRoot?: string;
  irRoot?: string;
  generatedRoot?: string;
  legacyRoot?: string;
}

export interface WorkspaceLayerPaths {
  projectRoot: string;
  campaignRoot: string;
  designRoot: string;
  contentRoot: string;
  irRoot: string;
  generatedRoot: string;
  legacyRoot: string;
  /** Short aliases make the path map convenient for pure core callers. */
  design: string;
  content: string;
  ir: string;
  generated: string;
  legacy: string;
}

export const DEFAULT_LAYER_PATHS = Object.freeze({
  design: 'campaign/design',
  content: 'campaign/content',
  ir: 'campaign/source',
  generated: 'campaign/generated',
  legacy: 'campaign/source-legacy',
});

const layerIds = ['design', 'content', 'ir', 'generated'] as const;
const allPathIds = [...layerIds, 'legacy'] as const;

const pathWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

/** Lexical containment check; use `validateLayerPathsOnDisk` for symlink checks. */
export const isPathContained = pathWithin;

export const pathsOverlap = (left: string, right: string): boolean =>
  pathWithin(left, right) || pathWithin(right, left);

const overrideFor = (overrides: LayerPathOverrides, id: keyof typeof DEFAULT_LAYER_PATHS): unknown => {
  const rootKey = `${id}Root` as keyof LayerPathOverrides;
  const directKey = id as keyof LayerPathOverrides;
  if (Object.prototype.hasOwnProperty.call(overrides, rootKey)) return overrides[rootKey];
  if (Object.prototype.hasOwnProperty.call(overrides, directKey)) return overrides[directKey];
  return DEFAULT_LAYER_PATHS[id];
};

interface ComputedLayerPaths {
  paths: WorkspaceLayerPaths;
  roots: Record<(typeof allPathIds)[number], string>;
  problems: Problem[];
}

const configuredPath = (
  projectRoot: string,
  id: (typeof allPathIds)[number],
  value: unknown,
): { root?: string; problems: Problem[] } => {
  const problems: Problem[] = [];
  const pathName = `layers.${id}`;
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    problems.push(problem('LAYER_PATH_INVALID', `${id} path must be a non-empty path`, pathName));
    return { problems };
  }

  const absolute = path.isAbsolute(value);
  if (!absolute && value.includes('\\')) {
    problems.push(problem('LAYER_PATH_INVALID', `${id} path must use POSIX separators`, pathName));
    return { problems };
  }

  const segments = value.replaceAll('\\', '/').split('/');
  if (!absolute && segments.some((segment) => segment === '..' || segment === '.')) {
    problems.push(problem('LAYER_PATH_ESCAPE', `${id} path contains a traversal segment`, pathName));
    return { problems };
  }

  const root = path.resolve(absolute ? value : path.join(projectRoot, ...segments));
  if (!pathWithin(projectRoot, root)) {
    problems.push(problem('LAYER_PATH_ESCAPE', `${id} path escapes the project root`, pathName));
    return { problems };
  }
  return { root, problems };
};

const computeLayerPaths = (projectRootInput: string, overrides: LayerPathOverrides = {}): ComputedLayerPaths => {
  const projectRoot = path.resolve(projectRootInput);
  const problems: Problem[] = [];
  const roots = {} as Record<(typeof allPathIds)[number], string>;
  for (const id of allPathIds) {
    const configured = configuredPath(projectRoot, id, overrideFor(overrides, id));
    problems.push(...configured.problems);
    roots[id] = configured.root || path.resolve(projectRoot, DEFAULT_LAYER_PATHS[id]);
  }

  for (let leftIndex = 0; leftIndex < allPathIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < allPathIds.length; rightIndex += 1) {
      const left = allPathIds[leftIndex];
      const right = allPathIds[rightIndex];
      if (pathsOverlap(roots[left], roots[right])) {
        problems.push(problem(
          'LAYER_PATH_OVERLAP',
          `${left} and ${right} layer paths must not be equal or nested`,
          `layers.${left},layers.${right}`,
        ));
      }
    }
  }

  const paths: WorkspaceLayerPaths = {
    projectRoot,
    campaignRoot: path.resolve(projectRoot, 'campaign'),
    designRoot: roots.design,
    contentRoot: roots.content,
    irRoot: roots.ir,
    generatedRoot: roots.generated,
    legacyRoot: roots.legacy,
    design: roots.design,
    content: roots.content,
    ir: roots.ir,
    generated: roots.generated,
    legacy: roots.legacy,
  };
  return { paths, roots, problems };
};

export const validateLayerPaths = (
  projectRoot: string,
  overrides: LayerPathOverrides = {},
): Problem[] => computeLayerPaths(projectRoot, overrides).problems;

export const resolveLayerPaths = (
  projectRoot: string,
  overrides: LayerPathOverrides = {},
): WorkspaceLayerPaths => {
  const computed = computeLayerPaths(projectRoot, overrides);
  if (computed.problems.length) throw new LayerContractError(computed.problems);
  return computed.paths;
};

export const assertLayerPaths = resolveLayerPaths;

/** Check both lexical containment and existing symlink parents. */
export const validateLayerPathsOnDisk = async (
  projectRoot: string,
  overrides: LayerPathOverrides = {},
): Promise<Problem[]> => {
  const computed = computeLayerPaths(projectRoot, overrides);
  if (computed.problems.length) return computed.problems;
  const problems: Problem[] = [];
  const realRoots = new Map<string, string>();
  for (const id of allPathIds) {
    try {
      await assertRealPathInside(computed.paths.projectRoot, computed.roots[id]);
      try {
        realRoots.set(id, await fs.realpath(computed.roots[id]));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    } catch (error) {
      problems.push(problem('LAYER_PATH_SYMLINK_ESCAPE', String(error), `layers.${id}`));
    }
  }
  for (let leftIndex = 0; leftIndex < allPathIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < allPathIds.length; rightIndex += 1) {
      const left = allPathIds[leftIndex];
      const right = allPathIds[rightIndex];
      const leftRoot = realRoots.get(left);
      const rightRoot = realRoots.get(right);
      if (leftRoot && rightRoot && pathsOverlap(leftRoot, rightRoot)) {
        problems.push(problem(
          'LAYER_PATH_OVERLAP',
          `${left} and ${right} layer paths resolve to equal or nested directories`,
          `layers.${left},layers.${right}`,
        ));
      }
    }
  }
  return problems;
};

export const LAYER_MANIFEST_VERSION = 1 as const;
export const CONTENT_MANIFEST_FILE = 'manifest.json';
export const IR_GENERATION_METADATA_FILE = 'generation.json';
export const YGOMASTER_TARGET_CONTRACT_VERSION = 'ygomaster-campaign-target/v2' as const;

export interface ContentManifest {
  formatVersion: typeof LAYER_MANIFEST_VERSION;
  layer: 'content';
  campaign: {
    name: string;
    slug: string;
    version: string;
  };
  /** Content directories are relative to the content root. */
  directories?: {
    gates?: string;
    chapters?: string;
    decks?: string;
    shop?: string;
    structures?: string;
    regulations?: string;
    localization?: string;
    assets?: string;
    target?: string;
  };
  sourceOfTruth: true;
  [key: string]: unknown;
}

export const CONTENT_DIRECTORY_DEFAULTS = Object.freeze({
  gates: 'gates',
  chapters: 'chapters',
  decks: 'decks',
  shop: 'shop',
  structures: 'structures',
  regulations: 'regulations',
  localization: 'localization',
  assets: 'assets',
  target: 'target/ygomaster',
});

export const defaultContentManifest = (): ContentManifest => ({
  formatVersion: LAYER_MANIFEST_VERSION,
  layer: 'content',
  campaign: {
    name: 'Chronicle Progression',
    slug: 'chronicle-progression',
    version: '0.1.0',
  },
  directories: { ...CONTENT_DIRECTORY_DEFAULTS },
  sourceOfTruth: true,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const safeManifestRelativePath = (value: unknown): boolean => {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || value.includes('\0')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
};

export const validateContentManifest = (value: unknown): Problem[] => {
  const problems: Problem[] = [];
  if (!isRecord(value)) return [problem('CONTENT_MANIFEST_INVALID', 'Content manifest must be an object', CONTENT_MANIFEST_FILE)];

  if (value.formatVersion !== LAYER_MANIFEST_VERSION) {
    problems.push(problem(
      value.formatVersion !== undefined && typeof value.formatVersion === 'number' && value.formatVersion > LAYER_MANIFEST_VERSION
        ? 'CONTENT_MANIFEST_FUTURE_VERSION'
        : 'CONTENT_MANIFEST_VERSION_INVALID',
      `Content manifest formatVersion must be ${LAYER_MANIFEST_VERSION}`,
      `${CONTENT_MANIFEST_FILE}:formatVersion`,
    ));
  }
  if (value.layer !== 'content') {
    problems.push(problem('CONTENT_MANIFEST_LAYER_INVALID', 'Content manifest layer must be "content"', `${CONTENT_MANIFEST_FILE}:layer`));
  }
  if (!isRecord(value.campaign) || !requiredString(value.campaign.name) || !requiredString(value.campaign.slug) || !requiredString(value.campaign.version)) {
    problems.push(problem(
      'CONTENT_MANIFEST_CAMPAIGN_INVALID',
      'Content manifest campaign.name, campaign.slug, and campaign.version are required',
      `${CONTENT_MANIFEST_FILE}:campaign`,
    ));
  }
  if (value.sourceOfTruth !== true) {
    problems.push(problem('CONTENT_MANIFEST_AUTHORITY_INVALID', 'Content manifest sourceOfTruth must be true', `${CONTENT_MANIFEST_FILE}:sourceOfTruth`));
  }

  if (value.directories !== undefined) {
    if (!isRecord(value.directories)) {
      problems.push(problem('CONTENT_MANIFEST_DIRECTORIES_INVALID', 'Content manifest directories must be an object', `${CONTENT_MANIFEST_FILE}:directories`));
    } else {
      for (const [key, directory] of Object.entries(value.directories)) {
        if (!safeManifestRelativePath(directory)) {
          problems.push(problem(
            'CONTENT_MANIFEST_PATH_INVALID',
            `Content directory ${key} must be a safe relative POSIX path`,
            `${CONTENT_MANIFEST_FILE}:directories.${key}`,
          ));
        }
      }
    }
  }
  return problems;
};

export const parseContentManifest = (value: unknown): ContentManifest => {
  const problems = validateContentManifest(value);
  if (problems.length) throw new LayerContractError(problems);
  return value as ContentManifest;
};

export const loadContentManifest = async (contentRoot: string): Promise<ContentManifest> => {
  const filePath = await resolveSafeInside(contentRoot, CONTENT_MANIFEST_FILE);
  if (!(await exists(filePath))) throw new LayerContractError([problem('CONTENT_MANIFEST_MISSING', `Required content manifest is missing: ${filePath}`, CONTENT_MANIFEST_FILE)]);
  return parseContentManifest(await readJsonFile<unknown>(filePath));
};

export const readContentManifest = loadContentManifest;
export const loadLayerManifest = loadContentManifest;

export const writeContentManifest = async (
  contentRoot: string,
  manifest: ContentManifest,
  replace = false,
): Promise<string> => {
  const parsed = parseContentManifest(manifest);
  const filePath = await resolveSafeInside(contentRoot, CONTENT_MANIFEST_FILE);
  await atomicWriteJson(filePath, parsed, replace);
  return filePath;
};

export interface LayerState {
  id: LayerId;
  root: string;
  exists: boolean;
  directory: boolean;
  contract: LayerContract;
}

export interface LayeredWorkspaceInspection {
  projectRoot: string;
  paths: WorkspaceLayerPaths;
  layers: Record<LayerId, LayerState>;
  manifest?: ContentManifest;
  problems: Problem[];
}

const inspectRoot = async (root: string): Promise<{ exists: boolean; directory: boolean }> => {
  try {
    const stats = await fs.stat(root);
    return { exists: true, directory: stats.isDirectory() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, directory: false };
    throw error;
  }
};

const contentDirectoryPaths = (contentRoot: string, manifest: ContentManifest): string[] => {
  const directories = { ...CONTENT_DIRECTORY_DEFAULTS, ...(manifest.directories || {}) };
  const paths = Object.values(directories).map((directory) => path.resolve(contentRoot, ...directory.split('/')));
  const shopRoot = path.resolve(contentRoot, ...(directories.shop || 'shop').split('/'));
  paths.push(path.join(shopRoot, 'packs'), path.join(shopRoot, 'pools'), path.join(shopRoot, 'odds'));
  return paths;
};

export const inspectLayeredWorkspace = async (
  projectRoot: string,
  overrides: LayerPathOverrides = {},
): Promise<LayeredWorkspaceInspection> => {
  const computed = computeLayerPaths(projectRoot, overrides);
  const layerState = {} as Record<LayerId, LayerState>;
  const problems = [...computed.problems];
  if (!computed.problems.length) problems.push(...await validateLayerPathsOnDisk(projectRoot, overrides));
  for (const id of layerIds) {
    const status = await inspectRoot(computed.roots[id]);
    if (status.exists && !status.directory) {
      problems.push(problem('LAYER_ROOT_NOT_DIRECTORY', `${id} layer root is not a directory`, `layers.${id}`));
    }
    layerState[id] = {
      id,
      root: computed.roots[id],
      exists: status.exists,
      directory: status.directory,
      contract: getLayerContract(id),
    };
  }

  let manifest: ContentManifest | undefined;
  const manifestPath = path.join(computed.paths.contentRoot, CONTENT_MANIFEST_FILE);
  const unsafePath = problems.some((entry) => entry.code === 'LAYER_PATH_SYMLINK_ESCAPE');
  if (await exists(manifestPath) && !unsafePath) {
    try {
      manifest = await loadContentManifest(computed.paths.contentRoot);
    } catch (error) {
      if (error instanceof LayerContractError) problems.push(...error.problems);
      else problems.push(problem('CONTENT_MANIFEST_READ_FAILED', String(error), CONTENT_MANIFEST_FILE));
    }
  } else {
    problems.push(problem('CONTENT_MANIFEST_MISSING', `Required content manifest is missing: ${manifestPath}`, CONTENT_MANIFEST_FILE));
  }

  return { projectRoot: computed.paths.projectRoot, paths: computed.paths, layers: layerState, manifest, problems };
};

export const inspectWorkspaceLayers = inspectLayeredWorkspace;

export interface InitializeLayeredWorkspaceOptions {
  manifest?: ContentManifest;
  replaceManifest?: boolean;
  /** Source/legacy are never copied, moved, or removed by initialization. */
  createManagedRoots?: boolean;
}

export const initializeLayeredWorkspace = async (
  projectRoot: string,
  overrides: LayerPathOverrides = {},
  options: InitializeLayeredWorkspaceOptions = {},
): Promise<{ paths: WorkspaceLayerPaths; manifest: ContentManifest }> => {
  const paths = resolveLayerPaths(projectRoot, overrides);
  const diskProblems = await validateLayerPathsOnDisk(projectRoot, overrides);
  if (diskProblems.length) throw new LayerContractError(diskProblems);

  const manifest = options.manifest ? parseContentManifest(options.manifest) : defaultContentManifest();
  await ensureDirectory(paths.designRoot);
  await ensureDirectory(paths.contentRoot);
  if (options.createManagedRoots !== false) {
    await ensureDirectory(paths.irRoot);
    await ensureDirectory(paths.generatedRoot);
  }

  const manifestPath = path.join(paths.contentRoot, CONTENT_MANIFEST_FILE);
  let activeManifest: ContentManifest;
  if (await exists(manifestPath)) {
    const existing = await loadContentManifest(paths.contentRoot);
    if (options.replaceManifest) {
      await writeContentManifest(paths.contentRoot, manifest, true);
      activeManifest = manifest;
    } else {
      activeManifest = existing;
    }
  } else {
    await writeContentManifest(paths.contentRoot, manifest, false);
    activeManifest = manifest;
  }

  const directories = contentDirectoryPaths(paths.contentRoot, activeManifest);
  await Promise.all(directories.map(ensureDirectory));
  return { paths, manifest: activeManifest };
};

export const initLayeredWorkspace = initializeLayeredWorkspace;

export const initializeContentWorkspace = async (
  projectRoot: string,
  contentRoot?: string,
  manifest?: ContentManifest,
): Promise<{ paths: WorkspaceLayerPaths; manifest: ContentManifest }> => initializeLayeredWorkspace(
  projectRoot,
  contentRoot ? { content: contentRoot } : {},
  manifest ? { manifest } : {},
);

export const validateLayeredWorkspace = async (
  projectRoot: string,
  overrides: LayerPathOverrides = {},
): Promise<Problem[]> => (await inspectLayeredWorkspace(projectRoot, overrides)).problems;

export const defaultLayerManifest = defaultContentManifest;
export const parseLayerManifest = parseContentManifest;
export const validateLayerManifest = validateContentManifest;

export interface IRGenerationMetadata {
  schemaVersion: typeof LAYER_MANIFEST_VERSION;
  contentGeneration: string;
  compilerVersion: string;
  catalogGeneration: string;
  /** The lock generation used to turn symbolic ids into target ids. */
  idLockGeneration?: string;
  /** Compatibility spelling used by the ID registry ticket. */
  idRegistryGeneration?: string;
  targetContractVersion: string;
  generatedAt?: string;
  sourceManifestVersion?: number;
  [key: string]: unknown;
}

export type IrGenerationMetadata = IRGenerationMetadata;

export interface IRGenerationMetadataInput {
  contentGeneration: string;
  compilerVersion: string;
  catalogGeneration: string;
  idLockGeneration?: string;
  idRegistryGeneration?: string;
  targetContractVersion?: string;
  generatedAt?: string;
  sourceManifestVersion?: number;
}

const metadataString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export const validateIrGenerationMetadata = (value: unknown, sourcePath = IR_GENERATION_METADATA_FILE): Problem[] => {
  const problems: Problem[] = [];
  if (!isRecord(value)) return [problem('IR_GENERATION_METADATA_INVALID', 'IR generation metadata must be an object', sourcePath)];
  if (value.schemaVersion !== LAYER_MANIFEST_VERSION) {
    problems.push(problem(
      value.schemaVersion !== undefined && typeof value.schemaVersion === 'number' && value.schemaVersion > LAYER_MANIFEST_VERSION
        ? 'IR_GENERATION_METADATA_FUTURE_VERSION'
        : 'IR_GENERATION_METADATA_VERSION_INVALID',
      `IR generation metadata schemaVersion must be ${LAYER_MANIFEST_VERSION}`,
      `${sourcePath}:schemaVersion`,
    ));
  }
  for (const key of ['contentGeneration', 'compilerVersion', 'catalogGeneration'] as const) {
    if (!metadataString(value[key])) problems.push(problem('IR_GENERATION_METADATA_FIELD_MISSING', `${key} is required`, `${sourcePath}:${key}`));
  }
  if (!metadataString(value.idLockGeneration) && !metadataString(value.idRegistryGeneration)) {
    problems.push(problem('IR_GENERATION_METADATA_ID_LOCK_MISSING', 'idLockGeneration or idRegistryGeneration is required', `${sourcePath}:idLockGeneration`));
  }
  if (metadataString(value.idLockGeneration) && metadataString(value.idRegistryGeneration)
    && value.idLockGeneration !== value.idRegistryGeneration) {
    problems.push(problem(
      'IR_GENERATION_METADATA_ID_GENERATION_CONFLICT',
      'idLockGeneration and idRegistryGeneration must match when both are present',
      `${sourcePath}:idRegistryGeneration`,
    ));
  }
  if (value.targetContractVersion !== YGOMASTER_TARGET_CONTRACT_VERSION) {
    problems.push(problem('IR_GENERATION_METADATA_TARGET_VERSION_INVALID', `targetContractVersion must be ${YGOMASTER_TARGET_CONTRACT_VERSION}`, `${sourcePath}:targetContractVersion`));
  }
  if (value.generatedAt !== undefined && (!metadataString(value.generatedAt) || Number.isNaN(Date.parse(value.generatedAt)))) {
    problems.push(problem('IR_GENERATION_METADATA_TIMESTAMP_INVALID', 'generatedAt must be a valid timestamp', `${sourcePath}:generatedAt`));
  }
  if (value.sourceManifestVersion !== undefined && (!Number.isInteger(value.sourceManifestVersion) || (value.sourceManifestVersion as number) < 1)) {
    problems.push(problem('IR_GENERATION_METADATA_SOURCE_VERSION_INVALID', 'sourceManifestVersion must be a positive integer', `${sourcePath}:sourceManifestVersion`));
  }
  return problems;
};

export const createIrGenerationMetadata = (input: IRGenerationMetadataInput): IRGenerationMetadata => {
  const idLockGeneration = input.idLockGeneration || input.idRegistryGeneration;
  const metadata: IRGenerationMetadata = {
    schemaVersion: LAYER_MANIFEST_VERSION,
    contentGeneration: input.contentGeneration,
    compilerVersion: input.compilerVersion,
    catalogGeneration: input.catalogGeneration,
    ...(idLockGeneration ? { idLockGeneration } : {}),
    ...(input.idRegistryGeneration ? { idRegistryGeneration: input.idRegistryGeneration } : {}),
    targetContractVersion: input.targetContractVersion ?? YGOMASTER_TARGET_CONTRACT_VERSION,
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
    ...(input.sourceManifestVersion !== undefined ? { sourceManifestVersion: input.sourceManifestVersion } : {}),
  };
  const problems = validateIrGenerationMetadata(metadata);
  if (problems.length) throw new LayerContractError(problems);
  return metadata;
};

export const createIRGenerationMetadata = createIrGenerationMetadata;

export const parseIrGenerationMetadata = (value: unknown): IRGenerationMetadata => {
  const problems = validateIrGenerationMetadata(value);
  if (problems.length) throw new LayerContractError(problems);
  return value as IRGenerationMetadata;
};

export const parseIRGenerationMetadata = parseIrGenerationMetadata;
export const createGenerationMetadata = createIrGenerationMetadata;
export const parseGenerationMetadata = parseIrGenerationMetadata;
export const validateGenerationMetadata = validateIrGenerationMetadata;

export const readIrGenerationMetadata = async (
  irRoot: string,
  fileName = IR_GENERATION_METADATA_FILE,
): Promise<IRGenerationMetadata> => {
  const filePath = await resolveSafeInside(irRoot, fileName);
  if (!(await exists(filePath))) throw new LayerContractError([problem('IR_GENERATION_METADATA_MISSING', `IR generation metadata is missing: ${filePath}`, fileName)]);
  return parseIrGenerationMetadata(await readJsonFile<unknown>(filePath));
};

export const writeIrGenerationMetadata = async (
  irRoot: string,
  metadata: IRGenerationMetadata,
  fileName = IR_GENERATION_METADATA_FILE,
): Promise<string> => {
  const parsed = parseIrGenerationMetadata(metadata);
  const filePath = await resolveSafeInside(irRoot, fileName);
  await atomicWriteJson(filePath, parsed, true);
  return filePath;
};

export interface IRGenerationEnvelope {
  formatVersion: typeof LAYER_MANIFEST_VERSION;
  layer: 'ir';
  generated: true;
  generation: IRGenerationMetadata;
  [key: string]: unknown;
}

export const createIrGenerationEnvelope = (
  metadata: IRGenerationMetadata,
  extra: Record<string, unknown> = {},
): IRGenerationEnvelope => {
  const generation = parseIrGenerationMetadata(metadata);
  return {
    ...extra,
    formatVersion: LAYER_MANIFEST_VERSION,
    layer: 'ir',
    generated: true,
    generation,
  };
};

export const validateIrGenerationEnvelope = (value: unknown, sourcePath = IR_GENERATION_METADATA_FILE): Problem[] => {
  if (!isRecord(value)) return [problem('IR_GENERATION_ENVELOPE_INVALID', 'IR generation envelope must be an object', sourcePath)];
  const problems: Problem[] = [];
  if (value.formatVersion !== LAYER_MANIFEST_VERSION) problems.push(problem('IR_GENERATION_ENVELOPE_VERSION_INVALID', `IR envelope formatVersion must be ${LAYER_MANIFEST_VERSION}`, `${sourcePath}:formatVersion`));
  if (value.layer !== 'ir') problems.push(problem('IR_GENERATION_ENVELOPE_LAYER_INVALID', 'IR envelope layer must be "ir"', `${sourcePath}:layer`));
  if (value.generated !== true) problems.push(problem('IR_GENERATION_ENVELOPE_GENERATED_INVALID', 'IR envelope generated must be true', `${sourcePath}:generated`));
  problems.push(...validateIrGenerationMetadata(value.generation, `${sourcePath}:generation`));
  return problems;
};

export class LayerContractError extends Error {
  readonly problems: Problem[];

  constructor(problems: Problem[]) {
    super(problems.map((entry) => `${entry.code}: ${entry.message}`).join('; ') || 'Layer contract violation');
    this.name = 'LayerContractError';
    this.problems = problems;
  }
}
