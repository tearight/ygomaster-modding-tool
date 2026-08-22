import { existsSync } from 'node:fs';
import path from 'node:path';

const isPortableRoot = (candidate: string): boolean =>
  existsSync(path.join(candidate, 'manifest.json'))
  && existsSync(path.join(candidate, 'cli'))
  && existsSync(path.join(candidate, 'core'));

const isSourceRoot = (candidate: string): boolean =>
  existsSync(path.join(candidate, 'package.json'))
  && existsSync(path.join(candidate, 'src', 'core'));

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
