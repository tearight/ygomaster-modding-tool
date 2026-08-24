import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  CONTENT_MANIFEST_FILE,
  LAYER_CONTRACTS,
  createIrGenerationEnvelope,
  createIrGenerationMetadata,
  defaultContentManifest,
  initializeLayeredWorkspace,
  inspectLayeredWorkspace,
  isForbiddenLayerInput,
  isPathContained,
  loadContentManifest,
  parseContentManifest,
  readIrGenerationMetadata,
  resolveLayerPaths,
  validateContentManifest,
  validateIrGenerationEnvelope,
  validateIrGenerationMetadata,
  validateLayerInput,
  validateLayerPaths,
  writeIrGenerationMetadata,
  YGOMASTER_TARGET_CONTRACT_VERSION,
} from '../src/core/layers';

const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'ygomaster-layers-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('four-layer workspace contract', () => {
  it('declares authority, lifecycle, and forbidden inputs for every layer', () => {
    assert.deepEqual(Object.keys(LAYER_CONTRACTS), ['design', 'content', 'ir', 'generated']);
    assert.equal(LAYER_CONTRACTS.design.writeOwner, 'human-agent');
    assert.equal(LAYER_CONTRACTS.content.writeOwner, 'author');
    assert.equal(LAYER_CONTRACTS.content.sourceOfTruth, true);
    assert.equal(LAYER_CONTRACTS.content.regeneration, 'never');
    assert.equal(LAYER_CONTRACTS.ir.writeOwner, 'compiler');
    assert.equal(LAYER_CONTRACTS.ir.persistence, 'managed');
    assert.equal(LAYER_CONTRACTS.ir.regeneration, 'from-content');
    assert.equal(LAYER_CONTRACTS.generated.persistence, 'disposable');
    assert.equal(LAYER_CONTRACTS.generated.regeneration, 'from-ir');
    assert.equal(isForbiddenLayerInput('ir', 'source-legacy'), true);
    assert.deepEqual(validateLayerInput('ir', 'source-legacy').map((entry) => entry.code), ['LAYER_INPUT_FORBIDDEN']);
    assert.deepEqual(validateLayerInput('ir', 'content'), []);
  });

  it('resolves the default roots and rejects escapes and nested layer roots', async () => {
    const root = await makeRoot();
    const paths = resolveLayerPaths(root);
    assert.equal(paths.contentRoot, path.join(root, 'campaign', 'content'));
    assert.equal(paths.irRoot, path.join(root, 'campaign', 'source'));
    assert.equal(paths.generatedRoot, path.join(root, 'campaign', 'generated'));
    assert.equal(isPathContained(root, paths.contentRoot), true);
    assert.equal(isPathContained(paths.contentRoot, path.join(paths.contentRoot, 'gates')), true);
    assert.equal(isPathContained(paths.contentRoot, path.join(root, 'outside')), false);

    const escaped = validateLayerPaths(root, { content: '../outside' });
    assert.equal(escaped.some((entry) => entry.code === 'LAYER_PATH_ESCAPE'), true);
    const absoluteOutside = validateLayerPaths(root, { generated: path.resolve(root, '..', 'generated') });
    assert.equal(absoluteOutside.some((entry) => entry.code === 'LAYER_PATH_ESCAPE'), true);
    const nested = validateLayerPaths(root, { content: 'campaign/layers', ir: 'campaign/layers/ir' });
    assert.equal(nested.some((entry) => entry.code === 'LAYER_PATH_OVERLAP'), true);
    assert.throws(() => resolveLayerPaths(root, { content: 'campaign/layers', ir: 'campaign/layers/ir' }));
  });

  it('initializes content skeleton without importing or rewriting legacy source', async () => {
    const root = await makeRoot();
    const existingSource = path.join(root, 'campaign', 'source');
    await fs.mkdir(existingSource, { recursive: true });
    await fs.writeFile(path.join(existingSource, 'keep.txt'), 'keep');

    const initialized = await initializeLayeredWorkspace(root);
    assert.equal(await fs.readFile(path.join(existingSource, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(initialized.manifest.formatVersion, 1);
    assert.equal(initialized.manifest.layer, 'content');
    assert.equal(initialized.manifest.sourceOfTruth, true);
    assert.equal(await fs.stat(path.join(root, 'campaign', 'content', CONTENT_MANIFEST_FILE)).then(() => true), true);
    for (const directory of [
      'gates',
      'chapters',
      'decks',
      'shop/packs',
      'shop/pools',
      'shop/odds',
      'structures',
      'regulations',
      'localization',
      'assets',
      'target/ygomaster',
    ]) {
      assert.equal(await fs.stat(path.join(root, 'campaign', 'content', directory)).then(() => true), true, directory);
    }

    assert.deepEqual(await loadContentManifest(initialized.paths.contentRoot), initialized.manifest);
    const inspection = await inspectLayeredWorkspace(root);
    assert.equal(inspection.problems.length, 0);
    assert.equal(inspection.layers.content.exists, true);
    assert.equal(inspection.layers.ir.contract.writeOwner, 'compiler');
  });

  it('parses and validates the minimum versioned content manifest', () => {
    const manifest = defaultContentManifest();
    assert.deepEqual(validateContentManifest(manifest), []);
    assert.deepEqual(parseContentManifest(manifest), manifest);
    assert.equal(validateContentManifest({ ...manifest, formatVersion: 2 }).some((entry) => entry.code === 'CONTENT_MANIFEST_FUTURE_VERSION'), true);
    assert.equal(validateContentManifest({ ...manifest, directories: { gates: '../outside' } }).some((entry) => entry.code === 'CONTENT_MANIFEST_PATH_INVALID'), true);
    assert.throws(() => parseContentManifest({ ...manifest, layer: 'ir' }));
  });
});

describe('IR generation metadata', () => {
  it('records content, compiler, catalog, ID lock, and target contract generations', async () => {
    const metadata = createIrGenerationMetadata({
      contentGeneration: 'content-0001',
      compilerVersion: 'compiler-0.1.0',
      catalogGeneration: 'catalog-2026-08-23',
      idLockGeneration: 'ids-0007',
      targetContractVersion: YGOMASTER_TARGET_CONTRACT_VERSION,
    });
    assert.deepEqual(validateIrGenerationMetadata(metadata), []);
    assert.equal(metadata.contentGeneration, 'content-0001');
    assert.equal(metadata.compilerVersion, 'compiler-0.1.0');
    assert.equal(metadata.catalogGeneration, 'catalog-2026-08-23');
    assert.equal(metadata.idLockGeneration, 'ids-0007');
    assert.equal(metadata.targetContractVersion, YGOMASTER_TARGET_CONTRACT_VERSION);

    const root = await makeRoot();
    const irRoot = path.join(root, 'campaign', 'source');
    await fs.mkdir(irRoot, { recursive: true });
    await writeIrGenerationMetadata(irRoot, metadata);
    assert.deepEqual(await readIrGenerationMetadata(irRoot), metadata);
    const envelope = createIrGenerationEnvelope(metadata, { custom: 'preserved' });
    assert.equal(envelope.layer, 'ir');
    assert.equal(envelope.generated, true);
    assert.equal(envelope.custom, 'preserved');
    assert.deepEqual(validateIrGenerationEnvelope(envelope), []);
  });

  it('rejects incomplete or future metadata instead of guessing', () => {
    const invalid = {
      schemaVersion: 1,
      contentGeneration: 'content-0001',
      compilerVersion: 'compiler-0.1.0',
      catalogGeneration: 'catalog-1',
      targetContractVersion: YGOMASTER_TARGET_CONTRACT_VERSION,
    };
    const problems = validateIrGenerationMetadata(invalid);
    assert.equal(problems.some((entry) => entry.code === 'IR_GENERATION_METADATA_ID_LOCK_MISSING'), true);
    assert.equal(validateIrGenerationMetadata({ ...invalid, schemaVersion: 2 }).some((entry) => entry.code === 'IR_GENERATION_METADATA_FUTURE_VERSION'), true);
    assert.equal(validateIrGenerationMetadata({
      ...invalid,
      idLockGeneration: 'ids-a',
      idRegistryGeneration: 'ids-b',
    }).some((entry) => entry.code === 'IR_GENERATION_METADATA_ID_GENERATION_CONFLICT'), true);
  });
});
