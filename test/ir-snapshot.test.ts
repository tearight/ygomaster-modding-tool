import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  IR_SNAPSHOT_CODES,
  discoverIrSnapshot,
} from '../src/core/ir-snapshot';

const manifest = {
  formatVersion: 1,
  layer: 'content',
  campaign: { name: 'Snapshot Fixture', slug: 'snapshot-fixture', version: '1.0.0' },
  directories: { gates: 'gates', decks: 'decks' },
  sourceOfTruth: true,
};

const makeRoot = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'ir-snapshot-'));

const writeText = async (filePath: string, value: string): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, 'utf8');
};

const writeManifest = async (root: string, value: unknown = manifest): Promise<void> =>
  writeText(path.join(root, 'manifest.json'), `${JSON.stringify(value)}\n`);

describe('IR content snapshot discovery', () => {
  it('enumerates files in ordinal relative-path order and is stable across creation order', async () => {
    const first = await makeRoot();
    const second = await makeRoot();
    try {
      await writeManifest(first);
      await writeText(path.join(first, 'zeta', 'value.txt'), 'same');
      await writeText(path.join(first, 'alpha', 'value.txt'), 'same');

      await writeText(path.join(second, 'alpha', 'value.txt'), 'same');
      await writeManifest(second);
      await writeText(path.join(second, 'zeta', 'value.txt'), 'same');

      const left = await discoverIrSnapshot(first);
      const right = await discoverIrSnapshot(second);
      assert.equal(left.ok, true);
      assert.equal(right.ok, true);
      assert.deepEqual(left.snapshot?.files.map((entry) => entry.path), [
        'alpha/value.txt',
        'manifest.json',
        'zeta/value.txt',
      ]);
      assert.equal(left.snapshot?.contentGeneration, right.snapshot?.contentGeneration);
      assert.deepEqual(left.snapshot?.files, right.snapshot?.files);
    } finally {
      await fs.rm(first, { recursive: true, force: true });
      await fs.rm(second, { recursive: true, force: true });
    }
  });

  it('changes generation for either a path change or an exact byte change', async () => {
    const root = await makeRoot();
    try {
      await writeManifest(root);
      await writeText(path.join(root, 'content.txt'), 'one');
      const original = await discoverIrSnapshot(root);
      assert.equal(original.ok, true);

      await writeText(path.join(root, 'other.txt'), 'one');
      const pathChanged = await discoverIrSnapshot(root);
      assert.equal(pathChanged.ok, true);
      assert.notEqual(pathChanged.snapshot?.contentGeneration, original.snapshot?.contentGeneration);

      await fs.rm(path.join(root, 'other.txt'));
      await writeText(path.join(root, 'content.txt'), 'two');
      const byteChanged = await discoverIrSnapshot(root);
      assert.equal(byteChanged.ok, true);
      assert.notEqual(byteChanged.snapshot?.contentGeneration, original.snapshot?.contentGeneration);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlink or junction inputs without following them', async (t) => {
    const root = await makeRoot();
    const outside = await makeRoot();
    try {
      await writeManifest(root);
      await writeText(path.join(outside, 'secret.txt'), 'outside');
      const link = path.join(root, 'linked');
      try {
        await fs.symlink(outside, link, 'junction');
      } catch {
        t.skip('directory junctions are unavailable in this Windows runner');
        return;
      }
      const result = await discoverIrSnapshot(root);
      assert.equal(result.ok, false);
      assert.ok(result.problems.some((entry) => entry.code === IR_SNAPSHOT_CODES.SYMLINK_FORBIDDEN));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects forbidden layer roots and manifest path escapes', async () => {
    const parent = await makeRoot();
    const forbidden = path.join(parent, 'source-legacy');
    await fs.mkdir(forbidden, { recursive: true });
    try {
      const rootResult = await discoverIrSnapshot(forbidden);
      assert.equal(rootResult.ok, false);
      assert.ok(rootResult.problems.some((entry) => entry.code === IR_SNAPSHOT_CODES.ROOT_FORBIDDEN));

      const valid = path.join(parent, 'content');
      await fs.mkdir(valid, { recursive: true });
      await writeManifest(valid, { ...manifest, directories: { gates: '../source' } });
      const manifestResult = await discoverIrSnapshot(valid);
      assert.equal(manifestResult.ok, false);
      assert.ok(manifestResult.problems.some((entry) => entry.code === 'CONTENT_MANIFEST_PATH_INVALID'));
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it('reports missing or malformed manifests and does not write the input tree', async () => {
    const root = await makeRoot();
    try {
      await writeText(path.join(root, 'payload.txt'), 'keep');
      const before = await fs.readFile(path.join(root, 'payload.txt'));
      const missing = await discoverIrSnapshot(root);
      assert.equal(missing.ok, false);
      assert.ok(missing.problems.some((entry) => entry.code === IR_SNAPSHOT_CODES.MANIFEST_MISSING));
      assert.deepEqual(await fs.readFile(path.join(root, 'payload.txt')), before);

      await writeText(path.join(root, 'manifest.json'), '{not-json');
      const malformed = await discoverIrSnapshot(root);
      assert.equal(malformed.ok, false);
      assert.ok(malformed.problems.some((entry) => entry.code === IR_SNAPSHOT_CODES.MANIFEST_INVALID));
      assert.deepEqual(await fs.readFile(path.join(root, 'payload.txt')), before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
