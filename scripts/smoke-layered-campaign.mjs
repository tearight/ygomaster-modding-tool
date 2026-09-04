import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  TARGET_CAPABILITIES,
  materializeCampaignData,
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
const releaseCandidatePath = path.join(projectRoot, 'campaign', 'design', 'research', 'series1-release-candidate.json');
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

const baseSolo = { Master: { Solo: { gate: { '1': {} }, chapter: { '1': {} }, unlock: {}, unlock_item: {}, reward: {} } } };
const baseShop = { preserve: true, PackShop: { '1': { packId: 1 } }, StructureShop: { '2': { shopId: 2 } } };
const baseShopOdds = [{ name: 'baseline', packShopIds: [1] }];
const deployOnce = async (name) => {
  const runtime = await buildFakeRuntime({
    root: path.join(temp, name),
    files: {
      'Data/Solo.json': baseSolo,
      'Data/Shop.json': baseShop,
      'Data/ShopPackOdds.json': baseShopOdds,
      'Data/SoloDuels/1.json': { Duel: { chapter: 1 } },
      'Data/StructureDecks/1120001.json': { structure_id: 1120001 },
    },
  });
  const started = performance.now();
  const applied = await materializeCampaignData(irRoot, runtime.root, { projectRoot });
  return { runtime, applied, durationMs: performance.now() - started, digest: await treeDigest(runtime.root) };
};

try {
  const releaseCandidate = JSON.parse(await fs.readFile(releaseCandidatePath, 'utf8'));
  const irGeneration = JSON.parse(await fs.readFile(path.join(irRoot, 'generation.json'), 'utf8')).contentGeneration;
  assert.equal(releaseCandidate.status, 'release-candidate-static-verified-pending-client-qa');
  assert.equal(releaseCandidate.generation.contentGeneration, irGeneration, 'Release candidate generation must match fake deployment input');
  assert.equal(releaseCandidate.act01VerticalSlice.complete, true);
  assert.ok(Object.values(releaseCandidate.coverage.blockingGaps).every((value) => value === 0), 'Series 1 release candidate must have zero blocking coverage gaps');
  const first = await deployOnce('fake-runtime-cold');
  const second = await deployOnce('fake-runtime-warm');
  assert.equal(first.digest, second.digest, 'Repeated fake deployments must be byte-identical');

  const gateSources = await Promise.all((await fs.readdir(path.join(irRoot, 'gate')))
    .filter((name) => name.endsWith('.json'))
    .map(async (name) => JSON.parse(await fs.readFile(path.join(irRoot, 'gate', name), 'utf8'))));
  const gateIds = gateSources.map((gate) => Number(gate.id)).sort((left, right) => left - right);
  assert.ok(gateIds.length > 0, 'At least one authored campaign Gate must be included');
  const duelChapterIds = gateSources.flatMap((gate) => (gate.chapters ?? [])
    .filter((chapter) => chapter.type === 'Duel' || typeof chapter.cpu_deck === 'string')
    .map((chapter) => {
      const chapterId = Number(chapter.id);
      return chapterId >= 1 && chapterId <= 9999 ? Number(gate.id) * 10000 + chapterId : chapterId;
    }));
  assert.ok(duelChapterIds.length > 0, 'At least one authored Duel chapter must be included');
  const structureEntries = await fs.readdir(path.join(irRoot, 'structure')).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const structureIds = structureEntries
    .filter((name) => name.endsWith('.json'))
    .map((name) => Number(path.basename(name, '.json')));
  const expected = [
    ...(structureIds.length > 0 ? [
      'Data/ClientData/IDS/IDS_ITEM.txt',
      'Data/ClientData/IDS/IDS_ITEMDESC.txt',
    ] : []),
    'Data/ClientData/IDS/IDS_SOLO.txt',
    ...gateIds.map((gateId) => `Data/ClientData/SoloGateBackgrounds/${gateId}.png`),
    'Data/ClientData/SoloGateCards.txt',
    'Data/Shop.json',
    'Data/ShopPackOdds.json',
    'Data/Solo.json',
    ...duelChapterIds.map((chapterId) => `Data/SoloDuels/${chapterId}.json`),
    ...structureIds.map((structureId) => `Data/StructureDecks/${structureId}.json`),
  ].sort((left, right) => left.localeCompare(right, 'en'));
  const deployedFiles = await filesBelow(first.runtime.root);
  assert.deepEqual(deployedFiles, expected);
  const soloDocument = JSON.parse(await fs.readFile(path.join(first.runtime.root, 'Data', 'Solo.json'), 'utf8'));
  const solo = unwrapPayload(soloDocument, 'Master').payload.Solo;
  for (const gate of gateSources) {
    const gateId = String(gate.id);
    assert.ok(solo.gate[gateId], `Authored Gate ${gateId} must be deployed`);
    const authoredClear = Number(gate.clear_chapter);
    const clearChapterId = authoredClear >= 1 && authoredClear <= 9999 ? Number(gate.id) * 10000 + authoredClear : authoredClear;
    assert.equal(solo.gate[gateId].clear_chapter, clearChapterId);
    for (const chapter of gate.chapters ?? []) {
      const authoredId = Number(chapter.id);
      const chapterId = String(authoredId >= 1 && authoredId <= 9999 ? Number(gate.id) * 10000 + authoredId : authoredId);
      const deployedChapter = solo.chapter[gateId]?.[chapterId];
      assert.ok(deployedChapter, `Authored chapter ${chapterId} must be deployed under Gate ${gateId}`);
      assert.equal(deployedChapter.begin_sn, '', `Authored Duel ${chapterId} must not materialize as Scenario`);
      if (typeof chapter.rental_deck === 'string') {
        assert.ok(deployedChapter.set_id > 0, `Rental chapter ${chapterId} must materialize as Practice Duel`);
        assert.equal(deployedChapter.mydeck_set_id, 0, `Rental chapter ${chapterId} must not require My Deck`);
      } else {
        assert.equal(deployedChapter.set_id, 0, `My Deck chapter ${chapterId} must not materialize as Practice Duel`);
        assert.ok(deployedChapter.mydeck_set_id > 0, `My Deck chapter ${chapterId} must materialize as Duel`);
      }
    }
  }
  const shopDocument = JSON.parse(await fs.readFile(path.join(first.runtime.root, 'Data', 'Shop.json'), 'utf8'));
  const packs = shopDocument.PackShop;
  assert.equal(shopDocument.preserve, true);
  assert.deepEqual(shopDocument.StructureShop, {});
  assert.equal(Object.keys(packs).length, releaseCandidate.runtimeRegression.shopPacks);
  const orderedPackIds = Object.keys(packs).map(Number).sort((left, right) => left - right);
  const expectedPoolSizes = releaseCandidate.runtimeRegression.shopPoolSizes;
  orderedPackIds.forEach((id, index) => {
    const pack = packs[String(id)];
    assert.equal(pack.price, 100);
    assert.equal(pack.pack_card_num, 8);
    assert.equal(Object.keys(pack.cardList).length, expectedPoolSizes[index], `Series 1 Shop pool ${id} size must not regress`);
    assert.ok(Object.values(pack.cardList).every((rarity) => [1, 2, 3, 4].includes(rarity)), `Series 1 Shop pool ${id} must use supported rarities`);
  });
  const roots = orderedPackIds.filter((id) => packs[String(id)].secretType === 0);
  assert.equal(roots.length, 1);
  const visitedPacks = new Set();
  const visitingPacks = new Set();
  const visitPack = (packId) => {
    assert.equal(visitingPacks.has(packId), false, 'Shop predecessor projection must be acyclic');
    if (visitedPacks.has(packId)) return;
    visitingPacks.add(packId);
    const successors = packs[String(packId)].unlockSecrets;
    assert.ok(Array.isArray(successors));
    for (const successor of successors) {
      assert.ok(packs[String(successor)], `Shop successor ${successor} must exist`);
      visitPack(successor);
    }
    visitingPacks.delete(packId);
    visitedPacks.add(packId);
  };
  visitPack(roots[0]);
  assert.equal(visitedPacks.size, orderedPackIds.length, 'Every Series 1 Shop pack must be reachable');
  const shopOdds = JSON.parse(await fs.readFile(path.join(first.runtime.root, 'Data', 'ShopPackOdds.json'), 'utf8'));
  assert.equal(shopOdds.length, releaseCandidate.runtimeRegression.shopPacks);
  assert.equal(releaseCandidate.runtimeRegression.shopPacks, Object.keys(packs).length);
  assert.equal(releaseCandidate.runtimeRegression.chapters, duelChapterIds.length);
  assert.equal(releaseCandidate.runtimeRegression.structures, structureIds.length);

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
  await fs.mkdir(path.join(cacheRuntime, 'Data', 'SoloDuels'), { recursive: true });
  await fs.mkdir(path.join(cacheRuntime, 'Data', 'StructureDecks'), { recursive: true });
  await fs.writeFile(path.join(cacheRuntime, 'Data', 'SoloDuels', '1.json'), '{}');
  await fs.writeFile(path.join(cacheRuntime, 'Data', 'StructureDecks', '1120001.json'), '{}');
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
  assetManifest.assets = [];
  await fs.writeFile(assetManifestPath, `${JSON.stringify(assetManifest, null, 2)}\n`);
  await fs.rm(path.join(missingAssetContent, 'assets', 'solo-gate-backgrounds', 'series-1.png'));
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
  assert.ok(missingAssetDiagnostic, JSON.stringify(missingAsset.problems));
  assert.equal(await treeDigest(irRoot), actualIrBefore, 'Missing Gate background must fail before publishing IR');

  assert.equal(TARGET_CAPABILITIES.shop.status, 'assumed');
  assert.equal(TARGET_CAPABILITIES.shop.evidence, 'official-example');
  assert.equal(TARGET_CAPABILITIES.shop.blockingCode, 'SHOP_TARGET_UNVERIFIED');
  console.log(JSON.stringify({
    ok: true,
    irGeneration,
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
      packs: orderedPackIds.length,
      poolSizes: expectedPoolSizes,
      price: 100,
      cardsPerPack: 8,
    },
    structureProjection: structureIds.length === 0 ? 'not-yet-authored' : 'active',
    releaseCandidate: {
      products: releaseCandidate.boundary.products,
      identities: releaseCandidate.boundary.identities,
      supportedIdentities: releaseCandidate.boundary.supportedIdentities,
      blockingGaps: Object.values(releaseCandidate.coverage.blockingGaps).reduce((sum, value) => sum + value, 0),
      act01Complete: releaseCandidate.act01VerticalSlice.complete,
    },
    manualAgentSteps: 4,
  }, null, 2));
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
