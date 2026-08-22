import * as fs from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { atomicWriteJson, copyDirectory, ensureDirectory, exists, readJsonFile, removeExact } from './fs';
import { loadManifest } from './manifest';
import { applyCampaignOverlay } from './overlay';
import { ensureRuntime, runtimeStatus } from './runtime';
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
  return !!campaign && typeof campaign.name === 'string' && typeof campaign.slug === 'string' && typeof campaign.version === 'string'
    && typeof metadata.deployedAt === 'string' && typeof metadata.resolvedRuntimeTag === 'string'
    && !!runtimeAsset && typeof runtimeAsset.name === 'string' && typeof runtimeAsset.url === 'string'
    && typeof metadata.moddingToolVersion === 'string' && Number.isInteger(metadata.contractVersion);
};

export interface DeployOptions {
  projectRoot: string;
  sourceRoot?: string;
  gameRoot: string;
  transport?: import('./types').RuntimeTransport;
  logger?: CoreLogger;
  toolVersion?: string;
}

export const deployCampaign = async (options: DeployOptions): Promise<OperationResult<DeploymentSummary>> => {
  const warnings: Problem[] = [];
  try {
    const sourceRoot = path.resolve(options.sourceRoot || path.join(options.projectRoot, 'campaign', 'source'));
    const validation = await validateCampaign(options.projectRoot, sourceRoot);
    warnings.push(...validation.warnings);
    if (!validation.ok) return failure(validation.problems, 'COMMAND_FAILED', warnings);
    const manifest = await loadManifest(sourceRoot);
    const runtime = await ensureRuntime(options.projectRoot, { transport: options.transport, logger: options.logger });
    warnings.push(...runtime.warnings);
    const campaignName = manifest.campaign?.name || manifest.campaignId || 'Campaign';
    const campaignSlug = safePart(manifest.campaign?.slug || manifest.campaignId || 'campaign', 'campaign', warnings, 'Campaign slug');
    const campaignVersion = manifest.campaign?.version || '0.1.0';
    const versionPart = safePart(campaignVersion, '0.1.0', warnings, 'Campaign version');
    await ensureDirectory(options.gameRoot);
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const finalPath = await uniqueDeploymentPath(options.gameRoot, `YgoMaster-${campaignSlug}-${versionPart}-${timestamp}`);
    const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await copyDirectory(runtime.value.entry.runtimePath, tempPath);
      const overlay = await applyCampaignOverlay(sourceRoot, tempPath, { projectRoot: options.projectRoot, logger: options.logger });
      warnings.push(...overlay.warnings);
      for (const relative of overlay.changedFiles.filter((file) => file.toLowerCase().endsWith('.json'))) {
        await readJsonFile(path.resolve(tempPath, ...relative.split('/')));
      }
      const metadata: DeploymentMetadata = {
        campaign: { name: campaignName, slug: manifest.campaign?.slug || manifest.campaignId || 'campaign', version: campaignVersion },
        deployedAt: new Date().toISOString(),
        resolvedRuntimeTag: runtime.value.entry.tag,
        runtimeAsset: { name: runtime.value.entry.assetName, url: runtime.value.entry.assetUrl },
        moddingToolVersion: options.toolVersion || TOOL_VERSION,
        contractVersion: CONTRACT_VERSION,
      };
      await atomicWriteJson(path.join(tempPath, DEPLOYMENT_METADATA_FILE), metadata);
      await fs.rename(tempPath, finalPath);
      return result({ path: finalPath, metadata }, warnings);
    } catch (error) {
      await removeExact(tempPath);
      throw error;
    }
  } catch (error) {
    return failure([problem('CAMPAIGN_DEPLOY_FAILED', String(error))], 'COMMAND_FAILED', warnings);
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
  } catch {
    return false;
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
