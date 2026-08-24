import { performance } from 'node:perf_hooks';

import { validateCampaign } from './validate';
import type { ExitName, OperationResult, Problem } from './types';

/** A source location which can be attached to a generated IR diagnostic. */
export interface LayeredSourceLocation {
  sourcePath: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  jsonPointer?: string;
}

/** Generated-path to authored-source mapping used for diagnostic provenance. */
export type LayeredSourceMap = Record<string, LayeredSourceLocation | string>;

export interface LayeredValidationContext {
  projectRoot?: string;
  contentRoot?: string;
  irRoot?: string;
  checkOnly: boolean;
  sourceMap?: LayeredSourceMap;
  priorProblems: readonly Problem[];
}

export type LayeredCheck =
  | ((context: LayeredValidationContext) => unknown | Promise<unknown>);

export type LayeredIrCheck =
  | ((projectRoot: string, irRoot: string, context: LayeredValidationContext) =>
      unknown | Promise<unknown>);

export interface LayeredValidationOptions {
  projectRoot?: string;
  contentRoot?: string;
  irRoot?: string;
  checkOnly?: boolean;
  sourceMap?: LayeredSourceMap;
  /** Authored-family validation. Its result may be Problem[] or OperationResult-shaped. */
  contentCheck?: LayeredCheck;
  /** Compiler check-only operation. This API never publishes or writes IR itself. */
  compileCheck?: LayeredCheck;
  /** Alias retained for callers that use compilerCheck terminology. */
  compilerCheck?: LayeredCheck;
  /** Existing generated-IR validator. Defaults to validateCampaign when paths are supplied. */
  validateIr?: LayeredIrCheck;
  /** Non-blocking review hook; returned diagnostics are kept separate from correctness. */
  qualityHook?: LayeredCheck;
  performanceTargetMs?: number;
}

export interface LayeredPhaseReport {
  phase: 'content' | 'compiler' | 'ir' | 'quality';
  ok: boolean;
  durationMs: number;
  problems: Problem[];
  warnings: Problem[];
  exitCode?: number;
  exitName?: ExitName;
  skipped?: boolean;
}

export interface LayeredPerformanceReport {
  totalMs: number;
  targetMs: number;
  coldTargetMet: boolean;
  phases: Record<string, number>;
}

export interface LayeredValidationReport {
  checkOnly: boolean;
  warningOnly: boolean;
  blockingCodes: string[];
  phases: LayeredPhaseReport[];
  qualityProblems: Problem[];
  performance: LayeredPerformanceReport;
  remappedDiagnosticCount: number;
}

export interface LayeredValidationResult
  extends OperationResult<LayeredValidationReport> {
  /** All non-quality warnings from authored/compiler/IR phases. */
  warnings: Problem[];
  /** Correctness failures after capability promotion and source remapping. */
  problems: Problem[];
  qualityProblems: Problem[];
  performance: LayeredPerformanceReport;
  phaseResults: LayeredPhaseReport[];
}

const CAPABILITY_BLOCKING_CODES = new Set([
  'CLIENT_ASSET_UNSUPPORTED',
  'REGULATION_TARGET_UNSUPPORTED',
  'SHOP_TARGET_UNSUPPORTED',
  'UNLOCK_SECRET_UNSUPPORTED',
  'TARGET_CAPABILITY_UNSUPPORTED',
  'TARGET_UNSUPPORTED',
]);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;

const isProblem = (value: unknown): value is Problem => {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.code === 'string' &&
    typeof record.message === 'string'
  );
};

const toProblems = (value: unknown): Problem[] =>
  Array.isArray(value) ? value.filter(isProblem).map((problem) => ({ ...problem })) : [];

interface NormalizedProviderResult {
  ok: boolean;
  problems: Problem[];
  warnings: Problem[];
  exitCode?: number;
  exitName?: ExitName;
  raw?: unknown;
}

const normalizeProviderResult = (
  value: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): NormalizedProviderResult => {
  if (Array.isArray(value)) {
    const problems = toProblems(value);
    return {
      ok: problems.every((problem) => problem.severity === 'warning'),
      problems: problems.filter((problem) => problem.severity !== 'warning'),
      warnings: problems.filter((problem) => problem.severity === 'warning'),
      raw: value,
    };
  }

  if (isProblem(value)) {
    const problem = { ...value };
    const blocking = problem.severity !== 'warning';
    return {
      ok: !blocking,
      problems: blocking ? [problem] : [],
      warnings: blocking ? [] : [problem],
      raw: value,
    };
  }

  const record = asRecord(value);
  if (record === undefined) {
    return { ok: true, problems: [], warnings: [], raw: value };
  }

  const problems = toProblems(record.problems);
  const warnings = toProblems(record.warnings);
  const explicitOk = typeof record.ok === 'boolean' ? record.ok : undefined;
  if (explicitOk === false && problems.every((problem) => problem.severity === 'warning')) {
    problems.push({ code: fallbackCode, message: fallbackMessage });
  }

  return {
    ok:
      (explicitOk ?? problems.length === 0) &&
      problems.every((problem) => problem.severity === 'warning'),
    problems: problems.filter((problem) => problem.severity !== 'warning'),
    warnings: [
      ...warnings,
      ...problems.filter((problem) => problem.severity === 'warning'),
    ],
    exitCode: typeof record.exitCode === 'number' ? record.exitCode : undefined,
    exitName:
      typeof record.exitName === 'string' &&
      ['SUCCESS', 'COMMAND_FAILED', 'USAGE_ERROR', 'PATH_ERROR', 'INTERNAL_ERROR'].includes(
        record.exitName,
      )
        ? (record.exitName as ExitName)
        : undefined,
    raw: value,
  };
};

const normalizePath = (value: string): string =>
  value.replaceAll('\\', '/').replace(/^\.\//, '');

const locationForProblem = (
  problem: Problem,
  sourceMap: LayeredSourceMap | undefined,
): LayeredSourceLocation | string | undefined => {
  if (sourceMap === undefined) return undefined;
  const candidates = [problem.sourcePath, problem.path].filter(
    (candidate): candidate is string => typeof candidate === 'string',
  );
  for (const candidate of candidates) {
    const mapped = sourceMap[candidate] ?? sourceMap[normalizePath(candidate)];
    if (mapped !== undefined) return mapped;
  }
  return undefined;
};

const remapProblem = (
  problem: Problem,
  sourceMap: LayeredSourceMap | undefined,
): { problem: Problem; remapped: boolean } => {
  const location = locationForProblem(problem, sourceMap);
  if (location === undefined) return { problem: { ...problem }, remapped: false };

  if (typeof location === 'string') {
    return {
      problem: {
        ...problem,
        sourcePath: location,
        path: location,
      },
      remapped: true,
    };
  }

  const sourceSpan =
    location.line !== undefined && location.column !== undefined
      ? {
          sourcePath: location.sourcePath,
          line: location.line,
          column: location.column,
          endLine: location.endLine ?? location.line,
          endColumn: location.endColumn ?? location.column,
        }
      : undefined;
  return {
    problem: {
      ...problem,
      sourcePath: location.sourcePath,
      path: location.sourcePath,
      ...(location.line === undefined ? {} : { line: location.line }),
      ...(location.column === undefined ? {} : { column: location.column }),
      ...(location.endLine === undefined ? {} : { endLine: location.endLine }),
      ...(location.endColumn === undefined ? {} : { endColumn: location.endColumn }),
      ...(location.jsonPointer === undefined
        ? {}
        : { jsonPointer: location.jsonPointer }),
      ...(sourceSpan === undefined ? {} : { sourceSpan }),
    },
    remapped: true,
  };
};

const problemIdentity = (problem: Problem): string =>
  JSON.stringify([
    problem.code,
    problem.sourcePath ?? problem.path ?? '',
    problem.line ?? 0,
    problem.column ?? 0,
    problem.endLine ?? 0,
    problem.endColumn ?? 0,
    problem.jsonPointer ?? '',
    problem.severity ?? 'error',
  ]);

const uniqueProblems = (problems: readonly Problem[]): Problem[] => {
  const seen = new Set<string>();
  const result: Problem[] = [];
  for (const problem of problems) {
    const identity = problemIdentity(problem);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(problem);
  }
  return result;
};

const isCapabilityProblem = (problem: Problem): boolean =>
  CAPABILITY_BLOCKING_CODES.has(problem.code) ||
  problem.code.endsWith('_TARGET_UNSUPPORTED') ||
  problem.code.endsWith('_CAPABILITY_UNSUPPORTED');

const isPathFailure = (phase: LayeredPhaseReport): boolean =>
  phase.exitName === 'PATH_ERROR' || phase.problems.some((problem) =>
    problem.code.includes('PATH') || problem.code.includes('ROOT'),
  );

const phaseContext = (
  options: LayeredValidationOptions,
  priorProblems: readonly Problem[],
): LayeredValidationContext => ({
  projectRoot: options.projectRoot,
  contentRoot: options.contentRoot,
  irRoot: options.irRoot,
  checkOnly: options.checkOnly ?? true,
  sourceMap: options.sourceMap,
  priorProblems,
});

const runCheck = async (
  phase: LayeredPhaseReport['phase'],
  check: LayeredCheck,
  context: LayeredValidationContext,
  fallbackCode: string,
  fallbackMessage: string,
): Promise<{ report: LayeredPhaseReport; normalized: NormalizedProviderResult }> => {
  const started = performance.now();
  try {
    const normalized = normalizeProviderResult(
      await check(context),
      fallbackCode,
      fallbackMessage,
    );
    return {
      normalized,
      report: {
        phase,
        ok: normalized.ok,
        durationMs: Math.max(0, performance.now() - started),
        problems: normalized.problems,
        warnings: normalized.warnings,
        exitCode: normalized.exitCode,
        exitName: normalized.exitName,
      },
    };
  } catch (error) {
    const problem: Problem = {
      code: fallbackCode,
      message: `${fallbackMessage}: ${error instanceof Error ? error.message : String(error)}`,
    };
    return {
      normalized: {
        ok: false,
        problems: [problem],
        warnings: [],
      },
      report: {
        phase,
        ok: false,
        durationMs: Math.max(0, performance.now() - started),
        problems: [problem],
        warnings: [],
        exitCode: 1,
        exitName: 'COMMAND_FAILED',
      },
    };
  }
};

const skippedPhase = (phase: LayeredPhaseReport['phase']): LayeredPhaseReport => ({
  phase,
  ok: true,
  durationMs: 0,
  problems: [],
  warnings: [],
  skipped: true,
});

/**
 * Validate authored content, run a compiler check-only callback, and reuse the
 * existing generated-IR validator. The function is deliberately callback
 * driven: the compiler owns staging/publish policy, while this API owns the
 * stable diagnostic and exit policy around it.
 */
export async function validateLayeredCampaign(
  options: LayeredValidationOptions = {},
): Promise<LayeredValidationResult> {
  const started = performance.now();
  const checkOnly = options.checkOnly ?? true;
  const phases: LayeredPhaseReport[] = [];
  const allProblems: Problem[] = [];
  const allWarnings: Problem[] = [];
  const qualityProblems: Problem[] = [];
  let remappedDiagnosticCount = 0;
  let compilerRaw: unknown;

  const context = (): LayeredValidationContext =>
    phaseContext(options, allProblems);

  if (options.contentCheck !== undefined) {
    const result = await runCheck(
      'content',
      options.contentCheck,
      context(),
      'LAYERED_CONTENT_CHECK_FAILED',
      'Authored content validation failed',
    );
    phases.push(result.report);
    allProblems.push(...result.normalized.problems);
    allWarnings.push(...result.normalized.warnings);
  } else {
    phases.push(skippedPhase('content'));
  }

  const compilerCheck = options.compileCheck ?? options.compilerCheck;
  if (compilerCheck !== undefined) {
    const result = await runCheck(
      'compiler',
      compilerCheck,
      context(),
      'LAYERED_COMPILER_CHECK_FAILED',
      'Compiler check failed',
    );
    compilerRaw = result.normalized.raw;
    phases.push(result.report);
    allProblems.push(...result.normalized.problems);
    allWarnings.push(...result.normalized.warnings);
    const rawRecord = asRecord(compilerRaw);
    if (checkOnly && rawRecord?.published === true) {
      allProblems.push({
        code: 'LAYERED_CHECK_ONLY_PUBLISH_FORBIDDEN',
        message: 'A check-only validation run must not publish generated IR.',
      });
    }
  } else {
    phases.push(skippedPhase('compiler'));
  }

  const compilerPhase = phases.find((phase) => phase.phase === 'compiler');
  const compilerBlocked = compilerPhase?.problems.length !== 0;
  const compilerRecord = asRecord(compilerRaw);
  const compilerRoot =
    typeof compilerRecord?.stagingRoot === 'string'
      ? compilerRecord.stagingRoot
      : typeof compilerRecord?.irRoot === 'string'
        ? compilerRecord.irRoot
        : options.irRoot;
  const validateIr = options.validateIr;
  const canValidateIr = !compilerBlocked && compilerRoot !== undefined &&
    (validateIr !== undefined || options.projectRoot !== undefined);

  if (canValidateIr) {
    const startedIr = performance.now();
    let normalized: NormalizedProviderResult;
    try {
      const result = validateIr !== undefined
        ? await validateIr(
            options.projectRoot ?? '',
            compilerRoot,
            context(),
          )
        : await validateCampaign(options.projectRoot ?? '', compilerRoot);
      normalized = normalizeProviderResult(
        result,
        'LAYERED_IR_VALIDATION_FAILED',
        'Generated IR validation failed',
      );
    } catch (error) {
      normalized = {
        ok: false,
        problems: [
          {
            code: 'LAYERED_IR_VALIDATION_FAILED',
            message: `Generated IR validation failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        warnings: [],
      };
    }
    const report: LayeredPhaseReport = {
      phase: 'ir',
      ok: normalized.ok,
      durationMs: Math.max(0, performance.now() - startedIr),
      problems: normalized.problems,
      warnings: normalized.warnings,
      exitCode: normalized.exitCode,
      exitName: normalized.exitName,
    };
    phases.push(report);
    allProblems.push(...normalized.problems);
    allWarnings.push(...normalized.warnings);
  } else {
    phases.push(skippedPhase('ir'));
  }

  if (options.qualityHook !== undefined) {
    const result = await runCheck(
      'quality',
      options.qualityHook,
      context(),
      'LAYERED_QUALITY_HOOK_FAILED',
      'Quality hook failed',
    );
    phases.push(result.report);
    qualityProblems.push(...result.normalized.problems, ...result.normalized.warnings);
  } else {
    phases.push(skippedPhase('quality'));
  }

  const remappedProblems: Problem[] = [];
  const remappedWarnings: Problem[] = [];
  for (const problem of allProblems) {
    const mapped = remapProblem(problem, options.sourceMap);
    remappedProblems.push(mapped.problem);
    if (mapped.remapped) remappedDiagnosticCount += 1;
  }
  for (const warning of allWarnings) {
    const mapped = remapProblem(warning, options.sourceMap);
    remappedWarnings.push(mapped.problem);
    if (mapped.remapped) remappedDiagnosticCount += 1;
  }

  const promotedWarnings = remappedWarnings.filter(isCapabilityProblem);
  const ordinaryWarnings = remappedWarnings.filter(
    (problem) => !isCapabilityProblem(problem),
  );
  const blockingProblems = uniqueProblems([
    ...remappedProblems,
    ...promotedWarnings,
  ]);
  const warnings = uniqueProblems(ordinaryWarnings);
  const uniqueQualityProblems = uniqueProblems(qualityProblems);
  const targetMs = options.performanceTargetMs ?? 2000;
  const totalMs = Math.max(0, performance.now() - started);
  const performanceReport: LayeredPerformanceReport = {
    totalMs,
    targetMs,
    coldTargetMet: totalMs <= targetMs,
    phases: Object.fromEntries(
      phases.map((phase) => [phase.phase, phase.durationMs]),
    ),
  };
  if (!performanceReport.coldTargetMet) {
    uniqueQualityProblems.push({
      code: 'VALIDATION_PERFORMANCE_TARGET_MISSED',
      message: `Cold layered validation exceeded ${targetMs}ms.`,
      severity: 'warning',
    });
  }

  const warningOnly = blockingProblems.length === 0 &&
    (warnings.length !== 0 || uniqueQualityProblems.length !== 0);
  const pathError = phases.some(isPathFailure);
  const exitName: ExitName = blockingProblems.length === 0
    ? 'SUCCESS'
    : pathError
      ? 'PATH_ERROR'
      : 'COMMAND_FAILED';
  const report: LayeredValidationReport = {
    checkOnly,
    warningOnly,
    blockingCodes: [...new Set(blockingProblems.map((problem) => problem.code))],
    phases,
    qualityProblems: uniqueQualityProblems,
    performance: performanceReport,
    remappedDiagnosticCount,
  };

  return {
    ok: blockingProblems.length === 0,
    exitCode: exitName === 'SUCCESS' ? 0 : exitName === 'PATH_ERROR' ? 3 : 1,
    exitName,
    warnings,
    problems: blockingProblems,
    data: report,
    qualityProblems: uniqueQualityProblems,
    performance: performanceReport,
    phaseResults: phases,
  };
}

/** Stable descriptive aliases for callers using the pipeline terminology. */
export const runLayeredValidation = validateLayeredCampaign;
export const validateCampaignLayers = validateLayeredCampaign;
