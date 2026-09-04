import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertRealPathInside,
  ensureDirectory,
  pathInside,
} from './fs';
import { validateIrGenerationMetadata } from './layers';
import type { IRGenerationMetadata } from './layers';
import type { DeckIR } from './deck-content';
import type { GateCompileIR } from './gate-content';
import type { StructureProjection } from './structure-content';
import type { JsonObject, Problem } from './types';
import { reloadDeckIr } from './deck-content';

export const IR_PROJECTION_WRITER_CODES = Object.freeze({
  OPTIONS_INVALID: 'IR_PROJECTION_OPTIONS_INVALID',
  STAGING_INVALID: 'IR_PROJECTION_STAGING_INVALID',
  STAGING_NOT_EMPTY: 'IR_PROJECTION_STAGING_NOT_EMPTY',
  PATH_INVALID: 'IR_PROJECTION_PATH_INVALID',
  PATH_ESCAPE: 'IR_PROJECTION_PATH_ESCAPE',
  PATH_COLLISION: 'IR_PROJECTION_PATH_COLLISION',
  SYMLINK_FORBIDDEN: 'IR_PROJECTION_SYMLINK_FORBIDDEN',
  MANIFEST_INVALID: 'IR_PROJECTION_MANIFEST_INVALID',
  GENERATION_INVALID: 'IR_PROJECTION_GENERATION_INVALID',
  PROVENANCE_INVALID: 'IR_PROJECTION_PROVENANCE_INVALID',
  DECK_INVALID: 'IR_PROJECTION_DECK_INVALID',
  GATE_INVALID: 'IR_PROJECTION_GATE_INVALID',
  STRUCTURE_INVALID: 'IR_PROJECTION_STRUCTURE_INVALID',
  TARGET_INVALID: 'IR_PROJECTION_TARGET_INVALID',
  PRESERVED_SOURCE_INVALID: 'IR_PROJECTION_PRESERVED_SOURCE_INVALID',
  PRESERVED_READ_FAILED: 'IR_PROJECTION_PRESERVED_READ_FAILED',
} as const);

export type IrProjectionWriterCode = (typeof IR_PROJECTION_WRITER_CODES)[keyof typeof IR_PROJECTION_WRITER_CODES];

export type IrProjectionFile = string | Uint8Array | JsonObject;

export interface IrProjectionWriterInput {
  stagingRoot: string;
  manifest: JsonObject;
  decks: Record<string, DeckIR>;
  gates: readonly GateCompileIR[];
  structures: readonly StructureProjection[];
  /** Validated campaign analysis graphs; never deployed into YgoMaster Data. */
  graphs?: Record<string, JsonObject>;
  /** Structure projection path or numeric structure id to legacy deck reference. */
  structureDecks?: Record<string, string>;
  structureMetadata?: Record<string, { name?: string; description?: string }>;
  /** Relative YgoMaster Data target files. JSON objects are serialized deterministically. */
  target?: Record<string, IrProjectionFile>;
  /** Compatibility spelling for callers that keep localization projections separate. */
  localization?: Record<string, IrProjectionFile>;
  generation: IRGenerationMetadata;
  provenance: JsonObject;
  /** Existing source is read-only; only the explicit preservation allowlist is copied. */
  preservedSourceRoot?: string;
}

export interface IrStaleDisposition {
  path: string;
  disposition: 'stale-not-preserved';
}

export interface IrProjectionWriterResult {
  ok: boolean;
  files: string[];
  staleDisposition: IrStaleDisposition[];
  problems: Problem[];
}

interface PlannedFile {
  path: string;
  bytes: Uint8Array;
  owner: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(compareOrdinal)
      .map((key) => [key, stableValue(value[key])]),
  );
};

const jsonBytes = (value: unknown): Uint8Array =>
  Buffer.from(`${JSON.stringify(stableValue(value), null, 2)}\n`, 'utf8');

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const diagnostic = (code: string, message: string, sourcePath?: string): Problem => ({
  code,
  message,
  ...(sourcePath ? { sourcePath, path: sourcePath } : {}),
});

const problemSort = (left: Problem, right: Problem): number =>
  compareOrdinal(left.sourcePath || left.path || '', right.sourcePath || right.path || '')
  || compareOrdinal(left.jsonPointer || '', right.jsonPointer || '')
  || compareOrdinal(left.code, right.code)
  || compareOrdinal(left.message, right.message);

const sortedProblems = (problems: readonly Problem[]): Problem[] => [...problems].sort(problemSort);

const safeRelative = (value: string): boolean => {
  if (!value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value
    && normalized !== '.'
    && !normalized.split('/').some((segment) => !segment || segment === '..');
};

const outputPath = (stagingRoot: string, relative: string): string => path.resolve(stagingRoot, ...relative.split('/'));

const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;

const fileBytes = (value: IrProjectionFile, relative: string): Uint8Array => {
  if (isBytes(value)) return new Uint8Array(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (isRecord(value)) return jsonBytes(value);
  throw new Error(`Target file must be text, bytes, or a JSON object: ${relative}`);
};

const normalizedOutputRelative = (
  raw: unknown,
  family: 'gate' | 'deck' | 'structure' | 'target',
): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.replace(/\\/gu, '/');
  if (family === 'structure' && normalized.startsWith('Data/StructureDecks/')) {
    const basename = path.posix.basename(normalized);
    return basename ? `structure/${basename}` : undefined;
  }
  if (family === 'target') {
    const relative = normalized.startsWith('Data/') ? normalized : `Data/${normalized}`;
    if (!relative.startsWith('target/ygomaster/')) return `target/ygomaster/${relative}`;
  }
  return normalized;
};

const preserveAllowed = (relative: string): boolean =>
  relative === 'README.md'
  || relative === '.ygomaster-source.json'
  || relative === '.gitkeep'
  || relative.startsWith('card-db/');

const mergeUnknown = (current: unknown, previous: unknown): unknown => {
  if (!isRecord(current) || !isRecord(previous)) return current;
  const merged: Record<string, unknown> = { ...current };
  for (const key of Object.keys(previous)) {
    if (merged[key] === undefined) merged[key] = previous[key];
    else if (isRecord(merged[key]) && isRecord(previous[key])) merged[key] = mergeUnknown(merged[key], previous[key]);
  }
  return merged;
};

const readJson = async (filePath: string): Promise<unknown> => {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/u, '')) as unknown;
};

const assertRealDirectory = async (root: string, code: string, label: string): Promise<Problem[]> => {
  try {
    const stats = await fs.lstat(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return [diagnostic(code, `${label} must be a real directory: ${root}`, root)];
    await assertRealPathInside(root, root);
    return [];
  } catch (error) {
    return [diagnostic(code, `${label} is not safe: ${errorMessage(error)}`, root)];
  }
};

const addPlanned = (
  planned: Map<string, PlannedFile>,
  problems: Problem[],
  relative: string,
  bytes: Uint8Array,
  owner: string,
): void => {
  if (!safeRelative(relative)) {
    problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.PATH_INVALID, `Generated path must be a safe relative POSIX path: ${relative}`, relative));
    return;
  }
  const existing = planned.get(relative);
  if (existing) {
    problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.PATH_COLLISION, `Generated path collides between ${existing.owner} and ${owner}: ${relative}`, relative));
    return;
  }
  planned.set(relative, { path: relative, bytes: new Uint8Array(bytes), owner });
};

const collectSourceFiles = async (
  root: string,
): Promise<{ files: Array<{ path: string; bytes: Uint8Array }>; problems: Problem[] }> => {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const problems: Problem[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.PRESERVED_READ_FAILED, `Cannot enumerate preserved source: ${errorMessage(error)}`, directory));
      return;
    }
    entries.sort((left, right) => compareOrdinal(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      try {
        await assertRealPathInside(root, absolute);
        const stats = await fs.lstat(absolute);
        if (stats.isSymbolicLink()) {
          problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.SYMLINK_FORBIDDEN, `Preserved source contains a symlink or junction: ${relative}`, relative));
        } else if (stats.isDirectory()) {
          await visit(absolute);
        } else if (stats.isFile()) {
          files.push({ path: relative, bytes: await fs.readFile(absolute) });
        } else {
          problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.PRESERVED_SOURCE_INVALID, `Preserved source entry is not a regular file: ${relative}`, relative));
        }
      } catch (error) {
        problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.PATH_ESCAPE, `Preserved source path is unsafe: ${relative} (${errorMessage(error)})`, relative));
      }
    }
  };
  await visit(root);
  files.sort((left, right) => compareOrdinal(left.path, right.path));
  return { files, problems };
};

/** Write one validated compiled-family bundle into a caller-created empty IR staging root. */
export const writeIrProjection = async (
  input: IrProjectionWriterInput,
): Promise<IrProjectionWriterResult> => {
  const problems: Problem[] = [];
  const staleDisposition: IrStaleDisposition[] = [];
  const planned = new Map<string, PlannedFile>();
  if (!input || typeof input.stagingRoot !== 'string' || !isRecord(input.manifest) || !isRecord(input.provenance)) {
    return {
      ok: false,
      files: [],
      staleDisposition,
      problems: [diagnostic(IR_PROJECTION_WRITER_CODES.OPTIONS_INVALID, 'stagingRoot, manifest, and provenance are required')],
    };
  }
  problems.push(...await assertRealDirectory(input.stagingRoot, IR_PROJECTION_WRITER_CODES.STAGING_INVALID, 'Staging root'));
  if (problems.length) return { ok: false, files: [], staleDisposition, problems: sortedProblems(problems) };
  const existingEntries = await fs.readdir(input.stagingRoot, { withFileTypes: true });
  if (existingEntries.length) {
    problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.STAGING_NOT_EMPTY, 'IR staging root must be empty before projection write', input.stagingRoot));
    return { ok: false, files: [], staleDisposition, problems: sortedProblems(problems) };
  }

  const manifest = { ...input.manifest } as JsonObject;
  const generationProblems = validateIrGenerationMetadata(input.generation);
  if (generationProblems.length) problems.push(...generationProblems.map((entry) => ({ ...entry, code: IR_PROJECTION_WRITER_CODES.GENERATION_INVALID })));
  if (!isRecord(input.provenance)) problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.PROVENANCE_INVALID, 'Provenance must be a JSON object', 'provenance.json'));
  addPlanned(planned, problems, 'manifest.json', jsonBytes(manifest), 'manifest');
  addPlanned(planned, problems, 'generation.json', jsonBytes(input.generation), 'generation');
  addPlanned(planned, problems, 'provenance.json', jsonBytes(input.provenance), 'provenance');

  for (const [relativeDeckPath, deck] of Object.entries(input.decks || {}).sort(([left], [right]) => compareOrdinal(left, right))) {
    try {
      addPlanned(planned, problems, `deck/${relativeDeckPath.replace(/\\/gu, '/')}`, jsonBytes(reloadDeckIr(deck)), `deck:${relativeDeckPath}`);
    } catch (error) {
      problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.DECK_INVALID, `Deck ${relativeDeckPath} is not a valid DeckIR: ${errorMessage(error)}`, relativeDeckPath));
    }
  }

  for (const [gateIndex, gate] of (input.gates || []).entries()) {
    if (!isRecord(gate) || !isRecord(gate.sourceFiles)) {
      problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.GATE_INVALID, `Gate bundle ${gateIndex} has no sourceFiles object`, `gate[${gateIndex}]`));
      continue;
    }
    for (const [relative, document] of Object.entries(gate.sourceFiles).sort(([left], [right]) => compareOrdinal(left, right))) {
      const output = normalizedOutputRelative(relative, 'gate');
      if (!output || !output.startsWith('gate/')) {
        problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.PATH_INVALID, `Gate source file must stay under gate/: ${relative}`, relative));
        continue;
      }
      if (!isRecord(document)) {
        problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.GATE_INVALID, `Gate source file must contain a JSON object: ${relative}`, relative));
        continue;
      }
      addPlanned(planned, problems, output, jsonBytes(document), `gate:${relative}`);
    }
  }

  for (const [index, structure] of (input.structures || []).entries()) {
    if (!isRecord(structure) || typeof structure.path !== 'string' || !isRecord(structure.document)) {
      problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.STRUCTURE_INVALID, `Structure projection ${index} is invalid`, `structure[${index}]`));
      continue;
    }
    const output = normalizedOutputRelative(structure.path, 'structure');
    if (!output || !output.startsWith('structure/')) {
      problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.PATH_INVALID, `Structure projection path is invalid: ${structure.path}`, structure.path));
      continue;
    }
    const structureId = structure.document.structure_id;
    const deckReference = input.structureDecks?.[structure.path]
      || (typeof structureId === 'number' ? input.structureDecks?.[String(structureId)] : undefined);
    const metadata = input.structureMetadata?.[structure.path]
      || (typeof structureId === 'number' ? input.structureMetadata?.[String(structureId)] : undefined);
    if (!Number.isInteger(structureId) || typeof deckReference !== 'string' || !deckReference) {
      problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.STRUCTURE_INVALID, `Structure projection requires numeric structure_id and a generated deck reference: ${structure.path}`, structure.path));
      continue;
    }
    const accessory = structure.document.accessory as Record<string, unknown> | undefined;
    const focus = structure.document.focus as { ids?: unknown } | undefined;
    addPlanned(planned, problems, output, jsonBytes({
      id: structureId,
      deck: deckReference,
      ...(typeof accessory?.box === 'number' ? { box: accessory.box } : {}),
      ...(typeof accessory?.sleeve === 'number' ? { sleeve: accessory.sleeve } : {}),
      ...(Array.isArray(focus?.ids) ? { focus: focus.ids } : {}),
      ...(metadata?.name ? { name: metadata.name } : {}),
      ...(metadata?.description ? { description: metadata.description } : {}),
    }), `structure:${structure.path}`);
  }

  for (const [relative, graph] of Object.entries(input.graphs || {}).sort(([left], [right]) => compareOrdinal(left, right))) {
    const output = `graph/${relative.replace(/\\/gu, '/')}`;
    if (!output.endsWith('.json') || !isRecord(graph)) {
      problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.PATH_INVALID, `Graph projection must be a JSON object with a .json path: ${relative}`, relative));
      continue;
    }
    addPlanned(planned, problems, output, jsonBytes(graph), `graph:${relative}`);
  }

  const targetFiles = { ...(input.localization || {}), ...(input.target || {}) };
  for (const [relative, value] of Object.entries(targetFiles).sort(([left], [right]) => compareOrdinal(left, right))) {
    const output = normalizedOutputRelative(relative, 'target');
    if (!output || !output.startsWith('target/ygomaster/Data/')) {
      problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.TARGET_INVALID, `Target path is invalid: ${relative}`, relative));
      continue;
    }
    try {
      addPlanned(planned, problems, output, fileBytes(value, relative), `target:${relative}`);
    } catch (error) {
      problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.TARGET_INVALID, errorMessage(error), relative));
    }
  }

  if (input.preservedSourceRoot) {
    const sourceProblems = await assertRealDirectory(input.preservedSourceRoot, IR_PROJECTION_WRITER_CODES.PRESERVED_SOURCE_INVALID, 'Preserved source root');
    problems.push(...sourceProblems);
    if (!sourceProblems.length) {
      const source = await collectSourceFiles(input.preservedSourceRoot);
      problems.push(...source.problems);
      for (const file of source.files) {
        if (file.path === 'manifest.json') {
          try {
            const previous = await readJson(path.join(input.preservedSourceRoot, file.path));
            const merged = mergeUnknown(manifest, previous);
            planned.delete('manifest.json');
            addPlanned(planned, problems, 'manifest.json', jsonBytes(merged), 'manifest+preserved-unknown');
          } catch (error) {
            problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.PRESERVED_READ_FAILED, `Preserved manifest cannot be read: ${errorMessage(error)}`, file.path));
          }
          continue;
        }
        if (!preserveAllowed(file.path)) {
          staleDisposition.push({ path: file.path, disposition: 'stale-not-preserved' });
          continue;
        }
        addPlanned(planned, problems, file.path, file.bytes, `preserved:${file.path}`);
      }
    }
  }

  if (problems.length) return { ok: false, files: [], staleDisposition: staleDisposition.sort((left, right) => compareOrdinal(left.path, right.path)), problems: sortedProblems(problems) };

  const files = [...planned.keys()].sort(compareOrdinal);
  try {
    for (const relative of files) {
      const target = outputPath(input.stagingRoot, relative);
      if (!pathInside(input.stagingRoot, target)) throw new Error(`Generated path escapes staging root: ${relative}`);
      await ensureDirectory(path.dirname(target));
      await assertRealPathInside(input.stagingRoot, target);
      await fs.writeFile(target, planned.get(relative)?.bytes as Uint8Array);
    }
  } catch (error) {
    problems.push(diagnostic(IR_PROJECTION_WRITER_CODES.PATH_ESCAPE, `IR projection write failed closed: ${errorMessage(error)}`, input.stagingRoot));
    return { ok: false, files: [], staleDisposition: staleDisposition.sort((left, right) => compareOrdinal(left.path, right.path)), problems: sortedProblems(problems) };
  }
  return {
    ok: true,
    files,
    staleDisposition: staleDisposition.sort((left, right) => compareOrdinal(left.path, right.path)),
    problems: [],
  };
};

export const writeIrProjectionStaging = writeIrProjection;
export const writeLegacyIrProjection = writeIrProjection;
