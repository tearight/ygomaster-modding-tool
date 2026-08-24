import path from 'node:path';

import { loadCardResolver, type CardNameResolver } from './card-resolver';
import { compileCampaignContent, type CompileCampaignContentOptions } from './campaign-pipeline';
import { discoverCampaignIrBundle } from './content-bundle-loader';
import { exists } from './fs';
import {
  applyRegistryPlan,
  createEmptyRegistry,
  readRegistry,
  type IdRegistry,
  type RegistryDiff,
  type RegistryNamespace,
  type RegistryPlan,
} from './id-registry';
import { IR_COMPILER_VERSION } from './ir-compiler';
import { validateLayeredCampaign } from './layered-validation';
import {
  IR_GENERATION_METADATA_FILE,
  YGOMASTER_TARGET_CONTRACT_VERSION,
  readIrGenerationMetadata,
} from './layers';
import type { OperationResult, Problem } from './types';
import { failure, problem, result } from './types';

export interface ContentOperationPaths {
  projectRoot: string;
  contentRoot?: string;
  irRoot?: string;
  registryPath?: string;
}

export interface ContentExecutionOptions extends ContentOperationPaths {
  resolver?: CardNameResolver;
  registry?: IdRegistry;
  /**
   * The shared project compiler owns an approved compatibility adapter for
   * the fixture-backed Structure projection.  This does not promote the
   * upstream target capability; callers can explicitly set false to retain
   * the low-level fail-closed path.
   */
  verifiedStructureAdapter?: boolean;
  allowAssumedStructure?: boolean;
  deckOptions?: CompileCampaignContentOptions['deckOptions'];
}

export interface ContentCompileOptions extends ContentExecutionOptions {
  /** False/missing is check-only. Publishing requires explicit apply:true. */
  apply?: boolean;
  expectedContentGeneration?: string;
}

const operationPaths = (options: ContentOperationPaths) => ({
  contentRoot: path.resolve(options.contentRoot || path.join(options.projectRoot, 'campaign', 'content')),
  irRoot: path.resolve(options.irRoot || path.join(options.projectRoot, 'campaign', 'source')),
  registryPath: path.resolve(options.registryPath || path.join(options.projectRoot, 'campaign', 'id-registry.json')),
});

const executionInputs = async (options: ContentExecutionOptions): Promise<{ resolver: CardNameResolver; registry: IdRegistry }> => ({
  resolver: options.resolver || await loadCardResolver(options.projectRoot),
  registry: options.registry || (await exists(operationPaths(options).registryPath)
    ? await readRegistry(operationPaths(options).registryPath)
    : createEmptyRegistry()),
});

const capabilityProblems = (unconsumed: readonly string[], manifest: { directories?: { shop?: string; target?: string } }): Problem[] => {
  const shopRoot = `${manifest.directories?.shop || 'shop'}/`;
  const targetRoot = `${manifest.directories?.target || 'target/ygomaster'}/`;
  return unconsumed.filter((sourcePath) => !sourcePath.endsWith('/.gitkeep') && sourcePath !== '.gitkeep').flatMap((sourcePath) => sourcePath.startsWith(shopRoot)
    ? [problem('SHOP_TARGET_UNSUPPORTED', 'Shop authored content cannot be projected by the current target contract', sourcePath)]
    : sourcePath.startsWith(targetRoot)
      ? [problem('TARGET_CAPABILITY_UNSUPPORTED', 'Unrecognized YgoMaster target extension is not deployable', sourcePath)]
      : []);
};

export const inspectCampaignContent = async (
  options: ContentOperationPaths,
): Promise<OperationResult<unknown>> => {
  try {
    const paths = operationPaths(options);
    const loaded = await discoverCampaignIrBundle(paths.contentRoot);
    if (!loaded.ok || !loaded.bundle) return failure(loaded.problems, 'COMMAND_FAILED');
    const bundle = loaded.bundle;
    let generationStatus: Record<string, unknown> = {
      state: 'missing',
      contentGeneration: bundle.snapshot.contentGeneration,
      irGeneration: null,
      mismatches: ['generation.json is missing'],
    };
    if (await exists(path.join(paths.irRoot, IR_GENERATION_METADATA_FILE))) {
      try {
        const metadata = await readIrGenerationMetadata(paths.irRoot);
        const mismatches = [
          ...(metadata.contentGeneration === bundle.snapshot.contentGeneration ? [] : ['contentGeneration']),
          ...(metadata.compilerVersion === IR_COMPILER_VERSION ? [] : ['compilerVersion']),
          ...(metadata.targetContractVersion === YGOMASTER_TARGET_CONTRACT_VERSION ? [] : ['targetContractVersion']),
        ];
        generationStatus = {
          state: mismatches.length === 0 ? 'current' : 'stale',
          contentGeneration: bundle.snapshot.contentGeneration,
          irGeneration: metadata.contentGeneration,
          compilerVersion: metadata.compilerVersion,
          targetContractVersion: metadata.targetContractVersion,
          mismatches,
        };
      } catch (error) {
        generationStatus = {
          state: 'invalid',
          contentGeneration: bundle.snapshot.contentGeneration,
          irGeneration: null,
          mismatches: [String(error)],
        };
      }
    }
    return result({
      paths,
      contentGeneration: bundle.snapshot.contentGeneration,
      generationStatus,
      campaign: bundle.manifest.campaign,
      families: {
        decks: Object.keys(bundle.decks),
        gates: bundle.gates.map((entry) => entry.sourcePath),
        structures: bundle.structures.map((entry) => entry.sourcePath),
        shops: bundle.shops.map((entry) => entry.metadata.sourcePath),
        regulations: Object.keys(bundle.regulations),
        localizationLanguages: bundle.localization ? Object.keys(bundle.localization.languages).sort() : [],
      },
      consumedPaths: bundle.consumedPaths,
      unconsumedPaths: bundle.unconsumedPaths,
      capabilities: capabilityProblems(bundle.unconsumedPaths, bundle.manifest),
      compilerVersion: IR_COMPILER_VERSION,
      targetContractVersion: YGOMASTER_TARGET_CONTRACT_VERSION,
    });
  } catch (error) {
    return failure([problem('CONTENT_INSPECT_FAILED', String(error))], 'PATH_ERROR');
  }
};

const compileCore = async (options: ContentCompileOptions, checkOnly: boolean) => {
  const paths = operationPaths(options);
  const inputs = await executionInputs(options);
  return compileCampaignContent({
    projectRoot: options.projectRoot,
    contentRoot: paths.contentRoot,
    irRoot: paths.irRoot,
    resolver: inputs.resolver,
    catalogGeneration: inputs.resolver.catalogGeneration,
    registry: inputs.registry,
    checkOnly,
    verifiedStructureAdapter: options.verifiedStructureAdapter ?? options.allowAssumedStructure ?? true,
    allowAssumedStructure: options.allowAssumedStructure,
    deckOptions: options.deckOptions,
  });
};

const assignmentDiff = (before: IdRegistry, after: IdRegistry): RegistryDiff[] => {
  const output: RegistryDiff[] = [];
  for (const namespace of Object.keys(after.namespaces) as RegistryNamespace[]) {
    const oldEntries = before.namespaces[namespace].assignments;
    const newEntries = after.namespaces[namespace].assignments;
    const keys = [...new Set([...Object.keys(oldEntries), ...Object.keys(newEntries)])].sort();
    for (const key of keys) {
      const oldId = oldEntries[key]?.id;
      const newId = newEntries[key]?.id;
      if (oldId === newId) continue;
      output.push({ namespace, key, action: oldId === undefined ? 'add' : newId === undefined ? 'remove' : 'update', ...(oldId === undefined ? {} : { before: oldId }), ...(newId === undefined ? {} : { after: newId }) });
    }
  }
  return output;
};

export const compileCampaignContentOperation = async (
  options: ContentCompileOptions,
): Promise<OperationResult<unknown>> => {
  try {
    const apply = options.apply === true;
    const paths = operationPaths(options);
    const inspected = await discoverCampaignIrBundle(paths.contentRoot);
    if (!inspected.ok || !inspected.bundle) return failure(inspected.problems, 'COMMAND_FAILED');
    const actualGeneration = inspected.bundle.snapshot.contentGeneration;
    if (apply && !options.expectedContentGeneration) {
      return failure([problem('CONTENT_EXPECTED_GENERATION_REQUIRED', 'Applied compile requires expectedContentGeneration from content inspect')], 'USAGE_ERROR');
    }
    if (options.expectedContentGeneration && options.expectedContentGeneration !== actualGeneration) {
      return failure([problem('CONTENT_GENERATION_STALE', `Expected content generation ${options.expectedContentGeneration}, received ${actualGeneration}`, 'campaign/content')], 'COMMAND_FAILED');
    }
    const inputs = await executionInputs(options);
    const compiled = await compileCampaignContent({
      projectRoot: options.projectRoot,
      contentRoot: paths.contentRoot,
      irRoot: paths.irRoot,
      resolver: inputs.resolver,
      catalogGeneration: inputs.resolver.catalogGeneration,
      registry: inputs.registry,
      checkOnly: !apply,
      verifiedStructureAdapter: options.verifiedStructureAdapter ?? options.allowAssumedStructure ?? true,
      allowAssumedStructure: options.allowAssumedStructure,
      deckOptions: options.deckOptions,
    });
    if (!compiled.ok) return failure(compiled.problems, 'COMMAND_FAILED', compiled.warnings);
    let registryUpdate: unknown;
    if (apply && compiled.registry && compiled.registry.generation !== inputs.registry.generation) {
      const plan: RegistryPlan = {
        dryRun: true,
        baseGeneration: inputs.registry.generation,
        generation: compiled.registry.generation,
        registry: compiled.registry,
        diff: assignmentDiff(inputs.registry, compiled.registry),
      };
      registryUpdate = await applyRegistryPlan(paths.registryPath, plan, { accept: true });
    }
    return result({
      mode: apply ? 'apply' : 'check',
      contentGeneration: actualGeneration,
      generation: compiled.generation,
      published: compiled.published,
      zeroDiff: compiled.zeroDiff,
      diff: compiled.diff,
      staleDisposition: compiled.staleDisposition,
      registry: compiled.registry,
      registryUpdate,
      provenance: compiled.provenance,
    }, compiled.warnings);
  } catch (error) {
    const nested = error && typeof error === 'object' && 'problems' in error && Array.isArray(error.problems)
      ? error.problems as Problem[]
      : [problem('CONTENT_COMPILE_FAILED', String(error))];
    return failure(nested, 'COMMAND_FAILED');
  }
};

export const validateCampaignContentOperation = async (
  options: ContentExecutionOptions,
): Promise<OperationResult<unknown>> => {
  try {
    const compiled = await compileCore(options, true);
    const layered = await validateLayeredCampaign({
      checkOnly: true,
      compileCheck: () => compiled,
    });
    return layered;
  } catch (error) {
    return failure([problem('CONTENT_VALIDATE_FAILED', String(error))], 'COMMAND_FAILED');
  }
};

const isResolverProblem = (entry: Problem): boolean =>
  entry.code.startsWith('CARD_NAME_') || entry.code.startsWith('CARD_RUNTIME_') || entry.code === 'CARD_ALIAS_UNREVIEWED';

export const resolveCampaignContent = async (
  options: ContentExecutionOptions,
): Promise<OperationResult<unknown>> => {
  try {
    const compiled = await compileCore(options, true);
    const unresolved = compiled.problems.filter(isResolverProblem).sort((left, right) =>
      (left.sourcePath || left.path || '').localeCompare(right.sourcePath || right.path || '')
      || (left.line || 0) - (right.line || 0)
      || left.code.localeCompare(right.code));
    const data = { unresolved, count: unresolved.length };
    return unresolved.length ? { ...failure(unresolved, 'COMMAND_FAILED'), data } : result(data, compiled.warnings.filter(isResolverProblem));
  } catch (error) {
    return failure([problem('CONTENT_RESOLVE_FAILED', String(error))], 'COMMAND_FAILED');
  }
};

export const diffCampaignContent = async (
  options: ContentExecutionOptions,
): Promise<OperationResult<unknown>> => {
  const compiled = await compileCampaignContentOperation({ ...options, apply: false });
  if (!compiled.ok) return compiled;
  const data = compiled.data as Record<string, unknown>;
  return result({ contentGeneration: data.contentGeneration, zeroDiff: data.zeroDiff, diff: data.diff, staleDisposition: data.staleDisposition }, compiled.warnings);
};

export const contentInspect = inspectCampaignContent;
export const contentResolve = resolveCampaignContent;
export const contentValidate = validateCampaignContentOperation;
export const contentCompile = compileCampaignContentOperation;
export const contentDiff = diffCampaignContent;
