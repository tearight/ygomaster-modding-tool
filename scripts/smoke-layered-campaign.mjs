import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  TARGET_CAPABILITIES,
  applyCampaignOverlay,
  buildFakeRuntime,
  compileCampaignContent,
  deployCampaign,
  loadCardResolver,
  readRegistry,
  unwrapPayload,
} from '../dist-cli/core/index.js';

const editorRoot = process.cwd();
const projectRoot = path.resolve(editorRoot, '..', '..');
const contentRoot = path.join(projectRoot, 'campaign', 'content');
const irRoot = path.join(projectRoot, 'campaign', 'source');
const registryPath = path.join(projectRoot, 'campaign', 'id-registry.json');
const temp = await fs.mkdtemp(path.join(editorRoot, '.layered-campaign-smoke-'));

const filesBelow = async (root) => {
  const output = [];
  const visit = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  };
  await visit(root);
  return output;
};

const treeDigest = async (root) => {
  const hash = createHash('sha256');
  for (const relative of await filesBelow(root)) {
    hash.update(relative);
    hash.update(Buffer.from([0]));
    hash.update(await fs.readFile(path.join(root, ...relative.split('/'))));
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
};

const baseSolo = { Master: { Solo: { gate: {}, chapter: {}, unlock: {}, unlock_item: {}, reward: {} } } };
const baseShop = { PackShop: {} };
const baseShopOdds = [];
const deployOnce = async (name) => {
  const runtime = await buildFakeRuntime({
    root: path.join(temp, name),
    files: {
      'Data/Solo.json': baseSolo,
      'Data/Shop.json': baseShop,
      'Data/ShopPackOdds.json': baseShopOdds,
    },
  });
  const started = performance.now();
  const applied = await applyCampaignOverlay(irRoot, runtime.root, { projectRoot });
  return { runtime, applied, durationMs: performance.now() - started, digest: await treeDigest(runtime.root) };
};

try {
  const first = await deployOnce('fake-runtime-cold');
  const second = await deployOnce('fake-runtime-warm');
  assert.equal(first.digest, second.digest, 'Repeated fake deployments must be byte-identical');

  const expected = [
    'Data/ClientData/IDS/IDS_SOLO.txt',
    'Data/ClientData/SoloGateBackgrounds/90001.png',
    'Data/ClientData/SoloGateBackgrounds/90002.png',
    'Data/ClientData/SoloGateBackgrounds/90003.png',
    'Data/ClientData/SoloGateBackgrounds/90004.png',
    'Data/ClientData/SoloGateBackgrounds/90005.png',
    'Data/ClientData/SoloGateBackgrounds/90006.png',
    'Data/ClientData/SoloGateBackgrounds/90007.png',
    'Data/ClientData/SoloGateCards.txt',
    'Data/Shop.json',
    'Data/ShopPackOdds.json',
    'Data/Solo.json',
    'Data/SoloDuels/900010001.json',
    'Data/SoloDuels/900020001.json',
    'Data/SoloDuels/900030001.json',
    'Data/SoloDuels/900030002.json',
    'Data/SoloDuels/900040001.json',
    'Data/SoloDuels/900050001.json',
    'Data/SoloDuels/900050002.json',
    'Data/SoloDuels/900060001.json',
    'Data/SoloDuels/900070001.json',
    'Data/SoloDuels/900070002.json',
  ];
  const deployedFiles = await filesBelow(first.runtime.root);
  assert.deepEqual(deployedFiles, expected);
  const soloDocument = JSON.parse(await fs.readFile(path.join(first.runtime.root, 'Data', 'Solo.json'), 'utf8'));
  const solo = unwrapPayload(soloDocument, 'Master').payload.Solo;
  for (let volume = 1; volume <= 7; volume += 1) {
    const gateId = String(90000 + volume);
    const chapterId = String((90000 + volume) * 10000 + 1);
    assert.ok(solo.gate[gateId], `Vol.${volume} Gate must be deployed`);
    assert.ok(solo.chapter[gateId][chapterId], `Vol.${volume} showdown chapter must be deployed`);
    assert.equal(solo.gate[gateId].clear_chapter, Number(chapterId));
    if (volume > 1) {
      assert.equal(solo.gate[gateId].view_gate, 90000 + volume - 1);
      assert.notEqual(solo.gate[gateId].unlock_id, 0);
    }
  }
  for (const volume of [3, 5, 7]) {
    const gateId = String(90000 + volume);
    const masteryId = String((90000 + volume) * 10000 + 2);
    assert.ok(solo.chapter[gateId][masteryId], `Vol.${volume} optional mastery chapter must be deployed`);
    assert.notEqual(solo.chapter[gateId][masteryId].mydeck_set_id, 0);
  }
  const shopDocument = JSON.parse(await fs.readFile(path.join(first.runtime.root, 'Data', 'Shop.json'), 'utf8'));
  const packs = shopDocument.PackShop;
  assert.equal(Object.keys(packs).length, 7);
  const orderedPackIds = Object.keys(packs).map(Number).sort((left, right) => left - right);
  const expectedPoolSizes = [39, 35, 45, 45, 45, 45, 45];
  orderedPackIds.forEach((id, index) => {
    const pack = packs[String(id)];
    assert.equal(pack.price, 100);
    assert.equal(pack.pack_card_num, 8);
    assert.equal(Object.keys(pack.cardList).length, expectedPoolSizes[index], `Vol.${index + 1} pool size must not regress`);
    assert.deepEqual([...new Set(Object.values(pack.cardList))].sort(), [1, 2, 3, 4], `Vol.${index + 1} must contain every rarity`);
    assert.equal(pack.secretType, index === 0 ? 0 : 4);
    assert.deepEqual(pack.unlockSecrets, index < orderedPackIds.length - 1 ? [orderedPackIds[index + 1]] : []);
  });
  const shopOdds = JSON.parse(await fs.readFile(path.join(first.runtime.root, 'Data', 'ShopPackOdds.json'), 'utf8'));
  assert.equal(shopOdds.length, 7);

  const deployProject = path.join(temp, 'deploy-project');
  const deploySource = path.join(deployProject, 'source');
  const cacheEntry = path.join(deployProject, '.cache', 'ygomaster', 'releases', 'v1.77');
  const cacheRuntime = path.join(cacheEntry, 'runtime');
  const gameRoot = path.join(deployProject, 'game');
  await fs.mkdir(path.join(cacheRuntime, 'Data'), { recursive: true });
  await fs.cp(irRoot, deploySource, { recursive: true, force: false });
  await fs.writeFile(path.join(cacheEntry, 'metadata.json'), JSON.stringify({
    tag: 'v1.77', assetName: 'YgoMaster-v1.77.zip', assetUrl: 'fixture://runtime', downloadedAt: '2026-08-23T00:00:00.000Z',
  }));
  await fs.writeFile(path.join(cacheRuntime, 'YgoMaster.exe'), '');
  await fs.writeFile(path.join(cacheRuntime, 'YgoMasterClient.exe'), '');
  await fs.writeFile(path.join(cacheRuntime, 'YgoMasterLoader.dll'), '');
  await fs.writeFile(path.join(cacheRuntime, 'Data', 'Solo.json'), JSON.stringify(baseSolo));
  await fs.writeFile(path.join(cacheRuntime, 'Data', 'Shop.json'), JSON.stringify(baseShop));
  await fs.writeFile(path.join(cacheRuntime, 'Data', 'ShopPackOdds.json'), JSON.stringify(baseShopOdds));
  const generation = JSON.parse(await fs.readFile(path.join(deploySource, 'generation.json'), 'utf8'));
  const deployed = await deployCampaign({
    projectRoot: deployProject,
    sourceRoot: deploySource,
    gameRoot,
    requireGenerationMetadata: true,
    expectedGeneration: {
      contentGeneration: generation.contentGeneration,
      compilerVersion: generation.compilerVersion,
      catalogGeneration: generation.catalogGeneration,
      idRegistryGeneration: generation.idRegistryGeneration,
      targetContractVersion: generation.targetContractVersion,
    },
    transport: { getJson: async () => { throw new Error('offline fixture'); }, getBytes: async () => new Uint8Array() },
  });
  assert.equal(deployed.ok, true, JSON.stringify(deployed.problems));
  assert.equal(deployed.data.metadata.irGeneration.contentGeneration, generation.contentGeneration);
  assert.ok((await filesBelow(deployed.data.path)).includes('.campaign-deployment.json'));

  const actualIrBefore = await treeDigest(irRoot);
  const negativeContent = path.join(temp, 'negative-content');
  await fs.cp(contentRoot, negativeContent, { recursive: true, force: false });
  const negativeDeck = path.join(negativeContent, 'decks', 'vol-7-cpu.decklist');
  const deckText = await fs.readFile(negativeDeck, 'utf8');
  await fs.writeFile(negativeDeck, deckText.replace('[main]\n', '[main]\n1 Definitely Missing CAM 002 Card\n'));
  const resolver = await loadCardResolver(projectRoot);
  const registry = await readRegistry(registryPath);
  const negative = await compileCampaignContent({
    projectRoot,
    contentRoot: negativeContent,
    irRoot,
    resolver,
    catalogGeneration: resolver.catalogGeneration,
    registry,
    checkOnly: false,
  });
  assert.equal(negative.ok, false);
  const diagnostic = negative.problems.find((entry) => entry.code === 'CARD_NAME_UNRESOLVED');
  assert.ok(diagnostic);
  assert.equal(diagnostic.sourcePath, 'decks/vol-7-cpu.decklist');
  assert.equal(diagnostic.line, 2);
  assert.equal(await treeDigest(irRoot), actualIrBefore, 'Failed compile must preserve the existing IR');

  const missingAssetContent = path.join(temp, 'negative-missing-gate-background');
  await fs.cp(contentRoot, missingAssetContent, { recursive: true, force: false });
  const assetManifestPath = path.join(missingAssetContent, 'assets', 'manifest.json');
  const assetManifest = JSON.parse(await fs.readFile(assetManifestPath, 'utf8'));
  assetManifest.assets[0].gateRefs = assetManifest.assets[0].gateRefs.filter((entry) => entry !== 'gate:vol-7');
  await fs.writeFile(assetManifestPath, `${JSON.stringify(assetManifest, null, 2)}\n`);
  const missingAsset = await compileCampaignContent({
    projectRoot,
    contentRoot: missingAssetContent,
    irRoot,
    resolver,
    catalogGeneration: resolver.catalogGeneration,
    registry,
    checkOnly: false,
  });
  assert.equal(missingAsset.ok, false);
  const missingAssetDiagnostic = missingAsset.problems.find((entry) => entry.code === 'GATE_BACKGROUND_MISSING');
  assert.ok(missingAssetDiagnostic);
  assert.equal(await treeDigest(irRoot), actualIrBefore, 'Missing Gate background must fail before publishing IR');

  assert.equal(TARGET_CAPABILITIES.shop.status, 'assumed');
  assert.equal(TARGET_CAPABILITIES.shop.evidence, 'official-example');
  assert.equal(TARGET_CAPABILITIES.shop.blockingCode, 'SHOP_TARGET_UNVERIFIED');
  console.log(JSON.stringify({
    ok: true,
    irGeneration: JSON.parse(await fs.readFile(path.join(irRoot, 'generation.json'), 'utf8')).contentGeneration,
    fakeDeploymentDigest: first.digest,
    deploymentCore: { ok: deployed.ok, offlineCacheFallback: true },
    files: deployedFiles,
    coldMs: first.durationMs,
    warmMs: second.durationMs,
    unresolved: 0,
    deliberateFailure: { code: diagnostic.code, sourcePath: diagnostic.sourcePath, line: diagnostic.line },
    assetHarnessFailure: { code: missingAssetDiagnostic.code, path: missingAssetDiagnostic.path },
    shop: {
      supportedSubset: ['custom-card-pack', 'named-odds', 'pack-opening-progression'],
      boundary: 'project-approved assumed adapter',
      packs: 7,
      poolSizes: expectedPoolSizes,
      price: 100,
      cardsPerPack: 8,
    },
    structureProjection: 'not-used-by-vol-1-through-7',
    manualAgentSteps: 4,
  }, null, 2));
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
