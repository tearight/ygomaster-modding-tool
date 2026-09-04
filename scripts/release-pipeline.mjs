import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const TARGET_CONTRACT_VERSION = 'ygomaster-campaign-target/v3';
export const RELEASE_BUILD_STATE_VERSION = 2;

const commandName = (name) => process.platform === 'win32' ? `${name}.cmd` : name;
const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;

export const timed = async (name, action, timings) => {
  const started = performance.now();
  try {
    return await action();
  } finally {
    timings[name] = Math.round(performance.now() - started);
  }
};

export const runReleaseStages = async ({ preflight, verify, buildElectron, assemble, smoke, publish }) => {
  await preflight();
  await verify();
  await buildElectron();
  await assemble();
  await smoke();
  await publish();
};

export const runLogged = (command, args, { cwd, label, logDirectory }) => {
  const result = execFileSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return result;
};

export const runLoggedSafe = async (command, args, options) => {
  try {
    return runLogged(command, args, options);
  } catch (error) {
    await fs.mkdir(options.logDirectory, { recursive: true });
    const logPath = path.join(options.logDirectory, `${options.label.replaceAll(/[^a-z0-9.-]+/gi, '-')}.log`);
    const details = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    await fs.writeFile(logPath, details);
    throw new Error(`${options.label} failed. Diagnostic log: ${logPath}`, { cause: error });
  }
};

const canWriteDirectory = async (directory) => {
  await fs.mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.release-write-probe-${process.pid}-${Date.now()}`);
  await fs.writeFile(probe, 'probe');
  await fs.rm(probe);
};

export const findCanonicalReleaseProcesses = async (releaseRoot) => {
  if (process.platform !== 'win32') return [];
  const script = [
    "$ErrorActionPreference='Stop'",
    `$root=[IO.Path]::GetFullPath(${quotePowerShell(releaseRoot)}).TrimEnd('\\') + '\\'`,
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  $p=$_.ExecutablePath',
    '  if ($p -and [IO.Path]::GetFullPath($p).StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) {',
    '    [PSCustomObject]@{ ProcessId=$_.ProcessId; Name=$_.Name; ExecutablePath=$p }',
    '  }',
    '} | ConvertTo-Json -Compress',
  ].join('; ');
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
};

export const preflightRelease = async ({ editorRoot, workspaceRoot, releaseRoot, processFinder = findCanonicalReleaseProcesses }) => {
  if (process.platform !== 'win32') throw new Error('Windows x64 release must be built on Windows');
  for (const tool of ['powershell.exe', 'tar.exe']) {
    try {
      execFileSync('where.exe', [tool], { stdio: 'ignore', windowsHide: true });
    } catch {
      throw new Error(`Required Windows tool is unavailable: ${tool}`);
    }
  }
  await canWriteDirectory(path.dirname(releaseRoot));
  if (existsSync(releaseRoot)) await canWriteDirectory(releaseRoot);
  const running = await processFinder(releaseRoot);
  if (running.length) {
    const detail = running.map((item) => `${item.Name || 'process'} (${item.ProcessId || '?'})`).join(', ');
    throw new Error(`Canonical release is in use: ${detail}. Close the portable app before rebuilding.`);
  }
  const packageJson = JSON.parse(await fs.readFile(path.join(editorRoot, 'package.json'), 'utf8'));
  const lockJson = JSON.parse(await fs.readFile(path.join(editorRoot, 'package-lock.json'), 'utf8'));
  if (packageJson.version !== lockJson.packages?.['']?.version) throw new Error('package.json and package-lock.json versions differ');
  const contractSource = await fs.readFile(path.join(editorRoot, 'src', 'core', 'layers.ts'), 'utf8');
  if (!contractSource.includes(`YGOMASTER_TARGET_CONTRACT_VERSION = '${TARGET_CONTRACT_VERSION}'`)) {
    throw new Error(`Source target contract is not ${TARGET_CONTRACT_VERSION}`);
  }
  const generation = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'campaign', 'source', 'generation.json'), 'utf8'));
  if (generation.targetContractVersion !== TARGET_CONTRACT_VERSION) {
    throw new Error(`Campaign IR target contract is stale: ${generation.targetContractVersion || 'missing'}`);
  }
  const registry = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'campaign', 'id-registry.json'), 'utf8'));
  if (registry.targetContractVersion !== TARGET_CONTRACT_VERSION) {
    throw new Error(`Campaign ID registry target contract is stale: ${registry.targetContractVersion || 'missing'}`);
  }
  return { packageJson, lockJson, targetContractVersion: TARGET_CONTRACT_VERSION };
};

export const validateBuiltCliContract = ({ editorRoot, workspaceRoot }) => {
  const cli = path.join(editorRoot, 'dist-cli', 'cli', 'index.js');
  let output;
  try {
    output = JSON.parse(execFileSync(process.execPath, [cli, 'content', 'inspect',
      '--content', path.join(workspaceRoot, 'campaign', 'content'),
      '--ir', path.join(workspaceRoot, 'campaign', 'source'),
      '--registry', path.join(workspaceRoot, 'campaign', 'id-registry.json')],
    { cwd: editorRoot, encoding: 'utf8', windowsHide: true }));
  } catch (error) {
    throw new Error('Built portable CLI could not inspect the current campaign contract', { cause: error });
  }
  if (!output.ok) throw new Error(`Built portable CLI campaign inspection failed: ${JSON.stringify(output.problems || [])}`);
  if (output.data?.targetContractVersion !== TARGET_CONTRACT_VERSION) {
    throw new Error(`Built portable CLI target contract is stale: ${output.data?.targetContractVersion || 'missing'}`);
  }
  if (output.data?.generationStatus?.state !== 'current') {
    throw new Error(`Campaign source/IR generation is ${output.data?.generationStatus?.state || 'unknown'}; compile and review it before release`);
  }
  return output.data;
};

const packageNameForSpecifier = (specifier) => specifier.startsWith('@')
  ? specifier.split('/').slice(0, 2).join('/')
  : specifier.split('/')[0];

export const discoverCliRuntimeDependencies = async ({ editorRoot, distCliRoot }) => {
  const discovered = new Set();
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const text = await fs.readFile(fullPath, 'utf8');
        const patterns = [/require\(["']([^"']+)["']\)/g, /from\s+["']([^"']+)["']/g, /import\(["']([^"']+)["']\)/g];
        for (const pattern of patterns) {
          for (const match of text.matchAll(pattern)) {
            const specifier = match[1];
            if (!specifier.startsWith('.') && !specifier.startsWith('node:') && !path.isAbsolute(specifier)) {
              discovered.add(packageNameForSpecifier(specifier));
            }
          }
        }
      }
    }
  };
  await visit(distCliRoot);
  const queue = [...discovered];
  while (queue.length) {
    const dependency = queue.shift();
    const packagePath = path.join(editorRoot, 'node_modules', ...dependency.split('/'), 'package.json');
    let metadata;
    try {
      metadata = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    } catch {
      throw new Error(`Portable CLI runtime dependency is not installed: ${dependency}`);
    }
    for (const child of Object.keys(metadata.dependencies || {})) {
      if (!discovered.has(child)) {
        discovered.add(child);
        queue.push(child);
      }
    }
  }
  return [...discovered].sort();
};

export const copyCliRuntimeDependencies = async ({ editorRoot, stagingRoot, dependencies }) => {
  for (const dependency of dependencies) {
    const source = path.join(editorRoot, 'node_modules', ...dependency.split('/'));
    const destination = path.join(stagingRoot, 'node_modules', ...dependency.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true });
  }
};

export const copyCliBuildOutput = async ({ distCliRoot, stagingRoot }) => {
  if (!existsSync(path.join(distCliRoot, 'cli', 'index.js'))) {
    throw new Error(`Portable CLI entrypoint is missing: ${path.join(distCliRoot, 'cli', 'index.js')}`);
  }
  await fs.cp(distCliRoot, stagingRoot, { recursive: true });
};

export const hashFile = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');

export const hashTree = async (root) => {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  await visit(root);
  files.sort((left, right) => path.relative(root, left).localeCompare(path.relative(root, right)));
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(path.relative(root, file).replaceAll('\\', '/'));
    digest.update('\0');
    digest.update(await fs.readFile(file));
    digest.update('\0');
  }
  return { digest: digest.digest('hex'), fileCount: files.length };
};

export const readReusableBuildState = async ({ editorRoot, verificationKey }) => {
  const statePath = path.join(editorRoot, 'out', '.release-build-state.json');
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    const distCliRoot = path.join(editorRoot, 'dist-cli');
    const appRoot = path.join(editorRoot, state.appRelativePath || '');
    if (state.schemaVersion !== RELEASE_BUILD_STATE_VERSION || state.verificationKey !== verificationKey) return undefined;
    if (!existsSync(distCliRoot) || !existsSync(appRoot) || !existsSync(path.join(appRoot, 'ygomaster-modding-tool.exe'))) return undefined;
    const [cliTree, appTree] = await Promise.all([hashTree(distCliRoot), hashTree(appRoot)]);
    if (state.cliTree?.digest !== cliTree.digest || state.cliTree?.fileCount !== cliTree.fileCount) return undefined;
    if (state.appTree?.digest !== appTree.digest || state.appTree?.fileCount !== appTree.fileCount) return undefined;
    return { ...state, appRoot, statePath };
  } catch {
    return undefined;
  }
};

export const writeBuildState = async ({ editorRoot, verificationKey, appRoot }) => {
  const statePath = path.join(editorRoot, 'out', '.release-build-state.json');
  const [cliTree, appTree] = await Promise.all([hashTree(path.join(editorRoot, 'dist-cli')), hashTree(appRoot)]);
  const state = {
    schemaVersion: RELEASE_BUILD_STATE_VERSION,
    verificationKey,
    cliTree,
    appTree,
    appRelativePath: path.relative(editorRoot, appRoot),
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
};

export const findPackagedApp = async (editorRoot) => {
  const outRoot = path.join(editorRoot, 'out');
  const entries = await fs.readdir(outRoot, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes('win32-x64'));
  if (candidates.length !== 1) throw new Error(`Expected one Windows x64 Electron package under out/, found ${candidates.length}`);
  return path.join(outRoot, candidates[0].name);
};

export const createReleaseArchive = async ({ stagingRoot, archivePath }) => {
  await fs.rm(archivePath, { force: true });
  execFileSync('tar.exe', ['-a', '-c', '-f', archivePath, '-C', path.dirname(stagingRoot), path.basename(stagingRoot)], { stdio: 'ignore', windowsHide: true });
};

export const publishRelease = async ({ stagingRoot, releaseRoot, beforePromote }) => {
  const backupRoot = `${releaseRoot}.previous-${process.pid}-${Date.now()}`;
  let priorMoved = false;
  try {
    if (existsSync(releaseRoot)) {
      await fs.rename(releaseRoot, backupRoot);
      priorMoved = true;
    }
    if (beforePromote) await beforePromote();
    await fs.rename(stagingRoot, releaseRoot);
  } catch (error) {
    if (priorMoved && !existsSync(releaseRoot)) await fs.rename(backupRoot, releaseRoot);
    throw error;
  }
  if (priorMoved) await fs.rm(backupRoot, { recursive: true, force: true });
};

export const npmCommand = commandName('npm');
export const makeLogDirectory = async () => fs.mkdtemp(path.join(os.tmpdir(), 'ygomaster-release-logs-'));
