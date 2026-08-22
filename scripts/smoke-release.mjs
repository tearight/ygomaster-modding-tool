import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const zip = path.join(root, 'release', 'modding-tool', 'YgoMaster-Modding-Tool-0.13.0-win32-x64.zip');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ygomaster-release-smoke-'));
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
const run = (cli, cwd, args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', windowsHide: true }));

try {
  execFileSync('tar', ['-xf', zip, '-C', temp], { stdio: 'inherit', windowsHide: true });
  const releaseRoot = path.join(temp, 'modding-tool');
  const cli = path.join(releaseRoot, 'cli', 'index.js');
  const info = run(cli, temp, ['info']);
  if (!info.ok || info.data?.version !== '0.13.0') throw new Error('Extracted CLI info failed');
  const config = run(cli, temp, ['config', 'show']);
  if (!config.ok || path.resolve(config.data?.projectRoot || '') !== path.resolve(releaseRoot)) throw new Error(`Extracted CLI project root mismatch: ${JSON.stringify(config)}`);

  const sourceRoot = path.join(temp, 'source');
  const gameRoot = path.join(temp, 'fake-game');
  const initialized = run(cli, temp, ['workspace', 'init', '--source', sourceRoot]);
  if (!initialized.ok) throw new Error(`Workspace init failed: ${JSON.stringify(initialized)}`);
  await fs.writeFile(path.join(sourceRoot, 'deck', 'cpu.json'), JSON.stringify({ m: { ids: [10001], r: [1] }, e: { ids: [], r: [] }, s: { ids: [], r: [] } }));
  await fs.writeFile(path.join(sourceRoot, 'gate', '90001.json'), JSON.stringify({ id: 90001, name: 'Release smoke', description: 'Release smoke', priority: 1, clear_chapter: { gateId: 90001, chapterId: 1 }, chapters: [{ id: 1, type: 'Duel', cpu_deck: 'cpu.json', cpu_name: 'CPU' }] }));

  const fetched = run(cli, temp, ['runtime', 'fetch']);
  if (!fetched.ok || fetched.data?.cacheHit) throw new Error(`Expected first latest fetch to download: ${JSON.stringify(fetched)}`);
  const cached = run(cli, temp, ['runtime', 'fetch']);
  if (!cached.ok || !cached.data?.cacheHit) throw new Error(`Expected second latest fetch to hit cache: ${JSON.stringify(cached)}`);
  const deployed = run(cli, temp, ['campaign', 'deploy', '--source', sourceRoot, '--game-root', gameRoot]);
  if (!deployed.ok || !deployed.data?.path) throw new Error(`Release deploy failed: ${JSON.stringify(deployed)}`);
  const deploymentPath = deployed.data.path;
  const metadata = JSON.parse(await fs.readFile(path.join(deploymentPath, '.campaign-deployment.json'), 'utf8'));
  const soloDocument = JSON.parse(await fs.readFile(path.join(deploymentPath, 'Data', 'Solo.json'), 'utf8'));
  const master = findMaster(soloDocument);
  if (!master?.Solo?.gate?.['90001']) throw new Error('Release overlay gate missing');
  if (metadata.resolvedRuntimeTag !== fetched.data.entry.tag) throw new Error('Deployment metadata runtime tag mismatch');
  const cacheRoot = path.join(releaseRoot, '.cache', 'ygomaster', 'releases');
  await fs.access(path.join(cacheRoot, metadata.resolvedRuntimeTag, 'metadata.json'));
  console.log(JSON.stringify({ ok: true, cli, tag: metadata.resolvedRuntimeTag, firstCacheHit: fetched.data.cacheHit, secondCacheHit: cached.data.cacheHit, deploymentPath }, null, 2));
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
