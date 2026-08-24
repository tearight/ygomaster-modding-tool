import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  IR_PROJECTION_WRITER_CODES,
  writeIrProjection,
  type IrProjectionWriterInput,
} from '../src/core/ir-projection-writer';
import type { GateCompileIR } from '../src/core/gate-content';
import type { IRGenerationMetadata } from '../src/core/layers';

const makeRoot = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'ir-projection-writer-'));

const manifest = {
  formatVersion: 1,
  campaign: { name: 'Projection Fixture', slug: 'projection-fixture', version: '1.0.0' },
  directories: { gate: 'gate', deck: 'deck', structure: 'structure', overlay: 'overlay' },
  unknownRoot: { preserve: true },
};

const generation: IRGenerationMetadata = {
  schemaVersion: 1,
  contentGeneration: 'content-generation-1',
  compilerVersion: 'compiler-1',
  catalogGeneration: 'catalog-1',
  idRegistryGeneration: 'registry-1',
  targetContractVersion: 'ygomaster-campaign-target/v2',
};

const deck = {
  m: { ids: [1001, 1002], r: [1, 2] },
  e: { ids: [], r: [] },
  s: { ids: [], r: [] },
};

const gate: GateCompileIR = {
  formatVersion: 1,
  kind: 'gate-ir' as const,
  targetContractVersion: 'ygomaster-campaign-target/v2',
  registryGeneration: 'registry-1',
  solo: { gate: {}, chapter: {}, unlock: {}, unlock_item: {}, reward: {} },
  duels: {},
  sourceFiles: {
    'gate/chronicle.json': { id: 90001, chapters: [] },
  },
  rewardItems: {},
};

const structure = {
  path: 'Data/StructureDecks/1129001.json',
  document: {
    structure_id: 1129001,
    accessory: { box: 1, sleeve: 2 },
    focus: { ids: [1001], r: [1] },
    contents: deck,
  },
};

const baseInput = (stagingRoot: string): IrProjectionWriterInput => ({
  stagingRoot,
  manifest,
  decks: { 'chronicle.json': deck },
  gates: [gate],
  structures: [structure],
  structureDecks: { 'Data/StructureDecks/1129001.json': 'chronicle.json' },
  structureMetadata: { 'Data/StructureDecks/1129001.json': { name: 'Chronicle', description: 'Fixture' } },
  overlay: {
    'Data/ClientData/IDS/IDS_SOLO.txt': '[IDS_SOLO.GATE001]\nChronicle\n',
    'Data/ClientData/SoloGateCards.txt': '90001,4027,0,0\n',
  },
  generation,
  provenance: { formatVersion: 1, sources: [{ path: 'content/gate.json', hash: 'abc', size: 3 }] },
});

const listFiles = async (root: string): Promise<string[]> => {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else result.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  };
  await visit(root);
  return result.sort();
};

describe('IR projection writer', () => {
  it('writes the singular deterministic legacy layout and preserves text bytes', async () => {
    const root = await makeRoot();
    try {
      const input = baseInput(root);
      const result = await writeIrProjection(input);
      assert.equal(result.ok, true);
      assert.deepEqual(result.files, [
        'deck/chronicle.json',
        'gate/chronicle.json',
        'generation.json',
        'manifest.json',
        'overlay/ClientData/IDS/IDS_SOLO.txt',
        'overlay/ClientData/SoloGateCards.txt',
        'provenance.json',
        'structure/1129001.json',
      ]);
      assert.equal(await fs.readFile(path.join(root, 'overlay/ClientData/IDS/IDS_SOLO.txt'), 'utf8'), '[IDS_SOLO.GATE001]\nChronicle\n');
      assert.equal((JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as { unknownRoot: { preserve: boolean } }).unknownRoot.preserve, true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('copies only the preservation allowlist and reports stale source content explicitly', async () => {
    const root = await makeRoot();
    const preserved = await makeRoot();
    try {
      await fs.mkdir(path.join(preserved, 'card-db'), { recursive: true });
      await fs.mkdir(path.join(preserved, 'gate'), { recursive: true });
      await fs.writeFile(path.join(preserved, 'README.md'), Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x4f, 0x6c, 0x64]));
      await fs.writeFile(path.join(preserved, '.ygomaster-source.json'), '{"opaque":true}');
      await fs.writeFile(path.join(preserved, '.gitkeep'), '');
      await fs.writeFile(path.join(preserved, 'card-db', 'CardList.json'), '{"keep":true}');
      await fs.writeFile(path.join(preserved, 'gate', 'stale.json'), '{"stale":true}');
      await fs.writeFile(path.join(preserved, 'manifest.json'), JSON.stringify({ legacyUnknown: { keep: 'yes' } }));

      const result = await writeIrProjection({ ...baseInput(root), preservedSourceRoot: preserved });
      assert.equal(result.ok, true);
      assert.deepEqual(result.staleDisposition, [{ path: 'gate/stale.json', disposition: 'stale-not-preserved' }]);
      assert.deepEqual(await fs.readFile(path.join(root, 'README.md')), Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x4f, 0x6c, 0x64]));
      assert.equal(await fs.readFile(path.join(root, 'card-db', 'CardList.json'), 'utf8'), '{"keep":true}');
      const writtenManifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as { legacyUnknown: { keep: string } };
      assert.equal(writtenManifest.legacyUnknown.keep, 'yes');
      assert.equal((await listFiles(root)).includes('gate/stale.json'), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(preserved, { recursive: true, force: true });
    }
  });

  it('rejects path escape and collisions before writing partial output', async () => {
    const root = await makeRoot();
    try {
      const escaped = await writeIrProjection({ ...baseInput(root), decks: { '../escape.json': deck } });
      assert.equal(escaped.ok, false);
      assert.ok(escaped.problems.some((entry) => entry.code === IR_PROJECTION_WRITER_CODES.PATH_INVALID));
      assert.deepEqual(await fs.readdir(root), []);

      const collision = await writeIrProjection({
        ...baseInput(root),
        gates: [gate, gate],
      });
      assert.equal(collision.ok, false);
      assert.ok(collision.problems.some((entry) => entry.code === IR_PROJECTION_WRITER_CODES.PATH_COLLISION));
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlink staging root and a non-empty staging root', async (t) => {
    const root = await makeRoot();
    const target = await makeRoot();
    try {
      const link = path.join(root, 'link');
      try {
        await fs.symlink(target, link, 'junction');
      } catch {
        t.skip('directory junctions are unavailable in this Windows runner');
      }
      if (await fs.lstat(link).catch(() => undefined)) {
        const linked = await writeIrProjection({ ...baseInput(link) });
        assert.equal(linked.ok, false);
        assert.ok(linked.problems.some((entry) => entry.code === IR_PROJECTION_WRITER_CODES.STAGING_INVALID));
      }

      await fs.writeFile(path.join(root, 'existing.txt'), 'do not overwrite');
      const nonEmpty = await writeIrProjection({ ...baseInput(root) });
      assert.equal(nonEmpty.ok, false);
      assert.ok(nonEmpty.problems.some((entry) => entry.code === IR_PROJECTION_WRITER_CODES.STAGING_NOT_EMPTY));
      assert.equal(await fs.readFile(path.join(root, 'existing.txt'), 'utf8'), 'do not overwrite');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it('produces byte-identical output for the same bundle regardless of input key order', async () => {
    const first = await makeRoot();
    const second = await makeRoot();
    try {
      const left = await writeIrProjection(baseInput(first));
      const right = await writeIrProjection({
        ...baseInput(second),
        decks: { 'chronicle.json': deck },
        overlay: {
          'Data/ClientData/SoloGateCards.txt': '90001,4027,0,0\n',
          'Data/ClientData/IDS/IDS_SOLO.txt': '[IDS_SOLO.GATE001]\nChronicle\n',
        },
      });
      assert.equal(left.ok, true);
      assert.equal(right.ok, true);
      const files = await listFiles(first);
      assert.deepEqual(files, await listFiles(second));
      for (const relative of files) {
        assert.deepEqual(
          await fs.readFile(path.join(first, relative)),
          await fs.readFile(path.join(second, relative)),
          relative,
        );
      }
    } finally {
      await fs.rm(first, { recursive: true, force: true });
      await fs.rm(second, { recursive: true, force: true });
    }
  });
});
