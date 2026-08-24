import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { initWorkspace } from '../src/core/manifest';
import { applyCampaignOverlay } from '../src/core/overlay';
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

describe('managed Shop runtime overlay', () => {
  it('preserves JSONC wrapper/unknown fields and fails closed on an ID collision', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shop-overlay-'));
    const sourceRoot = path.join(root, 'campaign', 'source');
    const runtimeRoot = path.join(root, 'runtime');
    try {
      await initWorkspace(root, sourceRoot);
      await fs.mkdir(path.join(sourceRoot, 'overlay'), { recursive: true });
      await fs.writeFile(path.join(sourceRoot, 'overlay', 'Shop.json'), `${JSON.stringify({ PackShop: { '1130000': pack } }, null, 2)}\n`, 'utf8');
      await fs.writeFile(path.join(sourceRoot, 'overlay', 'ShopPackOdds.json'), `${JSON.stringify({ entries: [odds] }, null, 2)}\n`, 'utf8');
      await fs.mkdir(path.join(runtimeRoot, 'Data'), { recursive: true });
      await fs.writeFile(path.join(runtimeRoot, 'Data', 'Solo.json'), JSON.stringify({ Master: { Solo: { gate: { '1': {} }, chapter: {}, unlock: {}, unlock_item: {}, reward: {}, sentinel: true } } }), 'utf8');
      await fs.writeFile(path.join(runtimeRoot, 'Data', 'Shop.json'), '{\n // YgoMaster JSONC\n "code": 0, "res": [{ "Shop": { "sentinel": true, "PackShop": { "100": { "packId": 100 } }, }, }],\n}\n}\n', 'utf8');
      await fs.writeFile(path.join(runtimeRoot, 'Data', 'ShopPackOdds.json'), '{"code":0,"res":[{"ShopPackOdds":[{"name":"existing","packShopIds":[100],"unknown":true},],}],}\n', 'utf8');

      const applied = await applyCampaignOverlay(sourceRoot, runtimeRoot, { projectRoot: root });
      assert.equal(applied.changedFiles.includes('Data/Shop.json'), true);
      assert.equal(applied.changedFiles.includes('Data/ShopPackOdds.json'), true);
      const shop = await readJsonFile<Record<string, unknown>>(path.join(runtimeRoot, 'Data', 'Shop.json'));
      const nestedShop = ((shop.res as Array<Record<string, unknown>>)[0]?.Shop as Record<string, unknown>);
      assert.equal(nestedShop.sentinel, true);
      assert.deepEqual(Object.keys(nestedShop.PackShop as object).sort(), ['100', '1130000']);
      const oddsDocument = await readJsonFile<Record<string, unknown>>(path.join(runtimeRoot, 'Data', 'ShopPackOdds.json'));
      const nestedOdds = (oddsDocument.res as Array<Record<string, unknown>>)[0]?.ShopPackOdds as Array<Record<string, unknown>>;
      assert.equal(nestedOdds[0]?.unknown, true);
      assert.equal(nestedOdds[1]?.name, odds.name);

      const beforeShop = await fs.readFile(path.join(runtimeRoot, 'Data', 'Shop.json'), 'utf8');
      const beforeOdds = await fs.readFile(path.join(runtimeRoot, 'Data', 'ShopPackOdds.json'), 'utf8');
      await assert.rejects(() => applyCampaignOverlay(sourceRoot, runtimeRoot, { projectRoot: root }), /PackShop id already exists/u);
      assert.equal(await fs.readFile(path.join(runtimeRoot, 'Data', 'Shop.json'), 'utf8'), beforeShop);
      assert.equal(await fs.readFile(path.join(runtimeRoot, 'Data', 'ShopPackOdds.json'), 'utf8'), beforeOdds);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
