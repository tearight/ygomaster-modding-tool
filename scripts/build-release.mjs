import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TARGET_CONTRACT_VERSION, copyCliRuntimeDependencies, createReleaseArchive,
  discoverCliRuntimeDependencies, findPackagedApp, makeLogDirectory, npmCommand,
  preflightRelease, publishRelease, readReusableBuildState, runLoggedSafe,
  runReleaseStages, timed, validateBuiltCliContract, writeBuildState,
} from './release-pipeline.mjs';
import { preflightSmokeFixture } from './release-smoke-fixture.mjs';

const editorRoot = process.cwd();
const workspaceRoot = path.resolve(editorRoot, '..', '..');
const releaseParent = path.join(workspaceRoot, 'release');
const releaseRoot = path.join(releaseParent, 'modding-tool');
const verificationScript = path.join(workspaceRoot, 'scripts', 'verification-stamp.mjs');
const verificationStamp = path.join(workspaceRoot, '.cache', 'verification', 'full-verification-v1.json');
const candidateParent = path.join(releaseParent, `.modding-tool-candidate-${randomUUID()}`);
const candidateRoot = path.join(candidateParent, 'modding-tool');
const logDirectory = await makeLogDirectory();
const smokeFixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ygomaster-release-fixture-preflight-'));
const timings = {};
const summary = { verification: 'unknown', build: 'unknown', dependencies: [], timings };
let preflight;
let appRoot;
let cliPrebuilt = false;

const validateStamp = async () => {
  try {
    const stdout = await runLoggedSafe(process.execPath, [verificationScript, 'validate', '--workspace-root', workspaceRoot, '--stamp', verificationStamp, '--json'], {
      cwd: workspaceRoot, label: 'verification-stamp-validate', logDirectory,
    });
    const result = JSON.parse(stdout);
    if (!result.valid) throw new Error(`Verification stamp rejected: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`);
    return result;
  } catch (error) {
    if (error.cause?.status === 2 || error.status === 2) return undefined;
    throw error;
  }
};

const ensureVerified = async () => {
  let validation = await validateStamp();
  if (validation) {
    summary.verification = 'reused';
    return validation;
  }
  summary.verification = 'cold';
  await runLoggedSafe('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(workspaceRoot, 'scripts', 'verify-workspace.ps1'), '-Full'], {
    cwd: workspaceRoot, label: 'full-workspace-verification', logDirectory,
  });
  validation = await validateStamp();
  if (!validation) throw new Error('Full workspace verification completed without a valid verification stamp');
  return validation;
};

const verificationKey = (validation) => createHash('sha256').update(JSON.stringify({
  inputs: validation.current?.inputs, toolchain: validation.current?.toolchain,
})).digest('hex');

const buildCliAndPreflight = async () => {
  await runLoggedSafe(npmCommand, ['run', 'build:cli'], { cwd: editorRoot, label: 'build-cli', logDirectory });
  validateBuiltCliContract({ editorRoot, workspaceRoot });
  summary.dependencies = await discoverCliRuntimeDependencies({ editorRoot, distCliRoot: path.join(editorRoot, 'dist-cli') });
  if (!summary.dependencies.length) throw new Error('Portable CLI dependency discovery returned no dependencies');
};

const assemble = async () => {
  await fs.mkdir(path.join(candidateRoot, 'cli'), { recursive: true });
  await fs.cp(path.join(editorRoot, 'dist-cli', 'cli', 'index.js'), path.join(candidateRoot, 'cli', 'index.js'));
  await fs.cp(path.join(editorRoot, 'dist-cli', 'core'), path.join(candidateRoot, 'core'), { recursive: true });
  await copyCliRuntimeDependencies({ editorRoot, stagingRoot: candidateRoot, dependencies: summary.dependencies });
  await fs.cp(appRoot, path.join(candidateRoot, 'app'), { recursive: true });
  await fs.writeFile(path.join(candidateRoot, 'manifest.json'), `${JSON.stringify({
    name: 'YgoMaster Modding Tool', version: preflight.packageJson.version, platform: 'win32', arch: 'x64',
    cli: 'cli/index.js', coreContractVersion: 1, targetContractVersion: TARGET_CONTRACT_VERSION,
  }, null, 2)}\n`);
  await fs.writeFile(path.join(candidateRoot, 'README.md'), `# YgoMaster Modding Tool ${preflight.packageJson.version}\n\nPortable Windows x64 release. Requires Node.js >=20 for the CLI.\n\nRun: node cli/index.js info\n`);
  const licenseCandidates = [path.join(editorRoot, 'LICENSE'), path.join(workspaceRoot, 'repositories', 'YgoMaster', 'LICENSE')];
  const licensePath = licenseCandidates.find((candidate) => existsSync(candidate));
  if (!licensePath) throw new Error('Could not find an existing LICENSE file for the portable release');
  await fs.cp(licensePath, path.join(candidateRoot, 'LICENSE'));
  const archiveName = `YgoMaster-Modding-Tool-${preflight.packageJson.version}-win32-x64.zip`;
  const archiveTemp = path.join(candidateParent, archiveName);
  await createReleaseArchive({ stagingRoot: candidateRoot, archivePath: archiveTemp });
  await fs.cp(archiveTemp, path.join(candidateRoot, archiveName));
  await fs.rm(archiveTemp);
};

try {
  let stampValidation;
  await runReleaseStages({
    preflight: async () => timed('preflight', async () => {
      preflight = await preflightRelease({ editorRoot, workspaceRoot, releaseRoot });
      await preflightSmokeFixture(smokeFixtureRoot);
      const existingCli = path.join(editorRoot, 'dist-cli', 'cli', 'index.js');
      if (existsSync(existingCli)) validateBuiltCliContract({ editorRoot, workspaceRoot });
      else {
        await buildCliAndPreflight();
        cliPrebuilt = true;
      }
    }, timings),
    verify: async () => timed('verify', async () => { stampValidation = await ensureVerified(); }, timings),
    buildElectron: async () => timed('build', async () => {
      if (!cliPrebuilt) await buildCliAndPreflight();
      const key = verificationKey(stampValidation);
      const reusable = await readReusableBuildState({ editorRoot, verificationKey: key });
      if (reusable) {
        summary.build = 'reused';
        appRoot = reusable.appRoot;
        return;
      }
      summary.build = 'cold';
      await runLoggedSafe(npmCommand, ['run', 'package', '--', '--platform=win32', '--arch=x64'], { cwd: editorRoot, label: 'electron-package', logDirectory });
      appRoot = await findPackagedApp(editorRoot);
      await writeBuildState({ editorRoot, verificationKey: key, appRoot });
    }, timings),
    assemble: async () => timed('assemble', assemble, timings),
    smoke: async () => timed('smoke', async () => {
      await runLoggedSafe(process.execPath, [path.join(editorRoot, 'scripts', 'smoke-release.mjs'), `--release-root=${candidateRoot}`], {
        cwd: editorRoot, label: 'candidate-release-smoke', logDirectory,
      });
    }, timings),
    publish: async () => timed('publish', async () => publishRelease({ stagingRoot: candidateRoot, releaseRoot }), timings),
  });
  summary.ok = true;
  summary.releaseRoot = releaseRoot;
  summary.totalMs = Object.values(timings).reduce((total, value) => total + value, 0);
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(JSON.stringify({ ok: false, message: error.message, diagnosticDirectory: logDirectory, timings }));
  process.exitCode = 1;
} finally {
  await fs.rm(smokeFixtureRoot, { recursive: true, force: true });
  await fs.rm(candidateParent, { recursive: true, force: true });
}
