import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  ATOMIC_DIRECTORY_CODES,
  AtomicDirectoryError,
  publishAtomicDirectory,
} from '../src/core/atomic-directory';

const makeRoot = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'atomic-directory-'));

const writeText = async (filePath: string, value: string): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, 'utf8');
};

const publishError = (code: string) => (error: unknown): boolean =>
  error instanceof AtomicDirectoryError && error.code === code;

describe('atomic IR directory publish', () => {
  it('publishes a new sibling staging directory and leaves no staging or backup residue', async () => {
    const root = await makeRoot();
    try {
      const stagingPath = path.join(root, 'staging');
      const finalPath = path.join(root, 'final');
      await writeText(path.join(stagingPath, 'payload.json'), '{"generation":"new"}\n');

      const result = await publishAtomicDirectory({ root, stagingPath, finalPath });

      assert.equal(result.replaced, false);
      assert.equal(await fs.readFile(path.join(finalPath, 'payload.json'), 'utf8'), '{"generation":"new"}\n');
      await assert.rejects(() => fs.lstat(stagingPath), { code: 'ENOENT' });
      await assert.rejects(() => fs.lstat(`${finalPath}.backup`), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('moves an existing final to backup before staging and removes the backup after success', async () => {
    const root = await makeRoot();
    try {
      const stagingPath = path.join(root, 'staging');
      const finalPath = path.join(root, 'final');
      const backupPath = `${finalPath}.backup`;
      await writeText(path.join(finalPath, 'payload.bin'), 'old\r\nbytes');
      await writeText(path.join(stagingPath, 'payload.bin'), 'new\nbytes');
      const renames: Array<[string, string]> = [];
      const removed: string[] = [];

      const result = await publishAtomicDirectory({
        root,
        stagingPath,
        finalPath,
        rename: async (source, destination) => {
          renames.push([source, destination]);
          await fs.rename(source, destination);
        },
        remove: async (target) => {
          removed.push(target);
          await fs.rm(target, { recursive: true, force: true });
        },
      });

      assert.equal(result.replaced, true);
      assert.deepEqual(renames.slice(0, 2), [[finalPath, backupPath], [stagingPath, finalPath]]);
      assert.deepEqual(removed, [backupPath]);
      assert.equal(await fs.readFile(path.join(finalPath, 'payload.bin'), 'utf8'), 'new\nbytes');
      await assert.rejects(() => fs.lstat(stagingPath), { code: 'ENOENT' });
      await assert.rejects(() => fs.lstat(backupPath), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('restores the byte-identical old tree when staging-to-final rename fails', async () => {
    const root = await makeRoot();
    try {
      const stagingPath = path.join(root, 'staging');
      const finalPath = path.join(root, 'final');
      const backupPath = `${finalPath}.backup`;
      const oldBytes = Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6c, 0x64, 0x0d, 0x0a]);
      await fs.mkdir(path.join(finalPath, 'nested'), { recursive: true });
      await fs.writeFile(path.join(finalPath, 'nested', 'payload.bin'), oldBytes);
      await writeText(path.join(stagingPath, 'nested', 'payload.bin'), 'new\n');

      await assert.rejects(
        () => publishAtomicDirectory({
          root,
          stagingPath,
          finalPath,
          rename: async (source, destination) => {
            if (source === stagingPath && destination === finalPath) throw new Error('injected staging-to-final failure');
            await fs.rename(source, destination);
          },
        }),
        publishError(ATOMIC_DIRECTORY_CODES.PUBLISH_FAILED),
      );

      assert.deepEqual(await fs.readFile(path.join(finalPath, 'nested', 'payload.bin')), oldBytes);
      assert.equal(await fs.readFile(path.join(stagingPath, 'nested', 'payload.bin'), 'utf8'), 'new\n');
      await assert.rejects(() => fs.lstat(backupPath), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('removes a partial new final when a new publish rename moves and then throws', async () => {
    const root = await makeRoot();
    try {
      const stagingPath = path.join(root, 'staging');
      const finalPath = path.join(root, 'final');
      await writeText(path.join(stagingPath, 'payload.json'), '{"generation":"new"}\n');

      await assert.rejects(
        () => publishAtomicDirectory({
          root,
          stagingPath,
          finalPath,
          rename: async (source, destination) => {
            await fs.rename(source, destination);
            throw new Error('injected post-rename failure');
          },
        }),
        publishError(ATOMIC_DIRECTORY_CODES.PUBLISH_FAILED),
      );

      await assert.rejects(() => fs.lstat(finalPath), { code: 'ENOENT' });
      await assert.rejects(() => fs.lstat(stagingPath), { code: 'ENOENT' });
      await assert.rejects(() => fs.lstat(`${finalPath}.backup`), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for escape, overlap, and symlink paths', async (t) => {
    const root = await makeRoot();
    try {
      const stagingPath = path.join(root, 'staging');
      await writeText(path.join(stagingPath, 'payload.txt'), 'staging');
      await assert.rejects(
        () => publishAtomicDirectory({ root, stagingPath, finalPath: path.join(root, '..', 'outside-final') }),
        publishError(ATOMIC_DIRECTORY_CODES.PATH_ESCAPE),
      );
      await assert.rejects(
        () => publishAtomicDirectory({ root, stagingPath, finalPath: path.join(stagingPath, 'nested-final') }),
        publishError(ATOMIC_DIRECTORY_CODES.PATH_OVERLAP),
      );

      const symlinkTarget = path.join(root, 'symlink-target');
      const symlinkFinal = path.join(root, 'symlink-final');
      await fs.mkdir(symlinkTarget, { recursive: true });
      try {
        await fs.symlink(symlinkTarget, symlinkFinal, 'junction');
      } catch {
        t.skip('directory symlinks are unavailable in this Windows runner');
        return;
      }
      await assert.rejects(
        () => publishAtomicDirectory({ root, stagingPath, finalPath: symlinkFinal }),
        (error: unknown) => error instanceof AtomicDirectoryError
          && (error.code === ATOMIC_DIRECTORY_CODES.PATH_ESCAPE || error.code === ATOMIC_DIRECTORY_CODES.SYMLINK_FORBIDDEN),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
