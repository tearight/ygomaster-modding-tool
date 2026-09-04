import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  assertRealPathInside,
  atomicWriteJson,
  ensureDirectory,
  exists,
  removeExact,
} from './fs';
import { cloneJson, readJsonc, serializePayload, unwrapPayload } from './json';
import type { JsonObject } from './types';

export type DiagnosticSoloEnvelope = 'exact' | 'preserve-runtime';

export interface DiagnosticProjectionInspection {
  root: string;
  generation: string;
  files: string[];
}

export interface DiagnosticProjectionApplyResult extends DiagnosticProjectionInspection {
  changedFiles: string[];
}

const normalizeRelative = (root: string, file: string): string =>
  path.relative(root, file).split(path.sep).join('/');

const requiredFiles = [
  'Data/Solo.json',
  'Data/ClientData/IDS/IDS_SOLO.txt',
  'Data/ClientData/SoloGateCards.txt',
] as const;

const allowedProjectionFile = (relative: string): boolean => {
  const normalized = relative.toLowerCase();
  return normalized === 'data/solo.json'
    || normalized === 'data/clientdata/ids/ids_solo.txt'
    || normalized === 'data/clientdata/sologatecards.txt'
    || /^data\/soloduels\/\d+\.json$/u.test(normalized)
    || /^data\/clientdata\/sologatebackgrounds\/\d+\.png$/u.test(normalized);
};

const allowedProjectionDirectory = (relative: string): boolean => [
  '',
  'data',
  'data/soloduels',
  'data/clientdata',
  'data/clientdata/ids',
  'data/clientdata/sologatebackgrounds',
].includes(relative.toLowerCase());

const collectProjectionFiles = async (root: string): Promise<string[]> => {
  const rootStats = await fs.lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('Diagnostic projection root must be a real directory');
  }
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    await assertRealPathInside(root, directory);
    const directoryRelative = normalizeRelative(root, directory);
    if (!allowedProjectionDirectory(directoryRelative)) {
      throw new Error(`Unsupported diagnostic projection directory: ${directoryRelative}`);
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      await assertRealPathInside(root, absolute);
      const stats = await fs.lstat(absolute);
      if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
        throw new Error(`Diagnostic projection cannot contain symlinks: ${normalizeRelative(root, absolute)}`);
      }
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(absolute);
      else throw new Error(`Diagnostic projection cannot contain special entries: ${normalizeRelative(root, absolute)}`);
    }
  };
  await visit(root);
  return output.sort((left, right) => normalizeRelative(root, left).localeCompare(normalizeRelative(root, right), 'en'));
};

const projectionGeneration = async (root: string, files: readonly string[]): Promise<string> => {
  const hash = createHash('sha256');
  for (const file of files) {
    const relative = normalizeRelative(root, file);
    const bytes = await fs.readFile(file);
    hash.update(relative, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(String(bytes.byteLength), 'utf8');
    hash.update('\0', 'utf8');
    hash.update(bytes);
  }
  return `sha256-${hash.digest('hex')}`;
};

export const inspectDiagnosticProjection = async (
  projectionRootInput: string,
): Promise<DiagnosticProjectionInspection> => {
  const root = path.resolve(projectionRootInput);
  if (!(await exists(root))) throw new Error(`Diagnostic projection does not exist: ${root}`);
  const files = await collectProjectionFiles(root);
  const relatives = files.map((file) => normalizeRelative(root, file));
  const unsupported = relatives.find((relative) => !allowedProjectionFile(relative));
  if (unsupported) throw new Error(`Unsupported diagnostic projection file: ${unsupported}`);
  for (const required of requiredFiles) {
    if (!relatives.some((relative) => relative.toLowerCase() === required.toLowerCase())) {
      throw new Error(`Diagnostic projection is missing required file: ${required}`);
    }
  }
  if (!relatives.some((relative) => /^Data\/SoloDuels\/\d+\.json$/iu.test(relative))) {
    throw new Error('Diagnostic projection requires at least one Data/SoloDuels/<chapterId>.json file');
  }
  if (!relatives.some((relative) => /^Data\/ClientData\/SoloGateBackgrounds\/\d+\.png$/iu.test(relative))) {
    throw new Error('Diagnostic projection requires at least one numeric Solo Gate background PNG');
  }
  for (const file of files.filter((entry) => entry.toLowerCase().endsWith('.json'))) {
    await readJsonc(file);
  }
  return { root, generation: await projectionGeneration(root, files), files: relatives };
};

const copyProjectionFile = async (projectionRoot: string, runtimeRoot: string, relative: string): Promise<void> => {
  const source = path.resolve(projectionRoot, ...relative.split('/'));
  const target = path.resolve(runtimeRoot, ...relative.split('/'));
  await assertRealPathInside(projectionRoot, source);
  await assertRealPathInside(runtimeRoot, target);
  await ensureDirectory(path.dirname(target));
  await fs.copyFile(source, target);
};

const preserveRuntimeSoloEnvelope = async (
  projectionRoot: string,
  runtimeRoot: string,
): Promise<void> => {
  const projectionPath = path.join(projectionRoot, 'Data', 'Solo.json');
  const runtimePath = path.join(runtimeRoot, 'Data', 'Solo.json');
  const projectionDocument = await readJsonc<JsonObject>(projectionPath);
  const projectionSource = unwrapPayload<JsonObject>(projectionDocument, 'Master');
  const projectionMaster = projectionSource.payload;
  const projectionSolo = projectionMaster.Solo;
  if (!projectionSolo || typeof projectionSolo !== 'object' || Array.isArray(projectionSolo)) {
    throw new Error('Diagnostic projection Data/Solo.json does not contain Master.Solo');
  }
  const runtimeDocument = await readJsonc<JsonObject>(runtimePath);
  const runtimeSource = unwrapPayload<JsonObject>(runtimeDocument, 'Master');
  const runtimeMaster = cloneJson(runtimeSource.payload);
  runtimeMaster.Solo = cloneJson(projectionSolo);
  await atomicWriteJson(runtimePath, serializePayload({ Master: runtimeMaster }, runtimeSource));
};

export const applyDiagnosticProjection = async (
  projectionRootInput: string,
  runtimeRootInput: string,
  soloEnvelope: DiagnosticSoloEnvelope,
): Promise<DiagnosticProjectionApplyResult> => {
  if (soloEnvelope !== 'exact' && soloEnvelope !== 'preserve-runtime') {
    throw new Error(`Unsupported diagnostic Solo envelope mode: ${String(soloEnvelope)}`);
  }
  const inspection = await inspectDiagnosticProjection(projectionRootInput);
  const runtimeRoot = path.resolve(runtimeRootInput);
  const runtimeSolo = path.join(runtimeRoot, 'Data', 'Solo.json');
  await assertRealPathInside(runtimeRoot, runtimeSolo);
  if (!(await exists(runtimeSolo))) throw new Error('Runtime Data/Solo.json is missing');

  const duelRoot = path.join(runtimeRoot, 'Data', 'SoloDuels');
  const backgroundRoot = path.join(runtimeRoot, 'Data', 'ClientData', 'SoloGateBackgrounds');
  await Promise.all([
    assertRealPathInside(runtimeRoot, duelRoot),
    assertRealPathInside(runtimeRoot, backgroundRoot),
  ]);
  await removeExact(duelRoot);
  await removeExact(backgroundRoot);
  await ensureDirectory(duelRoot);
  await ensureDirectory(backgroundRoot);

  const changedFiles: string[] = [];
  for (const relative of inspection.files) {
    if (relative.toLowerCase() === 'data/solo.json') continue;
    await copyProjectionFile(inspection.root, runtimeRoot, relative);
    changedFiles.push(relative);
  }
  if (soloEnvelope === 'exact') await copyProjectionFile(inspection.root, runtimeRoot, 'Data/Solo.json');
  else await preserveRuntimeSoloEnvelope(inspection.root, runtimeRoot);
  changedFiles.push('Data/Solo.json');
  return { ...inspection, changedFiles: changedFiles.sort((left, right) => left.localeCompare(right, 'en')) };
};
