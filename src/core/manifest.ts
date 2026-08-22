import path from 'node:path';

import { ensureDirectory, exists, readJsonFile, resolveInside, atomicWriteJson } from './fs';
import { JsonObject, Problem, SourceManifest, WorkspacePaths, problem } from './types';

export const MANIFEST_FILE = 'manifest.json';

export const defaultManifest = (): SourceManifest => ({
  formatVersion: 1,
  campaign: {
    name: 'Chronicle Progression',
    slug: 'chronicle-progression',
    version: '0.1.0',
  },
  directories: {
    gate: 'gate',
    deck: 'deck',
    structure: 'structure',
  },
  authoring: { language: 'Korean' },
  idPolicy: { gatePrefix: 90000, structurePrefix: 1129000 },
  runtime: { repository: 'pixeltris/YgoMaster', channel: 'latest', autoDownload: true },
});

const getDirectory = (manifest: SourceManifest, key: keyof NonNullable<SourceManifest['directories']>, fallback: string) =>
  manifest.directories?.[key] || fallback;

export const getWorkspacePaths = (projectRoot: string, sourceRootInput?: string, manifest?: SourceManifest): WorkspacePaths => {
  const sourceRoot = path.resolve(sourceRootInput || path.join(projectRoot, 'campaign', 'source'));
  return {
    projectRoot: path.resolve(projectRoot),
    sourceRoot,
    gateRoot: resolveInside(sourceRoot, getDirectory(manifest || defaultManifest(), 'gate', 'gate')),
    deckRoot: resolveInside(sourceRoot, getDirectory(manifest || defaultManifest(), 'deck', 'deck')),
    structureRoot: resolveInside(sourceRoot, getDirectory(manifest || defaultManifest(), 'structure', 'structure')),
    overlayRoot: resolveInside(sourceRoot, getDirectory(manifest || defaultManifest(), 'overlay', 'overlay')),
    assetsRoot: resolveInside(sourceRoot, getDirectory(manifest || defaultManifest(), 'assets', 'assets')),
    trashRoot: resolveInside(sourceRoot, '.trash'),
  };
};

export const loadManifest = async (sourceRoot: string): Promise<SourceManifest> => {
  const filePath = path.join(sourceRoot, MANIFEST_FILE);
  if (!(await exists(filePath))) throw new Error(`Required manifest is missing: ${filePath}`);
  return readJsonFile<SourceManifest>(filePath);
};

export const validateManifest = (manifest: SourceManifest): Problem[] => {
  const problems: Problem[] = [];
  if (!Number.isInteger(manifest.formatVersion) || manifest.formatVersion < 1) {
    problems.push(problem('MANIFEST_FORMAT_INVALID', 'manifest.formatVersion must be a positive integer', 'manifest.json'));
  }
  const campaign = manifest.campaign;
  if (!campaign || typeof campaign.name !== 'string' || !campaign.name || typeof campaign.slug !== 'string' || !campaign.slug || typeof campaign.version !== 'string' || !campaign.version) {
    problems.push(problem('MANIFEST_CAMPAIGN_MISSING', 'manifest.campaign.name, slug, and version are required', 'manifest.json:campaign'));
  }
  const directories = manifest.directories || {};
  for (const key of ['gate', 'deck', 'structure'] as const) {
    const value = directories[key];
    if (!value || path.isAbsolute(value) || value.includes('\\') || value.split('/').includes('..') || value === '.trash' || value.startsWith('.trash/')) {
      problems.push(problem('MANIFEST_PATH_INVALID', `manifest directory ${key} must be a safe relative POSIX path`, `manifest.json:directories.${key}`));
    }
  }
  for (const [key, value] of Object.entries(directories).filter(([key]) => !['gate', 'deck', 'structure'].includes(key))) {
    if (value !== undefined && (!value || path.isAbsolute(value) || value.includes('\\') || value.split('/').includes('..') || value === '.trash' || value.startsWith('.trash/'))) {
      problems.push(problem('MANIFEST_PATH_INVALID', `manifest directory ${key} must be a safe relative POSIX path`, `manifest.json:directories.${key}`));
    }
  }
  if (typeof manifest.authoring?.language !== 'string' || !manifest.authoring.language) {
    problems.push(problem('MANIFEST_AUTHORING_MISSING', 'manifest.authoring.language is required', 'manifest.json:authoring.language'));
  }
  if (manifest.idPolicy?.gatePrefix !== 90000 || manifest.idPolicy?.structurePrefix !== 1129000) {
    problems.push(problem('MANIFEST_ID_POLICY_INVALID', 'manifest.idPolicy must use gatePrefix 90000 and structurePrefix 1129000', 'manifest.json:idPolicy'));
  }
  if (manifest.runtime?.repository !== 'pixeltris/YgoMaster' || manifest.runtime.channel !== 'latest' || typeof manifest.runtime.autoDownload !== 'boolean') {
    problems.push(problem('MANIFEST_RUNTIME_INVALID', 'manifest.runtime must declare pixeltris/YgoMaster latest and autoDownload', 'manifest.json:runtime'));
  }
  return problems;
};

export const initWorkspace = async (projectRoot: string, sourceRootInput?: string): Promise<{ paths: WorkspacePaths; manifest: SourceManifest }> => {
  const sourceRoot = path.resolve(sourceRootInput || path.join(projectRoot, 'campaign', 'source'));
  await ensureDirectory(sourceRoot);
  const manifestPath = path.join(sourceRoot, MANIFEST_FILE);
  const manifest = (await exists(manifestPath)) ? await loadManifest(sourceRoot) : defaultManifest();
  const paths = getWorkspacePaths(projectRoot, sourceRoot, manifest);
  await Promise.all([paths.gateRoot, paths.deckRoot, paths.structureRoot, paths.overlayRoot, paths.assetsRoot].map(ensureDirectory));
  if (!(await exists(manifestPath))) await atomicWriteJson(manifestPath, manifest, false);
  return { paths, manifest };
};

export const manifestToJson = (manifest: SourceManifest): JsonObject => manifest as unknown as JsonObject;
