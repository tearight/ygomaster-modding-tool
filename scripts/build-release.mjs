import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const editorRoot = process.cwd();
const workspaceRoot = path.resolve(editorRoot, '..', '..');
const releaseRoot = path.join(workspaceRoot, 'release', 'modding-tool');
const editorReleaseRoot = path.join(editorRoot, 'release');
const run = (command, args) => execFileSync(command, args, { cwd: editorRoot, stdio: 'inherit', windowsHide: true });

run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'type-check']);
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'lint']);
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'test']);
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:cli']);
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'package', '--', '--platform=win32', '--arch=x64']);

const stagingParent = await fs.mkdtemp(path.join(os.tmpdir(), 'ygomaster-release-'));
const stagingRoot = path.join(stagingParent, 'modding-tool');
const packageText = JSON.parse(await fs.readFile(path.join(editorRoot, 'package.json'), 'utf8'));
const archiveName = `YgoMaster-Modding-Tool-${packageText.version}-win32-x64.zip`;
const archiveTempPath = path.join(stagingParent, archiveName);

try {
  // Remove only generated release directories. The portable handoff belongs
  // at the workspace root; no editor-local release is retained.
  await fs.mkdir(path.join(stagingRoot, 'cli'), { recursive: true });
  await fs.cp(path.join(editorRoot, 'dist-cli', 'cli', 'index.js'), path.join(stagingRoot, 'cli', 'index.js'), { recursive: true });
  await fs.cp(path.join(editorRoot, 'dist-cli', 'core'), path.join(stagingRoot, 'core'), { recursive: true });

  const outRoot = path.join(editorRoot, 'out');
  const outEntries = existsSync(outRoot) ? await fs.readdir(outRoot, { withFileTypes: true }) : [];
  const appCandidates = outEntries.filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes('win32-x64'));
  if (!appCandidates.length) throw new Error('Could not find Windows x64 Electron package under out/');
  await fs.cp(path.join(outRoot, appCandidates[0].name), path.join(stagingRoot, 'app'), { recursive: true });

  await fs.writeFile(path.join(stagingRoot, 'manifest.json'), `${JSON.stringify({ name: 'YgoMaster Modding Tool', version: packageText.version, platform: 'win32', arch: 'x64', cli: 'cli/index.js', coreContractVersion: 1 }, null, 2)}\n`);
  await fs.writeFile(path.join(stagingRoot, 'README.md'), `# YgoMaster Modding Tool ${packageText.version}\n\nPortable Windows x64 release. Requires Node.js >=20 for the CLI.\n\nRun: node cli/index.js info\n`);
  const licenseCandidates = [
    path.join(editorRoot, 'LICENSE'),
    path.join(workspaceRoot, 'repositories', 'YgoMaster', 'LICENSE'),
  ];
  const licensePath = licenseCandidates.find((candidate) => existsSync(candidate));
  if (!licensePath) throw new Error('Could not find an existing LICENSE file for the portable release');
  await fs.cp(licensePath, path.join(stagingRoot, 'LICENSE'));

  if (process.platform !== 'win32') throw new Error('Windows x64 release ZIP must be built on Windows');
  const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;
  const command = `$ErrorActionPreference='Stop'; Compress-Archive -Path ${quotePowerShell(stagingRoot)} -DestinationPath ${quotePowerShell(archiveTempPath)} -Force`;
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { cwd: editorRoot, stdio: 'inherit', windowsHide: true });

  // Do not remove an existing handoff until all checks and archive creation
  // have succeeded. This keeps the last good release recoverable on failure.
  await fs.rm(editorReleaseRoot, { recursive: true, force: true });
  await fs.rm(releaseRoot, { recursive: true, force: true });
  await fs.mkdir(releaseRoot, { recursive: true });
  await fs.cp(archiveTempPath, path.join(releaseRoot, archiveName));
  for (const entry of await fs.readdir(stagingRoot)) {
    await fs.cp(path.join(stagingRoot, entry), path.join(releaseRoot, entry), { recursive: true, force: false, errorOnExist: true });
  }
  console.log(JSON.stringify({ releaseRoot, zipPath: path.join(releaseRoot, archiveName), version: packageText.version }, null, 2));
} finally {
  await fs.rm(stagingParent, { recursive: true, force: true });
}
