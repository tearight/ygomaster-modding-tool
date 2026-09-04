import path from 'node:path';

import {
  atomicWriteJson,
  ensureDirectory,
  exists,
  listFiles,
  moveToTrash,
  readJsonFile,
  resolveSafeInside,
} from './fs';
import { getWorkspacePaths, loadManifest, validateManifest } from './manifest';
import {
  DocumentType,
  JsonValue,
  OperationResult,
  Problem,
  WorkspaceInspect,
  failure,
  problem,
  result,
} from './types';

const directoryFor = (type: DocumentType, paths: ReturnType<typeof getWorkspacePaths>) => {
  if (type === 'gate') return paths.gateRoot;
  if (type === 'deck') return paths.deckRoot;
  return paths.structureRoot;
};

const relativeDocument = (filePath: string, root: string) => path.relative(root, filePath).split(path.sep).join('/');
const sourceRelative = (sourceRoot: string, filePath: string) => path.relative(sourceRoot, filePath).split(path.sep).join('/');
const moveWorkspaceDocumentToTrash = (sourceRoot: string, filePath: string, kind: string) =>
  moveToTrash(sourceRoot, sourceRelative(sourceRoot, filePath), kind);

export const inspectWorkspace = async (projectRoot: string, sourceRootInput?: string): Promise<OperationResult<WorkspaceInspect>> => {
  try {
    const manifest = await loadManifest(sourceRootInput || path.join(projectRoot, 'campaign', 'source'));
    const paths = getWorkspacePaths(projectRoot, sourceRootInput, manifest);
    const manifestProblems = validateManifest(manifest);
    const counts = {
      gate: (await listFiles(paths.gateRoot, '.json')).length,
      deck: (await listFiles(paths.deckRoot, '.json')).length,
      structure: (await listFiles(paths.structureRoot, '.json')).length,
    };
    const data: WorkspaceInspect = {
      manifest,
      sourceRoot: paths.sourceRoot,
      counts,
      paths: { gateRoot: paths.gateRoot, deckRoot: paths.deckRoot, structureRoot: paths.structureRoot, targetRoot: paths.targetRoot },
    };
    const errors = manifestProblems.filter((entry) => entry.severity !== 'warning');
    return errors.length ? failure(errors, 'COMMAND_FAILED') : result(data, manifestProblems.filter((entry) => entry.severity === 'warning'));
  } catch (error) {
    return failure([problem('WORKSPACE_INSPECT_FAILED', String(error))], 'PATH_ERROR');
  }
};

export const listDocuments = async (projectRoot: string, sourceRootInput: string | undefined, type: DocumentType): Promise<OperationResult<string[]>> => {
  try {
    const manifest = await loadManifest(sourceRootInput || path.join(projectRoot, 'campaign', 'source'));
    const paths = getWorkspacePaths(projectRoot, sourceRootInput, manifest);
    const root = directoryFor(type, paths);
    const files = await listFiles(root, '.json');
    return result(files.map((filePath) => relativeDocument(filePath, root)));
  } catch (error) {
    return failure([problem('DOCUMENT_LIST_FAILED', String(error))], 'PATH_ERROR');
  }
};

export const readDocument = async (
  projectRoot: string,
  sourceRootInput: string | undefined,
  type: DocumentType,
  relativePath: string,
): Promise<OperationResult<JsonValue>> => {
  try {
    const manifest = await loadManifest(sourceRootInput || path.join(projectRoot, 'campaign', 'source'));
    const paths = getWorkspacePaths(projectRoot, sourceRootInput, manifest);
    const root = directoryFor(type, paths);
    const filePath = await resolveSafeInside(root, relativePath);
    return result(await readJsonFile<JsonValue>(filePath));
  } catch (error) {
    return failure([problem('DOCUMENT_READ_FAILED', String(error), relativePath)], 'PATH_ERROR');
  }
};

export const writeDocument = async (
  projectRoot: string,
  sourceRootInput: string | undefined,
  type: DocumentType,
  relativePath: string,
  value: JsonValue,
  replace = false,
): Promise<OperationResult<{ path: string }>> => {
  try {
    const manifest = await loadManifest(sourceRootInput || path.join(projectRoot, 'campaign', 'source'));
    const paths = getWorkspacePaths(projectRoot, sourceRootInput, manifest);
    const root = directoryFor(type, paths);
    const filePath = await resolveSafeInside(root, relativePath);
    let trashPath: string | undefined;
    if (replace && (await exists(filePath))) trashPath = await moveWorkspaceDocumentToTrash(paths.sourceRoot, filePath, 'replaced');
    try {
      await atomicWriteJson(filePath, value, false);
    } catch (error) {
      if (trashPath) {
        const fs = await import('node:fs/promises');
        const originalPath = await resolveSafeInside(paths.sourceRoot, sourceRelative(paths.sourceRoot, filePath));
        if (!(await exists(originalPath))) {
          await ensureDirectory(path.dirname(originalPath));
          const trashAbsolute = await resolveSafeInside(paths.sourceRoot, trashPath);
          await fs.rename(trashAbsolute, originalPath);
        }
      }
      throw error;
    }
    return result({ path: relativePath });
  } catch (error) {
    return failure([problem('DOCUMENT_WRITE_FAILED', String(error), relativePath)], 'PATH_ERROR');
  }
};

export const deleteDocument = async (
  projectRoot: string,
  sourceRootInput: string | undefined,
  type: DocumentType,
  relativePath: string,
): Promise<OperationResult<{ trashPath: string }>> => {
  try {
    const manifest = await loadManifest(sourceRootInput || path.join(projectRoot, 'campaign', 'source'));
    const paths = getWorkspacePaths(projectRoot, sourceRootInput, manifest);
    const filePath = await resolveSafeInside(directoryFor(type, paths), relativePath);
    const trashPath = await moveWorkspaceDocumentToTrash(paths.sourceRoot, filePath, 'deleted');
    return result({ trashPath });
  } catch (error) {
    return failure([problem('DOCUMENT_DELETE_FAILED', String(error), relativePath)], 'PATH_ERROR');
  }
};

export const listTrash = async (projectRoot: string, sourceRootInput?: string): Promise<OperationResult<string[]>> => {
  try {
    const manifest = await loadManifest(sourceRootInput || path.join(projectRoot, 'campaign', 'source'));
    const paths = getWorkspacePaths(projectRoot, sourceRootInput, manifest);
    return result((await listFiles(paths.trashRoot)).map((filePath) => relativeDocument(filePath, paths.sourceRoot)));
  } catch (error) {
    return failure([problem('TRASH_LIST_FAILED', String(error))], 'PATH_ERROR');
  }
};

export const restoreTrash = async (
  projectRoot: string,
  sourceRootInput: string | undefined,
  trashRelativePath: string,
): Promise<OperationResult<{ path: string }>> => {
  try {
    const manifest = await loadManifest(sourceRootInput || path.join(projectRoot, 'campaign', 'source'));
    const paths = getWorkspacePaths(projectRoot, sourceRootInput, manifest);
    const trashPath = await resolveSafeInside(paths.sourceRoot, trashRelativePath);
    const trashRelative = path.relative(paths.trashRoot, trashPath);
    if (!trashRelative || path.isAbsolute(trashRelative) || trashRelative === '..' || trashRelative.startsWith(`..${path.sep}`)) throw new Error('Trash path must be inside .trash');
    const trashParts = trashRelative.split(path.sep);
    const skip = trashParts[0] === 'replaced' ? 2 : 1;
    const originalRelative = trashParts.slice(skip).join('/');
    if (!originalRelative) throw new Error('Trash path does not contain an original relative path');
    const originalPath = await resolveSafeInside(paths.sourceRoot, originalRelative);
    if (await exists(originalPath)) throw new Error(`Restore target already exists: ${originalRelative}`);
    await ensureDirectory(path.dirname(originalPath));
    const fs = await import('node:fs/promises');
    await fs.rename(trashPath, originalPath);
    return result({ path: originalRelative });
  } catch (error) {
    return failure([problem('TRASH_RESTORE_FAILED', String(error), trashRelativePath)], 'PATH_ERROR');
  }
};

export const manifestProblems = (manifest: unknown): Problem[] => {
  if (!manifest || typeof manifest !== 'object') return [problem('MANIFEST_INVALID', 'Manifest must be an object')];
  return validateManifest(manifest as never);
};
