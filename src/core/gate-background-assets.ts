import type { IdRegistry } from './id-registry';
import type { IrProjectionFile } from './ir-projection-writer';
import type { Problem } from './types';
import { problem } from './types';

export const GATE_BACKGROUND_CODES = Object.freeze({
  MANIFEST_MISSING: 'GATE_BACKGROUND_MANIFEST_MISSING',
  REFERENCE_INVALID: 'GATE_BACKGROUND_REFERENCE_INVALID',
  REFERENCE_ORPHAN: 'GATE_BACKGROUND_REFERENCE_ORPHAN',
  MISSING: 'GATE_BACKGROUND_MISSING',
  DUPLICATE: 'GATE_BACKGROUND_DUPLICATE',
  PNG_INVALID: 'GATE_BACKGROUND_PNG_INVALID',
  DIMENSIONS_INVALID: 'GATE_BACKGROUND_DIMENSIONS_INVALID',
} as const);

export interface GateBackgroundAsset {
  key: string;
  sourcePath: string;
  manifestSourcePath: string;
  gateRefs: readonly string[];
  bytes: Uint8Array;
}

export interface PngDimensions {
  width: number;
  height: number;
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export const inspectGateBackgroundPng = (bytes: Uint8Array): PngDimensions | undefined => {
  if (bytes.length < 24 || pngSignature.some((value, index) => bytes[index] !== value)) return undefined;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0 ? { width, height } : undefined;
};

export const validateGateBackgroundPng = (asset: Pick<GateBackgroundAsset, 'sourcePath' | 'bytes'>): Problem[] => {
  const dimensions = inspectGateBackgroundPng(asset.bytes);
  if (!dimensions) return [problem(GATE_BACKGROUND_CODES.PNG_INVALID, 'Solo Gate background must be a valid PNG with an IHDR header', asset.sourcePath)];
  if (dimensions.width !== dimensions.height || dimensions.width < 256 || dimensions.width > 2048) {
    return [problem(
      GATE_BACKGROUND_CODES.DIMENSIONS_INVALID,
      `Solo Gate background must be square and between 256 and 2048 pixels; got ${dimensions.width}x${dimensions.height}`,
      asset.sourcePath,
    )];
  }
  return [];
};

const gateKey = (reference: string): string | undefined => {
  const normalized = reference.trim();
  if (!/^gate:[a-z0-9][a-z0-9._-]*$/u.test(normalized)) return undefined;
  return normalized.slice('gate:'.length);
};

export const projectGateBackgrounds = (
  authoredGateRefs: readonly string[],
  assets: readonly GateBackgroundAsset[],
  registry: IdRegistry,
): { overlay: Record<string, IrProjectionFile>; problems: Problem[] } => {
  const problems: Problem[] = [];
  const expected = new Set(authoredGateRefs);
  const assigned = new Map<string, GateBackgroundAsset>();
  for (const asset of assets) {
    problems.push(...validateGateBackgroundPng(asset));
    for (const reference of asset.gateRefs) {
      const key = gateKey(reference);
      if (!key) {
        problems.push(problem(GATE_BACKGROUND_CODES.REFERENCE_INVALID, `Gate background reference must use gate:<key>: ${reference}`, asset.manifestSourcePath));
        continue;
      }
      if (!expected.has(reference)) {
        problems.push(problem(GATE_BACKGROUND_CODES.REFERENCE_ORPHAN, `Gate background references an unknown authored Gate: ${reference}`, asset.manifestSourcePath));
        continue;
      }
      if (assigned.has(reference)) {
        problems.push(problem(GATE_BACKGROUND_CODES.DUPLICATE, `More than one background is assigned to ${reference}`, asset.manifestSourcePath));
        continue;
      }
      assigned.set(reference, asset);
    }
  }
  for (const reference of [...expected].sort()) {
    if (!assigned.has(reference)) problems.push(problem(GATE_BACKGROUND_CODES.MISSING, `Custom Solo Gate requires a background PNG: ${reference}`, 'assets/manifest.json'));
  }
  const overlay: Record<string, IrProjectionFile> = {};
  if (problems.length) return { overlay, problems };
  for (const [reference, asset] of assigned) {
    const key = gateKey(reference) as string;
    const assignment = registry.namespaces.gate.assignments[key];
    if (!assignment) {
      problems.push(problem(GATE_BACKGROUND_CODES.REFERENCE_ORPHAN, `No target Gate ID was allocated for ${reference}`, asset.manifestSourcePath));
      continue;
    }
    overlay[`ClientData/SoloGateBackgrounds/${assignment.id}.png`] = new Uint8Array(asset.bytes);
  }
  return { overlay, problems };
};
