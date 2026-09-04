import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  DEPLOYMENT_METADATA_FILE,
  LOCAL_PROFILE_RELATIVE_PATH,
  SAVE_BACKUP_DIRECTORY,
  copyOpaqueLocalProfile,
  deployCampaign,
  initWorkspace,
  sameOpaqueSaveSnapshot,
  snapshotOpaqueLocalProfile,
  stableDeploymentName,
  type DeployOptions,
} from '../src/core';

const roots: string[] = [];
const fixtureProfile = path.resolve(__dirname, 'fixtures', 'save-carryover', 'Local');
const stopped = async () => false;
const offlineTransport = {
  getJson: async () => { throw new Error('offline'); },
  getBytes: async () => new Uint8Array(),
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const createHarness = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stable-current-save-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'source');
  const gameRoot = path.join(root, 'game');
  await initWorkspace(root, sourceRoot);
  await fs.writeFile(path.join(sourceRoot, 'manifest.json'), JSON.stringify({
    formatVersion: 1,
    campaign: { name: 'Fixture Campaign', slug: 'fixture', version: '1.0.0' },
    directories: { gate: 'gate', deck: 'deck', structure: 'structure', target: 'target/ygomaster' },
    authoring: { language: 'Korean' },
    idPolicy: { gatePrefix: 100, structurePrefix: 1129000 },
    runtime: { repository: 'pixeltris/YgoMaster', channel: 'latest', autoDownload: true },
  }));
  await fs.writeFile(path.join(sourceRoot, 'deck', 'cpu.json'), JSON.stringify({
    name: 'cpu', m: { ids: [10001], r: [1] }, e: { ids: [], r: [] }, s: { ids: [], r: [] },
  }));
  await fs.writeFile(path.join(sourceRoot, 'gate', '100.json'), JSON.stringify({
    id: 100,
    parent_id: 0,
    name: 'Fixture Gate',
    description: 'Test',
    priority: 1,
    illust_id: 4027,
    clear_chapter: { gateId: 100, chapterId: 1 },
    chapters: [{ id: 1, parent_id: 0, type: 'Duel', description: 'Duel', cpu_deck: 'cpu.json', cpu_name: 'CPU' }],
  }));
  const targetRoot = path.join(sourceRoot, 'target', 'ygomaster', 'Data');
  await fs.mkdir(path.join(targetRoot, 'ClientData', 'SoloGateBackgrounds'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(targetRoot, 'Shop.json'), JSON.stringify({ PackShop: {} })),
    fs.writeFile(path.join(targetRoot, 'ShopPackOdds.json'), JSON.stringify({ entries: [] })),
    fs.writeFile(path.join(targetRoot, 'ClientData', 'SoloGateBackgrounds', '100.png'), Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
    ])),
  ]);

  const releaseRoot = path.join(root, '.cache', 'ygomaster', 'releases', 'v1.77');
  const runtimeRoot = path.join(releaseRoot, 'runtime');
  await fs.mkdir(path.join(runtimeRoot, 'Data', 'SoloDuels'), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, 'Data', 'StructureDecks'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(releaseRoot, 'metadata.json'), JSON.stringify({
      tag: 'v1.77', assetName: 'YgoMaster-v1.77.zip', assetUrl: 'fixture://runtime', downloadedAt: new Date().toISOString(),
    })),
    fs.writeFile(path.join(runtimeRoot, 'YgoMaster.exe'), ''),
    fs.writeFile(path.join(runtimeRoot, 'YgoMasterClient.exe'), ''),
    fs.writeFile(path.join(runtimeRoot, 'YgoMasterLoader.dll'), ''),
    fs.writeFile(path.join(runtimeRoot, 'Data', 'Solo.json'), JSON.stringify({ Master: { Solo: { gate: {}, chapter: {}, unlock: {}, unlock_item: {}, reward: {} } } })),
    fs.writeFile(path.join(runtimeRoot, 'Data', 'Shop.json'), JSON.stringify({ PackShop: {}, StructureShop: {} })),
    fs.writeFile(path.join(runtimeRoot, 'Data', 'ShopPackOdds.json'), JSON.stringify([])),
  ]);
  return { root, sourceRoot, gameRoot };
};

const deploy = (
  sourceRoot: string,
  gameRoot: string,
  options: Partial<Omit<DeployOptions, 'projectRoot' | 'sourceRoot' | 'gameRoot'>> = {},
) =>
  deployCampaign({
    ...options,
    projectRoot: path.dirname(sourceRoot),
    sourceRoot,
    gameRoot,
    transport: offlineTransport,
    isRunning: stopped,
  });

const installSyntheticProfile = async (deploymentPath: string) => {
  const target = path.join(deploymentPath, LOCAL_PROFILE_RELATIVE_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(fixtureProfile, target, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  return target;
};

describe('stable current deployment and automatic Local save carryover', () => {
  it('copies an opaque synthetic profile to a verified backup and target without rewriting bytes', async () => {
    const { root, gameRoot } = await createHarness();
    const source = path.join(root, 'fixture-local');
    await fs.cp(fixtureProfile, source, { recursive: true });
    const target = path.join(root, 'candidate', 'Data', 'Players', 'Local');
    const copied = await copyOpaqueLocalProfile({ sourceProfileRoot: source, targetProfileRoot: target, gameRoot });
    assert.equal(sameOpaqueSaveSnapshot(copied.snapshot, await snapshotOpaqueLocalProfile(source)), true);
    assert.equal(sameOpaqueSaveSnapshot(copied.snapshot, await snapshotOpaqueLocalProfile(target)), true);
    assert.equal(sameOpaqueSaveSnapshot(
      copied.snapshot,
      await snapshotOpaqueLocalProfile(path.join(gameRoot, SAVE_BACKUP_DIRECTORY, copied.backupId, 'Local')),
    ), true);
    assert.equal(
      await fs.readFile(path.join(target, 'Player.json'), 'utf8'),
      await fs.readFile(path.join(source, 'Player.json'), 'utf8'),
    );
  });

  it('publishes the first deployment at one stable current path', async () => {
    const { sourceRoot, gameRoot } = await createHarness();
    const deployed = await deploy(sourceRoot, gameRoot);
    assert.equal(deployed.ok, true);
    assert.equal(deployed.data?.path, path.join(gameRoot, stableDeploymentName('fixture')));
    assert.equal(await fs.stat(path.join(deployed.data!.path, DEPLOYMENT_METADATA_FILE)).then(() => true), true);
  });

  it('requires approval and then automatically adopts the newest compatible legacy Local save', async () => {
    const { sourceRoot, gameRoot } = await createHarness();
    const first = await deploy(sourceRoot, gameRoot);
    assert.equal(first.ok, true);
    const legacy = path.join(gameRoot, 'YgoMaster-fixture-1.0.0-legacy');
    await fs.rename(first.data!.path, legacy);
    const legacyProfile = await installSyntheticProfile(legacy);
    const sourceSnapshot = await snapshotOpaqueLocalProfile(legacyProfile);

    const blocked = await deploy(sourceRoot, gameRoot);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.problems[0]?.code, 'SAVE_CARRYOVER_CONFIRMATION_REQUIRED');
    assert.equal(await fs.stat(path.join(gameRoot, stableDeploymentName('fixture'))).then(() => true, () => false), false);

    const carried = await deploy(sourceRoot, gameRoot, { acceptSaveCarryover: true });
    assert.equal(carried.ok, true);
    assert.equal(carried.warnings.some((entry) => entry.code === 'LEGACY_LOCAL_SAVE_AUTO_SELECTED'), true);
    assert.equal(carried.data?.metadata.saveCarryover?.sourceKind, 'legacy');
    assert.equal(carried.data?.metadata.saveCarryover?.generation, sourceSnapshot.generation);
    assert.equal(sameOpaqueSaveSnapshot(
      sourceSnapshot,
      await snapshotOpaqueLocalProfile(path.join(carried.data!.path, LOCAL_PROFILE_RELATIVE_PATH)),
    ), true);
    assert.equal(await fs.stat(legacy).then(() => true), true);
  });

  it('archives the old current and keeps the stable path while carrying its save', async () => {
    const { sourceRoot, gameRoot } = await createHarness();
    const first = await deploy(sourceRoot, gameRoot);
    assert.equal(first.ok, true);
    const sourceProfile = await installSyntheticProfile(first.data!.path);
    const before = await snapshotOpaqueLocalProfile(sourceProfile);
    const second = await deploy(sourceRoot, gameRoot, { acceptSaveCarryover: true });
    assert.equal(second.ok, true);
    assert.equal(second.data?.path, first.data?.path);
    assert.equal(second.data?.metadata.saveCarryover?.sourceKind, 'current');
    const entries = await fs.readdir(gameRoot);
    assert.equal(entries.some((entry) => /^YgoMaster-fixture-1\.0\.0-\d{8}T\d{6}Z(?:-\d+)?$/u.test(entry)), true);
    assert.equal(sameOpaqueSaveSnapshot(
      before,
      await snapshotOpaqueLocalProfile(path.join(second.data!.path, LOCAL_PROFILE_RELATIVE_PATH)),
    ), true);
  });

  it('rejects a save changed after staging and leaves the old current in place', async () => {
    const { sourceRoot, gameRoot } = await createHarness();
    const first = await deploy(sourceRoot, gameRoot);
    assert.equal(first.ok, true);
    const sourceProfile = await installSyntheticProfile(first.data!.path);
    const changed = await deploy(sourceRoot, gameRoot, {
      acceptSaveCarryover: true,
      beforeSavePromotion: async () => {
        await fs.writeFile(path.join(sourceProfile, 'Player.json'), '{"Gems":2000}\n');
      },
    });
    assert.equal(changed.ok, false);
    assert.match(changed.problems[0]?.message || '', /changed before deployment promotion/u);
    assert.equal(await fs.stat(first.data!.path).then(() => true), true);
  });

  it('refuses malformed save JSON and a running client without publishing', async () => {
    const malformedHarness = await createHarness();
    const first = await deploy(malformedHarness.sourceRoot, malformedHarness.gameRoot);
    assert.equal(first.ok, true);
    const profile = await installSyntheticProfile(first.data!.path);
    await fs.writeFile(path.join(profile, 'Player.json'), '{broken');
    const malformed = await deploy(malformedHarness.sourceRoot, malformedHarness.gameRoot, { acceptSaveCarryover: true });
    assert.equal(malformed.ok, false);
    assert.match(malformed.problems[0]?.message || '', /malformed JSON/u);

    const runningHarness = await createHarness();
    const blocked = await deployCampaign({
      projectRoot: runningHarness.root,
      sourceRoot: runningHarness.sourceRoot,
      gameRoot: runningHarness.gameRoot,
      transport: offlineTransport,
      isRunning: async (name) => name === 'YgoMasterClient.exe',
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.problems[0]?.message || '', /YgoMasterClient\.exe is running/u);
    assert.equal(await fs.stat(path.join(runningHarness.gameRoot, stableDeploymentName('fixture'))).then(() => true, () => false), false);
  });

  it('restores the old current name when candidate promotion fails', async () => {
    const { sourceRoot, gameRoot } = await createHarness();
    const first = await deploy(sourceRoot, gameRoot);
    assert.equal(first.ok, true);
    await installSyntheticProfile(first.data!.path);
    let renameCount = 0;
    const failed = await deploy(sourceRoot, gameRoot, {
      acceptSaveCarryover: true,
      renamePath: async (source, target) => {
        renameCount += 1;
        if (renameCount === 2) throw new Error('injected promotion failure');
        await fs.rename(source, target);
      },
    });
    assert.equal(failed.ok, false);
    assert.equal(renameCount, 3);
    assert.equal(await fs.stat(first.data!.path).then(() => true), true);
    assert.equal(await fs.stat(path.join(first.data!.path, LOCAL_PROFILE_RELATIVE_PATH, 'Player.json')).then(() => true), true);
  });
});
