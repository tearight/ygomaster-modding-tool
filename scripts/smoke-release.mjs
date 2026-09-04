import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSmokeGateFixture } from './release-smoke-fixture.mjs';
import { TARGET_CONTRACT_VERSION } from './release-pipeline.mjs';

const editorRoot = process.cwd();
const workspaceRoot = path.resolve(editorRoot, '..', '..');
const releaseRootArgument = process.argv.find((argument) => argument.startsWith('--release-root='));
const releaseRoot = releaseRootArgument ? path.resolve(releaseRootArgument.slice('--release-root='.length)) : path.join(workspaceRoot, 'release', 'modding-tool');
const releaseEntries = await fs.readdir(releaseRoot, { withFileTypes: true });
const releaseZips = releaseEntries
  .filter((entry) => entry.isFile() && /^YgoMaster-Modding-Tool-.+-win32-x64\.zip$/i.test(entry.name))
  .map((entry) => path.join(releaseRoot, entry.name));
if (releaseZips.length !== 1) throw new Error(`Expected exactly one Windows x64 release ZIP under ${releaseRoot}, found ${releaseZips.length}`);
const zip = releaseZips[0];
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ygomaster-release-smoke-'));
const run = (cli, cwd, args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', windowsHide: true }));

const findMaster = (value) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMaster(item);
      if (found) return found;
    }
  } else if (value && typeof value === 'object') {
    if (value.Master && typeof value.Master === 'object') return value.Master;
    for (const child of Object.values(value)) {
      const found = findMaster(child);
      if (found) return found;
    }
  }
  return undefined;
};

const smokeApp = async (appPath, workingDirectory) => {
  await fs.access(appPath);
  const userData = path.join(temp, 'user-data');
  const child = spawn(appPath, [`--user-data-dir=${userData}`, '--disable-gpu'], {
    cwd: workingDirectory,
    stdio: 'ignore',
    windowsHide: true,
  });
  let settled = false;
  let exitInfo;
  const exited = new Promise((resolve) => {
    child.once('error', (error) => {
      settled = true;
      resolve({ error });
    });
    child.once('exit', (code, signal) => {
      settled = true;
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), 8000));
  try {
    const outcome = await Promise.race([exited, timeout]);
    if (outcome?.error) throw outcome.error;
    if (outcome && outcome.code !== 0) throw new Error(`Packaged app exited early with code ${outcome.code} (${outcome.signal || 'no signal'})`);
    if (!outcome) {
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    return { earlyExit: Boolean(outcome), exit: exitInfo || null };
  } finally {
    if (!settled) child.kill();
  }
};

try {
  await fs.access(zip);
  const archiveEntries = execFileSync('tar', ['-tf', zip], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean);
    if (archiveEntries.some((entry) => {
      const normalized = entry.toLowerCase().replaceAll('\\', '/');
      return normalized.includes('/.cache/')
        || normalized.includes('/.db/')
        || normalized.endsWith('/.db')
        || normalized.endsWith('.cdb')
        || normalized.includes('/save/')
        || normalized.includes('/credentials/')
        || normalized.endsWith('/save.json')
        || normalized.endsWith('/credential.json')
        || normalized.endsWith('/credentials.json');
    })) {
    throw new Error('Release ZIP unexpectedly contains catalog cache or a CDB file');
  }
  execFileSync('tar', ['-xf', zip, '-C', temp], { stdio: 'inherit', windowsHide: true });
  const extractedRoot = path.join(temp, 'modding-tool');
  const cli = path.join(extractedRoot, 'cli', 'index.js');
  const manifest = JSON.parse(await fs.readFile(path.join(extractedRoot, 'manifest.json'), 'utf8'));
  if (manifest.targetContractVersion !== TARGET_CONTRACT_VERSION) throw new Error(`Release target contract mismatch: ${manifest.targetContractVersion || 'missing'}`);
  const info = run(cli, temp, ['info']);
  if (!info.ok || info.data?.version !== manifest.version) throw new Error(`Extracted CLI info failed: ${JSON.stringify(info)}`);
  const config = run(cli, temp, ['config', 'show']);
  if (!config.ok || path.resolve(config.data?.projectRoot || '') !== path.resolve(extractedRoot)) throw new Error(`Extracted CLI project root mismatch: ${JSON.stringify(config)}`);
  const catalog = run(cli, temp, ['catalog', 'status']);
  if (!catalog.ok || catalog.data?.valid !== false) throw new Error(`Catalog status without cache failed: ${JSON.stringify(catalog)}`);

  // Build a tiny local-only catalog and authored content root after extraction.
  // The archive itself must remain free of catalog/cache data.
  const databaseRoot = path.join(extractedRoot, '.db');
  await fs.mkdir(databaseRoot, { recursive: true });
  await fs.writeFile(path.join(databaseRoot, 'catalog.json'), JSON.stringify({ schemaVersion: 1, cards: [] }));
  await fs.writeFile(path.join(databaseRoot, 'metadata.json'), JSON.stringify({ schemaVersion: 1, generation: 'release-smoke-catalog', missingRuntimeIds: [] }));
  const contentRoot = path.join(extractedRoot, 'smoke-content');
  const contentIrRoot = path.join(extractedRoot, 'smoke-ir');
  const registryPath = path.join(extractedRoot, 'smoke-id-registry.json');
  await fs.mkdir(contentRoot, { recursive: true });
  await fs.writeFile(path.join(contentRoot, 'manifest.json'), JSON.stringify({
    formatVersion: 1,
    layer: 'content',
    campaign: { name: 'Release Content Smoke', slug: 'release-content-smoke', version: '0.0.1' },
    sourceOfTruth: true,
  }));
  for (const action of ['inspect', 'resolve', 'validate']) {
    const checked = run(cli, temp, ['content', action, '--content', contentRoot, '--ir', contentIrRoot, '--registry', registryPath]);
    if (!checked.ok) throw new Error(`Packaged content ${action} failed: ${JSON.stringify(checked)}`);
  }
  const compiledContent = run(cli, temp, ['content', 'compile', '--check', '--content', contentRoot, '--ir', contentIrRoot, '--registry', registryPath]);
  if (!compiledContent.ok || compiledContent.data?.mode !== 'check') throw new Error(`Packaged content compile check failed: ${JSON.stringify(compiledContent)}`);

  const sourceRoot = path.join(temp, 'source');
  const gameRoot = path.join(temp, 'fake-game');
  const initialized = run(cli, temp, ['workspace', 'init', '--source', sourceRoot]);
  if (!initialized.ok) throw new Error(`Workspace init failed: ${JSON.stringify(initialized)}`);
  await createSmokeGateFixture(sourceRoot);

  const fetched = run(cli, temp, ['runtime', 'fetch']);
  if (!fetched.ok || fetched.data?.cacheHit) throw new Error(`Expected first latest fetch to download: ${JSON.stringify(fetched)}`);
  const cached = run(cli, temp, ['runtime', 'fetch']);
  if (!cached.ok || !cached.data?.cacheHit) throw new Error(`Expected second latest fetch to hit cache: ${JSON.stringify(cached)}`);
  const deployed = run(cli, temp, ['campaign', 'deploy', '--source', sourceRoot, '--game-root', gameRoot, '--allow-legacy-ir']);
  if (!deployed.ok || !deployed.data?.path) throw new Error(`Release deploy failed: ${JSON.stringify(deployed)}`);
  const deploymentPath = deployed.data.path;
  const metadata = JSON.parse(await fs.readFile(path.join(deploymentPath, '.campaign-deployment.json'), 'utf8'));
  const soloDocument = JSON.parse(await fs.readFile(path.join(deploymentPath, 'Data', 'Solo.json'), 'utf8'));
  const master = findMaster(soloDocument);
  if (!master?.Solo?.gate?.['100']) throw new Error('Release campaign gate missing');
  if (metadata.resolvedRuntimeTag !== fetched.data.entry.tag) throw new Error('Deployment metadata runtime tag mismatch');
  const cacheRoot = path.join(extractedRoot, '.cache', 'ygomaster', 'releases');
  await fs.access(path.join(cacheRoot, metadata.resolvedRuntimeTag, 'metadata.json'));
  const app = await smokeApp(path.join(extractedRoot, 'app', 'ygomaster-modding-tool.exe'), path.join(extractedRoot, 'app'));
  console.log(JSON.stringify({ ok: true, zip, cli, catalogCachePresent: catalog.data?.valid, contentCommands: ['inspect', 'resolve', 'validate', 'compile --check'], tag: metadata.resolvedRuntimeTag, firstCacheHit: fetched.data.cacheHit, secondCacheHit: cached.data.cacheHit, deploymentPath, app }, null, 2));
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
