import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const editorRoot = process.cwd();
const workspaceRoot = path.resolve(editorRoot, '..', '..');
const releaseRoot = path.join(workspaceRoot, 'release', 'modding-tool');
const archives = (await fs.readdir(releaseRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /^YgoMaster-Modding-Tool-.+-win32-x64\.zip$/iu.test(entry.name));
if (archives.length !== 1) throw new Error(`Expected one portable release archive, found ${archives.length}`);

const temporaryRoot = await fs.mkdtemp(path.join(editorRoot, '.content-cli-smoke-'));
try {
  const archive = path.join(releaseRoot, archives[0].name);
  execFileSync('tar', ['-xf', archive, '-C', temporaryRoot], { windowsHide: true });
  const extractedRoot = path.join(temporaryRoot, 'modding-tool');
  const cli = path.join(extractedRoot, 'cli', 'index.js');
  const databaseRoot = path.join(extractedRoot, '.db');
  await fs.mkdir(databaseRoot, { recursive: true });
  await fs.writeFile(path.join(databaseRoot, 'catalog.json'), JSON.stringify({ schemaVersion: 1, cards: [] }));
  await fs.writeFile(path.join(databaseRoot, 'metadata.json'), JSON.stringify({ schemaVersion: 1, generation: 'offline-content-smoke', missingRuntimeIds: [] }));
  const contentRoot = path.join(extractedRoot, 'campaign', 'content');
  const irRoot = path.join(extractedRoot, 'campaign', 'source');
  const registryPath = path.join(extractedRoot, 'campaign', 'id-registry.json');
  await fs.mkdir(contentRoot, { recursive: true });
  await fs.writeFile(path.join(contentRoot, 'manifest.json'), JSON.stringify({
    formatVersion: 1,
    layer: 'content',
    campaign: { name: 'Offline CLI Smoke', slug: 'offline-cli-smoke', version: '0.0.1' },
    sourceOfTruth: true,
  }));
  const run = (args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], {
    cwd: temporaryRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, YGOMASTER_TOOL_PROJECT_ROOT: extractedRoot },
  }));
  const commands = [
    ['content', 'inspect'],
    ['content', 'resolve'],
    ['content', 'validate'],
    ['content', 'compile', '--check'],
    ['content', 'diff'],
  ];
  const results = commands.map((command) => ({ command: command.join(' '), result: run(command) }));
  for (const entry of results) if (!entry.result.ok) throw new Error(`${entry.command} failed: ${JSON.stringify(entry.result)}`);
  const irExists = await fs.stat(irRoot).then(() => true, () => false);
  const registryExists = await fs.stat(registryPath).then(() => true, () => false);
  if (irExists || registryExists) throw new Error('Read-only packaged content smoke mutated IR or registry');
  console.log(JSON.stringify({ ok: true, archive, commands: results.map((entry) => entry.command), network: false }, null, 2));
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
