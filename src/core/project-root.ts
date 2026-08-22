import { existsSync } from 'node:fs';
import path from 'node:path';

const isPortableRoot = (candidate: string): boolean =>
  existsSync(path.join(candidate, 'manifest.json'))
  && existsSync(path.join(candidate, 'cli'))
  && existsSync(path.join(candidate, 'core'));

const isSourceRoot = (candidate: string): boolean =>
  existsSync(path.join(candidate, 'package.json'))
  && existsSync(path.join(candidate, 'src', 'core'));

const isWorkspaceDataRoot = (candidate: string): boolean =>
  existsSync(path.join(candidate, 'campaign', 'source', 'manifest.json'));

/**
 * Resolve the shared project root from a source, compiled, CLI, or packaged
 * application anchor. The portable release's app and cli are siblings under
 * one root, so both must resolve to that parent for .local/.cache sharing.
 */
export const resolveProjectRoot = (anchor: string): string => {
  let current = path.resolve(anchor);
  for (let depth = 0; depth <= 8; depth += 1) {
    if (isPortableRoot(current) || isSourceRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(anchor);
};

/**
 * Resolve the shared data root used by workspace and portable catalog data.
 * A source checkout and a packaged release may live below one workspace; an
 * extracted portable ZIP has no campaign tree, so it safely falls back to the
 * portable/project root supplied by the caller.
 */
export const resolveWorkspaceDataRoot = (anchor: string): string => {
  let current = path.resolve(anchor);
  for (let depth = 0; depth <= 8; depth += 1) {
    if (isWorkspaceDataRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(anchor);
};
