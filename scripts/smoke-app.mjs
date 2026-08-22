import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const editorRoot = process.cwd();
const workspaceRoot = path.resolve(editorRoot, '..', '..');
const appCandidates = [
  path.join(workspaceRoot, 'release', 'modding-tool', 'app', 'ygomaster-modding-tool.exe'),
  path.join(editorRoot, 'out', 'ygomaster-modding-tool-win32-x64', 'ygomaster-modding-tool.exe'),
];
const appPath = process.env.YGOMASTER_APP_EXE || appCandidates.find((candidate) => existsSync(candidate)) || appCandidates[0];
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ygomaster-app-smoke-'));
const userData = path.join(temp, 'user-data');
const child = spawn(appPath, [`--user-data-dir=${userData}`, '--disable-gpu'], {
  cwd: path.dirname(appPath),
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
  await fs.access(appPath);
  const outcome = await Promise.race([exited, timeout]);
  if (outcome?.error) throw outcome.error;
  if (outcome && outcome.code !== 0) {
    throw new Error(`Packaged app exited early with code ${outcome.code} (${outcome.signal || 'no signal'})`);
  }
  if (!outcome) {
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  console.log(JSON.stringify({ ok: true, appPath, earlyExit: Boolean(outcome), exit: exitInfo || null }));
} finally {
  if (!settled) child.kill();
  await fs.rm(temp, { recursive: true, force: true });
}
