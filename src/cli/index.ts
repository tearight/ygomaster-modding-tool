#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  CONTRACT_VERSION,
  TOOL_VERSION,
  deployCampaign,
  catalogEnvironmentSources,
  catalogCardIds,
  catalogSearch,
  catalogStatus,
  refreshCatalog,
  validateCustomCardDatabase,
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
  isCatalogSortField,
  initializeLayeredWorkspace,
  inspectLayeredWorkspace,
  inspectCampaignContent,
  resolveCampaignContent,
  validateCampaignContentOperation,
  compileCampaignContentOperation,
  diffCampaignContent,
  discoverContentSnapshot,
  loadCardResolver,
  readRegistry,
  createEmptyRegistry,
  exists,
  IR_COMPILER_VERSION,
  YGOMASTER_TARGET_CONTRACT_VERSION,
  previewSourceMigration,
  applySourceMigration,
  SourceMigrationCandidateFile,
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
  'content inspect',
  'content resolve',
  'content validate',
  'content compile',
  'content diff',
  'migration preview',
  'migration apply',
  'runtime status',
  'runtime fetch',
  'catalog status',
  'catalog refresh',
  'catalog search',
  'catalog custom-validate',
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

const optionNumber = (parsed: ParsedArgs, key: string, fallback: number) => {
  const value = optionString(parsed, key);
  if (!value) return fallback;
  const parsedValue = Number(value);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
};

const findProjectRoot = (): string => {
  const configured = process.env.YGOMASTER_TOOL_PROJECT_ROOT;
  if (configured) return path.resolve(configured);
  const applicationRoot = resolveProjectRoot(__dirname);
  const workspaceCandidate = path.resolve(applicationRoot, '..', '..');
  return existsSync(path.join(workspaceCandidate, 'campaign', 'content', 'manifest.json'))
    ? workspaceCandidate
    : applicationRoot;
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

const readMigrationCandidate = async (candidateRoot: string): Promise<SourceMigrationCandidateFile[]> => {
  const root = path.resolve(candidateRoot);
  const output: SourceMigrationCandidateFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Migration candidate cannot contain symlinks: ${absolute}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push({ path: path.relative(root, absolute).split(path.sep).join('/'), content: await fs.readFile(absolute) });
      else throw new Error(`Migration candidate cannot contain special entries: ${absolute}`);
    }
  };
  await visit(root);
  return output;
};

const usage = () =>
  'Usage: node cli/index.js <command> [subcommand] [path] [--content path] [--ir path] [--registry path] [--check|--apply --expected-generation sha256] [--pretty]\nExamples: content inspect; content resolve; content validate; content compile --check; content compile --apply --expected-generation <sha256>; content diff; migration preview; migration apply --candidate <path> --accept --expected-source-generation <sha256> --expected-candidate-generation <sha256>';

const commandResult = async (parsed: ParsedArgs, projectRoot: string): Promise<OperationResult<unknown>> => {
  const config = await readConfig(projectRoot);
  const sourceRoot = optionString(parsed, 'source') || config.sourceRoot;
  const gameRoot = optionString(parsed, 'game-root') || config.gameRoot;
  const [group, action] = parsed.command;
  const resolvedSourceRoot = path.resolve(sourceRoot || path.join(projectRoot, 'campaign', 'source'));
  const managedIr = resolvedSourceRoot === path.resolve(projectRoot, 'campaign', 'source')
    || await exists(path.join(resolvedSourceRoot, 'generation.json'));

  const contentOptions = {
    projectRoot,
    ...(optionString(parsed, 'content') ? { contentRoot: optionString(parsed, 'content') } : {}),
    ...(optionString(parsed, 'ir') ? { irRoot: optionString(parsed, 'ir') } : {}),
    ...(optionString(parsed, 'registry') ? { registryPath: optionString(parsed, 'registry') } : {}),
    ...(parsed.options.get('allow-assumed-structure') === true ? { allowAssumedStructure: true } : {}),
  };

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
    if (action === 'init') {
      const layers = await initializeLayeredWorkspace(projectRoot);
      const source = await initWorkspace(projectRoot, sourceRoot);
      return result({ layers, source });
    }
    if (action === 'inspect') {
      const source = await inspectWorkspace(projectRoot, sourceRoot);
      if (!source.ok) return source;
      const layers = await inspectLayeredWorkspace(projectRoot);
      const errors = layers.problems.filter((entry) => entry.severity !== 'warning');
      const warnings = layers.problems.filter((entry) => entry.severity === 'warning');
      return errors.length ? failure(errors, 'COMMAND_FAILED', [...source.warnings, ...warnings]) : result({ source: source.data, layers }, [...source.warnings, ...warnings]);
    }
  }
  if (group === 'trash') {
    if (action === 'list') return listTrash(projectRoot, sourceRoot);
    if (action === 'restore') {
      const value = parsed.positionals[0];
      if (!value) return failure([problem('USAGE', 'trash restore requires a .trash relative path')], 'USAGE_ERROR');
      if (managedIr) return failure([problem('IR_MANAGED_READ_ONLY', 'Compiler-managed campaign/source cannot be restored or edited directly')], 'COMMAND_FAILED');
      return restoreTrash(projectRoot, sourceRoot, value);
    }
  }
  if (group === 'campaign') {
    if (action === 'validate') return validateCampaign(projectRoot, sourceRoot);
    if (action === 'deploy') {
      if (!gameRoot) return failure([problem('GAME_ROOT_REQUIRED', 'Configure game root before deploy')], 'PATH_ERROR');
      const deploySourceRoot = path.resolve(sourceRoot || path.join(projectRoot, 'campaign', 'source'));
      const managedGenerationPath = path.join(deploySourceRoot, 'generation.json');
      if (!(await exists(managedGenerationPath))) {
        if (parsed.options.get('allow-legacy-ir') !== true) {
          return failure([problem('IR_GENERATION_METADATA_MISSING', 'Managed deploy requires generation.json; use --allow-legacy-ir only for an explicitly reviewed legacy source')], 'COMMAND_FAILED');
        }
        return deployCampaign({ projectRoot, sourceRoot: deploySourceRoot, gameRoot });
      }
      const contentRoot = path.resolve(optionString(parsed, 'content') || path.join(projectRoot, 'campaign', 'content'));
      const registryPath = path.resolve(optionString(parsed, 'registry') || path.join(projectRoot, 'campaign', 'id-registry.json'));
      const snapshot = await discoverContentSnapshot(contentRoot, { projectRoot });
      if (!snapshot.ok || !snapshot.snapshot) return failure(snapshot.problems, 'COMMAND_FAILED');
      const resolver = await loadCardResolver(projectRoot);
      const registry = await exists(registryPath) ? await readRegistry(registryPath) : createEmptyRegistry();
      return deployCampaign({
        projectRoot,
        sourceRoot: deploySourceRoot,
        gameRoot,
        requireGenerationMetadata: true,
        expectedGeneration: {
          contentGeneration: snapshot.snapshot.contentGeneration,
          compilerVersion: IR_COMPILER_VERSION,
          catalogGeneration: resolver.catalogGeneration,
          idRegistryGeneration: registry.generation,
          targetContractVersion: YGOMASTER_TARGET_CONTRACT_VERSION,
        },
      });
    }
  }
  if (group === 'content') {
    if (action === 'inspect') return inspectCampaignContent(contentOptions);
    if (action === 'resolve') return resolveCampaignContent(contentOptions);
    if (action === 'validate') return validateCampaignContentOperation(contentOptions);
    if (action === 'diff') return diffCampaignContent(contentOptions);
    if (action === 'compile') return compileCampaignContentOperation({
      ...contentOptions,
      apply: parsed.options.get('apply') === true,
      ...(optionString(parsed, 'expected-generation') ? { expectedContentGeneration: optionString(parsed, 'expected-generation') } : {}),
    });
  }
  if (group === 'migration') {
    const candidateRoot = optionString(parsed, 'candidate');
    const candidateFiles = candidateRoot ? await readMigrationCandidate(candidateRoot) : undefined;
    const migrationOptions = {
      projectRoot,
      sourceRoot: resolvedSourceRoot,
      contentRoot: path.resolve(optionString(parsed, 'content') || path.join(projectRoot, 'campaign', 'content')),
      ...(candidateFiles ? { candidateFiles } : {}),
    };
    const preview = await previewSourceMigration(migrationOptions);
    if (action === 'preview' || !preview.ok || !preview.data) return preview;
    if (action === 'apply') {
      const expectedSourceGeneration = optionString(parsed, 'expected-source-generation');
      const expectedCandidateGeneration = optionString(parsed, 'expected-candidate-generation');
      if (!candidateRoot || !expectedSourceGeneration || !expectedCandidateGeneration || parsed.options.get('accept') !== true) {
        return failure([problem('USAGE', 'migration apply requires --candidate, --accept, --expected-source-generation, and --expected-candidate-generation')], 'USAGE_ERROR');
      }
      if (preview.data.candidateGeneration !== expectedCandidateGeneration) {
        return failure([problem('MIGRATION_PREVIEW_STALE', 'Reviewed candidate generation does not match the current candidate directory')], 'COMMAND_FAILED');
      }
      return applySourceMigration({
        ...migrationOptions,
        preview: preview.data,
        accept: true,
        expectedSourceGeneration,
        ...(optionString(parsed, 'backup') ? { backupRoot: optionString(parsed, 'backup') } : {}),
      });
    }
  }
  if (group === 'runtime') {
    if (action === 'status') return runtimeStatus(projectRoot);
    if (action === 'fetch') return runtimeFetch(projectRoot);
  }
  if (group === 'catalog') {
    if (action === 'status') return catalogStatus(projectRoot);
    if (action === 'search') {
      const sortValue = optionString(parsed, 'sort') || 'id';
      const direction = optionString(parsed, 'order') === 'desc' ? 'desc' as const : 'asc' as const;
      if (!isCatalogSortField(sortValue)) return failure([problem('USAGE', `Unsupported catalog sort field ${sortValue}`)], 'USAGE_ERROR');
      return catalogSearch(projectRoot, parsed.positionals.join(' '), optionNumber(parsed, 'limit', 100), sourceRoot, optionNumber(parsed, 'offset', 0), { field: sortValue, direction });
    }
    if (action === 'custom-validate') {
      const ids = await catalogCardIds(projectRoot);
      if (!ids.ok || !ids.data) return ids;
      return validateCustomCardDatabase(projectRoot, sourceRoot, new Set(ids.data));
    }
    if (action === 'refresh') {
      const configured = catalogEnvironmentSources();
      const koreanUrl = optionString(parsed, 'korean-url');
      const englishUrl = optionString(parsed, 'english-url');
      const format = optionString(parsed, 'format') === 'json' ? 'json' as const : 'sqlite' as const;
      const online = parsed.options.get('online') === true;
      const sources = [
        ...(koreanUrl ? [{ id: 'korean', language: 'korean' as const, url: koreanUrl, format }] : []),
        ...(englishUrl ? [{ id: 'english', language: 'english' as const, url: englishUrl, format }] : []),
      ];
      const refreshed = await refreshCatalog(projectRoot, { sources: sources.length ? sources : configured, online });
      if (!refreshed.ok || !refreshed.data) return refreshed;
      return {
        ...refreshed,
        data: { status: refreshed.data.status, cacheHit: refreshed.data.cacheHit, sourceUsage: refreshed.data.sourceUsage },
      };
    }
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
    if (action === 'write' || action === 'delete') {
      if (managedIr) return failure([problem('IR_MANAGED_READ_ONLY', 'Compiler-managed campaign/source is read-only; edit campaign/content and run content compile')], 'COMMAND_FAILED');
    }
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
