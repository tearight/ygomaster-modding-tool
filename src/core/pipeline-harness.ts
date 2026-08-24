import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { atomicWriteJson, atomicWriteText, ensureDirectory, listFiles } from './fs';
import type { JsonValue, Problem } from './types';

/** Version of the small, tool-independent fixture contract. */
export const PIPELINE_HARNESS_VERSION = 1 as const;

export type PipelineFixtureOutcome = 'success' | 'failure';

export interface PipelineFixtureManifest {
  formatVersion: 1;
  name: string;
  outcome: PipelineFixtureOutcome;
  /** Exact files (or `prefix/**` patterns) allowed in the deploy projection. */
  allowedDeployFiles?: string[];
  /** JSON pointers omitted by the semantic comparator in addition to timestamps. */
  ignoredSemanticPaths?: string[];
}

export interface PipelineFixturePaths {
  root: string;
  manifest: string;
  content: string;
  expectedIr: string;
  expectedDeploy: string;
  problems: string;
  problemsFile: string;
}

export interface PipelineFixture {
  manifest: PipelineFixtureManifest;
  paths: PipelineFixturePaths;
  expectedProblems: Problem[];
}

export class PipelineHarnessError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'PipelineHarnessError';
    this.code = code;
  }
}

const TIMESTAMP_KEYS = new Set([
  'createdAt',
  'updatedAt',
  'generatedAt',
  'deployedAt',
  'timestamp',
  'timestampMs',
  'writtenAt',
]);

const createHarnessTempRoot = async (prefix: string): Promise<string> => {
  // Some managed Windows runners deny stat/copy operations under the user
  // profile. Keep the default harness workspace local to the checkout; the
  // OS temp directory remains a fallback for ordinary environments.
  try {
    return await fs.mkdtemp(path.join(process.cwd(), `.${prefix}-`));
  } catch {
    return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  }
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const normalizePointer = (value: string): string => {
  if (!value) return '';
  return value.startsWith('/') ? value : `/${value}`;
};

const pointerPart = (value: string): string => value.replace(/~/g, '~0').replace(/\//g, '~1');

const pointerMatches = (pattern: string, actual: string): boolean => {
  const patternParts = normalizePointer(pattern).split('/').slice(1);
  const actualParts = normalizePointer(actual).split('/').slice(1);
  if (patternParts.length !== actualParts.length) return false;
  return patternParts.every((part, index) => part === '*' || part === actualParts[index]);
};

export interface SemanticCompareOptions {
  /** JSON pointers to omit. A `*` segment matches one object/array segment. */
  ignoredPaths?: readonly string[];
  /** Ignore common generated timestamp fields at every object level. */
  ignoreGeneratedTimestamps?: boolean;
  /** Additional object keys omitted wherever they occur. */
  ignoredKeys?: readonly string[];
}

const shouldIgnore = (
  key: string,
  pointer: string,
  options: SemanticCompareOptions,
): boolean => {
  if (options.ignoredKeys?.includes(key)) return true;
  if (options.ignoredPaths?.some((pattern) => pointerMatches(pattern, pointer))) return true;
  return options.ignoreGeneratedTimestamps !== false && TIMESTAMP_KEYS.has(key);
};

const normalizeSemanticValue = (
  value: unknown,
  pointer: string,
  options: SemanticCompareOptions,
): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeSemanticValue(entry, `${pointer}/${index}`, options),
    );
  }
  const record = asRecord(value);
  if (record) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const childPointer = `${pointer}/${pointerPart(key)}`;
      if (shouldIgnore(key, childPointer, options)) continue;
      result[key] = normalizeSemanticValue(record[key], childPointer, options);
    }
    return result;
  }
  return value;
};

const stableStringify = (value: unknown): string => JSON.stringify(value);

export interface SemanticComparison {
  equal: boolean;
  actual: unknown;
  expected: unknown;
}

/** Compare JSON values without object-key ordering or generated timestamps. */
export const compareSemantic = (
  actual: unknown,
  expected: unknown,
  options: SemanticCompareOptions = {},
): SemanticComparison => {
  const normalizedActual = normalizeSemanticValue(actual, '', options);
  const normalizedExpected = normalizeSemanticValue(expected, '', options);
  return {
    equal: stableStringify(normalizedActual) === stableStringify(normalizedExpected),
    actual: normalizedActual,
    expected: normalizedExpected,
  };
};

export const pipelineSemanticEqual = (
  actual: unknown,
  expected: unknown,
  options: SemanticCompareOptions = {},
): boolean => compareSemantic(actual, expected, options).equal;

const isJsonFile = (filePath: string): boolean => path.extname(filePath).toLowerCase() === '.json';

const relativeFile = (root: string, filePath: string): string =>
  path.relative(root, filePath).split(path.sep).join('/');

const normalizeRelative = (value: string): string => {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new PipelineHarnessError('UNSAFE_PATH', `Unsafe fixture path: ${value}`);
  }
  const parts = normalized.split('/');
  if (parts.includes('..')) {
    throw new PipelineHarnessError('UNSAFE_PATH', `Fixture path escapes root: ${value}`);
  }
  return parts.filter(Boolean).join('/');
};

const ensureDirectoryExists = async (directory: string, label: string): Promise<void> => {
  try {
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
  } catch (error) {
    throw new PipelineHarnessError(
      'FIXTURE_LAYOUT',
      `Missing ${label}: ${directory} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
};

const readStrictJson = async (filePath: string): Promise<unknown> => {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new PipelineHarnessError(
      'FIXTURE_LAYOUT',
      `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch (error) {
    throw new PipelineHarnessError(
      'FIXTURE_JSON',
      `Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const validateManifest = (value: unknown, filePath: string): PipelineFixtureManifest => {
  const record = asRecord(value);
  if (!record || record.formatVersion !== PIPELINE_HARNESS_VERSION) {
    throw new PipelineHarnessError(
      'FIXTURE_VERSION',
      `${filePath} must declare formatVersion ${PIPELINE_HARNESS_VERSION}`,
    );
  }
  if (typeof record.name !== 'string' || !record.name.trim()) {
    throw new PipelineHarnessError('FIXTURE_MANIFEST', `${filePath} requires a name`);
  }
  if (record.outcome !== 'success' && record.outcome !== 'failure') {
    throw new PipelineHarnessError('FIXTURE_MANIFEST', `${filePath} requires outcome success|failure`);
  }
  const allowed = record.allowedDeployFiles;
  if (allowed !== undefined && (!Array.isArray(allowed) || !allowed.every((entry) => typeof entry === 'string'))) {
    throw new PipelineHarnessError('FIXTURE_MANIFEST', `${filePath} has invalid allowedDeployFiles`);
  }
  const ignored = record.ignoredSemanticPaths;
  if (ignored !== undefined && (!Array.isArray(ignored) || !ignored.every((entry) => typeof entry === 'string'))) {
    throw new PipelineHarnessError('FIXTURE_MANIFEST', `${filePath} has invalid ignoredSemanticPaths`);
  }
  return {
    formatVersion: 1,
    name: record.name,
    outcome: record.outcome,
    ...(allowed ? { allowedDeployFiles: allowed } : {}),
    ...(ignored ? { ignoredSemanticPaths: ignored } : {}),
  };
};

/** Load and validate the shared content/expected-ir/expected-deploy/problems layout. */
export const loadPipelineFixture = async (fixtureRoot: string): Promise<PipelineFixture> => {
  const root = path.resolve(fixtureRoot);
  const paths: PipelineFixturePaths = {
    root,
    manifest: path.join(root, 'fixture.json'),
    content: path.join(root, 'content'),
    expectedIr: path.join(root, 'expected-ir'),
    expectedDeploy: path.join(root, 'expected-deploy'),
    problems: path.join(root, 'problems'),
    problemsFile: path.join(root, 'problems', 'problems.json'),
  };
  await ensureDirectoryExists(root, 'fixture root');
  const manifest = validateManifest(await readStrictJson(paths.manifest), paths.manifest);
  await Promise.all([
    ensureDirectoryExists(paths.content, 'content directory'),
    ensureDirectoryExists(paths.expectedIr, 'expected-ir directory'),
    ensureDirectoryExists(paths.expectedDeploy, 'expected-deploy directory'),
    ensureDirectoryExists(paths.problems, 'problems directory'),
  ]);
  const expectedProblemsValue = await readStrictJson(paths.problemsFile);
  if (!Array.isArray(expectedProblemsValue)) {
    throw new PipelineHarnessError('FIXTURE_PROBLEMS', `${paths.problemsFile} must contain a JSON array`);
  }
  const expectedProblems = expectedProblemsValue as Problem[];
  return { manifest, paths, expectedProblems };
};

export interface DirectoryComparison {
  equal: boolean;
  missing: string[];
  unexpected: string[];
  mismatched: string[];
  semanticMismatches: string[];
}

/** Compare a generated directory with a golden directory. JSON uses semantic comparison. */
export const compareDirectories = async (
  actualRoot: string,
  expectedRoot: string,
  options: SemanticCompareOptions = {},
): Promise<DirectoryComparison> => {
  const actualFiles = (await listFiles(actualRoot)).map((filePath) => relativeFile(actualRoot, filePath));
  const expectedFiles = (await listFiles(expectedRoot)).map((filePath) => relativeFile(expectedRoot, filePath));
  const actualSet = new Set(actualFiles);
  const expectedSet = new Set(expectedFiles);
  const missing = expectedFiles.filter((file) => !actualSet.has(file));
  const unexpected = actualFiles.filter((file) => !expectedSet.has(file));
  const mismatched: string[] = [];
  const semanticMismatches: string[] = [];
  for (const relative of expectedFiles) {
    if (!actualSet.has(relative)) continue;
    const actualPath = path.join(actualRoot, ...relative.split('/'));
    const expectedPath = path.join(expectedRoot, ...relative.split('/'));
    if (isJsonFile(relative)) {
      const [actual, expected] = await Promise.all([readStrictJson(actualPath), readStrictJson(expectedPath)]);
      if (!pipelineSemanticEqual(actual, expected, options)) semanticMismatches.push(relative);
    } else {
      const [actual, expected] = await Promise.all([fs.readFile(actualPath), fs.readFile(expectedPath)]);
      if (!actual.equals(expected)) mismatched.push(relative);
    }
  }
  return {
    equal: missing.length === 0 && unexpected.length === 0 && mismatched.length === 0 && semanticMismatches.length === 0,
    missing,
    unexpected,
    mismatched,
    semanticMismatches,
  };
};

const matchesFilePattern = (file: string, pattern: string): boolean => {
  const normalized = normalizeRelative(pattern);
  if (normalized.endsWith('/**')) return file.startsWith(`${normalized.slice(0, -3)}/`);
  if (normalized.endsWith('/*')) return file.startsWith(`${normalized.slice(0, -1)}`) && !file.slice(normalized.length - 1).includes('/');
  return file === normalized;
};

export interface AllowedFilesInspection {
  ok: boolean;
  files: string[];
  allowed: string[];
  missing: string[];
  unexpected: string[];
}

/** Ensure a generated target contains only the fixture's explicitly allowed files. */
export const inspectAllowedFiles = async (
  root: string,
  allowedFiles: readonly string[],
): Promise<AllowedFilesInspection> => {
  const allowed = allowedFiles.map(normalizeRelative);
  const files = (await listFiles(root)).map((filePath) => relativeFile(root, filePath));
  const unexpected = files.filter((file) => !allowed.some((pattern) => matchesFilePattern(file, pattern)));
  const missing = allowed.filter((pattern) => !files.some((file) => matchesFilePattern(file, pattern)));
  return { ok: unexpected.length === 0 && missing.length === 0, files, allowed, missing, unexpected };
};

export interface FakeRuntimeOptions {
  root?: string;
  files?: Record<string, string | Uint8Array | JsonValue>;
  allowedFiles?: string[];
}

export interface FakeRuntime {
  root: string;
  files: string[];
  allowedFiles: string[];
  inspectAllowedFiles: (allowedFiles?: readonly string[]) => Promise<AllowedFilesInspection>;
}

/** Build a synthetic runtime tree. It never downloads or invokes a client/runtime/save. */
export const buildFakeRuntime = async (options: FakeRuntimeOptions = {}): Promise<FakeRuntime> => {
  const root = path.resolve(options.root ?? (await createHarnessTempRoot('ygomaster-fake-runtime')));
  await ensureDirectory(root);
  const inputFiles = options.files ?? {};
  for (const [relative, value] of Object.entries(inputFiles)) {
    const safeRelative = normalizeRelative(relative);
    const filePath = path.join(root, ...safeRelative.split('/'));
    await ensureDirectory(path.dirname(filePath));
    if (typeof value === 'string' || value instanceof Uint8Array) {
      await fs.writeFile(filePath, value);
    } else {
      await atomicWriteJson(filePath, value);
    }
  }
  const files = (await listFiles(root)).map((filePath) => relativeFile(root, filePath));
  const allowedFiles = (options.allowedFiles ?? files).map(normalizeRelative);
  return {
    root,
    files,
    allowedFiles,
    inspectAllowedFiles: (allowed = allowedFiles) => inspectAllowedFiles(root, allowed),
  };
};

const bytesKey = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

interface FileSnapshot {
  bytes: string;
  semantic?: unknown;
  mtimeMs: number;
}

type DirectorySnapshot = Map<string, FileSnapshot>;

const snapshotDirectory = async (
  root: string,
  options: SemanticCompareOptions = {},
): Promise<DirectorySnapshot> => {
  const snapshot: DirectorySnapshot = new Map();
  for (const filePath of await listFiles(root)) {
    const relative = relativeFile(root, filePath);
    const [bytes, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    let semantic: unknown;
    if (isJsonFile(relative)) {
      try {
        semantic = normalizeSemanticValue(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), '', options);
      } catch {
        semantic = undefined;
      }
    }
    snapshot.set(relative, { bytes: bytesKey(bytes), semantic, mtimeMs: stat.mtimeMs });
  }
  return snapshot;
};

const snapshotsByteEqual = (left: DirectorySnapshot, right: DirectorySnapshot): boolean => {
  if (left.size !== right.size) return false;
  for (const [file, snapshot] of left) {
    if (snapshot.bytes !== right.get(file)?.bytes) return false;
  }
  return true;
};

const snapshotsSemanticEqual = (left: DirectorySnapshot, right: DirectorySnapshot): boolean => {
  if (left.size !== right.size) return false;
  for (const [file, snapshot] of left) {
    const other = right.get(file);
    if (!other) return false;
    if (snapshot.semantic !== undefined || other.semantic !== undefined) {
      if (stableStringify(snapshot.semantic) !== stableStringify(other.semantic)) return false;
    } else if (snapshot.bytes !== other.bytes) {
      return false;
    }
  }
  return true;
};

export interface DeterminismOptions {
  outputRoot: string;
  compile: (context: { outputRoot: string; pass: 1 | 2 }) => Promise<unknown>;
  semantic?: SemanticCompareOptions;
  settleMs?: number;
}

export interface DeterminismReport {
  byteStable: boolean;
  semanticStable: boolean;
  rewrittenFiles: string[];
  zeroDiff: boolean;
}

/** Compile twice in one output directory and detect both changed bytes and rewrites. */
export const checkCompileDeterminism = async (
  options: DeterminismOptions,
): Promise<DeterminismReport> => {
  await ensureDirectory(options.outputRoot);
  const semantic = options.semantic ?? {};
  await options.compile({ outputRoot: options.outputRoot, pass: 1 });
  const first = await snapshotDirectory(options.outputRoot, semantic);
  const settleMs = options.settleMs ?? 10;
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
  await options.compile({ outputRoot: options.outputRoot, pass: 2 });
  const second = await snapshotDirectory(options.outputRoot, semantic);
  const rewrittenFiles: string[] = [];
  for (const [file, before] of first) {
    const after = second.get(file);
    if (after && after.mtimeMs !== before.mtimeMs) rewrittenFiles.push(file);
  }
  return {
    byteStable: snapshotsByteEqual(first, second),
    semanticStable: snapshotsSemanticEqual(first, second),
    rewrittenFiles: rewrittenFiles.sort(),
    zeroDiff: snapshotsByteEqual(first, second) && rewrittenFiles.length === 0,
  };
};

export const checkZeroDiffNoRewrite = checkCompileDeterminism;

export interface FailureAtomicityOptions {
  outputRoot: string;
  compileFailure: (context: { outputRoot: string }) => Promise<unknown>;
  semantic?: SemanticCompareOptions;
}

export interface FailureAtomicityReport {
  failureObserved: boolean;
  byteUnchanged: boolean;
  semanticUnchanged: boolean;
  preserved: boolean;
}

/** Verify a failed compile leaves a pre-existing IR tree byte- and semantically unchanged. */
export const checkFailurePreservesOutput = async (
  options: FailureAtomicityOptions,
): Promise<FailureAtomicityReport> => {
  const before = await snapshotDirectory(options.outputRoot, options.semantic ?? {});
  let failureObserved = false;
  try {
    const result = await options.compileFailure({ outputRoot: options.outputRoot });
    failureObserved = asRecord(result)?.ok === false || result === false;
  } catch {
    failureObserved = true;
  }
  const after = await snapshotDirectory(options.outputRoot, options.semantic ?? {});
  const byteUnchanged = snapshotsByteEqual(before, after);
  const semanticUnchanged = snapshotsSemanticEqual(before, after);
  return {
    failureObserved,
    byteUnchanged,
    semanticUnchanged,
    preserved: failureObserved && byteUnchanged && semanticUnchanged,
  };
};

export const assertFailurePreservesOutput = checkFailurePreservesOutput;

const problemSourcePath = (problem: Problem): string | undefined =>
  problem.sourcePath ?? problem.sourceSpan?.sourcePath ?? problem.path;

const problemSpan = (problem: Problem): Record<string, unknown> => ({
  sourcePath: problemSourcePath(problem),
  line: problem.line ?? problem.sourceSpan?.line,
  column: problem.column ?? problem.sourceSpan?.column,
  endLine: problem.endLine ?? problem.end?.line ?? problem.sourceSpan?.endLine,
  endColumn: problem.endColumn ?? problem.end?.column ?? problem.sourceSpan?.endColumn,
  jsonPointer: problem.jsonPointer,
});

const comparableProblem = (problem: Problem): Record<string, unknown> => ({
  code: problem.code,
  ...problemSpan(problem),
});

const problemSortKey = (problem: Problem): string => stableStringify(comparableProblem(problem));

export interface ProblemComparison {
  equal: boolean;
  missing: Problem[];
  unexpected: Problem[];
  mismatched: Array<{ expected: Problem; actual: Problem }>;
}

/** Compare problem goldens by stable code and source location, not localized messages. */
export const compareExpectedProblems = (
  actual: readonly Problem[],
  expected: readonly Problem[],
): ProblemComparison => {
  const remainingActual = [...actual];
  const missing: Problem[] = [];
  const mismatched: Array<{ expected: Problem; actual: Problem }> = [];
  for (const wanted of expected) {
    const exactIndex = remainingActual.findIndex(
      (candidate) => problemSortKey(candidate) === problemSortKey(wanted),
    );
    if (exactIndex >= 0) {
      remainingActual.splice(exactIndex, 1);
      continue;
    }
    const codeIndex = remainingActual.findIndex((candidate) => candidate.code === wanted.code);
    if (codeIndex >= 0) {
      const [candidate] = remainingActual.splice(codeIndex, 1);
      mismatched.push({ expected: wanted, actual: candidate });
    } else {
      missing.push(wanted);
    }
  }
  return {
    equal: missing.length === 0 && remainingActual.length === 0 && mismatched.length === 0,
    missing,
    unexpected: remainingActual,
    mismatched,
  };
};

export interface PipelineCompileContext {
  fixture: PipelineFixture;
  workspaceRoot: string;
  contentRoot: string;
  irRoot: string;
  deployRoot: string;
  fakeRuntime: FakeRuntime;
}

export interface PipelineCompileResult {
  ok?: boolean;
  problems?: Problem[];
}

export interface PipelineFixtureRunOptions {
  fixtureRoot: string;
  compile: (context: PipelineCompileContext) => Promise<PipelineCompileResult | void>;
  semantic?: SemanticCompareOptions;
  workspaceRoot?: string;
}

export interface PipelineFixtureRunReport {
  ok: boolean;
  fixture: PipelineFixture;
  workspaceRoot: string;
  ir: DirectoryComparison;
  deploy: DirectoryComparison;
  allowedDeploy: AllowedFilesInspection;
  problems: ProblemComparison;
}

/** Execute one fixture without an external runtime and compare all its goldens. */
export const runPipelineFixture = async (
  options: PipelineFixtureRunOptions,
): Promise<PipelineFixtureRunReport> => {
  const fixture = await loadPipelineFixture(options.fixtureRoot);
  const ownsWorkspace = options.workspaceRoot === undefined;
  const workspaceRoot = path.resolve(
    ownsWorkspace ? await createHarnessTempRoot('ygomaster-pipeline-harness') : (options.workspaceRoot as string),
  );
  const contentRoot = path.join(workspaceRoot, 'content');
  const irRoot = path.join(workspaceRoot, 'expected-ir');
  const deployRoot = path.join(workspaceRoot, 'expected-deploy');
  try {
    await ensureDirectory(workspaceRoot);
    await fs.cp(fixture.paths.content, contentRoot, { recursive: true, force: true });
    await Promise.all([ensureDirectory(irRoot), ensureDirectory(deployRoot)]);
    const fakeRuntime = await buildFakeRuntime({ root: path.join(workspaceRoot, 'fake-runtime') });
    let compileResult: PipelineCompileResult = {};
    let thrownProblems: Problem[] | undefined;
    try {
      compileResult = (await options.compile({
        fixture,
        workspaceRoot,
        contentRoot,
        irRoot,
        deployRoot,
        fakeRuntime,
      })) ?? {};
    } catch (error) {
      const record = asRecord(error);
      thrownProblems = Array.isArray(record?.problems) ? (record.problems as Problem[]) : undefined;
      compileResult = { ok: false, problems: thrownProblems };
    }
    const actualProblems = compileResult.problems ?? thrownProblems ?? [];
    const semantic = {
      ...(options.semantic ?? {}),
      ignoredPaths: [
        ...(options.semantic?.ignoredPaths ?? []),
        ...(fixture.manifest.ignoredSemanticPaths ?? []),
      ],
    };
    const ir = await compareDirectories(irRoot, fixture.paths.expectedIr, semantic);
    const deploy = await compareDirectories(deployRoot, fixture.paths.expectedDeploy, semantic);
    const allowed = fixture.manifest.allowedDeployFiles ??
      (await listFiles(fixture.paths.expectedDeploy)).map((filePath) => relativeFile(fixture.paths.expectedDeploy, filePath));
    const allowedDeploy = await inspectAllowedFiles(deployRoot, allowed);
    const problems = compareExpectedProblems(actualProblems, fixture.expectedProblems);
    const expectedOutcome = fixture.manifest.outcome;
    const outcomeMatches = expectedOutcome === 'success'
      ? compileResult.ok !== false && actualProblems.length === 0
      : compileResult.ok === false;
    return {
      ok: outcomeMatches && ir.equal && deploy.equal && allowedDeploy.ok && problems.equal,
      fixture,
      workspaceRoot,
      ir,
      deploy,
      allowedDeploy,
      problems,
    };
  } finally {
    // Only remove the exact root created above. Caller-owned workspaces are
    // deliberately retained for inspection and are never recursively deleted.
    if (ownsWorkspace) {
      await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
    }
  }
};

export interface PipelineBenchmarkStep {
  name: string;
  run: () => unknown | Promise<unknown>;
}

export interface PipelineBenchmarkReport {
  schemaVersion: 1;
  fixture?: string;
  generatedAt: string;
  timings: Array<{ name: string; durationMs: number }>;
  agentSteps: number;
}

/** Measure steps only; correctness remains the fixture runner's separate result. */
export const measurePipelineSteps = async (
  steps: readonly PipelineBenchmarkStep[],
  options: { fixture?: string; agentSteps?: number } = {},
): Promise<PipelineBenchmarkReport> => {
  const timings: Array<{ name: string; durationMs: number }> = [];
  for (const step of steps) {
    const started = performance.now();
    await step.run();
    timings.push({ name: step.name, durationMs: Number((performance.now() - started).toFixed(3)) });
  }
  return {
    schemaVersion: 1,
    ...(options.fixture ? { fixture: options.fixture } : {}),
    generatedAt: new Date().toISOString(),
    timings,
    agentSteps: options.agentSteps ?? 0,
  };
};

export const writePipelineBenchmarkReport = async (
  filePath: string,
  report: PipelineBenchmarkReport,
): Promise<void> => atomicWriteJson(filePath, report);

/** Small helper for fixture compilers that want atomic text output. */
export const writeHarnessText = async (filePath: string, text: string): Promise<void> =>
  atomicWriteText(filePath, text);
