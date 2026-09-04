import * as fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteJson, exists } from './fs';
import { ProjectConfig } from './types';

export const LOCAL_CONFIG_RELATIVE = path.join('.local', 'modding-tool.json');

export const getConfigPath = (projectRoot: string) => path.resolve(projectRoot, LOCAL_CONFIG_RELATIVE);

export const readConfig = async (projectRoot: string): Promise<ProjectConfig> => {
  const configPath = getConfigPath(projectRoot);
  if (!(await exists(configPath))) return {};
  try {
    return (JSON.parse(await fs.readFile(configPath, 'utf8')) || {}) as ProjectConfig;
  } catch {
    throw new Error(`Could not parse ${configPath}`);
  }
};

export const writeConfig = async (projectRoot: string, config: ProjectConfig): Promise<ProjectConfig> => {
  const normalized: ProjectConfig = {
    ...(config.workspaceRoot ? { workspaceRoot: path.resolve(config.workspaceRoot) } : {}),
    ...(config.gameRoot ? { gameRoot: path.resolve(config.gameRoot) } : {}),
    ...(config.sourceRoot ? { sourceRoot: path.resolve(config.sourceRoot) } : {}),
  };
  await atomicWriteJson(getConfigPath(projectRoot), normalized);
  return normalized;
};

export const updateConfig = async (projectRoot: string, patch: ProjectConfig): Promise<ProjectConfig> =>
  writeConfig(projectRoot, { ...(await readConfig(projectRoot)), ...patch });
