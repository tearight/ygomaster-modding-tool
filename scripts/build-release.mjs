import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const releaseRoot = path.join(root, 'release', 'modding-tool');
const stagingRoot = path.join(root, 'release', '.staging', 'modding-tool');
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });

run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'type-check']);
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'lint']);
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'test']);
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:cli']);
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'package', '--', '--platform=win32', '--arch=x64']);

await fs.rm(path.join(root, 'release'), { recursive: true, force: true });
await fs.mkdir(stagingRoot, { recursive: true });
await fs.mkdir(path.join(stagingRoot, 'cli'), { recursive: true });
await fs.cp(path.join(root, 'dist-cli', 'cli', 'index.js'), path.join(stagingRoot, 'cli', 'index.js'), { recursive: true });
await fs.cp(path.join(root, 'dist-cli', 'core'), path.join(stagingRoot, 'core'), { recursive: true });

const outRoot = path.join(root, 'out');
const outEntries = existsSync(outRoot) ? await fs.readdir(outRoot, { withFileTypes: true }) : [];
const appCandidates = outEntries.filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes('win32-x64'));
if (!appCandidates.length) throw new Error('Could not find Windows x64 Electron package under out/');
await fs.cp(path.join(outRoot, appCandidates[0].name), path.join(stagingRoot, 'app'), { recursive: true });

const packageText = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
await fs.writeFile(path.join(stagingRoot, 'manifest.json'), `${JSON.stringify({ name: 'YgoMaster Modding Tool', version: packageText.version, platform: 'win32', arch: 'x64', cli: 'cli/index.js', coreContractVersion: 1 }, null, 2)}\n`);
await fs.writeFile(path.join(stagingRoot, 'README.md'), `# YgoMaster Modding Tool ${packageText.version}\n\nPortable Windows x64 release. Requires Node.js >=20 for the CLI.\n\nRun: node cli/index.js info\n`);
await fs.writeFile(path.join(stagingRoot, 'LICENSE'), 'MIT License\n\nCopyright (c) YgoMaster Modding Tool contributors.\n');

const archiveName = `YgoMaster-Modding-Tool-${packageText.version}-win32-x64.zip`;
const archiveTempPath = path.join(root, 'release', '.staging', archiveName);
const zipPath = path.join(releaseRoot, archiveName);
await fs.mkdir(releaseRoot, { recursive: true });
const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;
if (process.platform === 'win32') {
  const command = `$ErrorActionPreference='Stop'; Compress-Archive -Path ${quotePowerShell(stagingRoot)} -DestinationPath ${quotePowerShell(archiveTempPath)} -Force`;
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { cwd: root, stdio: 'inherit', windowsHide: true });
} else {
  throw new Error('Windows x64 release ZIP must be built on Windows');
}
await fs.rename(archiveTempPath, zipPath);
for (const entry of await fs.readdir(stagingRoot)) {
  await fs.cp(path.join(stagingRoot, entry), path.join(releaseRoot, entry), { recursive: true, force: false, errorOnExist: true });
}
await fs.rm(path.join(root, 'release', '.staging'), { recursive: true, force: true });
console.log(zipPath);
