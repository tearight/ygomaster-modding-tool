import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createCardResolver } from '../src/core/card-resolver';
import { compileCampaignContent } from '../src/core/campaign-pipeline';
import {
  compileCampaignContentOperation,
  diffCampaignContent,
  inspectCampaignContent,
  resolveCampaignContent,
  validateCampaignContentOperation,
} from '../src/core/content-operations';
import { compileCampaignIr, type CampaignIrBundle } from '../src/core/ir-compiler';
import { createEmptyRegistry } from '../src/core/id-registry';
import { defaultContentManifest } from '../src/core/layers';
import type { LocalizationCatalog } from '../src/core/localization-content';
import { materializeCampaignData } from '../src/core/materialize';
import { buildFakeRuntime } from '../src/core/pipeline-harness';
import type { CatalogCard, Problem } from '../src/core/types';

const catalog = Array.from({ length: 40 }, (_, index): CatalogCard => ({
  id: 1001 + index,
  ydkId: 500001 + index,
  names: { english: `Fixture Card ${String(index + 1).padStart(2, '0')}`, display: `Fixture Card ${String(index + 1).padStart(2, '0')}` },
  texts: { english: 'Fixture', display: 'Fixture' },
  original: {},
  stats: {},
  autoTags: [],
}));

const localization = (): LocalizationCatalog => {
  const values: Record<string, string> = {
    'gate.demo.name': 'Demo Gate',
    'gate.demo.description': 'Demo Description',
    'chapter.demo.description': 'Demo Duel',
    'duel.player.name': 'Player',
    'duel.cpu.name': 'CPU',
    'structure.demo.name': 'Demo Structure',
    'structure.demo.description': 'Demo Structure Description',
  };
  return {
    formatVersion: 1,
    fallbackLanguage: 'en',
    languages: { en: values },
    entries: Object.entries(values).map(([key, value]) => ({ key, value, language: 'en', sourcePath: 'localization/en.json' })),
    entriesByLanguage: { en: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { key, value, language: 'en', sourcePath: 'localization/en.json' }])) },
    diagnostics: [],
  };
};

const deckSource = `${['[main]', ...catalog.map((card) => `1 ${card.names.english}`), '[extra]', '[side]', ''].join('\n')}`;

const gate = {
  formatVersion: 1,
  kind: 'gate',
  payload: {
    id: 'gate:demo',
    nameKey: 'gate.demo.name',
    descriptionKey: 'gate.demo.description',
    regulation: 'regulation:demo',
    priority: 1,
    goal: 'chapter:duel',
    chapters: [{
      id: 'chapter:duel',
      kind: 'duel',
      entry: true,
      required: true,
      descriptionKey: 'chapter.demo.description',
      duel: {
        cpuDeck: 'decks/cpu.json',
        rentalDeck: 'decks/rental.json',
        playerMode: 'rental',
        playerNameKey: 'duel.player.name',
        cpuNameKey: 'duel.cpu.name',
      },
    }],
    target: { ygomaster: { illust_id: 4027 } },
  },
};

const structure = {
  formatVersion: 1,
  kind: 'structure',
  payload: {
    key: 'demo',
    nameKey: 'structure.demo.name',
    descriptionKey: 'structure.demo.description',
    deck: 'decks/rental.json',
    focus: ['Fixture Card 01'],
    accessory: 'starter',
    reward: { quantity: 1, oneCopy: true },
  },
};

const shopOdds = {
  formatVersion: 1,
  kind: 'shop-odds',
  payload: {
    slots: [{ name: 'standard', count: 8, entries: [{ rarity: 'common', probability: 0.75 }, { rarity: 'ultra', probability: 0.25 }] }],
    collation: [{ slot: 'standard', count: 8 }],
  },
};

const shopPack = (id: string, availability: 'always' | 'unlock', predecessor?: string) => ({
  formatVersion: 1,
  kind: 'shop-pack',
  payload: {
    shopId: `shop:${id}`,
    name: `Fixture ${id}`,
    price: 100,
    availability,
    ...(predecessor ? { unlock: { ref: predecessor } } : {}),
    packlist: `pools/${id}.packlist`,
    odds: `odds/${id}.json`,
    oddsName: `fixture-${id}`,
    packSize: 8,
    cover: 'Fixture Card 01',
  },
});

const shopPool = '[common]\nFixture Card 01\nFixture Card 02\n[ultra]\nFixture Card 03\nFixture Card 04\n';

const manifest = defaultContentManifest();

const fixturePng = (): Uint8Array => Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
]);

interface Fixture {
  root: string;
  contentRoot: string;
  irRoot: string;
  bundle: CampaignIrBundle;
}

const makeFixture = async (): Promise<Fixture> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ir-compiler-'));
  const contentRoot = path.join(root, 'campaign', 'content');
  const irRoot = path.join(root, 'campaign', 'source');
  const files: Record<string, string> = {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'decks/cpu.decklist': deckSource,
    'decks/rental.decklist': deckSource,
    'gates/demo.json': `${JSON.stringify(gate, null, 2)}\n`,
    'structures/demo.json': `${JSON.stringify(structure, null, 2)}\n`,
    'regulations/demo.json': `${JSON.stringify({ formatVersion: 1, kind: 'regulation', payload: {
      regulationId: 'regulation:demo',
      name: 'Demo Regulation',
      cutoffRef: 'release:demo',
      allowedRef: 'card-pool:demo',
      rulesRef: 'regulations/demo.regulation',
    } }, null, 2)}\n`,
    'regulations/demo.regulation': `${['[allowed]', ...catalog.map((card) => `3 ${card.names.english}`), '[forbidden]', '[limited]', '[semi-limited]', ''].join('\n')}`,
    'localization/en.json': `${JSON.stringify(localization().languages.en, null, 2)}\n`,
    'assets/accessories.json': `${JSON.stringify({ starter: { box: 1, sleeve: 1 } }, null, 2)}\n`,
    'assets/manifest.json': `${JSON.stringify({ formatVersion: 1, assets: [{
      key: 'gate.demo.background',
      source: 'assets/background.png',
      role: 'solo-gate-background',
      gateRefs: ['gate:demo'],
      provenance: 'test fixture',
      license: 'test fixture',
      confirmed: true,
    }] }, null, 2)}\n`,
    'shop/packs/first.json': `${JSON.stringify(shopPack('first', 'always'), null, 2)}\n`,
    'shop/packs/second.json': `${JSON.stringify(shopPack('second', 'unlock', 'shop:first'), null, 2)}\n`,
    'shop/pools/first.packlist': shopPool,
    'shop/pools/second.packlist': shopPool,
    'shop/odds/first.json': `${JSON.stringify(shopOdds, null, 2)}\n`,
    'shop/odds/second.json': `${JSON.stringify(shopOdds, null, 2)}\n`,
    'runtime-policy/settings.json': `${JSON.stringify({ payload: { DefaultGems: 1000, DisableBanList: false } }, null, 2)}\n`,
    'runtime-policy/shop.json': `${JSON.stringify({ payload: { NoDuplicatesPerPack: true } }, null, 2)}\n`,
    'runtime-policy/client.json': `${JSON.stringify({ payload: { DuelClientTimeMultiplier: 2 } }, null, 2)}\n`,
  };
  for (const [relative, value] of Object.entries(files)) {
    const target = path.join(contentRoot, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value, 'utf8');
  }
  const backgroundPath = path.join(contentRoot, 'assets', 'background.png');
  await fs.writeFile(backgroundPath, fixturePng());
  const bundle: CampaignIrBundle = {
    decks: [
      { key: 'decks/cpu.json', source: deckSource, sourcePath: 'decks/cpu.decklist' },
      { key: 'decks/rental.json', source: deckSource, sourcePath: 'decks/rental.decklist' },
    ],
    gates: [{ value: gate, sourcePath: 'gates/demo.json' }],
    structures: [{ value: structure, sourcePath: 'structures/demo.json' }],
    regulations: [{
      key: 'demo',
      metadata: JSON.parse(files['regulations/demo.json']) as unknown,
      rules: files['regulations/demo.regulation'],
      metadataSourcePath: 'regulations/demo.json',
      rulesSourcePath: 'regulations/demo.regulation',
    }],
    localization: localization(),
    language: 'en',
    fallbackLanguage: 'en',
    accessories: { starter: { box: 1, sleeve: 1 } },
    gateBackgrounds: [{
      key: 'gate.demo.background',
      sourcePath: 'assets/background.png',
      manifestSourcePath: 'assets/manifest.json',
      gateRefs: ['gate:demo'],
      bytes: fixturePng(),
    }],
    shops: [
      {
        metadata: shopPack('first', 'always'),
        packList: shopPool,
        odds: shopOdds,
        metadataSourcePath: 'shop/packs/first.json',
        packListSourcePath: 'shop/pools/first.packlist',
        oddsSourcePath: 'shop/odds/first.json',
      },
      {
        metadata: shopPack('second', 'unlock', 'shop:first'),
        packList: shopPool,
        odds: shopOdds,
        metadataSourcePath: 'shop/packs/second.json',
        packListSourcePath: 'shop/pools/second.packlist',
        oddsSourcePath: 'shop/odds/second.json',
      },
    ],
    runtimePolicy: { settings: { DefaultGems: 1000, DisableBanList: false }, shop: { NoDuplicatesPerPack: true }, client: { DuelClientTimeMultiplier: 2 } },
    consumedSourcePaths: ['localization/en.json', 'assets/accessories.json', 'assets/manifest.json', 'assets/background.png', 'runtime-policy/settings.json', 'runtime-policy/shop.json', 'runtime-policy/client.json'],
  };
  return { root, contentRoot, irRoot, bundle };
};

const treeBytes = async (root: string): Promise<Record<string, string>> => {
  const output: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else output[path.relative(root, target).replace(/\\/gu, '/')] = (await fs.readFile(target)).toString('base64');
    }
  };
  if (await fs.stat(root).then(() => true, () => false)) await visit(root);
  return output;
};

describe('integrated content to Modding Tool IR compiler', () => {
  it('does not compile nested physical Deck sources under the logical-folder contract', async () => {
    const fixture = await makeFixture();
    try {
      const resolver = createCardResolver(catalog, { catalogGeneration: 'catalog-nested-deck-fixture' });
      const options = {
        projectRoot: fixture.root,
        contentRoot: fixture.contentRoot,
        irRoot: fixture.irRoot,
        resolver,
        catalogGeneration: resolver.catalogGeneration,
        registry: createEmptyRegistry(),
        deckOptions: { extraDeckCardIds: new Set<number>() },
      };
      const published = await compileCampaignContent(options);
      assert.equal(published.ok, true, JSON.stringify(published.problems));
      assert.equal(published.published, true);
      const before = await treeBytes(fixture.irRoot);
      const nestedPath = path.join(fixture.contentRoot, 'decks', 'nested', 'rogue.decklist');
      await fs.mkdir(path.dirname(nestedPath), { recursive: true });
      await fs.writeFile(nestedPath, deckSource, 'utf8');
      await fs.writeFile(path.join(fixture.contentRoot, 'decks', 'nested', 'rogue.json'), `${JSON.stringify({ metadata: { identity: { formatVersion: 1, reference: 'deck:rogue-stable' }, role: 'cpu', folder: 'deck-folder:not-projected', unknown: { keep: true } } })}\n`, 'utf8');
      const compiled = await compileCampaignContent(options);
      assert.equal(compiled.ok, false);
      assert.equal(compiled.published, false);
      assert.equal(compiled.problems.some((entry) => entry.code === 'IR_COMPILER_SOURCE_UNTRACKED' && (entry.sourcePath || entry.path) === 'decks/nested/rogue.decklist'), true);
      assert.equal(compiled.problems.some((entry) => entry.code === 'IR_COMPILER_SOURCE_UNTRACKED' && (entry.sourcePath || entry.path) === 'decks/nested/rogue.json'), true);
      assert.deepEqual(await treeBytes(fixture.irRoot), before);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('injects catalog-driven Extra legality into Duel and Structure compilation', async () => {
    const fixture = await makeFixture();
    try {
      const fusion = {
        ...catalog[0],
        id: 2000,
        ydkId: 600000,
        names: { english: 'Fixture Fusion', display: 'Fixture Fusion' },
        stats: { type: 0x41 },
        autoTags: ['type:monster', 'type:fusion'],
      } satisfies CatalogCard;
      const validSource = deckSource.replace('[extra]\n', '[extra]\n1 Fixture Fusion\n');
      const fixtureRegulation = fixture.bundle.regulations?.[0];
      if (!fixtureRegulation || typeof fixtureRegulation.rules !== 'string') throw new Error('Fixture regulation is missing');
      const validRegulation = {
        ...fixtureRegulation,
        rules: fixtureRegulation.rules.replace('[forbidden]', '3 Fixture Fusion\n[forbidden]'),
      };
      const validBundle: CampaignIrBundle = {
        ...fixture.bundle,
        decks: fixture.bundle.decks.map((entry) => ({ ...entry, source: validSource })),
        regulations: [validRegulation],
      };
      await Promise.all([
        fs.writeFile(path.join(fixture.contentRoot, 'decks/cpu.decklist'), validSource, 'utf8'),
        fs.writeFile(path.join(fixture.contentRoot, 'decks/rental.decklist'), validSource, 'utf8'),
        fs.writeFile(path.join(fixture.contentRoot, 'regulations/demo.regulation'), validRegulation.rules, 'utf8'),
      ]);
      const resolver = createCardResolver([...catalog, fusion], { catalogGeneration: 'catalog-extra-fixture' });
      const valid = await compileCampaignIr({
        projectRoot: fixture.root,
        contentRoot: fixture.contentRoot,
        irRoot: fixture.irRoot,
        resolver,
        catalogGeneration: resolver.catalogGeneration,
        registry: createEmptyRegistry(),
        bundle: validBundle,
        checkOnly: true,
      });
      assert.equal(valid.ok, true, JSON.stringify(valid.problems));
      assert.deepEqual(valid.deckProjections?.['decks/cpu.json'].e.ids, [2000]);
      assert.deepEqual(valid.structureProjections?.[0]?.document.contents.e.ids, [2000]);

      const invalidSource = deckSource.replace('[main]\n', '[main]\n1 Fixture Fusion\n');
      await Promise.all([
        fs.writeFile(path.join(fixture.contentRoot, 'decks/cpu.decklist'), invalidSource, 'utf8'),
        fs.writeFile(path.join(fixture.contentRoot, 'decks/rental.decklist'), invalidSource, 'utf8'),
      ]);
      const invalid = await compileCampaignIr({
        projectRoot: fixture.root,
        contentRoot: fixture.contentRoot,
        irRoot: fixture.irRoot,
        resolver,
        catalogGeneration: resolver.catalogGeneration,
        registry: createEmptyRegistry(),
        bundle: { ...validBundle, decks: validBundle.decks.map((entry) => ({ ...entry, source: invalidSource })) },
        checkOnly: true,
      });
      assert.equal(invalid.ok, false);
      assert.equal(invalid.problems.some((problem) => problem.code === 'DECK_MAIN_CARD_INVALID'), true);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('uses the approved Structure adapter without a caller flag while keeping check-only/read-only and zero-diff guarantees', async () => {
    const fixture = await makeFixture();
    try {
      const common = {
        projectRoot: fixture.root,
        contentRoot: fixture.contentRoot,
        irRoot: fixture.irRoot,
        resolver: createCardResolver(catalog, { catalogGeneration: 'catalog-fixture' }),
        catalogGeneration: 'catalog-fixture',
        registry: createEmptyRegistry(),
        bundle: fixture.bundle,
        deckOptions: { extraDeckCardIds: new Set<number>() },
      };
      const overlap = await compileCampaignIr({ ...common, irRoot: fixture.contentRoot });
      assert.equal(overlap.ok, false);
      const missingBackground = await compileCampaignIr({ ...common, bundle: { ...fixture.bundle, gateBackgrounds: [] } });
      assert.equal(missingBackground.ok, false);
      assert.equal(missingBackground.problems.some((entry) => entry.code === 'GATE_BACKGROUND_MISSING'), true);
      assert.equal(overlap.problems[0]?.code, 'IR_COMPILER_OPTIONS_INVALID');
      const discovered = await compileCampaignContent({
        projectRoot: common.projectRoot,
        contentRoot: common.contentRoot,
        irRoot: common.irRoot,
        resolver: common.resolver,
        catalogGeneration: common.catalogGeneration,
        registry: createEmptyRegistry(),
        deckOptions: common.deckOptions,
        checkOnly: true,
      });
      assert.equal(discovered.ok, true, JSON.stringify(discovered.problems));
      assert.equal(discovered.published, false);
      const checked = await compileCampaignIr({ ...common, checkOnly: true });
      assert.equal(checked.ok, true, JSON.stringify(checked.problems));
      assert.equal(checked.problems.some((entry) => entry.severity === 'warning'), false);
      assert.equal(checked.warnings.some((entry) => entry.code === 'STRUCTURE_REWARD_ONE_COPY_ASSUMED'), true);
      assert.equal(checked.published, false);
      assert.equal(await fs.stat(fixture.irRoot).then(() => true, () => false), false);

      const staleReviewedPlan = await compileCampaignIr({ ...common, expectedOutputRegistryGeneration: 'stale-reviewed-plan' });
      assert.equal(staleReviewedPlan.ok, false);
      assert.equal(staleReviewedPlan.published, false);
      assert.equal(staleReviewedPlan.problems[0]?.code, 'ID_REGISTRY_STALE_PLAN');
      assert.equal(await fs.stat(fixture.irRoot).then(() => true, () => false), false);

      const published = await compileCampaignIr(common);
      assert.equal(published.ok, true, JSON.stringify(published.problems));
      assert.equal(published.published, true);
      const structureFile = `structure/${path.posix.basename(published.structureProjections?.[0]?.path || '')}`;
      for (const relative of ['manifest.json', 'generation.json', 'provenance.json', 'gate/demo.json', 'deck/decks/cpu.json', 'deck/decks/rental.json', structureFile, 'target/ygomaster/Data/Shop.json', 'target/ygomaster/Data/ShopPackOdds.json', 'target/ygomaster/Data/Settings.json', 'target/ygomaster/Data/Shop.policy.json', 'target/ygomaster/Data/ClientData/ClientSettings.json']) {
        assert.equal(await fs.stat(path.join(fixture.irRoot, ...relative.split('/'))).then(() => true, () => false), true, relative);
      }
      const before = await treeBytes(fixture.irRoot);
      const runtime = await buildFakeRuntime({
        root: path.join(fixture.root, 'runtime'),
        files: {
          'Data/Solo.json': { Master: { Solo: { gate: {}, chapter: {}, unlock: {}, unlock_item: {}, reward: {} } } },
          'Data/Shop.json': { runtimeUnknown: true, PackShop: { '1': { packId: 1 } }, StructureShop: { '2': {} } },
          'Data/ShopPackOdds.json': [],
          'Data/Settings.json': { DefaultGems: 0, runtimeUnknown: true },
          'Data/ClientData/ClientSettings.json': { DuelClientTimeMultiplier: 1, runtimeUnknown: true },
        },
      });
      const materialized = await materializeCampaignData(fixture.irRoot, runtime.root, { projectRoot: fixture.root });
      assert.equal(materialized.changedFiles.includes('Data/Solo.json'), true);
      assert.equal(materialized.changedFiles.some((entry) => entry.startsWith('Data/SoloDuels/')), true);
      assert.equal(materialized.changedFiles.some((entry) => entry.startsWith('Data/StructureDecks/')), true);
      assert.equal(materialized.changedFiles.includes('Data/Shop.json'), true);
      assert.equal(materialized.changedFiles.includes('Data/ShopPackOdds.json'), true);
      assert.equal(materialized.changedFiles.includes('Data/Settings.json'), true);
      assert.equal(materialized.changedFiles.includes('Data/ClientData/ClientSettings.json'), true);
      const deployedShop = JSON.parse(await fs.readFile(path.join(runtime.root, 'Data', 'Shop.json'), 'utf8')) as { runtimeUnknown: boolean; PackShop: Record<string, { unlockSecrets: number[] }> };
      const shopIds = Object.keys(deployedShop.PackShop).sort();
      assert.equal(deployedShop.runtimeUnknown, true);
      assert.equal(shopIds.length, 2);
      assert.deepEqual(deployedShop.PackShop[shopIds[0] as string]?.unlockSecrets, [Number(shopIds[1])]);
      assert.deepEqual(
        Object.fromEntries((published.shopProjections || []).map((entry) => [String(entry.shopId), entry.shopEntry])),
        deployedShop.PackShop,
      );
      const deployedOdds = JSON.parse(await fs.readFile(path.join(runtime.root, 'Data', 'ShopPackOdds.json'), 'utf8')) as unknown[];
      assert.deepEqual(deployedOdds, (published.shopProjections || []).map((entry) => entry.oddsEntry));
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtime.root, 'Data', 'Settings.json'), 'utf8')), { DefaultGems: 1000, DisableBanList: false, runtimeUnknown: true });
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtime.root, 'Data', 'ClientData', 'ClientSettings.json'), 'utf8')), { DuelClientTimeMultiplier: 2, runtimeUnknown: true });
      assert.equal(materialized.changedFiles.includes('Data/ClientData/IDS/IDS_SOLO.txt'), true);
      const repeated = await compileCampaignIr(common);
      assert.equal(repeated.ok, true, JSON.stringify(repeated.problems));
      assert.equal(repeated.zeroDiff, true);
      assert.equal(repeated.published, false);
      assert.deepEqual(await treeBytes(fixture.irRoot), before);
      assert.equal(repeated.provenance?.sources.some((entry) => entry.path === 'gates/demo.json'), true);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('resolves symbolic authored deck identities while emitting physical legacy adapter paths', async () => {
    const fixture = await makeFixture();
    try {
      const symbolicGate = JSON.parse(JSON.stringify(gate)) as typeof gate;
      symbolicGate.payload.chapters[0].duel.cpuDeck = 'deck:cpu';
      symbolicGate.payload.chapters[0].duel.rentalDeck = 'deck:rental';
      await fs.writeFile(path.join(fixture.contentRoot, 'gates', 'demo.json'), `${JSON.stringify(symbolicGate, null, 2)}\n`, 'utf8');

      const compiled = await compileCampaignContent({
        projectRoot: fixture.root,
        contentRoot: fixture.contentRoot,
        irRoot: fixture.irRoot,
        resolver: createCardResolver(catalog, { catalogGeneration: 'catalog-fixture' }),
        catalogGeneration: 'catalog-fixture',
        registry: createEmptyRegistry(),
        deckOptions: { extraDeckCardIds: new Set<number>() },
      });
      assert.equal(compiled.ok, true, JSON.stringify(compiled.problems));
      const sourceChapter = (compiled.gateProjection?.sourceFiles['gate/demo.json']?.chapters as Array<Record<string, unknown>>)[0];
      assert.equal(sourceChapter?.cpu_deck, 'decks/cpu.json');
      assert.equal(sourceChapter?.rental_deck, 'decks/rental.json');
      assert.equal(await fs.stat(path.join(fixture.irRoot, 'deck', 'decks', 'cpu.json')).then(() => true, () => false), true);

      const chapterId = Number(Object.keys(compiled.gateProjection?.duels || {})[0]);
      const duel = compiled.gateProjection?.duels[String(chapterId)]?.Duel as {
        Deck: Array<{ Main: { CardIds: number[] } }>;
      };
      assert.deepEqual(duel.Deck[0]?.Main.CardIds, catalog.map((card) => card.id));
      assert.deepEqual(duel.Deck[1]?.Main.CardIds, catalog.map((card) => card.id));
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('validates logical Gate Deck scope while excluding folder metadata from IR and target projections', async () => {
    const fixture = await makeFixture();
    try {
      const folderCatalog = {
        formatVersion: 1,
        kind: 'deck-folders',
        payload: { folders: [
          { id: 'deck-folder:shared', name: 'Shared' },
          { id: 'deck-folder:demo', name: 'Demo', parent: 'deck-folder:shared' },
        ] },
      };
      const scopedGate = JSON.parse(JSON.stringify(gate)) as typeof gate & { payload: typeof gate.payload & { deckFolder: string } };
      scopedGate.payload.deckFolder = 'deck-folder:demo';
      scopedGate.payload.chapters[0].duel.cpuDeck = 'deck:cpu';
      scopedGate.payload.chapters[0].duel.rentalDeck = 'deck:rental';
      await Promise.all([
        fs.writeFile(path.join(fixture.contentRoot, 'decks', '_folders.json'), `${JSON.stringify(folderCatalog, null, 2)}\n`, 'utf8'),
        fs.writeFile(path.join(fixture.contentRoot, 'decks', 'cpu.json'), `${JSON.stringify({ metadata: { role: 'cpu', folder: 'deck-folder:demo', future: { preserved: true } }, unknownTopLevel: true }, null, 2)}\n`, 'utf8'),
        fs.writeFile(path.join(fixture.contentRoot, 'decks', 'rental.json'), `${JSON.stringify({ metadata: { role: 'rental', folder: 'deck-folder:demo' } }, null, 2)}\n`, 'utf8'),
        fs.writeFile(path.join(fixture.contentRoot, 'gates', 'demo.json'), `${JSON.stringify(scopedGate, null, 2)}\n`, 'utf8'),
      ]);
      const options = {
        projectRoot: fixture.root,
        contentRoot: fixture.contentRoot,
        irRoot: fixture.irRoot,
        resolver: createCardResolver(catalog, { catalogGeneration: 'catalog-fixture' }),
        catalogGeneration: 'catalog-fixture',
        registry: createEmptyRegistry(),
        deckOptions: { extraDeckCardIds: new Set<number>() },
      };
      const first = await compileCampaignContent(options);
      assert.equal(first.ok, true, JSON.stringify(first.problems));
      assert.equal(first.deckProjections?.['decks/cpu.json'] !== undefined, true);
      assert.equal(JSON.stringify(first.deckProjections).includes('deck-folder:'), false);
      assert.equal(JSON.stringify(first.gateProjection).includes('deck-folder:'), false);
      const tree = await treeBytes(fixture.irRoot);
      assert.equal(Object.keys(tree).some((entry) => entry.endsWith('/_folders.json') || entry === '_folders.json'), false);
      const decodedTree = Object.values(tree).map((entry) => Buffer.from(entry, 'base64').toString('utf8')).join('\n');
      assert.equal(decodedTree.includes('deck-folder:demo'), false);
      assert.equal(decodedTree.includes('future'), false);

      const movedCatalog = JSON.parse(JSON.stringify(folderCatalog)) as typeof folderCatalog;
      movedCatalog.payload.folders[1] = { id: 'deck-folder:demo', name: 'Renamed Demo' };
      await fs.writeFile(path.join(fixture.contentRoot, 'decks', '_folders.json'), `${JSON.stringify(movedCatalog, null, 2)}\n`, 'utf8');
      const second = await compileCampaignContent({ ...options, registry: createEmptyRegistry(), checkOnly: true });
      assert.equal(second.ok, true, JSON.stringify(second.problems));
      assert.deepEqual(second.deckProjections, first.deckProjections);
      assert.deepEqual(second.gateProjection?.solo, first.gateProjection?.solo);
      assert.deepEqual(second.gateProjection?.duels, first.gateProjection?.duels);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('blocks unsupported capability before staging and preserves an existing IR on publish failure', async () => {
    const fixture = await makeFixture();
    try {
      const common = {
        projectRoot: fixture.root,
        contentRoot: fixture.contentRoot,
        irRoot: fixture.irRoot,
        resolver: createCardResolver(catalog, { catalogGeneration: 'catalog-fixture' }),
        catalogGeneration: 'catalog-fixture',
        registry: createEmptyRegistry(),
        bundle: fixture.bundle,
        deckOptions: { extraDeckCardIds: new Set<number>() },
      };
      assert.equal((await compileCampaignIr(common)).ok, true);
      const before = await treeBytes(fixture.irRoot);
      const injectedBundle: CampaignIrBundle = {
        ...fixture.bundle,
        decks: fixture.bundle.decks.map((entry, index) => index === 0 ? { ...entry, source: `${entry.source}# injected\n` } : entry),
      };
      const injected = await compileCampaignIr({ ...common, bundle: injectedBundle });
      assert.equal(injected.ok, false);
      assert.equal(injected.problems.some((entry) => entry.code === 'IR_COMPILER_SOURCE_UNTRACKED'), true);
      assert.deepEqual(await treeBytes(fixture.irRoot), before);
      const blockedProblem: Problem = { code: 'SHOP_TARGET_UNSUPPORTED', message: 'Shop projection is unsupported', severity: 'error', sourcePath: 'shop/demo.json' };
      const blocked = await compileCampaignIr({ ...common, bundle: { ...fixture.bundle, blockingCapabilities: [blockedProblem] } });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.problems[0]?.code, 'SHOP_TARGET_UNSUPPORTED');
      assert.deepEqual(await treeBytes(fixture.irRoot), before);

      const writerFailed = await compileCampaignIr({
        ...common,
        writeProjection: async (input) => {
          await fs.writeFile(path.join(input.stagingRoot, 'partial.json'), '{}\n', 'utf8');
          return {
            ok: false,
            files: [],
            staleDisposition: [],
            problems: [{ code: 'INJECTED_WRITER_FAILURE', message: 'injected', severity: 'error' }],
          };
        },
      });
      assert.equal(writerFailed.ok, false);
      assert.equal(writerFailed.problems[0]?.code, 'INJECTED_WRITER_FAILURE');
      assert.deepEqual(await treeBytes(fixture.irRoot), before);

      const validationFailed = await compileCampaignIr({
        ...common,
        validateProjection: async () => ({
          ok: false,
          exitCode: 1,
          exitName: 'COMMAND_FAILED',
          problems: [{ code: 'INJECTED_VALIDATION_FAILURE', message: 'injected', severity: 'error' }],
          warnings: [],
        }),
      });
      assert.equal(validationFailed.ok, false);
      assert.equal(validationFailed.problems[0]?.code, 'INJECTED_VALIDATION_FAILURE');
      assert.deepEqual(await treeBytes(fixture.irRoot), before);

      const changedGate = JSON.parse(JSON.stringify(gate)) as typeof gate;
      changedGate.payload.target.ygomaster.illust_id = 4028;
      await fs.writeFile(path.join(fixture.contentRoot, 'gates', 'demo.json'), `${JSON.stringify(changedGate, null, 2)}\n`, 'utf8');
      const changedBundle: CampaignIrBundle = {
        ...fixture.bundle,
        gates: [{ value: changedGate, sourcePath: 'gates/demo.json' }],
      };
      const failed = await compileCampaignIr({ ...common, bundle: changedBundle, publish: async () => { throw new Error('injected publish failure'); } });
      assert.equal(failed.ok, false);
      assert.equal(failed.problems.some((entry) => entry.code === 'IR_COMPILER_PUBLISH_FAILED'), true);
      assert.deepEqual(await treeBytes(fixture.irRoot), before);
      const parentEntries = await fs.readdir(path.dirname(fixture.irRoot));
      assert.equal(parentEntries.some((entry) => entry.startsWith('.campaign-ir-staging-') || entry.startsWith('.campaign-ir-backup-')), false);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('exposes read-only content operations and requires an expected generation before apply', async () => {
    const fixture = await makeFixture();
    try {
      const resolver = createCardResolver(catalog, { catalogGeneration: 'catalog-fixture' });
      const common = {
        projectRoot: fixture.root,
        contentRoot: fixture.contentRoot,
        irRoot: fixture.irRoot,
        resolver,
        registry: createEmptyRegistry(),
        deckOptions: { extraDeckCardIds: new Set<number>() },
      };
      const inspected = await inspectCampaignContent(common);
      assert.equal(inspected.ok, true);
      const contentGeneration = (inspected.data as { contentGeneration: string }).contentGeneration;
      const beforeContent = await treeBytes(fixture.contentRoot);
      const resolved = await resolveCampaignContent(common);
      const validated = await validateCampaignContentOperation(common);
      const diffed = await diffCampaignContent(common);
      assert.equal(resolved.ok, true, JSON.stringify(resolved.problems));
      assert.equal(validated.ok, true, JSON.stringify(validated.problems));
      assert.equal(diffed.ok, true, JSON.stringify(diffed.problems));
      assert.equal(await fs.stat(fixture.irRoot).then(() => true, () => false), false);
      assert.equal(await fs.stat(path.join(fixture.root, 'campaign', 'id-registry.json')).then(() => true, () => false), false);
      assert.deepEqual(await treeBytes(fixture.contentRoot), beforeContent);

      const missingExpected = await compileCampaignContentOperation({ ...common, apply: true });
      assert.equal(missingExpected.ok, false);
      assert.equal(missingExpected.exitName, 'USAGE_ERROR');
      const applied = await compileCampaignContentOperation({ ...common, apply: true, expectedContentGeneration: contentGeneration });
      assert.equal(applied.ok, true, JSON.stringify(applied.problems));
      assert.equal((applied.data as { published: boolean }).published, true);
      assert.equal(await fs.stat(path.join(fixture.root, 'campaign', 'id-registry.json')).then(() => true, () => false), true);
      const repeated = await compileCampaignContentOperation({ ...common, registry: undefined, apply: true, expectedContentGeneration: contentGeneration });
      assert.equal(repeated.ok, true, JSON.stringify(repeated.problems));
      assert.equal((repeated.data as { zeroDiff: boolean }).zeroDiff, true);
      assert.deepEqual(await treeBytes(fixture.contentRoot), beforeContent);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });
});
