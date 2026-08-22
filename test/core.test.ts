import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  deployCampaign,
  initWorkspace,
  JsonObject,
  readDocument,
  serializePayload,
  unwrapPayload,
  writeDocument,
  deleteDocument,
  listTrash,
  restoreTrash,
  resolveProjectRoot,
  validateCampaign,
} from '../src/core';

const roots: string[] = [];

const makeRoot = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ygomaster-core-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('core contracts', () => {
  it('preserves raw root unknown fields while replacing the payload', () => {
    const source = { Master: { Solo: { gate: {} } }, custom: { keep: true } };
    const result = serializePayload({ Master: { Solo: { gate: { '90001': { priority: 1 } } } } }, {
      document: source,
      payloadKey: 'Master',
      payload: source.Master,
      shape: 'raw',
    });
    assert.deepEqual(result.custom, { keep: true });
    assert.equal((result.Master as { Solo: { gate: Record<string, unknown> } }).Solo.gate['90001'] !== undefined, true);
  });

  it('preserves wrapped payload envelopes while replacing only the payload', () => {
    const source = {
      code: 0,
      res: [[106, { Master: { Solo: { gate: {} } } }]],
      remove: ['keep-wrapper-field'],
    };
    const unwrapped = unwrapPayload<JsonObject>(source, 'Master');
    const result = serializePayload({ Master: { Solo: { gate: { '90001': { priority: 1 } } } } }, unwrapped);
    assert.equal(result.code, 0);
    assert.deepEqual(result.remove, ['keep-wrapper-field']);
    assert.deepEqual((result.res as unknown[][])[0][1], { Master: { Solo: { gate: { '90001': { priority: 1 } } } } });
  });

  it('resolves one project root for source, compiled, release CLI, and packaged UI anchors', async () => {
    const repositoryRoot = path.resolve(__dirname, '..');
    assert.equal(resolveProjectRoot(repositoryRoot), repositoryRoot);
    assert.equal(resolveProjectRoot(path.join(repositoryRoot, 'src', 'cli')), repositoryRoot);
    assert.equal(resolveProjectRoot(path.join(repositoryRoot, 'dist-cli', 'cli')), repositoryRoot);

    const root = await makeRoot();
    const releaseRoot = path.join(root, 'release', 'modding-tool');
    await Promise.all([
      fs.mkdir(path.join(releaseRoot, 'app'), { recursive: true }),
      fs.mkdir(path.join(releaseRoot, 'cli'), { recursive: true }),
      fs.mkdir(path.join(releaseRoot, 'core'), { recursive: true }),
    ]);
    await fs.writeFile(path.join(releaseRoot, 'manifest.json'), '{}');
    assert.equal(resolveProjectRoot(path.join(releaseRoot, 'app')), releaseRoot);
    assert.equal(resolveProjectRoot(path.join(releaseRoot, 'cli')), releaseRoot);
  });

  it('implements workspace CRUD with replace trash and restore', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    await initWorkspace(root, sourceRoot);
    const first = await writeDocument(root, sourceRoot, 'gate', '90001.json', { id: 90001 }, false);
    assert.equal(first.ok, true);
    const rejected = await writeDocument(root, sourceRoot, 'gate', '90001.json', { id: 90001, changed: true }, false);
    assert.equal(rejected.ok, false);
    const replaced = await writeDocument(root, sourceRoot, 'gate', '90001.json', { id: 90001, changed: true }, true);
    assert.equal(replaced.ok, true);
    const deck = await writeDocument(root, sourceRoot, 'deck', 'authoring/starter.json', { name: 'starter', cards: [1, 2, 3] }, false);
    assert.equal(deck.ok, true);
    assert.deepEqual((await readDocument(root, sourceRoot, 'deck', 'authoring/starter.json')).data, { name: 'starter', cards: [1, 2, 3] });
    assert.equal((await writeDocument(root, sourceRoot, 'deck', 'authoring/starter.json', { name: 'updated' }, true)).ok, true);
    const deletedDeck = await deleteDocument(root, sourceRoot, 'deck', 'authoring/starter.json');
    assert.equal(deletedDeck.ok, true);
    assert.match(deletedDeck.data?.trashPath || '', /deck[\\/]authoring[\\/]starter\.json$/);
    const trash = await listTrash(root, sourceRoot);
    assert.equal(trash.ok, true);
    assert.equal((trash.data || []).some((entry) => entry.includes('90001.json')), true);
    const deleted = await deleteDocument(root, sourceRoot, 'gate', '90001.json');
    assert.equal(deleted.ok, true);
    assert.equal((await writeDocument(root, sourceRoot, 'gate', path.join(root, 'escape.json'), { id: 1 }, false)).ok, false);
    assert.equal((await writeDocument(root, sourceRoot, 'gate', '../escape.json', { id: 1 }, false)).ok, false);
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside, { recursive: true });
    let linked = false;
    try {
      await fs.symlink(outside, path.join(sourceRoot, 'gate', 'outside-link'), 'junction');
      linked = true;
    } catch {
      // Windows developer mode or symlink privileges may be unavailable in CI.
    }
    if (linked) assert.equal((await writeDocument(root, sourceRoot, 'gate', 'outside-link/escape.json', { id: 1 }, false)).ok, false);
    const trashPath = deleted.data?.trashPath;
    assert.ok(trashPath);
    const occupied = await writeDocument(root, sourceRoot, 'gate', '90001.json', { id: 90001, occupied: true }, false);
    assert.equal(occupied.ok, true);
    const blockedRestore = await restoreTrash(root, sourceRoot, trashPath as string);
    assert.equal(blockedRestore.ok, false);
    assert.equal((await deleteDocument(root, sourceRoot, 'gate', '90001.json')).ok, true);
    const restored = await restoreTrash(root, sourceRoot, trashPath as string);
    assert.equal(restored.ok, true);
    const read = await readDocument(root, sourceRoot, 'gate', '90001.json');
    assert.deepEqual(read.data, { id: 90001, changed: true });
    const failedReplacement = await writeDocument(root, sourceRoot, 'gate', '90001.json', { bad: BigInt(1) } as never, true);
    assert.equal(failedReplacement.ok, false);
    assert.deepEqual((await readDocument(root, sourceRoot, 'gate', '90001.json')).data, { id: 90001, changed: true });
  });

  it('rejects missing manifests and invalid ID/reference graphs', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    await fs.mkdir(sourceRoot, { recursive: true });
    const missingManifest = await validateCampaign(root, sourceRoot);
    assert.equal(missingManifest.ok, false);
    assert.equal(missingManifest.problems[0]?.code, 'MANIFEST_MISSING');
    await initWorkspace(root, sourceRoot);
    await fs.writeFile(path.join(sourceRoot, 'gate', '90001.json'), JSON.stringify({ id: 90001, parent_id: 90002, chapters: [{ id: 1, parent_id: 2, type: 'Duel', cpu_deck: 'missing.json' }, { id: 2, parent_id: 1, type: 'Unlock', unlock: [{ gateId: 90001, chapterId: 3 }] }] }));
    await fs.writeFile(path.join(sourceRoot, 'gate', '91000.json'), JSON.stringify({ id: 91000, chapters: [] }));
    await fs.writeFile(path.join(sourceRoot, 'structure', '1129001.json'), JSON.stringify({ id: 1129001, deck: 'missing-structure.json' }));
    const invalid = await validateCampaign(root, sourceRoot);
    assert.equal(invalid.ok, false);
    const codes = new Set(invalid.problems.map((entry) => entry.code));
    assert.equal(codes.has('GATE_PARENT_ORPHAN'), true);
    assert.equal(codes.has('REFERENCE_GRAPH_CYCLE'), true);
    assert.equal(codes.has('CHAPTER_UNLOCK_ORPHAN'), true);
    assert.equal(codes.has('GATE_ID_OUT_OF_RANGE'), true);
    assert.equal(codes.has('STRUCTURE_DECK_MISSING') || codes.has('DECK_REFERENCE_MISSING'), true);
  });

  it('validates source and deploys an additive fake-runtime overlay with cache fallback', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const gameRoot = path.join(root, 'game');
    await initWorkspace(root, sourceRoot);
    await fs.writeFile(path.join(sourceRoot, 'manifest.json'), JSON.stringify({ formatVersion: 1, campaign: { name: 'Fixture', slug: 'fixture', version: 'test/1' }, directories: { gate: 'gate', deck: 'deck', structure: 'structure' }, authoring: { language: 'Korean' }, idPolicy: { gatePrefix: 90000, structurePrefix: 1129000 }, runtime: { repository: 'pixeltris/YgoMaster', channel: 'latest', autoDownload: true } }));
    await fs.writeFile(path.join(sourceRoot, 'deck', 'cpu.json'), JSON.stringify({ name: 'cpu', m: { ids: [10001], r: [1] }, e: { ids: [], r: [] }, s: { ids: [], r: [] } }));
    await fs.writeFile(path.join(sourceRoot, 'gate', '90001.json'), JSON.stringify({ id: 90001, parent_id: 0, name: 'Fixture Gate', description: 'Test', priority: 1, illust_id: 4027, clear_chapter: { gateId: 90001, chapterId: 1 }, chapters: [{ id: 1, parent_id: 0, type: 'Duel', description: 'Duel', cpu_deck: 'cpu.json', cpu_name: 'CPU', unlock_secret: '10001', unlock_pack: [10001], secretType: 4, unlockSecrets: [10001] }] }));
    await fs.mkdir(path.join(sourceRoot, 'overlay', 'ClientData'), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(sourceRoot, 'overlay', 'ClientData', 'Shop.json'), '{}'),
      fs.writeFile(path.join(sourceRoot, 'overlay', 'ClientData', 'ShopPackOdds.json'), '{}'),
      fs.writeFile(path.join(sourceRoot, 'overlay', 'ClientData', 'ShopPackOddsVisuals.json'), '{}'),
      fs.writeFile(path.join(sourceRoot, 'overlay', 'ClientData', 'Settings.json'), '{}'),
      fs.writeFile(path.join(sourceRoot, 'overlay', 'ClientData', 'RegulationMaster.json'), '{}'),
    ]);

    const cacheRuntime = path.join(root, '.cache', 'ygomaster', 'releases', 'v1.77', 'runtime');
    await fs.mkdir(path.join(cacheRuntime, 'Data'), { recursive: true });
    await fs.mkdir(path.join(root, '.cache', 'ygomaster', 'releases', 'v1.77'), { recursive: true });
    await fs.writeFile(path.join(root, '.cache', 'ygomaster', 'releases', 'v1.77', 'metadata.json'), JSON.stringify({ tag: 'v1.77', assetName: 'YgoMaster-v1.77.zip', assetUrl: 'fixture://runtime', downloadedAt: new Date().toISOString() }));
    await fs.writeFile(path.join(cacheRuntime, 'YgoMaster.exe'), '');
    await fs.writeFile(path.join(cacheRuntime, 'YgoMasterClient.exe'), '');
    await fs.writeFile(path.join(cacheRuntime, 'YgoMasterLoader.dll'), '');
    await fs.writeFile(path.join(cacheRuntime, 'Data', 'Solo.json'), JSON.stringify({ Master: { Solo: { gate: {}, chapter: {}, unlock: {}, unlock_item: {}, reward: {} } }, keep: true }));

    const validation = await validateCampaign(root, sourceRoot);
    assert.equal(validation.ok, true);
    const deployed = await deployCampaign({ projectRoot: root, sourceRoot, gameRoot, transport: { getJson: async () => { throw new Error('offline'); }, getBytes: async () => new Uint8Array() } });
    assert.equal(deployed.ok, true);
    assert.equal(deployed.warnings.some((entry) => entry.code === 'LATEST_RELEASE_LOOKUP_FAILED'), true);
    assert.equal(deployed.warnings.some((entry) => entry.code === 'UNLOCK_SECRET_UNSUPPORTED'), true);
    assert.equal(deployed.warnings.some((entry) => entry.code === 'UNSUPPORTED_PACK_FIELD'), true);
    const deploymentPath = deployed.data?.path as string;
    assert.ok(deploymentPath);
    const solo = JSON.parse(await readFile(path.join(deploymentPath, 'Data', 'Solo.json'), 'utf8')) as { Master: { Solo: { gate: Record<string, unknown> } }; keep: boolean };
    assert.equal(solo.keep, true);
    assert.equal(solo.Master.Solo.gate['90001'] !== undefined, true);
    const chapter = (solo.Master.Solo as unknown as { chapter: Record<string, Record<string, Record<string, unknown>>> }).chapter['90001']['900010001'];
    assert.equal(chapter.unlock_secret, undefined);
    assert.equal(chapter.unlock_pack, undefined);
    assert.equal(chapter.secretType, undefined);
    assert.equal(chapter.unlockSecrets, undefined);
    const sourceGate = JSON.parse(await readFile(path.join(sourceRoot, 'gate', '90001.json'), 'utf8')) as { chapters: Array<Record<string, unknown>> };
    assert.equal(sourceGate.chapters[0].unlock_secret, '10001');
    assert.deepEqual(sourceGate.chapters[0].unlock_pack, [10001]);
    for (const file of ['Shop.json', 'ShopPackOdds.json', 'ShopPackOddsVisuals.json', 'Settings.json', 'RegulationMaster.json']) {
      assert.equal(await fs.stat(path.join(deploymentPath, 'Data', 'ClientData', file)).then(() => true, () => false), false);
    }
    assert.equal(await fs.stat(path.join(deploymentPath, 'Data', 'SoloDuels', '900010001.json')).then(() => true), true);
    assert.equal(await fs.stat(path.join(deploymentPath, '.campaign-deployment.json')).then(() => true), true);
  });
});
