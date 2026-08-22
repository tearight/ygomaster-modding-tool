import * as fs from 'node:fs/promises';
import path from 'node:path';

import { cloneJson, readJsonc, writeJson } from './json';

export const pathInside = (root: string, candidate: string): boolean => {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
};

const nearestExistingPath = async (candidate: string): Promise<string> => {
  let current = path.resolve(candidate);
  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
};

/** Check lexical containment and the real path of every existing parent. */
export const assertRealPathInside = async (root: string, candidate: string): Promise<void> => {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!pathInside(resolvedRoot, resolvedCandidate)) throw new Error(`Path escapes root: ${candidate}`);
  const rootAnchor = await nearestExistingPath(resolvedRoot);
  const candidateAnchor = await nearestExistingPath(resolvedCandidate);
  const rootReal = await fs.realpath(rootAnchor);
  const candidateReal = await fs.realpath(candidateAnchor);
  if (!pathInside(rootReal, candidateReal)) throw new Error(`Symlink path escapes root: ${candidate}`);
  try {
    const stats = await fs.lstat(resolvedCandidate);
    if (stats.isSymbolicLink()) throw new Error(`Symlink document is not allowed: ${candidate}`);
    const candidateRealPath = await fs.realpath(resolvedCandidate);
    if (!pathInside(rootReal, candidateRealPath)) throw new Error(`Symlink path escapes root: ${candidate}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

export const resolveInside = (root: string, relativePath: string): string => {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\')) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('\0')) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }
  const resolved = path.resolve(root, ...normalized.split('/'));
  if (!pathInside(root, resolved)) throw new Error(`Path escapes root: ${relativePath}`);
  return resolved;
};

export const resolveSafeInside = async (root: string, relativePath: string): Promise<string> => {
  const resolved = resolveInside(root, relativePath);
  await assertRealPathInside(root, resolved);
  return resolved;
};

export const ensureDirectory = (directory: string) => fs.mkdir(directory, { recursive: true });

export const exists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const listFiles = async (root: string, extension?: string): Promise<string[]> => {
  if (!(await exists(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    await assertRealPathInside(root, entryPath);
    if (entry.isDirectory()) results.push(...(await listFiles(entryPath, extension)));
    else if (!extension || entry.name.toLowerCase().endsWith(extension.toLowerCase())) results.push(entryPath);
  }
  return results.sort();
};

export const atomicWriteText = async (
  filePath: string,
  text: string,
  replace = true,
): Promise<void> => {
  await ensureDirectory(path.dirname(filePath));
  if (!replace && (await exists(filePath))) throw new Error(`File already exists: ${filePath}`);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tempPath, text, 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
};

export const atomicWriteJson = async (
  filePath: string,
  value: unknown,
  replace = true,
): Promise<void> => atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`, replace);

export const moveToTrash = async (
  root: string,
  relativePath: string,
  kind = 'deleted',
): Promise<string> => {
  const sourcePath = await resolveSafeInside(root, relativePath);
  if (!(await exists(sourcePath))) throw new Error(`File does not exist: ${relativePath}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const trashPrefix = kind === 'deleted' ? '.trash' : path.posix.join('.trash', kind);
  let trashRelative = path.posix.join(trashPrefix, stamp, relativePath);
  let trashPath = await resolveSafeInside(root, trashRelative);
  let suffix = 1;
  while (await exists(trashPath)) {
    trashRelative = path.posix.join(trashPrefix, `${stamp}-${suffix}`, relativePath);
    trashPath = await resolveSafeInside(root, trashRelative);
    suffix += 1;
  }
  await ensureDirectory(path.dirname(trashPath));
  await fs.rename(sourcePath, trashPath);
  return trashRelative;
};

export const copyDirectory = async (source: string, target: string): Promise<void> => {
  await ensureDirectory(path.dirname(target));
  await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true });
};

export const removeExact = async (target: string): Promise<void> => fs.rm(target, { recursive: true, force: true });

export const readJsonFile = <T = unknown>(filePath: string) => readJsonc<T>(filePath);

export const writeJsonFile = async (filePath: string, value: unknown): Promise<void> =>
  writeJson(filePath, cloneJson(value));
