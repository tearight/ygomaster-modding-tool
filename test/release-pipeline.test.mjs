import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverCliRuntimeDependencies, publishRelease, readReusableBuildState, runReleaseStages, writeBuildState } from '../scripts/release-pipeline.mjs';

test('preflight failure occurs before Electron package and later release stages', async () => {
  const calls = [];
  await assert.rejects(runReleaseStages({
    preflight: async () => { calls.push('preflight'); throw new Error('release app locked'); },
    verify: async () => calls.push('verify'),
    buildElectron: async () => calls.push('electron'),
    assemble: async () => calls.push('assemble'),
    smoke: async () => calls.push('smoke'),
    publish: async () => calls.push('publish'),
  }), /locked/);
  assert.deepEqual(calls, ['preflight']);
});

test('failed promotion restores the prior good release', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-publish-test-'));
  const releaseRoot = path.join(root, 'modding-tool');
  const stagingRoot = path.join(root, 'modding-tool.staging');
  try {
    await fs.mkdir(releaseRoot);
    await fs.writeFile(path.join(releaseRoot, 'marker.txt'), 'prior-good');
    await fs.mkdir(stagingRoot);
    await fs.writeFile(path.join(stagingRoot, 'marker.txt'), 'candidate');
    await assert.rejects(publishRelease({
      stagingRoot,
      releaseRoot,
      beforePromote: async () => { throw new Error('simulated promotion failure'); },
    }), /simulated/);
    assert.equal(await fs.readFile(path.join(releaseRoot, 'marker.txt'), 'utf8'), 'prior-good');
    assert.equal(await fs.readFile(path.join(stagingRoot, 'marker.txt'), 'utf8'), 'candidate');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI runtime dependency discovery follows installed transitive dependencies', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-deps-test-'));
  try {
    const dist = path.join(root, 'dist-cli');
    await fs.mkdir(dist, { recursive: true });
    await fs.writeFile(path.join(dist, 'index.js'), 'const value = require("alpha/subpath");');
    await fs.mkdir(path.join(root, 'node_modules', 'alpha'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'alpha', 'package.json'), JSON.stringify({ name: 'alpha', dependencies: { beta: '1.0.0' } }));
    await fs.mkdir(path.join(root, 'node_modules', 'beta'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'beta', 'package.json'), JSON.stringify({ name: 'beta' }));
    assert.deepEqual(await discoverCliRuntimeDependencies({ editorRoot: root, distCliRoot: dist }), ['alpha', 'beta']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI runtime dependency discovery fails before packaging when a dependency is missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-deps-missing-test-'));
  try {
    const dist = path.join(root, 'dist-cli');
    await fs.mkdir(dist, { recursive: true });
    await fs.writeFile(path.join(dist, 'index.js'), 'require("missing-runtime");');
    await assert.rejects(discoverCliRuntimeDependencies({ editorRoot: root, distCliRoot: dist }), /not installed: missing-runtime/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('warm build reuse rejects a changed CLI core tree', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-state-test-'));
  try {
    const appRoot = path.join(root, 'out', 'tool-win32-x64');
    await fs.mkdir(path.join(root, 'dist-cli', 'cli'), { recursive: true });
    await fs.mkdir(path.join(root, 'dist-cli', 'core'), { recursive: true });
    await fs.mkdir(appRoot, { recursive: true });
    await fs.writeFile(path.join(root, 'dist-cli', 'cli', 'index.js'), 'cli');
    await fs.writeFile(path.join(root, 'dist-cli', 'core', 'index.js'), 'core-good');
    await fs.writeFile(path.join(appRoot, 'ygomaster-modding-tool.exe'), 'app');
    await writeBuildState({ editorRoot: root, verificationKey: 'verified', appRoot });
    assert.ok(await readReusableBuildState({ editorRoot: root, verificationKey: 'verified' }));
    await fs.writeFile(path.join(root, 'dist-cli', 'core', 'index.js'), 'core-corrupted');
    assert.equal(await readReusableBuildState({ editorRoot: root, verificationKey: 'verified' }), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
