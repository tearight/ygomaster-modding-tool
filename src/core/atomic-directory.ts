import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';

import { assertRealPathInside, pathInside, removeExact } from './fs';

/** Stable failure classes for the narrow IR directory publish boundary. */
export const ATOMIC_DIRECTORY_CODES = Object.freeze({
  OPTIONS_INVALID: 'ATOMIC_DIRECTORY_OPTIONS_INVALID',
  ROOT_INVALID: 'ATOMIC_DIRECTORY_ROOT_INVALID',
  PATH_ESCAPE: 'ATOMIC_DIRECTORY_PATH_ESCAPE',
  PATH_OVERLAP: 'ATOMIC_DIRECTORY_PATH_OVERLAP',
  SIBLING_REQUIRED: 'ATOMIC_DIRECTORY_SIBLING_REQUIRED',
  SYMLINK_FORBIDDEN: 'ATOMIC_DIRECTORY_SYMLINK_FORBIDDEN',
  STAGING_MISSING: 'ATOMIC_DIRECTORY_STAGING_MISSING',
  STAGING_INVALID: 'ATOMIC_DIRECTORY_STAGING_INVALID',
  FINAL_INVALID: 'ATOMIC_DIRECTORY_FINAL_INVALID',
  BACKUP_EXISTS: 'ATOMIC_DIRECTORY_BACKUP_EXISTS',
  PUBLISH_FAILED: 'ATOMIC_DIRECTORY_PUBLISH_FAILED',
  ROLLBACK_FAILED: 'ATOMIC_DIRECTORY_ROLLBACK_FAILED',
  CLEANUP_FAILED: 'ATOMIC_DIRECTORY_CLEANUP_FAILED',
} as const);

export type AtomicDirectoryCode = (typeof ATOMIC_DIRECTORY_CODES)[keyof typeof ATOMIC_DIRECTORY_CODES];

export type AtomicDirectoryRename = (source: string, destination: string) => Promise<void>;
export type AtomicDirectoryRemove = (target: string) => Promise<void>;

export interface AtomicDirectoryPublishOptions {
  /** Existing directory containing both sibling staging and final paths. */
  root: string;
  stagingPath?: string;
  finalPath?: string;
  backupPath?: string;
  /** Short aliases are accepted for callers that use the operation vocabulary. */
  staging?: string;
  final?: string;
  backup?: string;
  rename?: AtomicDirectoryRename;
  remove?: AtomicDirectoryRemove;
}

export interface AtomicDirectoryPublishResult {
  root: string;
  stagingPath: string;
  finalPath: string;
  /** The backup path is returned only when an existing final was replaced. */
  backupPath?: string;
  replaced: boolean;
}

export class AtomicDirectoryError extends Error {
  readonly code: AtomicDirectoryCode;
  readonly causeError?: unknown;

  constructor(code: AtomicDirectoryCode, message: string, causeError?: unknown) {
    super(message);
    this.name = 'AtomicDirectoryError';
    this.code = code;
    this.causeError = causeError;
  }
}

const isNotFound = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
};

const assertDirectoryRoot = async (root: string): Promise<void> => {
  let stats: Stats;
  try {
    stats = await fs.lstat(root);
  } catch (error) {
    throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.ROOT_INVALID, `Publish root does not exist: ${root}`, error);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.ROOT_INVALID, `Publish root must be a real directory: ${root}`);
  }
};

const assertContainedChild = async (root: string, target: string, label: string): Promise<string> => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.PATH_ESCAPE, `${label} must be a strict child of the publish root: ${target}`);
  }
  try {
    await assertRealPathInside(resolvedRoot, resolvedTarget);
  } catch (error) {
    throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.PATH_ESCAPE, `${label} is not contained by the publish root: ${target}`, error);
  }
  return resolvedTarget;
};

const assertNoSymlinkTree = async (root: string, target: string, label: string): Promise<void> => {
  let stats: Stats;
  try {
    stats = await fs.lstat(target);
  } catch (error) {
    throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.PATH_ESCAPE, `Cannot inspect ${label}: ${target}`, error);
  }
  if (stats.isSymbolicLink()) throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.SYMLINK_FORBIDDEN, `${label} cannot be a symlink: ${target}`);
  if (!stats.isDirectory()) return;
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    try {
      await assertRealPathInside(root, child);
    } catch (error) {
      throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.PATH_ESCAPE, `Symlink or escaped ${label} entry: ${child}`, error);
    }
    if (entry.isSymbolicLink()) throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.SYMLINK_FORBIDDEN, `${label} cannot contain symlinks: ${child}`);
    if (entry.isDirectory()) await assertNoSymlinkTree(root, child, label);
  }
};

const removeIfPresent = async (target: string, remove: AtomicDirectoryRemove): Promise<void> => {
  if (await pathExists(target)) await remove(target);
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const resolveOptionPath = (primary: string | undefined, alias: string | undefined): string | undefined => primary || alias;

/**
 * Publish a fully-written sibling staging directory as one directory swap.
 *
 * The final directory is first moved to a sibling backup (when present), then
 * staging is moved to final. A failed second rename removes only a possible
 * new final and restores the exact backup path. No copy or recursive merge is
 * performed at this boundary.
 */
export const publishAtomicDirectory = async (
  options: AtomicDirectoryPublishOptions,
): Promise<AtomicDirectoryPublishResult> => {
  if (!options || typeof options.root !== 'string') {
    throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.OPTIONS_INVALID, 'root, stagingPath, and finalPath are required');
  }
  const stagingInput = resolveOptionPath(options.stagingPath, options.staging);
  const finalInput = resolveOptionPath(options.finalPath, options.final);
  if (!stagingInput || !finalInput) {
    throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.OPTIONS_INVALID, 'root, stagingPath, and finalPath are required');
  }

  const root = path.resolve(options.root);
  const stagingPath = await assertContainedChild(root, stagingInput, 'stagingPath');
  const finalPath = await assertContainedChild(root, finalInput, 'finalPath');
  const backupInput = resolveOptionPath(options.backupPath, options.backup) || `${finalPath}.backup`;
  const backupPath = await assertContainedChild(root, backupInput, 'backupPath');
  if (stagingPath === finalPath || stagingPath === backupPath || finalPath === backupPath
    || pathInside(stagingPath, finalPath) || pathInside(finalPath, stagingPath)
    || pathInside(stagingPath, backupPath) || pathInside(backupPath, stagingPath)
    || pathInside(finalPath, backupPath) || pathInside(backupPath, finalPath)) {
    throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.PATH_OVERLAP, 'staging, final, and backup paths must not overlap');
  }
  if (path.dirname(stagingPath) !== path.dirname(finalPath) || path.dirname(backupPath) !== path.dirname(finalPath)) {
    throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.SIBLING_REQUIRED, 'staging, final, and backup paths must be siblings');
  }

  await assertDirectoryRoot(root);
  const stagingStats = await fs.lstat(stagingPath).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (!stagingStats) throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.STAGING_MISSING, `Staging directory does not exist: ${stagingPath}`);
  if (stagingStats.isSymbolicLink() || !stagingStats.isDirectory()) throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.STAGING_INVALID, `Staging path must be a real directory: ${stagingPath}`);
  await assertNoSymlinkTree(root, stagingPath, 'staging');

  const finalStats = await fs.lstat(finalPath).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (finalStats && (finalStats.isSymbolicLink() || !finalStats.isDirectory())) throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.FINAL_INVALID, `Final path must be a real directory: ${finalPath}`);
  if (finalStats) await assertNoSymlinkTree(root, finalPath, 'final');
  if (await pathExists(backupPath)) throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.BACKUP_EXISTS, `Backup path already exists: ${backupPath}`);

  const rename = options.rename || ((source: string, destination: string) => fs.rename(source, destination));
  const remove = options.remove || removeExact;
  const replaced = Boolean(finalStats);
  let backupMoved = false;

  if (replaced) {
    try {
      await rename(finalPath, backupPath);
      backupMoved = true;
    } catch (error) {
      throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.PUBLISH_FAILED, `Could not move final directory to backup: ${errorMessage(error)}`, error);
    }
  }

  try {
    await rename(stagingPath, finalPath);
  } catch (error) {
    if (!backupMoved) {
      // A platform/custom rename hook may move the directory and then throw.
      // The new-final path is still ours at this point, so remove only that
      // exact validated child to restore the pre-publish no-final state.
      try {
        await removeIfPresent(finalPath, remove);
      } catch (cleanupError) {
        throw new AtomicDirectoryError(
          ATOMIC_DIRECTORY_CODES.ROLLBACK_FAILED,
          `Publish failed and partial final cleanup failed: ${errorMessage(cleanupError)}`,
          cleanupError,
        );
      }
      throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.PUBLISH_FAILED, `Could not move staging directory to final: ${errorMessage(error)}`, error);
    }
    try {
      await removeIfPresent(finalPath, remove);
      await rename(backupPath, finalPath);
    } catch (rollbackError) {
      throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.ROLLBACK_FAILED, `Publish failed and rollback failed: ${errorMessage(rollbackError)}`, rollbackError);
    }
    throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.PUBLISH_FAILED, `Could not move staging directory to final; previous final restored: ${errorMessage(error)}`, error);
  }

  if (backupMoved) {
    try {
      await remove(backupPath);
    } catch (error) {
      try {
        await removeIfPresent(finalPath, remove);
        await rename(backupPath, finalPath);
      } catch (rollbackError) {
        throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.ROLLBACK_FAILED, `Backup cleanup failed and rollback failed: ${errorMessage(rollbackError)}`, rollbackError);
      }
      throw new AtomicDirectoryError(ATOMIC_DIRECTORY_CODES.CLEANUP_FAILED, `Published directory but could not remove backup: ${errorMessage(error)}`, error);
    }
  }

  return {
    root,
    stagingPath,
    finalPath,
    ...(backupMoved ? { backupPath } : {}),
    replaced,
  };
};

export const atomicPublishDirectory = publishAtomicDirectory;
export const publishDirectoryAtomically = publishAtomicDirectory;
