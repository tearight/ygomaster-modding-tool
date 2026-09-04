import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createCardResolver } from '../src/core/card-resolver';
import { inspectCampaignContent, mutateCampaignShopDocuments, readCampaignShopDocuments } from '../src/core/content-operations';
import { createEmptyRegistry } from '../src/core/id-registry';
import { defaultContentManifest } from '../src/core/layers';
import type { CatalogCard } from '../src/core/types';

const editorRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/shop-content');

const metadata = (key: string, availability: 'always' | 'unlock' = 'always', predecessor?: string) => `${JSON.stringify({
  formatVersion: 1,
  kind: 'shop-pack',
  payload: {
    shopId: `shop:${key}`,
    name: `Fixture ${key}`,
    price: 100,
    availability,
    ...(predecessor ? { unlock: { ref: predecessor } } : {}),
    packlist: `pools/${key}.packlist`,
    odds: `odds/${key}.json`,
    oddsName: key,
    packSize: 8,
    cover: 'Blue-Eyes White Dragon',
  },
}, null, 2)}\n`;

const odds = `${JSON.stringify({
  formatVersion: 1,
  kind: 'shop-odds',
  payload: {
    slots: [{ name: 'base', count: 8, entries: [{ rarity: 'common', probability: 1 }] }],
    collation: [{ slot: 'base', count: 8 }],
  },
}, null, 2)}\n`;

const pool = '[common]\nBlue-Eyes White Dragon\n';

const makeFixture = async (withSecond = false) => {
  const root = await fs.mkdtemp(path.join(editorRoot, '.shop-authoring-ui-'));
  const contentRoot = path.join(root, 'campaign', 'content');
  await Promise.all(['packs', 'pools', 'odds'].map((entry) => fs.mkdir(path.join(contentRoot, 'shop', entry), { recursive: true })));
  await fs.writeFile(path.join(contentRoot, 'manifest.json'), `${JSON.stringify(defaultContentManifest(), null, 2)}\n`);
  const writePack = async (key: string, body: string) => Promise.all([
    fs.writeFile(path.join(contentRoot, 'shop', 'packs', `${key}.json`), body),
    fs.writeFile(path.join(contentRoot, 'shop', 'pools', `${key}.packlist`), pool),
    fs.writeFile(path.join(contentRoot, 'shop', 'odds', `${key}.json`), odds),
  ]);
  await writePack('a', metadata('a'));
  if (withSecond) await writePack('b', metadata('b', 'unlock', 'shop:a'));
  const catalog = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'catalog.json'), 'utf8')) as { cards: CatalogCard[] };
  const resolver = createCardResolver(catalog.cards, { catalogGeneration: 'shop-authoring-ui-catalog' });
  return { root, contentRoot, resolver, registry: createEmptyRegistry() };
};

const mutationFor = (generation: string, metadataContent = metadata('a')) => ({
  metadata: { sourcePath: 'shop/packs/a.json', content: metadataContent },
  packList: { sourcePath: 'shop/pools/a.packlist', content: pool },
  odds: { sourcePath: 'shop/odds/a.json', content: odds },
  expectedContentGeneration: generation,
  confirmApply: false,
});

describe('EDITOR-012 Shop authoring UI boundary', () => {
  it('reads and validates linked metadata, pool, and odds with a read-only target preview', async () => {
    const value = await makeFixture();
    try {
      const options = { projectRoot: value.root, contentRoot: value.contentRoot, resolver: value.resolver, registry: value.registry };
      const inspected = await inspectCampaignContent(options);
      const generation = (inspected.data as { contentGeneration: string }).contentGeneration;
      const read = await readCampaignShopDocuments({ ...options, sourcePath: 'shop/packs/a.json' });
      assert.equal(read.ok, true, JSON.stringify(read.problems));
      assert.equal((read.data as { packList: { sourcePath: string } }).packList.sourcePath, 'shop/pools/a.packlist');
      const preview = await mutateCampaignShopDocuments(options, mutationFor(generation));
      assert.equal(preview.ok, true, JSON.stringify(preview.problems));
      const data = preview.data as { resolutions: Array<{ runtimeId?: number; sourceSpan?: { sourcePath: string; line: number } }>; projection: { shopId: number; shopEntry: { price: number }; oddsEntry: { packShopIds: number[] } }; requiresConfirmation: boolean };
      assert.equal(data.requiresConfirmation, true);
      assert.equal(data.resolutions[0]?.runtimeId, 1001);
      assert.equal(data.resolutions[0]?.sourceSpan?.sourcePath, 'shop/pools/a.packlist');
      assert.equal(data.projection.shopEntry.price, 100);
      assert.deepEqual(data.projection.oddsEntry.packShopIds, [data.projection.shopId]);
      assert.equal(await fs.stat(path.join(value.root, 'campaign', 'source')).then(() => true, () => false), false);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('blocks unsupported target fields and keeps all authored bytes unchanged', async () => {
    const value = await makeFixture();
    try {
      const options = { projectRoot: value.root, contentRoot: value.contentRoot, resolver: value.resolver, registry: value.registry };
      const generation = ((await inspectCampaignContent(options)).data as { contentGeneration: string }).contentGeneration;
      const original = await fs.readFile(path.join(value.contentRoot, 'shop', 'packs', 'a.json'), 'utf8');
      const parsed = JSON.parse(original) as { payload: Record<string, unknown> };
      parsed.payload.cashProduct = { sku: 'unsupported' };
      const blocked = await mutateCampaignShopDocuments(options, { ...mutationFor(generation, `${JSON.stringify(parsed, null, 2)}\n`), confirmApply: true });
      assert.equal(blocked.ok, false);
      const unsupported = blocked.problems.find((entry) => entry.code === 'SHOP_FIELD_UNSUPPORTED');
      assert.equal(unsupported?.sourcePath, 'shop/packs/a.json');
      assert.equal(unsupported?.jsonPointer, '/payload/cashProduct');
      assert.equal(await fs.readFile(path.join(value.contentRoot, 'shop', 'packs', 'a.json'), 'utf8'), original);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('atomically writes the previewed trio and rejects stale or escaped requests', async () => {
    const value = await makeFixture();
    try {
      const options = { projectRoot: value.root, contentRoot: value.contentRoot, resolver: value.resolver, registry: value.registry };
      const generation = ((await inspectCampaignContent(options)).data as { contentGeneration: string }).contentGeneration;
      const nextMetadata = metadata('a').replace('Fixture a', 'Updated Fixture a');
      const nextPool = `${pool}Dark Magician\n`;
      const request = { ...mutationFor(generation, nextMetadata), packList: { sourcePath: 'shop/pools/a.packlist', content: nextPool } };
      const preview = await mutateCampaignShopDocuments(options, request);
      assert.equal(preview.ok, true, JSON.stringify(preview.problems));
      assert.notEqual(await fs.readFile(path.join(value.contentRoot, 'shop', 'pools', 'a.packlist'), 'utf8'), nextPool);
      const applied = await mutateCampaignShopDocuments(options, { ...request, confirmApply: true });
      assert.equal(applied.ok, true, JSON.stringify(applied.problems));
      assert.equal(await fs.readFile(path.join(value.contentRoot, 'shop', 'packs', 'a.json'), 'utf8'), nextMetadata);
      assert.equal(await fs.readFile(path.join(value.contentRoot, 'shop', 'pools', 'a.packlist'), 'utf8'), nextPool);
      assert.equal(await fs.readFile(path.join(value.contentRoot, 'shop', 'odds', 'a.json'), 'utf8'), odds);
      const stale = await mutateCampaignShopDocuments(options, mutationFor(generation));
      assert.equal(stale.problems[0]?.code, 'CONTENT_GENERATION_STALE');
      const currentGeneration = ((await inspectCampaignContent(options)).data as { contentGeneration: string }).contentGeneration;
      const escaped = await mutateCampaignShopDocuments(options, { ...mutationFor(currentGeneration), packList: { sourcePath: 'shop/../outside.packlist', content: pool } });
      assert.equal(escaped.ok, false);
      assert.equal(escaped.problems[0]?.code, 'CONTENT_SHOP_PATH_UNAUTHORIZED');
      const familyEscape = await mutateCampaignShopDocuments(options, { ...mutationFor(currentGeneration), packList: { sourcePath: 'shop/pools/../packs/evil.packlist', content: pool } });
      assert.equal(familyEscape.ok, false);
      assert.equal(familyEscape.problems[0]?.code, 'CONTENT_SHOP_PATH_UNAUTHORIZED');
      assert.equal(await fs.stat(path.join(value.contentRoot, 'shop', 'packs', 'evil.packlist')).then(() => true, () => false), false);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('reports a predecessor cycle at the edited metadata source location', async () => {
    const value = await makeFixture(true);
    try {
      const options = { projectRoot: value.root, contentRoot: value.contentRoot, resolver: value.resolver, registry: value.registry };
      const generation = ((await inspectCampaignContent(options)).data as { contentGeneration: string }).contentGeneration;
      const cycle = await mutateCampaignShopDocuments(options, mutationFor(generation, metadata('a', 'unlock', 'shop:b')));
      assert.equal(cycle.ok, false);
      const problem = cycle.problems.find((entry) => entry.message.includes('cycle'));
      assert.equal(problem?.sourcePath, 'shop/packs/a.json');
      assert.equal(problem?.jsonPointer, '/payload/unlock');
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('renderer uses IPC write-through and never legacy generated Shop CRUD', async () => {
    const source = await fs.readFile(path.join(editorRoot, 'src', 'renderer', 'components', 'shop', 'ShopAuthoring.tsx'), 'utf8');
    assert.match(source, /contentShopRead/u);
    assert.match(source, /contentShopMutate/u);
    for (const forbidden of ['node:fs', 'fetch(', 'readShop', 'updateShop', 'Shop.json']) assert.equal(source.includes(forbidden), false, forbidden);
  });
});
