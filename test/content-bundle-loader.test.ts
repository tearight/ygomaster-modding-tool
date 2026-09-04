import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  CONTENT_BUNDLE_CODES,
  loadCampaignIrBundle,
} from '../src/core/content-bundle-loader';
import { discoverContentSnapshot } from '../src/core/ir-snapshot';

const fixtureRoot = path.resolve(process.cwd(), '..', '..', 'campaign', 'fixtures', 'ir-compiler');

const makeRoot = (): Promise<string> => fs.mkdtemp(path.resolve(fixtureRoot, '..', '..', '..', '.tmp-content-bundle-'));

const validManifest = {
  formatVersion: 1,
  layer: 'content',
  campaign: { name: 'Bundle Fixture', slug: 'bundle-fixture', version: '1.0.0' },
  directories: {
    gates: 'gates',
    decks: 'decks',
    structures: 'structures',
    regulations: 'regulations',
    localization: 'localization',
    assets: 'assets',
    shop: 'shop',
    target: 'target/ygomaster',
  },
  sourceOfTruth: true,
};

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
};

const copyTree = async (source: string, destination: string): Promise<void> => {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(sourcePath, destinationPath);
    else await fs.copyFile(sourcePath, destinationPath);
  }
};

const discoverAndLoad = async (root: string) => {
  const snapshot = await discoverContentSnapshot(root);
  assert.equal(snapshot.ok, true, snapshot.problems.map((entry) => entry.code).join(','));
  return loadCampaignIrBundle(root, snapshot);
};

describe('content bundle loader', () => {
  it('discovers the full fixture convention and leaves unsupported inputs visible', async () => {
    const snapshot = await discoverContentSnapshot(fixtureRoot);
    assert.equal(snapshot.ok, true, snapshot.problems.map((entry) => entry.code).join(','));
    const result = await loadCampaignIrBundle(fixtureRoot, snapshot);
    assert.equal(result.ok, true, result.problems.map((entry) => entry.code).join(','));
    assert.ok(result.bundle);
    assert.deepEqual(result.bundle.gates.map((entry) => entry.sourcePath), ['gates/chronicle.json']);
    assert.deepEqual(result.bundle.structures.map((entry) => entry.sourcePath), ['structures/starter.json']);
    assert.deepEqual(Object.keys(result.bundle.decks), ['cpu.decklist', 'starter.decklist']);
    assert.equal(result.bundle.decks['cpu.decklist']?.regulation, 'regulation:fixture');
    assert.deepEqual(Object.keys(result.bundle.regulations), ['regulation:fixture']);
    assert.equal(result.bundle.localization?.languages.en['gate.chronicle.name'], 'Chronicle');
    assert.equal(result.bundle.accessories?.value['starter-accessory'] !== undefined, true);
    assert.deepEqual(result.bundle.cardReferences, { 'card:blue-eyes': 'Blue-Eyes White Dragon' });
    assert.deepEqual(result.bundle.unconsumedPaths, [
      'shop/pack.json',
      'target/ygomaster/extension.json',
      'unknown.exe',
    ]);
    const gateBytes = await fs.readFile(path.join(fixtureRoot, 'gates/chronicle.json'));
    assert.deepEqual(Buffer.from(result.bundle.gates[0]?.bytes || []), gateBytes);
  });

  it('uses manifest directory overrides and keeps deterministic ordinal ordering', async () => {
    const root = await makeRoot();
    try {
      await writeJson(path.join(root, 'manifest.json'), {
        ...validManifest,
        directories: { ...validManifest.directories, gates: '../source', decks: 'authored/decks' },
      });
      // A layer escape is intentionally invalid and must not be silently normalized.
      const invalidSnapshot = await discoverContentSnapshot(root);
      assert.equal(invalidSnapshot.ok, false);
      const invalid = { ok: invalidSnapshot.ok, problems: invalidSnapshot.problems };
      assert.equal(invalid.ok, false);
      assert.ok(invalid.problems.some((entry) => entry.code === 'CONTENT_MANIFEST_PATH_INVALID'));

      await fs.rm(root, { recursive: true, force: true });
      await fs.mkdir(path.join(root, 'authored/gates'), { recursive: true });
      await fs.mkdir(path.join(root, 'authored/decks'), { recursive: true });
      await writeJson(path.join(root, 'manifest.json'), { ...validManifest, directories: { ...validManifest.directories, gates: 'authored/gates', decks: 'authored/decks' } });
      await writeJson(path.join(root, 'authored/gates/z.json'), { z: true });
      await writeJson(path.join(root, 'authored/gates/a.json'), { a: true });
      await fs.writeFile(path.join(root, 'authored/decks/z.decklist'), '[main]\n1 Card\n');
      await fs.writeFile(path.join(root, 'authored/decks/a.decklist'), '[main]\n1 Card\n');
      const result = await discoverAndLoad(root);
      assert.equal(result.ok, true, result.problems.map((entry) => entry.code).join(','));
      assert.deepEqual(result.bundle?.gates.map((entry) => entry.sourcePath), ['authored/gates/a.json', 'authored/gates/z.json']);
      assert.deepEqual(Object.keys(result.bundle?.decks || {}), ['a.decklist', 'z.decklist']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a missing regulation pair, malformed JSON, and duplicate stable Deck identities', async () => {
    const root = await makeRoot();
    try {
      await writeJson(path.join(root, 'manifest.json'), validManifest);
      await writeJson(path.join(root, 'regulations', 'missing.json'), { payload: { regulationId: 'regulation:missing' } });
      const missing = await discoverAndLoad(root);
      assert.equal(missing.ok, false);
      assert.ok(missing.problems.some((entry) => entry.code === CONTENT_BUNDLE_CODES.REGULATION_RULES_MISSING));

      await fs.rm(path.join(root, 'regulations'), { recursive: true, force: true });
      await fs.mkdir(path.join(root, 'decks'), { recursive: true });
      await writeJson(path.join(root, 'localization', 'en.json'), { 'good.key': 'ok' });
      await fs.writeFile(path.join(root, 'localization', 'bad.json'), '{not-json', 'utf8');
      const malformed = await discoverAndLoad(root);
      assert.equal(malformed.ok, false);
      assert.ok(malformed.problems.some((entry) => entry.code === CONTENT_BUNDLE_CODES.JSON_INVALID));

      await fs.rm(path.join(root, 'localization'), { recursive: true, force: true });
      await fs.writeFile(path.join(root, 'decks', 'foo.decklist'), '[main]\n1 Card\n');
      await writeJson(path.join(root, 'decks', 'foo.json'), { metadata: { identity: { formatVersion: 1, reference: 'deck:shared' } } });
      await fs.writeFile(path.join(root, 'decks', 'bar.decklist'), '[main]\n1 Card\n');
      await writeJson(path.join(root, 'decks', 'bar.json'), { metadata: { identity: { formatVersion: 1, reference: 'deck:shared' } } });
      const duplicate = await discoverAndLoad(root);
      assert.equal(duplicate.ok, false);
      assert.ok(duplicate.problems.some((entry) => entry.code === CONTENT_BUNDLE_CODES.DECK_DUPLICATE));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('detects snapshot byte drift and does not write the content root', async () => {
    const root = await makeRoot();
    try {
      const copyRoot = path.join(root, 'content');
      await copyTree(fixtureRoot, copyRoot);
      const snapshot = await discoverContentSnapshot(copyRoot);
      assert.equal(snapshot.ok, true);
      const before = await fs.readFile(path.join(copyRoot, 'gates/chronicle.json'));
      await fs.writeFile(path.join(copyRoot, 'gates/chronicle.json'), Buffer.concat([before, Buffer.from('x')]));
      const result = await loadCampaignIrBundle(copyRoot, snapshot);
      assert.equal(result.ok, false);
      assert.ok(result.problems.some((entry) => entry.code === CONTENT_BUNDLE_CODES.SNAPSHOT_BYTES_MISMATCH));
      assert.deepEqual(await fs.readFile(path.join(copyRoot, 'gates/chronicle.json')), Buffer.concat([before, Buffer.from('x')]));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('loads only the documented runtime-policy patch keys', async () => {
    const root = await makeRoot();
    try {
      await writeJson(path.join(root, 'manifest.json'), { ...validManifest, directories: { ...validManifest.directories, runtimePolicy: 'runtime-policy' } });
      await writeJson(path.join(root, 'runtime-policy', 'settings.json'), { payload: { DefaultGems: 1000 } });
      const valid = await discoverAndLoad(root);
      assert.equal(valid.ok, true, valid.problems.map((entry) => entry.code).join(','));
      assert.deepEqual(valid.bundle?.runtimePolicy, { settings: { DefaultGems: 1000 } });

      await writeJson(path.join(root, 'runtime-policy', 'settings.json'), { payload: { ArbitraryServerSwitch: true } });
      const invalid = await discoverAndLoad(root);
      assert.equal(invalid.ok, false);
      assert.ok(invalid.problems.some((entry) => entry.code === CONTENT_BUNDLE_CODES.RUNTIME_POLICY_INVALID));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('loads logical folder metadata while leaving physical subfolders unconsumed', async () => {
    const root = await makeRoot();
    try {
      await writeJson(path.join(root, 'manifest.json'), validManifest);
      await writeJson(path.join(root, 'decks', '_folders.json'), {
        formatVersion: 1,
        kind: 'deck-folders',
        payload: { folders: [{ id: 'deck-folder:gate-a', name: 'Gate A' }] },
      });
      await fs.writeFile(path.join(root, 'decks', 'stable.decklist'), '[main]\n1 Card\n');
      await writeJson(path.join(root, 'decks', 'stable.json'), {
        metadata: {
          role: 'cpu',
          folder: 'deck-folder:gate-a',
          identity: { formatVersion: 1, reference: 'deck:stable' },
          futureMetadata: { preserved: true },
        },
        unknownTopLevel: { preserved: true },
      });
      await fs.mkdir(path.join(root, 'decks', 'physical-folder'), { recursive: true });
      await fs.writeFile(path.join(root, 'decks', 'physical-folder', 'nested.decklist'), '[main]\n1 Card\n');
      await writeJson(path.join(root, 'decks', 'physical-folder', 'nested.json'), {
        metadata: { identity: { formatVersion: 1, reference: 'deck:nested-stable' }, role: 'rental', future: { keep: true } },
      });

      const loaded = await discoverAndLoad(root);
      assert.equal(loaded.ok, true, loaded.problems.map((entry) => entry.code).join(','));
      assert.equal(loaded.bundle?.deckFolderSource?.sourcePath, 'decks/_folders.json');
      assert.equal(loaded.bundle?.deckFolderCatalog?.folders[0]?.id, 'deck-folder:gate-a');
      assert.deepEqual(Object.keys(loaded.bundle?.decks || {}), ['stable.decklist']);
      assert.equal(loaded.bundle?.decks['stable.decklist']?.metadata?.folder, 'deck-folder:gate-a');
      assert.equal(loaded.bundle?.decks['stable.decklist']?.reference, 'deck:stable');
      assert.equal(loaded.bundle?.decks['stable.decklist']?.adapterPath, 'decks/stable.json');
      assert.deepEqual(loaded.bundle?.decks['stable.decklist']?.sidecar?.value.unknownTopLevel, { preserved: true });
      assert.deepEqual(loaded.bundle?.decks['stable.decklist']?.metadata?.futureMetadata, { preserved: true });
      assert.equal(loaded.bundle?.unconsumedPaths.includes('decks/physical-folder/nested.decklist'), true);
      assert.equal(loaded.bundle?.unconsumedPaths.includes('decks/physical-folder/nested.json'), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for portable path collisions without treating nested Decks as active inputs', async () => {
    const root = await makeRoot();
    try {
      await writeJson(path.join(root, 'manifest.json'), validManifest);
      await fs.mkdir(path.join(root, 'decks', 'nested'), { recursive: true });
      await fs.writeFile(path.join(root, 'decks', 'nested', 'missing.decklist'), '[main]\n1 Card\n');
      const nested = await discoverAndLoad(root);
      assert.equal(nested.ok, true, nested.problems.map((entry) => entry.code).join(','));
      assert.deepEqual(Object.keys(nested.bundle?.decks || {}), []);
      assert.equal(nested.bundle?.unconsumedPaths.includes('decks/nested/missing.decklist'), true);

      await fs.rm(path.join(root, 'decks'), { recursive: true, force: true });
      await fs.mkdir(path.join(root, 'decks'), { recursive: true });
      await fs.writeFile(path.join(root, 'decks', 'foo.decklist'), '[main]\n1 Card\n');
      await fs.writeFile(path.join(root, 'decks', 'Ｆoo.decklist'), '[main]\n1 Card\n');
      const collision = await discoverContentSnapshot(root);
      assert.equal(collision.ok, false);
      assert.ok(collision.problems.some((entry) => entry.code === 'IR_SNAPSHOT_PATH_COLLISION'));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('never consumes _folders.json as a Deck sidecar and leaves nested Deck sources unconsumed', async () => {
    const root = await makeRoot();
    try {
      await writeJson(path.join(root, 'manifest.json'), validManifest);
      await fs.mkdir(path.join(root, 'decks', 'nested'), { recursive: true });
      await fs.writeFile(path.join(root, 'decks', 'nested', 'foo.decklist'), '[main]\n1 Card\n');
      await writeJson(path.join(root, 'decks', 'nested', 'foo.json'), { metadata: { identity: { formatVersion: 1, reference: 'deck:foo' } } });
      await writeJson(path.join(root, 'decks', '_folders.json'), { formatVersion: 1, kind: 'deck-folders', payload: { folders: [] } });
      const snapshot = await discoverContentSnapshot(root);
      assert.equal(snapshot.ok, true);
      assert.ok(snapshot.snapshot);
      const loaded = await loadCampaignIrBundle(root, snapshot.snapshot!);
      assert.equal(loaded.ok, true);
      assert.ok(loaded.bundle);
      assert.deepEqual(Object.keys(loaded.bundle!.decks), []);
      assert.equal(loaded.bundle!.deckFolderSource?.sourcePath, 'decks/_folders.json');
      assert.equal(loaded.bundle!.unconsumedPaths.includes('decks/nested/foo.decklist'), true);
      assert.equal(loaded.bundle!.unconsumedPaths.includes('decks/nested/foo.json'), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
