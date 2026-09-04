import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { initWorkspace } from '../src/core/manifest';
import { materializeCampaignData } from '../src/core/materialize';
import { readJsonFile } from '../src/core/fs';

const pack = {
  packId: 1130000,
  productType: 1,
  packType: 1,
  secretType: 0,
  nameTextId: 'Fixture Pack',
  descGenerated: true,
  pack_card_num: 8,
  subCategory: 1,
  iconMrk: 1001,
  iconType: 2,
  cardList: { '1001': 1, '1002': 4 },
  price: 100,
  oddsName: 'campaign-fixture-1130000',
};

const odds = {
  name: 'campaign-fixture-1130000',
  packShopIds: [1130000],
  cardRateList: [{
    start_num: 1,
    end_num: 8,
    standard: false,
    rate: { '1': { rate: '75.00' }, '4': { rate: '25.00' } },
  }],
};

describe('authoritative campaign Data materialization', () => {
  it('keeps Chronicle progression on parent_chapter edges without runtime unlock tables', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chronicle-progression-'));
    const sourceRoot = path.join(root, 'campaign', 'source');
    const runtimeRoot = path.join(root, 'runtime');
    const workspaceRoot = path.resolve(__dirname, '../../..');
    const expectedParents: Record<string, number> = {
      '21010011': 0,
      '21010014': 21010011,
      '21010001': 21010014,
      '21010002': 21010001,
      '21010004': 21010002,
      '21010015': 21010002,
      '21010003': 21010015,
      '21010016': 21010003,
      '21010005': 21010016,
      '21010010': 21010005,
      '21010006': 21010005,
      '21010017': 21010006,
      '21010008': 21010017,
      '21010007': 21010008,
      '21010009': 21010008,
      '21010018': 21010009,
      '21010012': 21010018,
      '21010013': 21010012,
    };
    try {
      await fs.cp(path.join(workspaceRoot, 'campaign', 'source'), sourceRoot, { recursive: true });
      await fs.mkdir(path.join(runtimeRoot, 'Data'), { recursive: true });
      await fs.writeFile(path.join(runtimeRoot, 'Data', 'Solo.json'), JSON.stringify({ Master: { Solo: { gate: {}, chapter: {}, unlock: {}, unlock_item: {}, reward: {} } } }), 'utf8');
      await fs.writeFile(path.join(runtimeRoot, 'Data', 'Shop.json'), JSON.stringify({ PackShop: {}, StructureShop: {} }), 'utf8');
      await fs.writeFile(path.join(runtimeRoot, 'Data', 'ShopPackOdds.json'), '[]', 'utf8');

      await materializeCampaignData(sourceRoot, runtimeRoot, { projectRoot: root });
      const data = await readJsonFile<{ Master: { Solo: Record<string, unknown> } }>(path.join(runtimeRoot, 'Data', 'Solo.json'));
      const solo = data.Master.Solo;
      const gate = (solo.gate as Record<string, Record<string, unknown>>)['2101'];
      const chapters = (solo.chapter as Record<string, Record<string, Record<string, unknown>>>)['2101'];
      assert.deepEqual(Object.keys(chapters).sort(), Object.keys(expectedParents));
      assert.deepEqual(solo.unlock, {});
      assert.deepEqual(solo.unlock_item, {});
      assert.deepEqual({ parent_gate: gate.parent_gate, view_gate: gate.view_gate, unlock_id: gate.unlock_id, clear_chapter: gate.clear_chapter }, { parent_gate: 0, view_gate: 0, unlock_id: 0, clear_chapter: 21010012 });
      for (const [chapterId, parentChapter] of Object.entries(expectedParents)) {
        const chapter = chapters[chapterId];
        assert.equal(chapter.parent_chapter, parentChapter, chapterId);
        assert.equal(chapter.unlock_id, 0, chapterId);
        assert.equal(chapter.begin_sn, '', chapterId);
        assert.equal(typeof chapter.npc_id === 'number' && chapter.npc_id > 0, true, chapterId);
        assert.equal(chapter.cpu_deck, undefined, chapterId);
        assert.equal(chapter.rental_deck, undefined, chapterId);
        assert.equal(chapter.unlock_secret, undefined, chapterId);
      }
      for (const chapterId of ['21010011', '21010014', '21010001', '21010002', '21010015', '21010003', '21010016', '21010005', '21010006', '21010017', '21010008', '21010009', '21010018', '21010012']) {
        assert.equal((chapters[chapterId].set_id as number) > 0, true, chapterId);
        assert.equal(chapters[chapterId].mydeck_set_id, 0, chapterId);
      }
      for (const chapterId of ['21010004', '21010007', '21010010', '21010013']) {
        assert.equal(chapters[chapterId].set_id, 0, chapterId);
        assert.equal((chapters[chapterId].mydeck_set_id as number) > 0, true, chapterId);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('replaces owned Shop families exactly while preserving wrapper and non-owned fields', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'data-materialization-'));
    const sourceRoot = path.join(root, 'campaign', 'source');
    const runtimeRoot = path.join(root, 'runtime');
    try {
      await initWorkspace(root, sourceRoot);
      await fs.mkdir(path.join(sourceRoot, 'target', 'ygomaster', 'Data'), { recursive: true });
      await fs.writeFile(path.join(sourceRoot, 'target', 'ygomaster', 'Data', 'Shop.json'), `${JSON.stringify({ PackShop: { '1130000': pack } }, null, 2)}\n`, 'utf8');
      await fs.writeFile(path.join(sourceRoot, 'target', 'ygomaster', 'Data', 'ShopPackOdds.json'), `${JSON.stringify({ entries: [odds] }, null, 2)}\n`, 'utf8');
      await fs.mkdir(path.join(runtimeRoot, 'Data'), { recursive: true });
      await fs.writeFile(path.join(runtimeRoot, 'Data', 'Solo.json'), JSON.stringify({ Master: { Solo: { gate: { '1': {} }, chapter: {}, unlock: {}, unlock_item: {}, reward: {}, sentinel: true } } }), 'utf8');
      await fs.writeFile(path.join(runtimeRoot, 'Data', 'Shop.json'), '{\n // YgoMaster JSONC\n "code": 0, "res": [{ "Shop": { "sentinel": true, "PackShop": { "100": { "packId": 100 } }, "StructureShop": { "200": { "shopId": 200 } }, "AccessoryShop": { "300": { "shopId": 300 } }, }, }],\n}\n}\n', 'utf8');
      await fs.writeFile(path.join(runtimeRoot, 'Data', 'ShopPackOdds.json'), '{"code":0,"res":[{"ShopPackOdds":[{"name":"existing","packShopIds":[100],"unknown":true},],}],}\n', 'utf8');

      const applied = await materializeCampaignData(sourceRoot, runtimeRoot, { projectRoot: root });
      assert.equal(applied.changedFiles.includes('Data/Shop.json'), true);
      assert.equal(applied.changedFiles.includes('Data/ShopPackOdds.json'), true);
      const shop = await readJsonFile<Record<string, unknown>>(path.join(runtimeRoot, 'Data', 'Shop.json'));
      const nestedShop = ((shop.res as Array<Record<string, unknown>>)[0]?.Shop as Record<string, unknown>);
      assert.equal(nestedShop.sentinel, true);
      assert.deepEqual(Object.keys(nestedShop.PackShop as object), ['1130000']);
      assert.deepEqual(nestedShop.StructureShop, {});
      assert.deepEqual(Object.keys(nestedShop.AccessoryShop as object), ['300']);
      const oddsDocument = await readJsonFile<Record<string, unknown>>(path.join(runtimeRoot, 'Data', 'ShopPackOdds.json'));
      const nestedOdds = (oddsDocument.res as Array<Record<string, unknown>>)[0]?.ShopPackOdds as Array<Record<string, unknown>>;
      assert.equal(nestedOdds.length, 1);
      assert.equal(nestedOdds[0]?.name, odds.name);

      const beforeShop = await fs.readFile(path.join(runtimeRoot, 'Data', 'Shop.json'), 'utf8');
      const beforeOdds = await fs.readFile(path.join(runtimeRoot, 'Data', 'ShopPackOdds.json'), 'utf8');
      await materializeCampaignData(sourceRoot, runtimeRoot, { projectRoot: root });
      assert.equal(await fs.readFile(path.join(runtimeRoot, 'Data', 'Shop.json'), 'utf8'), beforeShop);
      assert.equal(await fs.readFile(path.join(runtimeRoot, 'Data', 'ShopPackOdds.json'), 'utf8'), beforeOdds);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('patches only allowlisted campaign runtime-policy keys into the fresh runtime baseline', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-policy-materialization-'));
    const sourceRoot = path.join(root, 'campaign', 'source');
    const runtimeRoot = path.join(root, 'runtime');
    try {
      await initWorkspace(root, sourceRoot);
      const targetData = path.join(sourceRoot, 'target', 'ygomaster', 'Data');
      await fs.mkdir(path.join(targetData, 'ClientData'), { recursive: true });
      await fs.writeFile(path.join(targetData, 'Shop.json'), `${JSON.stringify({ PackShop: {} })}\n`, 'utf8');
      await fs.writeFile(path.join(targetData, 'ShopPackOdds.json'), `${JSON.stringify({ entries: [] })}\n`, 'utf8');
      await fs.writeFile(path.join(targetData, 'Settings.json'), `${JSON.stringify({ patch: { DefaultGems: 1000, DisableBanList: false } })}\n`, 'utf8');
      await fs.writeFile(path.join(targetData, 'Shop.policy.json'), `${JSON.stringify({ patch: { NoDuplicatesPerPack: true } })}\n`, 'utf8');
      await fs.writeFile(path.join(targetData, 'ClientData', 'ClientSettings.json'), `${JSON.stringify({ patch: { DuelClientTimeMultiplier: 2, DeckEditorDisableLimits: false } })}\n`, 'utf8');
      await fs.mkdir(path.join(runtimeRoot, 'Data', 'ClientData'), { recursive: true });
      await fs.writeFile(path.join(runtimeRoot, 'Data', 'Solo.json'), JSON.stringify({ Master: { Solo: { gate: {}, chapter: {}, unlock: {}, unlock_item: {}, reward: {} } } }), 'utf8');
      await fs.writeFile(path.join(runtimeRoot, 'Data', 'Settings.json'), JSON.stringify({ DefaultGems: 1, unknownSetting: 'preserve' }), 'utf8');
      await fs.writeFile(path.join(runtimeRoot, 'Data', 'Shop.json'), JSON.stringify({ PackShop: {}, StructureShop: { '7': { shopId: 7 } }, unknownShop: true }), 'utf8');
      await fs.writeFile(path.join(runtimeRoot, 'Data', 'ShopPackOdds.json'), '[]', 'utf8');
      await fs.writeFile(path.join(runtimeRoot, 'Data', 'ClientData', 'ClientSettings.json'), JSON.stringify({ code: 0, res: [{ ClientSettings: { DuelClientTimeMultiplier: 1, keep: true } }] }), 'utf8');

      const applied = await materializeCampaignData(sourceRoot, runtimeRoot, { projectRoot: root });
      assert.deepEqual(applied.changedFiles.filter((file) => file.includes('Settings') || file === 'Data/Shop.json').sort(), ['Data/ClientData/ClientSettings.json', 'Data/Settings.json', 'Data/Shop.json']);
      assert.deepEqual(await readJsonFile(path.join(runtimeRoot, 'Data', 'Settings.json')), { DefaultGems: 1000, DisableBanList: false, unknownSetting: 'preserve' });
      const shop = await readJsonFile<Record<string, unknown>>(path.join(runtimeRoot, 'Data', 'Shop.json'));
      assert.equal(shop.NoDuplicatesPerPack, true);
      assert.equal(shop.unknownShop, true);
      const client = await readJsonFile<Record<string, Array<Record<string, Record<string, unknown>>>>>(path.join(runtimeRoot, 'Data', 'ClientData', 'ClientSettings.json'));
      assert.deepEqual(client.res[0]?.ClientSettings, { DuelClientTimeMultiplier: 2, DeckEditorDisableLimits: false, keep: true });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
