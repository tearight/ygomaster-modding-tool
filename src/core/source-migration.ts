import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import {
  publishAtomicDirectory,
  type AtomicDirectoryRemove,
  type AtomicDirectoryRename,
} from './atomic-directory';
import { assertRealPathInside, pathInside, removeExact } from './fs';
import type { ExitName, OperationResult, Problem } from './types';

export type SourceMigrationDisposition =
  | 'auto-convertible'
  | 'requires-review'
  | 'unsupported'
  | 'retain-reference'
  | 'remove-stale';

export const SOURCE_MIGRATION_CODES = Object.freeze({
  OPTIONS_INVALID: 'MIGRATION_OPTIONS_INVALID',
  SOURCE_MISSING: 'MIGRATION_SOURCE_MISSING',
  PATH_ESCAPE: 'MIGRATION_PATH_ESCAPE',
  PATH_OVERLAP: 'MIGRATION_PATH_OVERLAP',
  SYMLINK_FORBIDDEN: 'MIGRATION_SYMLINK_FORBIDDEN',
  REFERENCE_INPUT_FORBIDDEN: 'MIGRATION_REFERENCE_INPUT_FORBIDDEN',
  CANDIDATE_INVALID: 'MIGRATION_CANDIDATE_INVALID',
  CANDIDATE_SIDECAR: 'MIGRATION_OPAQUE_SIDECAR_FORBIDDEN',
  CANDIDATE_MANIFEST: 'MIGRATION_CANDIDATE_MANIFEST_MISSING',
  NO_AUTHORED_DATA: 'MIGRATION_NO_PROMOTABLE_AUTHORED_DATA',
  REVIEW_REQUIRED: 'MIGRATION_REVIEW_REQUIRED',
  PREVIEW_REQUIRED: 'MIGRATION_PREVIEW_REQUIRED',
  PREVIEW_STALE: 'MIGRATION_PREVIEW_STALE',
  PREVIEW_MISMATCH: 'MIGRATION_PREVIEW_MISMATCH',
  BACKUP_COLLISION: 'MIGRATION_BACKUP_COLLISION',
  APPLY_FAILED: 'MIGRATION_APPLY_FAILED',
} as const);

export interface SourceMigrationPathDisposition {
  path: string;
  kind: 'file' | 'directory';
  disposition: SourceMigrationDisposition;
  reason: string;
  reviewRequired?: boolean;
}

export interface SourceMigrationExcludedInput {
  path: string;
  reason: string;
}

export interface SourceMigrationCandidateFile {
  /** POSIX relative path below the content candidate root. */
  path: string;
  content: string | Uint8Array;
}

interface NormalizedCandidateFile {
  path: string;
  bytes: Uint8Array;
}

interface SourceTreeEntry {
  path: string;
  kind: 'file' | 'directory';
  bytes?: Uint8Array;
}

interface SourceTree {
  entries: SourceTreeEntry[];
  files: SourceTreeEntry[];
  generation: string;
}

export interface SourceMigrationPreview {
  projectRoot: string;
  sourceRoot: string;
  contentRoot: string;
  sourceGeneration: string;
  candidateGeneration: string;
  sourcePaths: string[];
  sourceFiles: string[];
  dispositions: SourceMigrationPathDisposition[];
  unresolved: SourceMigrationPathDisposition[];
  excludedInputs: SourceMigrationExcludedInput[];
  candidateFiles: SourceMigrationCandidateFile[];
  noPromotableAuthoredData: boolean;
  reviewedCandidate: boolean;
}

export interface SourceMigrationOptions {
  projectRoot: string;
  sourceRoot?: string;
  contentRoot?: string;
  /** A reviewed candidate is never inferred from source; it is copied exactly. */
  candidateFiles?: readonly SourceMigrationCandidateFile[];
}

export interface SourceMigrationApplyOptions extends SourceMigrationOptions {
  preview: SourceMigrationPreview;
  /** Apply is deliberately opt-in. */
  accept: boolean;
  /** Must equal preview.sourceGeneration and the current source generation. */
  expectedSourceGeneration?: string;
  /** Defaults to <projectRoot>/.migration-backups. */
  backupRoot?: string;
  /** Test-only injectable hooks; no external runtime is involved. */
  rename?: AtomicDirectoryRename;
  remove?: AtomicDirectoryRemove;
}

export interface SourceMigrationApplyReport {
  sourceGeneration: string;
  candidateGeneration: string;
  backupPath: string;
  publishedContentRoot: string;
  noPromotableAuthoredData: boolean;
}

const STALE_SKELETONS = new Set(['gates', 'decks', 'localization']);
const FORBIDDEN_SEGMENTS = new Set([
  'source-legacy',
  'reference',
  'external',
  'runtime',
  'private',
  'saves',
  'client',
  'ygomaster',
]);
const CANDIDATE_FORBIDDEN_SEGMENTS = new Set([
  'source',
  'source-legacy',
  'generated',
  'external',
  'runtime',
  'private',
  'saves',
  'client',
]);

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function problem(
  code: string,
  message: string,
  path?: string,
  severity: 'error' | 'warning' = 'error',
): Problem {
  return { code, message, ...(path ? { path } : {}), severity };
}

function failure<T>(
  exitName: ExitName,
  problems: Problem[],
  warnings: Problem[] = [],
): OperationResult<T> {
  return {
    ok: false,
    exitCode: exitName === 'PATH_ERROR' ? 3 : exitName === 'USAGE_ERROR' ? 2 : 1,
    exitName,
    problems,
    warnings,
  };
}

function success<T>(data: T, warnings: Problem[] = []): OperationResult<T> {
  return { ok: true, exitCode: 0, exitName: 'SUCCESS', problems: [], warnings, data };
}

function relativePosix(root: string, target: string): string {
  return relative(root, target).split(sep).join('/');
}

function segments(target: string): string[] {
  return target.split(/[\\/]+/u).filter(Boolean).map((part) => part.toLowerCase());
}

function hasForbiddenSegment(target: string): boolean {
  return segments(target).some((part) => FORBIDDEN_SEGMENTS.has(part));
}

function isStrictChild(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return normalizedRoot !== normalizedTarget && pathInside(normalizedRoot, normalizedTarget);
}

async function isSymlinkOrMissing(target: string): Promise<'missing' | 'symlink' | 'other'> {
  try {
    const stats = await lstat(target);
    return stats.isSymbolicLink() ? 'symlink' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function validatePaths(options: SourceMigrationOptions): Promise<
  | { ok: true; projectRoot: string; sourceRoot: string; contentRoot: string }
  | { ok: false; result: OperationResult<never> }
> {
  if (!options.projectRoot || isAbsolute(options.projectRoot) === false) {
    return { ok: false, result: failure('PATH_ERROR', [problem(SOURCE_MIGRATION_CODES.OPTIONS_INVALID, 'projectRoot must be an absolute path.')]) };
  }

  const projectRoot = resolve(options.projectRoot);
  const sourceRoot = resolve(options.sourceRoot ?? join(projectRoot, 'campaign', 'source'));
  const contentRoot = resolve(options.contentRoot ?? join(projectRoot, 'campaign', 'content'));
  if (!isStrictChild(projectRoot, sourceRoot) || !isStrictChild(projectRoot, contentRoot)) {
    return { ok: false, result: failure('PATH_ERROR', [problem(SOURCE_MIGRATION_CODES.PATH_ESCAPE, 'sourceRoot and contentRoot must be strict children of projectRoot.')]) };
  }
  if (pathInside(sourceRoot, contentRoot) || pathInside(contentRoot, sourceRoot)) {
    return { ok: false, result: failure('PATH_ERROR', [problem(SOURCE_MIGRATION_CODES.PATH_OVERLAP, 'sourceRoot and contentRoot must not overlap.')]) };
  }
  const sourceRelative = relativePosix(projectRoot, sourceRoot);
  const contentRelative = relativePosix(projectRoot, contentRoot);
  if (hasForbiddenSegment(sourceRelative) || hasForbiddenSegment(contentRelative)) {
    return { ok: false, result: failure('PATH_ERROR', [problem(SOURCE_MIGRATION_CODES.REFERENCE_INPUT_FORBIDDEN, 'Reference, runtime, private, legacy, or upstream paths are not migration inputs.')]) };
  }

  const projectState = await isSymlinkOrMissing(projectRoot);
  if (projectState !== 'other') {
    return {
      ok: false,
      result: failure('PATH_ERROR', [problem(projectState === 'missing' ? SOURCE_MIGRATION_CODES.SOURCE_MISSING : SOURCE_MIGRATION_CODES.SYMLINK_FORBIDDEN, 'projectRoot must be an existing non-symlink directory.', projectRoot)]),
    };
  }
  try {
    await assertRealPathInside(projectRoot, sourceRoot);
    await assertRealPathInside(projectRoot, dirname(contentRoot));
  } catch (error) {
    return { ok: false, result: failure('PATH_ERROR', [problem(SOURCE_MIGRATION_CODES.PATH_ESCAPE, error instanceof Error ? error.message : String(error))]) };
  }
  const sourceState = await isSymlinkOrMissing(sourceRoot);
  if (sourceState === 'missing') {
    return { ok: false, result: failure('PATH_ERROR', [problem(SOURCE_MIGRATION_CODES.SOURCE_MISSING, 'Active source directory does not exist.', sourceRoot)]) };
  }
  if (sourceState === 'symlink') {
    return { ok: false, result: failure('PATH_ERROR', [problem(SOURCE_MIGRATION_CODES.SYMLINK_FORBIDDEN, 'Active source directory may not be a symlink.', sourceRoot)]) };
  }
  const contentState = await isSymlinkOrMissing(contentRoot);
  if (contentState === 'symlink') {
    return { ok: false, result: failure('PATH_ERROR', [problem(SOURCE_MIGRATION_CODES.SYMLINK_FORBIDDEN, 'Content directory may not be a symlink.', contentRoot)]) };
  }
  return { ok: true, projectRoot, sourceRoot, contentRoot };
}

async function collectTree(root: string): Promise<SourceTree> {
  const entries: SourceTreeEntry[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareOrdinal(left.name, right.name));
    for (const child of children) {
      const childPath = join(directory, child.name);
      const childRelative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const stats = await lstat(childPath);
      if (stats.isSymbolicLink()) {
        throw problem(SOURCE_MIGRATION_CODES.SYMLINK_FORBIDDEN, 'Symlinks and junctions are not migration inputs.', childRelative);
      }
      if (stats.isDirectory()) {
        entries.push({ path: childRelative.split('\\').join('/'), kind: 'directory' });
        await visit(childPath, childRelative);
      } else if (stats.isFile()) {
        entries.push({ path: childRelative.split('\\').join('/'), kind: 'file', bytes: new Uint8Array(await readFile(childPath)) });
      } else {
        throw problem(SOURCE_MIGRATION_CODES.REFERENCE_INPUT_FORBIDDEN, 'Special filesystem entries are not migration inputs.', childRelative);
      }
    }
  }
  await visit(root, '');
  entries.sort((left, right) => compareOrdinal(left.path, right.path) || compareOrdinal(left.kind, right.kind));
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.path, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(entry.kind, 'utf8');
    hash.update(Buffer.from([0]));
    if (entry.bytes) hash.update(entry.bytes);
    hash.update(Buffer.from([0]));
  }
  return { entries, files: entries.filter((entry) => entry.kind === 'file'), generation: hash.digest('hex') };
}

function normalizeRelativeCandidatePath(value: string): string | undefined {
  if (!value || value.includes('\\') || value.includes('\0') || isAbsolute(value)) return undefined;
  const normalized = posix.normalize(value);
  if (normalized === '.' || normalized !== value || normalized.startsWith('../') || normalized.includes('/../')) return undefined;
  if (normalized.split('/').some((part) => CANDIDATE_FORBIDDEN_SEGMENTS.has(part.toLowerCase()))) return undefined;
  return normalized;
}

function normalizeCandidateFiles(
  files: readonly SourceMigrationCandidateFile[] | undefined,
): { files?: NormalizedCandidateFile[]; problems: Problem[] } {
  if (!files || files.length === 0) return { files: [], problems: [] };
  const normalized: NormalizedCandidateFile[] = [];
  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  for (const file of files) {
    const path = normalizeRelativeCandidatePath(file.path);
    if (!path) {
      return { problems: [problem(SOURCE_MIGRATION_CODES.CANDIDATE_INVALID, 'Candidate paths must be strict POSIX relative paths.', file.path)] };
    }
    if (path === '.ygomaster-source.json' || path.endsWith('/.ygomaster-source.json')) {
      return { problems: [problem(SOURCE_MIGRATION_CODES.CANDIDATE_SIDECAR, 'Opaque source sidecars are never authored content.', path)] };
    }
    const folded = path.toLowerCase();
    if (paths.has(path) || foldedPaths.has(folded)) {
      return { problems: [problem(SOURCE_MIGRATION_CODES.CANDIDATE_INVALID, 'Candidate paths must be unique, including on case-insensitive filesystems.', path)] };
    }
    paths.add(path);
    foldedPaths.add(folded);
    const content = typeof file.content === 'string' ? new Uint8Array(Buffer.from(file.content, 'utf8')) : new Uint8Array(file.content);
    normalized.push({ path, bytes: content });
  }
  normalized.sort((left, right) => compareOrdinal(left.path, right.path));
  return { files: normalized, problems: [] };
}

function hashCandidateFiles(files: readonly NormalizedCandidateFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(file.bytes);
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

function classify(entry: SourceTreeEntry, entries: readonly SourceTreeEntry[]): SourceMigrationPathDisposition {
  const path = entry.path;
  const first = path.split('/')[0].toLowerCase();
  const basename = path.split('/').at(-1) ?? path;
  if (path === 'manifest.json') {
    return { path, kind: entry.kind, disposition: 'retain-reference', reason: 'The source manifest describes generated IR and is not authored content.' };
  }
  if (basename === 'README.md') {
    return { path, kind: entry.kind, disposition: 'retain-reference', reason: 'Source-layer documentation is retained as a reference, not promoted.' };
  }
  if (first === 'card-db') {
    return { path, kind: entry.kind, disposition: 'retain-reference', reason: 'Card database files are service input and must not become campaign-authored facts.' };
  }
  if (basename === '.ygomaster-source.json') {
    return { path, kind: entry.kind, disposition: 'retain-reference', reason: 'Opaque editor provenance is retained for review only.', reviewRequired: true };
  }
  if (basename === '.gitkeep') {
    if (STALE_SKELETONS.has(first)) {
      return { path, kind: entry.kind, disposition: 'remove-stale', reason: 'Plural source skeleton is stale and is not a migration input.' };
    }
    return { path, kind: entry.kind, disposition: 'retain-reference', reason: 'Empty source skeleton marker is retained as a reference.' };
  }
  if (STALE_SKELETONS.has(first)) {
    const hasPayload = entries.some((candidate) => candidate.kind === 'file'
      && candidate.path.startsWith(`${first}/`)
      && candidate.path !== `${first}/.gitkeep`);
    if (entry.kind === 'directory' && !hasPayload) {
      return { path, kind: entry.kind, disposition: 'remove-stale', reason: 'Empty plural source skeleton is stale and is not a migration input.' };
    }
    return { path, kind: entry.kind, disposition: 'requires-review', reason: 'A non-empty plural source directory must be reviewed; it is never silently merged.' };
  }
  if (first === 'overlay' && /shop/i.test(path)) {
    return { path, kind: entry.kind, disposition: 'unsupported', reason: 'Legacy/editor overlay data has no automatic authored-content mapping.', reviewRequired: true };
  }
  if (entry.kind === 'directory') {
    return { path, kind: entry.kind, disposition: 'retain-reference', reason: 'Managed source directory boundary is retained without promoting data.' };
  }
  if (first === 'gate' || first === 'deck' || first === 'structure' || first === 'overlay' || first === 'assets') {
    return { path, kind: entry.kind, disposition: 'requires-review', reason: 'Generated/target-shaped source data requires an explicit reviewed content conversion.', reviewRequired: true };
  }
  return { path, kind: entry.kind, disposition: 'requires-review', reason: 'Unknown opaque source data is not promoted automatically.', reviewRequired: true };
}

function excludedInputs(projectRoot: string): SourceMigrationExcludedInput[] {
  return [
    { path: relativePosix(projectRoot, join(projectRoot, 'campaign', 'source-legacy')), reason: 'Reference snapshot is never an input and is never auto-merged.' },
    { path: relativePosix(projectRoot, join(projectRoot, 'repositories', 'YgoMaster')), reason: 'Upstream runtime checkout is outside this migration boundary.' },
    { path: 'private/*', reason: 'Private absolute references are discarded and replaced by review provenance.' },
    { path: 'runtime/*', reason: 'Runtime/client/save data is not authored campaign content.' },
  ];
}

function cloneCandidateFiles(files: readonly NormalizedCandidateFile[]): SourceMigrationCandidateFile[] {
  return files.map((file) => ({ path: file.path, content: new Uint8Array(file.bytes) }));
}

export async function previewSourceMigration(
  options: SourceMigrationOptions,
): Promise<OperationResult<SourceMigrationPreview>> {
  const paths = await validatePaths(options);
  if (!paths.ok) return paths.result;
  let tree: SourceTree;
  try {
    tree = await collectTree(paths.sourceRoot);
  } catch (error) {
    const detail = error as Problem;
    return failure('PATH_ERROR', [detail.code ? detail : problem(SOURCE_MIGRATION_CODES.SOURCE_MISSING, String(error))]);
  }
  const candidates = normalizeCandidateFiles(options.candidateFiles);
  if (candidates.problems.length > 0 || !candidates.files) return failure('USAGE_ERROR', candidates.problems);
  const dispositions = tree.entries.map((entry) => classify(entry, tree.entries)).sort((left, right) => compareOrdinal(left.path, right.path));
  const unresolved = dispositions.filter((entry) => entry.disposition === 'requires-review' || entry.disposition === 'unsupported');
  const hasAutoConvertible = dispositions.some((entry) => entry.disposition === 'auto-convertible');
  const noPromotableAuthoredData = !hasAutoConvertible && candidates.files.length === 0;
  const candidateGeneration = hashCandidateFiles(candidates.files);
  return success({
    projectRoot: paths.projectRoot,
    sourceRoot: paths.sourceRoot,
    contentRoot: paths.contentRoot,
    sourceGeneration: tree.generation,
    candidateGeneration,
    sourcePaths: tree.entries.map((entry) => entry.path),
    sourceFiles: tree.files.map((entry) => entry.path),
    dispositions,
    unresolved,
    excludedInputs: excludedInputs(paths.projectRoot),
    candidateFiles: cloneCandidateFiles(candidates.files),
    noPromotableAuthoredData,
    reviewedCandidate: candidates.files.length > 0,
  });
}

function generatedSibling(parent: string, name: string, prefix: string, generation: string): string {
  return join(parent, `.${name}.${prefix}-${generation.slice(0, 24)}`);
}

async function removeGeneratedPath(target: string, parent: string, prefix: string): Promise<void> {
  if (dirname(target) !== resolve(parent) || !target.split(/[\\/]/u).at(-1)?.startsWith(prefix)) {
    throw new Error('Refusing to remove a non-generated migration path.');
  }
  const state = await isSymlinkOrMissing(target);
  if (state === 'symlink') throw new Error('Generated migration path is a symlink.');
  if (state === 'other') await removeExact(target);
}

async function ensureBackup(
  sourceGeneration: string,
  backupRoot: string,
  sourceTree: SourceTree,
): Promise<string> {
  await mkdir(backupRoot, { recursive: true });
  const target = join(backupRoot, sourceGeneration, 'source');
  const targetParent = dirname(target);
  const state = await isSymlinkOrMissing(target);
  if (state === 'symlink') throw new Error('Migration backup target is a symlink.');
  if (state === 'other') {
    const existing = await collectTree(target);
    if (existing.generation !== sourceGeneration) throw new Error('Migration backup generation collision.');
    return target;
  }
  await mkdir(targetParent, { recursive: true });
  try {
    for (const entry of sourceTree.entries) {
      const destination = join(target, ...entry.path.split('/'));
      if (entry.kind === 'directory') {
        await mkdir(destination, { recursive: true });
      } else {
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, entry.bytes ?? new Uint8Array());
      }
    }
    const copied = await collectTree(target);
    if (copied.generation !== sourceGeneration) throw new Error('Migration source backup verification failed.');
    return target;
  } catch (error) {
    await removeGeneratedPath(target, targetParent, 'source').catch(() => undefined);
    throw error;
  }
}

async function writeCandidateTree(stagingRoot: string, files: readonly NormalizedCandidateFile[]): Promise<void> {
  await mkdir(stagingRoot, { recursive: true });
  for (const file of files) {
    const destination = resolve(stagingRoot, ...file.path.split('/'));
    if (!isStrictChild(stagingRoot, destination)) throw new Error('Candidate path escaped staging root.');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.bytes);
  }
}

export async function applySourceMigration(
  options: SourceMigrationApplyOptions,
): Promise<OperationResult<SourceMigrationApplyReport>> {
  if (options.accept !== true) {
    return failure('USAGE_ERROR', [problem(SOURCE_MIGRATION_CODES.REVIEW_REQUIRED, 'Apply requires explicit accept=true after a reviewed preview.')]);
  }
  if (!options.preview || !options.expectedSourceGeneration) {
    return failure('USAGE_ERROR', [problem(SOURCE_MIGRATION_CODES.PREVIEW_REQUIRED, 'Apply requires a preview and its expected source generation.')]);
  }
  const paths = await validatePaths(options);
  if (!paths.ok) return paths.result;
  const preview = options.preview;
  if (resolve(preview.projectRoot) !== paths.projectRoot || resolve(preview.sourceRoot) !== paths.sourceRoot || resolve(preview.contentRoot) !== paths.contentRoot) {
    return failure('PATH_ERROR', [problem(SOURCE_MIGRATION_CODES.PREVIEW_MISMATCH, 'Preview paths do not match apply paths.')]);
  }
  const candidates = normalizeCandidateFiles(preview.candidateFiles);
  if (candidates.problems.length > 0 || !candidates.files) return failure('USAGE_ERROR', candidates.problems);
  if (options.candidateFiles !== undefined) {
    const supplied = normalizeCandidateFiles(options.candidateFiles);
    if (supplied.problems.length > 0 || !supplied.files) return failure('USAGE_ERROR', supplied.problems);
    if (hashCandidateFiles(supplied.files) !== preview.candidateGeneration) {
      return failure('USAGE_ERROR', [problem(SOURCE_MIGRATION_CODES.PREVIEW_MISMATCH, 'Apply candidate bytes do not match the reviewed preview.')]);
    }
  }
  if (hashCandidateFiles(candidates.files) !== preview.candidateGeneration) {
    return failure('USAGE_ERROR', [problem(SOURCE_MIGRATION_CODES.PREVIEW_MISMATCH, 'Preview candidate generation does not match candidate bytes.')]);
  }
  let sourceTree: SourceTree;
  try {
    sourceTree = await collectTree(paths.sourceRoot);
  } catch (error) {
    const detail = error as Problem;
    return failure('PATH_ERROR', [detail.code ? detail : problem(SOURCE_MIGRATION_CODES.SOURCE_MISSING, String(error))]);
  }
  if (sourceTree.generation !== preview.sourceGeneration || options.expectedSourceGeneration !== preview.sourceGeneration) {
    return failure('COMMAND_FAILED', [problem(SOURCE_MIGRATION_CODES.PREVIEW_STALE, 'Active source changed since the reviewed preview was generated.', paths.sourceRoot)]);
  }
  if (preview.noPromotableAuthoredData && candidates.files.length === 0) {
    return failure('COMMAND_FAILED', [problem(SOURCE_MIGRATION_CODES.NO_AUTHORED_DATA, 'Active source contains no promotable authored data; empty skeleton migration is blocked.')]);
  }
  if (candidates.files.length === 0) {
    return failure('COMMAND_FAILED', [problem(SOURCE_MIGRATION_CODES.CANDIDATE_INVALID, 'A reviewed content candidate is required before apply.')]);
  }
  if (!candidates.files.some((file) => file.path === 'manifest.json')) {
    return failure('USAGE_ERROR', [problem(SOURCE_MIGRATION_CODES.CANDIDATE_MANIFEST, 'A content candidate must include manifest.json.')]);
  }

  const backupRoot = resolve(options.backupRoot ?? join(paths.projectRoot, '.migration-backups'));
  if (!isStrictChild(paths.projectRoot, backupRoot) || pathInside(paths.sourceRoot, backupRoot) || pathInside(paths.contentRoot, backupRoot)) {
    return failure('PATH_ERROR', [problem(SOURCE_MIGRATION_CODES.PATH_ESCAPE, 'backupRoot must be a separate strict child of projectRoot.')]);
  }
  const contentParent = dirname(paths.contentRoot);
  const contentName = paths.contentRoot.split(/[\\/]/u).at(-1) ?? 'content';
  const stagingRoot = generatedSibling(contentParent, contentName, 'migration-staging', preview.candidateGeneration);
  const atomicBackup = generatedSibling(contentParent, contentName, 'migration-backup', preview.candidateGeneration);
  let sourceBackupPath = '';
  try {
    await assertRealPathInside(paths.projectRoot, backupRoot);
    sourceBackupPath = await ensureBackup(sourceTree.generation, backupRoot, sourceTree);
    await removeGeneratedPath(stagingRoot, contentParent, `.${contentName}.migration-staging-`).catch(() => undefined);
    await writeCandidateTree(stagingRoot, candidates.files);
    await publishAtomicDirectory({
      root: contentParent,
      stagingPath: stagingRoot,
      finalPath: paths.contentRoot,
      backupPath: atomicBackup,
      rename: options.rename,
      remove: options.remove,
    });
    return success({
      sourceGeneration: sourceTree.generation,
      candidateGeneration: preview.candidateGeneration,
      backupPath: sourceBackupPath,
      publishedContentRoot: paths.contentRoot,
      noPromotableAuthoredData: false,
    });
  } catch (error) {
    await removeGeneratedPath(stagingRoot, contentParent, `.${contentName}.migration-staging-`).catch(() => undefined);
    return failure('COMMAND_FAILED', [problem(SOURCE_MIGRATION_CODES.APPLY_FAILED, error instanceof Error ? error.message : String(error))]);
  }
}

export const sourceMigrationPreview = previewSourceMigration;
export const sourceMigrationApply = applySourceMigration;
