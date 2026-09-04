import * as fs from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { atomicWriteJson, copyDirectory, ensureDirectory, exists, readJsonFile, removeExact } from './fs';
import { IR_GENERATION_METADATA_FILE, IRGenerationMetadata, YGOMASTER_TARGET_CONTRACT_VERSION, readIrGenerationMetadata } from './layers';
import { loadManifest } from './manifest';
import { materializeCampaignData } from './materialize';
import { applyDiagnosticProjection, inspectDiagnosticProjection } from './diagnostic-projection';
import type { DiagnosticSoloEnvelope } from './diagnostic-projection';
import { ensureRuntime, runtimeStatus } from './runtime';
import {
  LOCAL_PROFILE_RELATIVE_PATH,
  copyOpaqueLocalProfile,
  sameOpaqueSaveSnapshot,
  snapshotOpaqueLocalProfile,
  type OpaqueSaveSnapshot,
} from './save-carryover';
import { CoreLogger, DeploymentMetadata, DeploymentSummary, OperationResult, Problem, failure, problem, result } from './types';
import { validateCampaign } from './validate';

const execFileAsync = promisify(execFile);
export const DEPLOYMENT_METADATA_FILE = '.campaign-deployment.json';
export const TOOL_VERSION = '0.13.0';
export const CONTRACT_VERSION = 1;

const safePart = (value: string, fallback: string, warnings: Problem[], label: string) => {
  const original = value || fallback;
  const safe = original.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
  if (safe !== original) warnings.push(problem('SAFE_NAME_NORMALIZED', `${label} was normalized for a Windows path`, undefined, 'warning'));
  return safe;
};

const uniqueDeploymentPath = async (gameRoot: string, baseName: string) => {
  let candidate = path.join(gameRoot, baseName);
  let suffix = 1;
  while (await exists(candidate)) {
    candidate = path.join(gameRoot, `${baseName}-${suffix}`);
    suffix += 1;
  }
  return candidate;
};

const isDeploymentMetadata = (value: unknown): value is DeploymentMetadata => {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as Record<string, unknown>;
  const campaign = metadata.campaign as Record<string, unknown> | undefined;
  const runtimeAsset = metadata.runtimeAsset as Record<string, unknown> | undefined;
  const irGeneration = metadata.irGeneration as Record<string, unknown> | undefined;
  const diagnosticProfile = metadata.diagnosticProfile as Record<string, unknown> | undefined;
  const saveCarryover = metadata.saveCarryover as Record<string, unknown> | undefined;
  const nonEmpty = (entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0;
  const validIrGeneration = irGeneration === undefined || (
    nonEmpty(irGeneration.contentGeneration)
    && nonEmpty(irGeneration.compilerVersion)
    && nonEmpty(irGeneration.catalogGeneration)
    && nonEmpty(irGeneration.idRegistryGeneration)
    && irGeneration.targetContractVersion === YGOMASTER_TARGET_CONTRACT_VERSION
  );
  const validDiagnosticProfile = diagnosticProfile === undefined || (
    nonEmpty(diagnosticProfile.id)
    && nonEmpty(diagnosticProfile.projectionGeneration)
    && (diagnosticProfile.soloEnvelope === 'exact' || diagnosticProfile.soloEnvelope === 'preserve-runtime')
  );
  const validSaveCarryover = saveCarryover === undefined || (
    saveCarryover.contract === 'ygomaster-local-save/opaque-copy-v1'
    && (saveCarryover.sourceKind === 'current' || saveCarryover.sourceKind === 'legacy')
    && nonEmpty(saveCarryover.backupId)
    && nonEmpty(saveCarryover.generation)
    && Number.isInteger(saveCarryover.fileCount)
    && Number.isInteger(saveCarryover.totalBytes)
  );
  return !!campaign && typeof campaign.name === 'string' && typeof campaign.slug === 'string' && typeof campaign.version === 'string'
    && typeof metadata.deployedAt === 'string' && typeof metadata.resolvedRuntimeTag === 'string'
    && !!runtimeAsset && typeof runtimeAsset.name === 'string' && typeof runtimeAsset.url === 'string'
    && typeof metadata.moddingToolVersion === 'string' && Number.isInteger(metadata.contractVersion)
    && validIrGeneration && validDiagnosticProfile && validSaveCarryover;
};

export interface DeployOptions {
  projectRoot: string;
  sourceRoot?: string;
  gameRoot: string;
  transport?: import('./types').RuntimeTransport;
  logger?: CoreLogger;
  toolVersion?: string;
  /** Expected authored/service generations. Supplying this makes generation metadata mandatory. */
  expectedGeneration?: ExpectedDeploymentGeneration;
  requireGenerationMetadata?: boolean;
  /** Required when an existing compatible Local profile will be carried forward. */
  acceptSaveCarryover?: boolean;
  /** Test seam for the fail-closed process precondition. */
  isRunning?: (name: string) => Promise<boolean>;
  /** Test seam for recoverable current/archive promotion failures. */
  renamePath?: (source: string, target: string) => Promise<void>;
  /** Test seam used to prove that a save changed after staging is rejected. */
  beforeSavePromotion?: () => Promise<void>;
}

export interface ExpectedDeploymentGeneration {
  contentGeneration: string;
  compilerVersion?: string;
  catalogGeneration?: string;
  idRegistryGeneration?: string;
  targetContractVersion?: string;
}

export interface DiagnosticProjectionDeployOptions {
  projectRoot: string;
  projectionRoot: string;
  gameRoot: string;
  profileId: string;
  soloEnvelope: DiagnosticSoloEnvelope;
  transport?: import('./types').RuntimeTransport;
  logger?: CoreLogger;
  toolVersion?: string;
}

const generationValue = (metadata: IRGenerationMetadata): string =>
  metadata.idRegistryGeneration || metadata.idLockGeneration || '';

const compactTimestamp = (value: string | Date) =>
  (value instanceof Date ? value.toISOString() : value).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export const stableDeploymentName = (campaignSlug: string) => `YgoMaster-${campaignSlug}-current`;

interface SaveSource {
  deploymentPath: string;
  profilePath: string;
  sourceKind: 'current' | 'legacy';
  snapshot: OpaqueSaveSnapshot;
}

const localProfileExists = (deploymentPath: string) => exists(path.join(deploymentPath, LOCAL_PROFILE_RELATIVE_PATH, 'Player.json'));

const compatibleSaveDeployment = (
  metadata: DeploymentMetadata,
  campaignSlug: string,
  campaignVersion: string,
  runtimeTag: string,
) => !metadata.diagnosticProfile
  && metadata.campaign.slug === campaignSlug
  && metadata.campaign.version === campaignVersion
  && metadata.resolvedRuntimeTag === runtimeTag
  && metadata.contractVersion === CONTRACT_VERSION;

const findSaveSource = async (options: {
  gameRoot: string;
  currentPath: string;
  campaignSlug: string;
  campaignVersion: string;
  runtimeTag: string;
}): Promise<{ source?: SaveSource; warnings: Problem[] }> => {
  const warnings: Problem[] = [];
  if (await exists(options.currentPath)) {
    const inspected = await inspectDeployment(options.currentPath);
    if (!inspected.ok || !inspected.data) throw new Error('Stable current deployment metadata is invalid');
    if (await localProfileExists(options.currentPath)) {
      if (!compatibleSaveDeployment(inspected.data.metadata, options.campaignSlug, options.campaignVersion, options.runtimeTag)) {
        throw new Error('Stable current Local save is not compatible with the requested runtime and campaign version');
      }
      const profilePath = path.join(options.currentPath, LOCAL_PROFILE_RELATIVE_PATH);
      return { source: { deploymentPath: options.currentPath, profilePath, sourceKind: 'current', snapshot: await snapshotOpaqueLocalProfile(profilePath) }, warnings };
    }
  }

  const listed = await listDeployments(options.gameRoot);
  if (!listed.ok || !listed.data) throw new Error('Could not inspect legacy deployments for Local save carryover');
  const compatible: SaveSource[] = [];
  let incompatibleSaveFound = false;
  for (const deployment of listed.data) {
    if (path.resolve(deployment.path) === path.resolve(options.currentPath)) continue;
    if (!(await localProfileExists(deployment.path))) continue;
    if (!compatibleSaveDeployment(deployment.metadata, options.campaignSlug, options.campaignVersion, options.runtimeTag)) {
      if (deployment.metadata.campaign.slug === options.campaignSlug) incompatibleSaveFound = true;
      continue;
    }
    const profilePath = path.join(deployment.path, LOCAL_PROFILE_RELATIVE_PATH);
    compatible.push({ deploymentPath: deployment.path, profilePath, sourceKind: 'legacy', snapshot: await snapshotOpaqueLocalProfile(profilePath) });
  }
  compatible.sort((left, right) => right.snapshot.playerJsonModifiedAt.localeCompare(left.snapshot.playerJsonModifiedAt));
  if (!compatible.length && incompatibleSaveFound) {
    throw new Error('Existing campaign saves use an unsupported runtime or campaign version');
  }
  if (!compatible.length) return { warnings };
  warnings.push(problem(
    'LEGACY_LOCAL_SAVE_AUTO_SELECTED',
    'The most recently modified compatible legacy Local save will become the stable current save',
    undefined,
    'warning',
  ));
  return { source: compatible[0], warnings };
};

const ensureRuntimeStopped = async (runningCheck: (name: string) => Promise<boolean>) => {
  for (const processName of ['YgoMaster.exe', 'YgoMasterClient.exe', 'masterduel.exe']) {
    if (await runningCheck(processName)) throw new Error(`Cannot promote a deployment while ${processName} is running`);
  }
};

export const validateDeploymentGeneration = async (
  sourceRoot: string,
  expected?: ExpectedDeploymentGeneration,
  required = Boolean(expected),
): Promise<OperationResult<IRGenerationMetadata | undefined>> => {
  const metadataPath = path.join(sourceRoot, IR_GENERATION_METADATA_FILE);
  if (!(await exists(metadataPath))) {
    if (!required) return result(undefined);
    return failure([problem(
      'IR_GENERATION_METADATA_MISSING',
      `Managed IR generation metadata is required before deployment: ${metadataPath}`,
      IR_GENERATION_METADATA_FILE,
    )], 'COMMAND_FAILED');
  }
  try {
    const metadata = await readIrGenerationMetadata(sourceRoot);
    const mismatches: Problem[] = [];
    const compare = (field: string, actual: string, wanted: string | undefined) => {
      if (wanted !== undefined && actual !== wanted) mismatches.push(problem(
        'IR_GENERATION_STALE',
        `IR ${field} is stale: expected ${wanted}, received ${actual}`,
        `${IR_GENERATION_METADATA_FILE}:${field}`,
      ));
    };
    compare('contentGeneration', metadata.contentGeneration, expected?.contentGeneration);
    compare('compilerVersion', metadata.compilerVersion, expected?.compilerVersion);
    compare('catalogGeneration', metadata.catalogGeneration, expected?.catalogGeneration);
    compare('idRegistryGeneration', generationValue(metadata), expected?.idRegistryGeneration);
    compare('targetContractVersion', metadata.targetContractVersion, expected?.targetContractVersion);
    if (mismatches.length) return failure(mismatches, 'COMMAND_FAILED');
    return result(metadata);
  } catch (error) {
    return failure([problem('IR_GENERATION_METADATA_INVALID', String(error), IR_GENERATION_METADATA_FILE)], 'COMMAND_FAILED');
  }
};

export const deployCampaign = async (options: DeployOptions): Promise<OperationResult<DeploymentSummary>> => {
  const warnings: Problem[] = [];
  try {
    const sourceRoot = path.resolve(options.sourceRoot || path.join(options.projectRoot, 'campaign', 'source'));
    const generation = await validateDeploymentGeneration(
      sourceRoot,
      options.expectedGeneration,
      options.requireGenerationMetadata || Boolean(options.expectedGeneration),
    );
    if (!generation.ok) return failure(generation.problems, 'COMMAND_FAILED', warnings);
    const validation = await validateCampaign(options.projectRoot, sourceRoot);
    warnings.push(...validation.warnings);
    if (!validation.ok) return failure(validation.problems, 'COMMAND_FAILED', warnings);
    const manifest = await loadManifest(sourceRoot);
    const runtime = await ensureRuntime(options.projectRoot, { transport: options.transport, logger: options.logger });
    warnings.push(...runtime.warnings);
    const campaignName = manifest.campaign?.name || manifest.campaignId || 'Campaign';
    const campaignSlug = safePart(manifest.campaign?.slug || manifest.campaignId || 'campaign', 'campaign', warnings, 'Campaign slug');
    const campaignVersion = manifest.campaign?.version || '0.1.0';
    await ensureDirectory(options.gameRoot);
    const finalPath = path.join(options.gameRoot, stableDeploymentName(campaignSlug));
    const tempPath = `${finalPath}.next-${process.pid}-${Date.now()}`;
    const runningCheck = options.isRunning || defaultRunningCheck;
    await ensureRuntimeStopped(runningCheck);
    const selectedSave = await findSaveSource({
      gameRoot: options.gameRoot,
      currentPath: finalPath,
      campaignSlug: manifest.campaign?.slug || manifest.campaignId || 'campaign',
      campaignVersion,
      runtimeTag: runtime.value.entry.tag,
    });
    warnings.push(...selectedSave.warnings);
    if (selectedSave.source && options.acceptSaveCarryover !== true) {
      return failure([problem(
        'SAVE_CARRYOVER_CONFIRMATION_REQUIRED',
        'A compatible Local save was found. Re-run with explicit save carryover confirmation.',
      )], 'COMMAND_FAILED', warnings);
    }
    let backupId: string | undefined;
    let carriedSnapshot: OpaqueSaveSnapshot | undefined;
    let preserveTempOnFailure = false;
    try {
      await copyDirectory(runtime.value.entry.runtimePath, tempPath);
      const materialized = await materializeCampaignData(sourceRoot, tempPath, { projectRoot: options.projectRoot, logger: options.logger });
      warnings.push(...materialized.warnings);
      for (const relative of materialized.changedFiles.filter((file) => file.toLowerCase().endsWith('.json'))) {
        await readJsonFile(path.resolve(tempPath, ...relative.split('/')));
      }
      if (selectedSave.source) {
        const copied = await copyOpaqueLocalProfile({
          sourceProfileRoot: selectedSave.source.profilePath,
          targetProfileRoot: path.join(tempPath, LOCAL_PROFILE_RELATIVE_PATH),
          gameRoot: options.gameRoot,
        });
        backupId = copied.backupId;
        carriedSnapshot = copied.snapshot;
      }
      const metadata: DeploymentMetadata = {
        campaign: { name: campaignName, slug: manifest.campaign?.slug || manifest.campaignId || 'campaign', version: campaignVersion },
        deployedAt: new Date().toISOString(),
        resolvedRuntimeTag: runtime.value.entry.tag,
        runtimeAsset: { name: runtime.value.entry.assetName, url: runtime.value.entry.assetUrl },
        moddingToolVersion: options.toolVersion || TOOL_VERSION,
        contractVersion: CONTRACT_VERSION,
        ...(generation.data ? {
          irGeneration: {
            contentGeneration: generation.data.contentGeneration,
            compilerVersion: generation.data.compilerVersion,
            catalogGeneration: generation.data.catalogGeneration,
            idRegistryGeneration: generationValue(generation.data),
            targetContractVersion: generation.data.targetContractVersion,
          },
        } : {}),
        ...(selectedSave.source && backupId && carriedSnapshot ? {
          saveCarryover: {
            contract: 'ygomaster-local-save/opaque-copy-v1' as const,
            sourceKind: selectedSave.source.sourceKind,
            backupId,
            generation: carriedSnapshot.generation,
            fileCount: carriedSnapshot.fileCount,
            totalBytes: carriedSnapshot.totalBytes,
          },
        } : {}),
      };
      await atomicWriteJson(path.join(tempPath, DEPLOYMENT_METADATA_FILE), metadata);
      if (selectedSave.source && options.beforeSavePromotion) await options.beforeSavePromotion();
      if (selectedSave.source && carriedSnapshot) {
        const currentSource = await snapshotOpaqueLocalProfile(selectedSave.source.profilePath);
        if (!sameOpaqueSaveSnapshot(carriedSnapshot, currentSource)) throw new Error('Local save changed before deployment promotion');
      }
      await ensureRuntimeStopped(runningCheck);

      const renamePath = options.renamePath || fs.rename;
      let archivedPath: string | undefined;
      let promoted = false;
      try {
        if (await exists(finalPath)) {
          const current = await inspectDeployment(finalPath);
          if (!current.ok || !current.data) throw new Error('Stable current deployment metadata became invalid before promotion');
          const archivedVersion = safePart(current.data.metadata.campaign.version, 'unknown', warnings, 'Archived campaign version');
          archivedPath = await uniqueDeploymentPath(
            options.gameRoot,
            `YgoMaster-${campaignSlug}-${archivedVersion}-${compactTimestamp(current.data.metadata.deployedAt)}`,
          );
          await renamePath(finalPath, archivedPath);
        }
        await renamePath(tempPath, finalPath);
        promoted = true;
        const inspected = await inspectDeployment(finalPath);
        if (!inspected.ok || !inspected.data) throw new Error('Promoted current deployment failed metadata validation');
        if (carriedSnapshot) {
          const publishedSave = await snapshotOpaqueLocalProfile(path.join(finalPath, LOCAL_PROFILE_RELATIVE_PATH));
          if (!sameOpaqueSaveSnapshot(carriedSnapshot, publishedSave)) throw new Error('Promoted current Local save failed verification');
        }
      } catch (promotionError) {
        try {
          if (promoted && await exists(finalPath)) {
            const quarantinePath = await uniqueDeploymentPath(options.gameRoot, `YgoMaster-${campaignSlug}-failed-${compactTimestamp(new Date())}`);
            await renamePath(finalPath, quarantinePath);
          }
          if (archivedPath && await exists(archivedPath)) await renamePath(archivedPath, finalPath);
        } catch (rollbackError) {
          preserveTempOnFailure = true;
          throw new Error(`Deployment promotion failed and automatic rollback failed; recovery artifacts were preserved (${String(promotionError)}; ${String(rollbackError)})`);
        }
        throw promotionError;
      }
      return result({ path: finalPath, metadata }, warnings);
    } catch (error) {
      if (!preserveTempOnFailure && await exists(tempPath)) await removeExact(tempPath);
      throw error;
    }
  } catch (error) {
    return failure([problem('CAMPAIGN_DEPLOY_FAILED', String(error))], 'COMMAND_FAILED', warnings);
  }
};

/**
 * Deploy a final-shape Solo comparator without invoking the authored campaign
 * compiler or materializer. This is intentionally separate from production
 * campaign deploy so diagnostic values cannot become source defaults.
 */
export const deployDiagnosticProjection = async (
  options: DiagnosticProjectionDeployOptions,
): Promise<OperationResult<DeploymentSummary>> => {
  const warnings: Problem[] = [];
  try {
    if (!options.profileId.trim()) {
      return failure([problem('DIAGNOSTIC_PROFILE_REQUIRED', 'Diagnostic projection deploy requires a non-empty profile id')], 'USAGE_ERROR');
    }
    const projection = await inspectDiagnosticProjection(options.projectionRoot);
    const runtime = await ensureRuntime(options.projectRoot, { transport: options.transport, logger: options.logger });
    warnings.push(...runtime.warnings);
    const profilePart = safePart(options.profileId, 'solo-canary', warnings, 'Diagnostic profile');
    await ensureDirectory(options.gameRoot);
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const finalPath = await uniqueDeploymentPath(options.gameRoot, `YgoMaster-solo-canary-${profilePart}-${timestamp}`);
    const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await copyDirectory(runtime.value.entry.runtimePath, tempPath);
      const applied = await applyDiagnosticProjection(options.projectionRoot, tempPath, options.soloEnvelope);
      if (applied.generation !== projection.generation) {
        throw new Error('Diagnostic projection changed after preflight inspection');
      }
      for (const relative of applied.changedFiles.filter((file) => file.toLowerCase().endsWith('.json'))) {
        await readJsonFile(path.resolve(tempPath, ...relative.split('/')));
      }
      const metadata: DeploymentMetadata = {
        campaign: {
          name: `Solo diagnostic: ${options.profileId}`,
          slug: `solo-canary-${profilePart}`,
          version: 'diagnostic',
        },
        deployedAt: new Date().toISOString(),
        resolvedRuntimeTag: runtime.value.entry.tag,
        runtimeAsset: { name: runtime.value.entry.assetName, url: runtime.value.entry.assetUrl },
        moddingToolVersion: options.toolVersion || TOOL_VERSION,
        contractVersion: CONTRACT_VERSION,
        diagnosticProfile: {
          id: options.profileId,
          projectionGeneration: applied.generation,
          soloEnvelope: options.soloEnvelope,
        },
      };
      await atomicWriteJson(path.join(tempPath, DEPLOYMENT_METADATA_FILE), metadata);
      await fs.rename(tempPath, finalPath);
      return result({ path: finalPath, metadata }, warnings);
    } catch (error) {
      await removeExact(tempPath);
      throw error;
    }
  } catch (error) {
    return failure([problem('DIAGNOSTIC_PROJECTION_DEPLOY_FAILED', String(error))], 'COMMAND_FAILED', warnings);
  }
};

export const inspectDeployment = async (deploymentPath: string): Promise<OperationResult<DeploymentSummary>> => {
  try {
    const metadata = await readJsonFile<DeploymentMetadata>(path.join(deploymentPath, DEPLOYMENT_METADATA_FILE));
    if (!isDeploymentMetadata(metadata)) throw new Error('Deployment metadata is invalid');
    return result({ path: path.resolve(deploymentPath), metadata });
  } catch (error) {
    return failure([problem('DEPLOYMENT_INSPECT_FAILED', String(error), deploymentPath)], 'PATH_ERROR');
  }
};

export const listDeployments = async (gameRoot: string): Promise<OperationResult<DeploymentSummary[]>> => {
  try {
    const entries = (await exists(gameRoot)) ? await fs.readdir(gameRoot, { withFileTypes: true }) : [];
    const deployments: DeploymentSummary[] = [];
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const inspected = await inspectDeployment(path.join(gameRoot, entry.name));
      if (inspected.ok && inspected.data) deployments.push(inspected.data);
    }
    deployments.sort((left, right) => right.metadata.deployedAt.localeCompare(left.metadata.deployedAt));
    return result(deployments);
  } catch (error) {
    return failure([problem('DEPLOYMENT_LIST_FAILED', String(error), gameRoot)], 'PATH_ERROR');
  }
};

const defaultRunningCheck = async (name: string): Promise<boolean> => {
  if (process.platform !== 'win32') return false;
  try {
    const output = await execFileAsync('tasklist.exe', ['/FI', `IMAGENAME eq ${name}`]);
    return output.stdout.toLowerCase().includes(name.toLowerCase());
  } catch (error) {
    throw new Error(`Could not verify whether ${name} is running: ${String(error)}`);
  }
};

export const launchDeployment = async (
  deploymentPath: string,
  options: { isRunning?: (name: string) => Promise<boolean>; launch?: (file: string, cwd: string) => void } = {},
): Promise<OperationResult<{ launched: boolean; path: string }>> => {
  try {
    const inspected = await inspectDeployment(deploymentPath);
    if (!inspected.ok || !inspected.data) return failure(inspected.problems, inspected.exitName);
    const root = path.resolve(deploymentPath);
    const executable = path.join(root, 'YgoMasterClient.exe');
    if (!(await exists(executable))) return failure([problem('RUNTIME_EXECUTABLE_MISSING', 'YgoMasterClient.exe is missing', executable)], 'PATH_ERROR');
    const runningCheck = options.isRunning || defaultRunningCheck;
    for (const processName of ['YgoMaster.exe', 'YgoMasterClient.exe', 'masterduel.exe']) {
      if (await runningCheck(processName)) return failure([problem('RUNTIME_ALREADY_RUNNING', `Cannot launch while ${processName} is running`)], 'COMMAND_FAILED');
    }
    if (options.launch) options.launch(executable, root);
    else spawn(executable, [], { cwd: root, detached: true, stdio: 'ignore' }).unref();
    return result({ launched: true, path: root });
  } catch (error) {
    return failure([problem('DEPLOYMENT_LAUNCH_FAILED', String(error), deploymentPath)], 'COMMAND_FAILED');
  }
};

export const deploymentStatus = async (projectRoot: string): Promise<OperationResult<unknown>> => runtimeStatus(projectRoot);
