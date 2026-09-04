import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { assertRealPathInside, ensureDirectory, exists } from './fs';
import { parseJsonc } from './json';

export const LOCAL_PROFILE_RELATIVE_PATH = path.join('Data', 'Players', 'Local');
export const PLAYER_JSON_RELATIVE_PATH = 'Player.json';
export const SAVE_BACKUP_DIRECTORY = '.ygomaster-save-backups';

export interface OpaqueSaveSnapshot {
  generation: string;
  metadataGeneration: string;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  playerJsonModifiedAt: string;
}

export interface SaveCarryoverCopyResult {
  backupId: string;
  snapshot: OpaqueSaveSnapshot;
}

interface SnapshotEntry {
  relativePath: string;
  kind: 'directory' | 'file';
  size: number;
  modifiedAtMs: number;
  contentHash?: string;
}

const portableRelative = (root: string, candidate: string) =>
  path.relative(root, candidate).split(path.sep).join('/');

const digestEntries = (entries: SnapshotEntry[], includeMetadata: boolean) => {
  const digest = createHash('sha256');
  for (const entry of entries) {
    digest.update(entry.kind);
    digest.update('\0');
    digest.update(entry.relativePath);
    digest.update('\0');
    if (entry.kind === 'file') {
      digest.update(String(entry.size));
      digest.update('\0');
      digest.update(entry.contentHash || '');
      digest.update('\0');
      if (includeMetadata) digest.update(String(entry.modifiedAtMs));
    }
    digest.update('\n');
  }
  return digest.digest('hex');
};

/**
 * Read a Local profile as an opaque tree. JSON is parsed only to reject a
 * malformed or interrupted save; no field is interpreted or normalized.
 */
export const snapshotOpaqueLocalProfile = async (profileRoot: string): Promise<OpaqueSaveSnapshot> => {
  const root = path.resolve(profileRoot);
  if (!(await exists(root))) throw new Error('Local profile does not exist');
  await assertRealPathInside(path.dirname(root), root);
  const rootStats = await fs.lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error('Local profile must be a real directory');

  const entries: SnapshotEntry[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      await assertRealPathInside(root, absolute);
      const before = await fs.lstat(absolute, { bigint: true });
      if (child.isSymbolicLink() || before.isSymbolicLink()) throw new Error('Local profile contains a reparse-point entry');
      const relativePath = portableRelative(root, absolute);
      if (child.isDirectory() && before.isDirectory()) {
        entries.push({ relativePath, kind: 'directory', size: 0, modifiedAtMs: Number(before.mtimeMs) });
        await visit(absolute);
        continue;
      }
      if (!child.isFile() || !before.isFile()) throw new Error('Local profile contains an unsupported filesystem entry');
      const bytes = await fs.readFile(absolute);
      const after = await fs.lstat(absolute, { bigint: true });
      if (!after.isFile()
        || before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs) {
        throw new Error('Local profile changed while it was being inspected');
      }
      if (child.name.toLowerCase().endsWith('.json')) {
        try {
          parseJsonc(bytes.toString('utf8'));
        } catch {
          throw new Error('Local profile contains malformed JSON');
        }
      }
      const size = Number(after.size);
      totalBytes += size;
      entries.push({
        relativePath,
        kind: 'file',
        size,
        modifiedAtMs: Number(after.mtimeMs),
        contentHash: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  };
  await visit(root);

  const player = entries.find((entry) => entry.kind === 'file' && entry.relativePath.toLowerCase() === PLAYER_JSON_RELATIVE_PATH.toLowerCase());
  if (!player) throw new Error('Local profile has no Player.json');
  return {
    generation: digestEntries(entries, false),
    metadataGeneration: digestEntries(entries, true),
    fileCount: entries.filter((entry) => entry.kind === 'file').length,
    directoryCount: entries.filter((entry) => entry.kind === 'directory').length,
    totalBytes,
    playerJsonModifiedAt: new Date(player.modifiedAtMs).toISOString(),
  };
};

export const sameOpaqueSaveSnapshot = (left: OpaqueSaveSnapshot, right: OpaqueSaveSnapshot) =>
  left.generation === right.generation
  && left.metadataGeneration === right.metadataGeneration
  && left.fileCount === right.fileCount
  && left.directoryCount === right.directoryCount
  && left.totalBytes === right.totalBytes;

export const copyOpaqueLocalProfile = async (options: {
  sourceProfileRoot: string;
  targetProfileRoot: string;
  gameRoot: string;
}): Promise<SaveCarryoverCopyResult> => {
  const sourceProfileRoot = path.resolve(options.sourceProfileRoot);
  const targetProfileRoot = path.resolve(options.targetProfileRoot);
  if (await exists(targetProfileRoot)) throw new Error('Candidate already contains a Local profile');

  const before = await snapshotOpaqueLocalProfile(sourceProfileRoot);
  const backupId = randomUUID();
  const backupRoot = path.join(path.resolve(options.gameRoot), SAVE_BACKUP_DIRECTORY, backupId, 'Local');
  await ensureDirectory(path.dirname(backupRoot));
  await fs.cp(sourceProfileRoot, backupRoot, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  const backup = await snapshotOpaqueLocalProfile(backupRoot);
  if (!sameOpaqueSaveSnapshot(before, backup)) throw new Error('Save backup verification failed');

  await ensureDirectory(path.dirname(targetProfileRoot));
  await fs.cp(sourceProfileRoot, targetProfileRoot, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  const [after, copied] = await Promise.all([
    snapshotOpaqueLocalProfile(sourceProfileRoot),
    snapshotOpaqueLocalProfile(targetProfileRoot),
  ]);
  if (!sameOpaqueSaveSnapshot(before, after)) throw new Error('Local profile changed after backup');
  if (!sameOpaqueSaveSnapshot(before, copied)) throw new Error('Copied Local profile verification failed');
  return { backupId, snapshot: before };
};
