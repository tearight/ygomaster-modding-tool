import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { assertRealPathInside } from './fs';
import {
  CONTENT_MANIFEST_FILE,
  ContentManifest,
  validateContentManifest,
} from './layers';
import type { Problem } from './types';

/** Stable failure codes for the read-only content snapshot boundary. */
export const IR_SNAPSHOT_CODES = Object.freeze({
  ROOT_INVALID: 'IR_SNAPSHOT_ROOT_INVALID',
  ROOT_FORBIDDEN: 'IR_SNAPSHOT_FORBIDDEN_INPUT',
  PATH_ESCAPE: 'IR_SNAPSHOT_PATH_ESCAPE',
  SYMLINK_FORBIDDEN: 'IR_SNAPSHOT_SYMLINK_FORBIDDEN',
  FILE_INVALID: 'IR_SNAPSHOT_FILE_INVALID',
  READ_FAILED: 'IR_SNAPSHOT_READ_FAILED',
  MANIFEST_MISSING: 'IR_SNAPSHOT_MANIFEST_MISSING',
  MANIFEST_INVALID: 'IR_SNAPSHOT_MANIFEST_INVALID',
} as const);

export type IrSnapshotCode = (typeof IR_SNAPSHOT_CODES)[keyof typeof IR_SNAPSHOT_CODES];

export interface IrSnapshotFile {
  /** POSIX path relative to the content root; never an absolute path. */
  path: string;
  /** Lower-case SHA-256 digest of the exact source bytes. */
  hash: string;
  /** Exact source byte length. */
  size: number;
}

export interface IrSnapshot {
  /** Absolute root used for this read-only snapshot. */
  root: string;
  manifest: ContentManifest;
  files: IrSnapshotFile[];
  /** SHA-256 digest over sorted relative paths and exact file bytes. */
  contentGeneration: string;
}

export interface IrSnapshotResult {
  ok: boolean;
  snapshot?: IrSnapshot;
  problems: Problem[];
}

export interface IrSnapshotOptions {
  /** Optional project root used to enforce lexical/real-path containment. */
  projectRoot?: string;
  /** Additional path segment names that are forbidden as source inputs. */
  forbiddenSegments?: readonly string[];
}

interface SnapshotEntry extends IrSnapshotFile {
  bytes: Uint8Array;
}

const forbiddenSegmentNames = new Set(['source', 'source-legacy', 'generated', 'external']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Compare Unicode code points without host locale dependence. */
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

const problem = (
  code: IrSnapshotCode | string,
  message: string,
  sourcePath?: string,
): Problem => ({
  code,
  message,
  ...(sourcePath ? { sourcePath, path: sourcePath } : {}),
});

const problemSort = (left: Problem, right: Problem): number =>
  compareOrdinal(left.sourcePath || left.path || '', right.sourcePath || right.path || '')
  || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
  || (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER)
  || compareOrdinal(left.jsonPointer || '', right.jsonPointer || '')
  || compareOrdinal(left.code, right.code)
  || compareOrdinal(left.message, right.message);

const sortedProblems = (problems: readonly Problem[]): Problem[] => [...problems].sort(problemSort);

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const normalizedSegments = (value: string): string[] =>
  value.split(/[\\/]+/u).filter((segment) => segment.length > 0).map((segment) => segment.toLowerCase());

const forbiddenNames = (options: IrSnapshotOptions): Set<string> => new Set([
  ...forbiddenSegmentNames,
  ...(options.forbiddenSegments || []).map((segment) => segment.toLowerCase()),
]);

const hasForbiddenSegment = (value: string, forbidden: ReadonlySet<string>): boolean =>
  normalizedSegments(value).some((segment) => forbidden.has(segment));

const hashBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Compute a generation from provenance entries and exact source bytes.
 * A NUL separator and byte length make path/byte concatenation unambiguous.
 */
export const computeIrContentGeneration = (
  entries: readonly Pick<SnapshotEntry, 'path' | 'bytes'>[],
): string => {
  const digest = createHash('sha256');
  [...entries]
    .slice()
    .sort((left, right) => compareOrdinal(left.path, right.path))
    .forEach((entry) => {
      const pathBytes = Buffer.from(entry.path, 'utf8');
      const sizeBytes = Buffer.from(String(entry.bytes.byteLength), 'ascii');
      digest.update(pathBytes);
      digest.update(Buffer.from([0]));
      digest.update(sizeBytes);
      digest.update(Buffer.from([0]));
      digest.update(entry.bytes);
      digest.update(Buffer.from([0]));
    });
  return digest.digest('hex');
};

export const computeContentGeneration = computeIrContentGeneration;

const assertRoot = async (root: string, options: IrSnapshotOptions): Promise<Problem[]> => {
  const problems: Problem[] = [];
  const forbidden = forbiddenNames(options);
  if (hasForbiddenSegment(root, forbidden)) {
    problems.push(problem(IR_SNAPSHOT_CODES.ROOT_FORBIDDEN, 'source, source-legacy, generated, and external are not valid content snapshot roots', root));
  }
  if (options.projectRoot) {
    try {
      await assertRealPathInside(path.resolve(options.projectRoot), root);
    } catch (error) {
      problems.push(problem(IR_SNAPSHOT_CODES.PATH_ESCAPE, `Content snapshot root is outside project root: ${root}`, root));
    }
  }
  try {
    const stats = await fs.lstat(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      problems.push(problem(IR_SNAPSHOT_CODES.ROOT_INVALID, `Content snapshot root must be a real directory: ${root}`, root));
    }
  } catch (error) {
    problems.push(problem(IR_SNAPSHOT_CODES.ROOT_INVALID, `Content snapshot root cannot be read: ${errorMessage(error)}`, root));
  }
  return problems;
};

const readEntries = async (
  root: string,
  current: string,
  forbidden: ReadonlySet<string>,
  entries: SnapshotEntry[],
  problems: Problem[],
): Promise<void> => {
  let directoryEntries: import('node:fs').Dirent[];
  try {
    directoryEntries = await fs.readdir(current, { withFileTypes: true });
  } catch (error) {
    problems.push(problem(IR_SNAPSHOT_CODES.READ_FAILED, `Cannot enumerate content snapshot directory: ${errorMessage(error)}`, path.relative(root, current).split(path.sep).join('/') || '.'));
    return;
  }
  directoryEntries.sort((left, right) => compareOrdinal(left.name, right.name));
  for (const directoryEntry of directoryEntries) {
    const child = path.join(current, directoryEntry.name);
    const relative = path.relative(root, child).split(path.sep).join('/');
    if (hasForbiddenSegment(relative, forbidden)) {
      problems.push(problem(IR_SNAPSHOT_CODES.ROOT_FORBIDDEN, `Forbidden layer input appears inside the content snapshot: ${relative}`, relative));
      continue;
    }
    try {
      await assertRealPathInside(root, child);
      const stats = await fs.lstat(child);
      if (stats.isSymbolicLink()) {
        problems.push(problem(IR_SNAPSHOT_CODES.SYMLINK_FORBIDDEN, `Symlink or junction is not a valid content input: ${relative}`, relative));
        continue;
      }
      if (stats.isDirectory()) {
        await readEntries(root, child, forbidden, entries, problems);
        continue;
      }
      if (!stats.isFile()) {
        problems.push(problem(IR_SNAPSHOT_CODES.FILE_INVALID, `Content snapshot entry is not a regular file: ${relative}`, relative));
        continue;
      }
      const bytes = await fs.readFile(child);
      entries.push({ path: relative, hash: hashBytes(bytes), size: bytes.byteLength, bytes });
    } catch (error) {
      const code = error instanceof Error && error.message.toLowerCase().includes('symlink')
        ? IR_SNAPSHOT_CODES.SYMLINK_FORBIDDEN
        : IR_SNAPSHOT_CODES.PATH_ESCAPE;
      problems.push(problem(code, `Content snapshot entry is not a safe input: ${relative} (${errorMessage(error)})`, relative));
    }
  }
};

const parseManifest = (entry: SnapshotEntry): { manifest?: ContentManifest; problems: Problem[] } => {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(entry.bytes).toString('utf8').replace(/^\uFEFF/u, '')) as unknown;
  } catch (error) {
    return { problems: [problem(IR_SNAPSHOT_CODES.MANIFEST_INVALID, `Content manifest JSON is invalid: ${errorMessage(error)}`, CONTENT_MANIFEST_FILE)] };
  }
  const problems = validateContentManifest(value);
  if (problems.length || !isRecord(value)) return { problems: sortedProblems(problems) };
  return { manifest: value as ContentManifest, problems: [] };
};

/** Discover a read-only, fully contained content snapshot for the IR compiler. */
export const discoverIrSnapshot = async (
  contentRootInput: string,
  options: IrSnapshotOptions = {},
): Promise<IrSnapshotResult> => {
  const root = path.resolve(contentRootInput);
  const rootProblems = await assertRoot(root, options);
  if (rootProblems.length) return { ok: false, problems: sortedProblems(rootProblems) };

  const entries: SnapshotEntry[] = [];
  const problems: Problem[] = [];
  await readEntries(root, root, forbiddenNames(options), entries, problems);
  const manifestEntry = entries.find((entry) => entry.path === CONTENT_MANIFEST_FILE);
  if (!manifestEntry) problems.push(problem(IR_SNAPSHOT_CODES.MANIFEST_MISSING, `Required content manifest is missing: ${CONTENT_MANIFEST_FILE}`, CONTENT_MANIFEST_FILE));
  const manifestResult = manifestEntry ? parseManifest(manifestEntry) : { problems: [] as Problem[] };
  problems.push(...manifestResult.problems);
  if (problems.length || !manifestResult.manifest) return { ok: false, problems: sortedProblems(problems) };

  entries.sort((left, right) => compareOrdinal(left.path, right.path));
  const snapshot: IrSnapshot = {
    root,
    manifest: manifestResult.manifest,
    files: entries.map(({ path: relativePath, hash, size }) => ({ path: relativePath, hash, size })),
    contentGeneration: computeIrContentGeneration(entries),
  };
  return { ok: true, snapshot, problems: [] };
};

export const loadIrSnapshot = discoverIrSnapshot;
export const readIrSnapshot = discoverIrSnapshot;
export const discoverContentSnapshot = discoverIrSnapshot;
