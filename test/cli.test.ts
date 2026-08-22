import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLI_COMMAND_REGISTRY, runCli } from '../src/cli';
import { EXIT_CODES } from '../src/core';
import { resolveLatestRelease } from '../src/core/runtime';

const requiredCommands = [
  'info',
  'config show', 'config set-game-root', 'config set-source-root',
  'workspace init', 'workspace inspect',
  'gate list', 'gate read', 'gate write', 'gate delete',
  'deck list', 'deck read', 'deck write', 'deck delete',
  'structure list', 'structure read', 'structure write', 'structure delete',
  'trash list', 'trash restore',
  'campaign validate', 'campaign deploy',
  'runtime status', 'runtime fetch',
  'deployment list', 'deployment inspect', 'deployment launch',
];

describe('CLI contract', () => {
  it('returns structured JSON for info', async () => {
    const output: string[] = [];
    const code = await runCli(['info', '--pretty'], { stdout: (value) => output.push(value) });
    assert.equal(code, 0);
    const result = JSON.parse(output[0]) as { ok: boolean; exitCode: number; data: { version: string } };
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.data.version, '0.13.0');
  });

  it('keeps the public command registry and exit codes stable', async () => {
    assert.deepEqual([...CLI_COMMAND_REGISTRY], requiredCommands);
    assert.deepEqual(EXIT_CODES, { SUCCESS: 0, COMMAND_FAILED: 1, USAGE_ERROR: 2, PATH_ERROR: 3, INTERNAL_ERROR: 4 });
    const output: string[] = [];
    const errors: string[] = [];
    const unknown = await runCli(['unknown'], { stdout: (value) => output.push(value), stderr: (value) => errors.push(value) });
    assert.equal(unknown, EXIT_CODES.USAGE_ERROR);
    assert.equal(JSON.parse(output.at(-1) as string).exitName, 'USAGE_ERROR');
    const missingPath = await runCli(['gate', 'read'], { stdout: (value) => output.push(value), stderr: (value) => errors.push(value) });
    assert.equal(missingPath, EXIT_CODES.USAGE_ERROR);
  });

  it('selects the release asset from the resolved latest tag', async () => {
    const release = await resolveLatestRelease({
      getJson: async () => ({ tag_name: 'v9.2', assets: [{ name: 'YgoMaster-v9.2.zip', browser_download_url: 'fixture://v9.2' }] }),
      getBytes: async () => new Uint8Array(),
    });
    assert.equal(release.tag, 'v9.2');
    assert.equal(release.assetName, 'YgoMaster-v9.2.zip');
    await assert.rejects(() => resolveLatestRelease({ getJson: async () => ({ assets: [] }), getBytes: async () => new Uint8Array() }), /missing tag_name/);
  });
});
