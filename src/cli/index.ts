#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  CONTRACT_VERSION,
  TOOL_VERSION,
  deployCampaign,
  inspectDeployment,
  inspectWorkspace,
  initWorkspace,
  launchDeployment,
  listDeployments,
  listDocuments,
  listTrash,
  readConfig,
  readDocument,
  restoreTrash,
  result,
  runtimeFetch,
  runtimeStatus,
  updateConfig,
  validateCampaign,
  writeDocument,
  deleteDocument,
  isDocumentType,
  JsonValue,
  OperationResult,
  DocumentType,
  failure,
  parseJsonc,
  problem,
  resolveProjectRoot,
} from '../core';

interface ParsedArgs {
  command: string[];
  options: Map<string, string | boolean>;
  positionals: string[];
}

export interface CliIo {
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
}

export const CLI_COMMAND_REGISTRY = [
  'info',
  'config show',
  'config set-game-root',
  'config set-source-root',
  'workspace init',
  'workspace inspect',
  'gate list',
  'gate read',
  'gate write',
  'gate delete',
  'deck list',
  'deck read',
  'deck write',
  'deck delete',
  'structure list',
  'structure read',
  'structure write',
  'structure delete',
  'trash list',
  'trash restore',
  'campaign validate',
  'campaign deploy',
  'runtime status',
  'runtime fetch',
  'deployment list',
  'deployment inspect',
  'deployment launch',
] as const;

const parseArgs = (argv: string[]): ParsedArgs => {
  const command: string[] = [];
  const positionals: string[] = [];
  const options = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      if (command.length < 2) command.push(value);
      else positionals.push(value);
      continue;
    }
    const equals = value.indexOf('=');
    if (equals > 2) {
      options.set(value.slice(2, equals), value.slice(equals + 1));
    } else {
      const key = value.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        options.set(key, next);
        index += 1;
      } else {
        options.set(key, true);
      }
    }
  }
  return { command, options, positionals };
};

const optionString = (parsed: ParsedArgs, key: string) => {
  const value = parsed.options.get(key);
  return typeof value === 'string' ? value : undefined;
};

const findProjectRoot = (): string => {
  const configured = process.env.YGOMASTER_TOOL_PROJECT_ROOT;
  if (configured) return path.resolve(configured);
  return resolveProjectRoot(__dirname);
};

const readJsonInput = async (parsed: ParsedArgs): Promise<JsonValue> => {
  const file = optionString(parsed, 'file');
  const text = file ? await fs.readFile(path.resolve(file), 'utf8') : await readStdin();
  return parseJsonc<JsonValue>(text);
};

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) throw new Error('Provide --file or pipe JSON on stdin');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const usage = () =>
  'Usage: node cli/index.js <command> [subcommand] [path] [--source path] [--game-root path] [--pretty]';

const commandResult = async (parsed: ParsedArgs, projectRoot: string): Promise<OperationResult<unknown>> => {
  const config = await readConfig(projectRoot);
  const sourceRoot = optionString(parsed, 'source') || config.sourceRoot;
  const gameRoot = optionString(parsed, 'game-root') || config.gameRoot;
  const [group, action] = parsed.command;

  if (group === 'info') return result({ name: 'ygomaster-modding-tool', version: TOOL_VERSION, contractVersion: CONTRACT_VERSION, node: process.version, platform: process.platform });
  if (group === 'config') {
    if (action === 'show') return result({ projectRoot, path: path.resolve(projectRoot, '.local', 'modding-tool.json'), config });
    if (action === 'set-game-root' || action === 'set-source-root') {
      const value = parsed.positionals[0];
      if (!value) return failure([problem('USAGE', `${action} requires a path`)], 'USAGE_ERROR');
      const updated = await updateConfig(projectRoot, action === 'set-game-root' ? { gameRoot: value } : { sourceRoot: value });
      return result(updated);
    }
  }
  if (group === 'workspace') {
    if (action === 'init') return result(await initWorkspace(projectRoot, sourceRoot));
    if (action === 'inspect') return inspectWorkspace(projectRoot, sourceRoot);
  }
  if (group === 'trash') {
    if (action === 'list') return listTrash(projectRoot, sourceRoot);
    if (action === 'restore') {
      const value = parsed.positionals[0];
      if (!value) return failure([problem('USAGE', 'trash restore requires a .trash relative path')], 'USAGE_ERROR');
      return restoreTrash(projectRoot, sourceRoot, value);
    }
  }
  if (group === 'campaign') {
    if (action === 'validate') return validateCampaign(projectRoot, sourceRoot);
    if (action === 'deploy') {
      if (!gameRoot) return failure([problem('GAME_ROOT_REQUIRED', 'Configure game root before deploy')], 'PATH_ERROR');
      return deployCampaign({ projectRoot, sourceRoot, gameRoot });
    }
  }
  if (group === 'runtime') {
    if (action === 'status') return runtimeStatus(projectRoot);
    if (action === 'fetch') return runtimeFetch(projectRoot);
  }
  if (group === 'deployment') {
    if (action === 'list') {
      if (!gameRoot) return failure([problem('GAME_ROOT_REQUIRED', 'Configure game root before listing deployments')], 'PATH_ERROR');
      return listDeployments(gameRoot);
    }
    const deploymentPath = parsed.positionals[0];
    if (!deploymentPath) return failure([problem('USAGE', `${action} requires a deployment path`)], 'USAGE_ERROR');
    if (action === 'inspect') return inspectDeployment(deploymentPath);
    if (action === 'launch') return launchDeployment(deploymentPath);
  }
  if (isDocumentType(group)) {
    const type = group as DocumentType;
    if (action === 'list') return listDocuments(projectRoot, sourceRoot, type);
    const relativePath = parsed.positionals[0];
    if (!relativePath) return failure([problem('USAGE', `${group} ${action} requires a relative JSON path`)], 'USAGE_ERROR');
    if (action === 'read') return readDocument(projectRoot, sourceRoot, type, relativePath);
    if (action === 'write') return writeDocument(projectRoot, sourceRoot, type, relativePath, await readJsonInput(parsed), parsed.options.get('replace') === true);
    if (action === 'delete') return deleteDocument(projectRoot, sourceRoot, type, relativePath);
  }
  return failure([problem('USAGE', usage())], 'USAGE_ERROR');
};

export const runCli = async (argv: string[], io: CliIo = {}): Promise<number> => {
  const parsed = parseArgs(argv);
  const projectRoot = findProjectRoot();
  let operation: OperationResult<unknown>;
  try {
    operation = await commandResult(parsed, projectRoot);
  } catch (error) {
    operation = failure([problem('INTERNAL_ERROR', String(error))], 'INTERNAL_ERROR');
  }
  const pretty = parsed.options.get('pretty') === true;
  const output = JSON.stringify(operation, null, pretty ? 2 : undefined);
  (io.stdout || ((value: string) => process.stdout.write(`${value}\n`)))(output);
  if (!operation.ok) (io.stderr || ((value: string) => process.stderr.write(`${value}\n`)))(operation.problems.map((entry) => `${entry.code}: ${entry.message}`).join('\n'));
  return operation.exitCode;
};

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
