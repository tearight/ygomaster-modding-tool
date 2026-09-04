import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createCardResolver } from '../src/core/card-resolver';
import {
  inspectCampaignLocalizationAssets,
  mutateCampaignLocalizationAssetDocument,
} from '../src/core/content-operations';
import { computeRegistryGeneration, createEmptyRegistry } from '../src/core/id-registry';
import { defaultContentManifest } from '../src/core/layers';

const editorRoot = path.resolve(__dirname, '..');
const png256 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
]);
const localization = (name = 'Demo Gate') => `${JSON.stringify({
  en: { 'gate.demo.name': name, 'gate.demo.description': 'Demo description', 'chapter.demo.description': 'Reward description' },
  ko: { 'gate.demo.name': '데모 게이트', 'chapter.demo.description': '보상 설명' },
}, null, 2)}\n`;
const assetManifest = (override: Record<string, unknown> = {}) => `${JSON.stringify({ formatVersion: 1, assets: [{
  key: 'gate.demo.background',
  source: 'assets/background.png',
  role: 'solo-gate-background',
  gateRefs: ['gate:demo'],
  provenance: 'EDITOR-015 synthetic fixture',
  license: 'test fixture',
  ...override,
}] }, null, 2)}\n`;

const makeFixture = async () => {
  const root = await fs.mkdtemp(path.join(editorRoot, '.localization-asset-ui-'));
  const contentRoot = path.join(root, 'campaign', 'content');
  await Promise.all(['gates', 'decks', 'shop', 'structures', 'regulations', 'localization', 'assets', 'target/ygomaster']
    .map((entry) => fs.mkdir(path.join(contentRoot, entry), { recursive: true })));
  await fs.writeFile(path.join(contentRoot, 'manifest.json'), `${JSON.stringify({ ...defaultContentManifest(), authoring: { language: 'en' } }, null, 2)}\n`);
  await fs.writeFile(path.join(contentRoot, 'gates', 'demo.json'), `${JSON.stringify({
    formatVersion: 1,
    kind: 'gate',
    payload: {
      id: 'gate:demo', nameKey: 'gate.demo.name', descriptionKey: 'gate.demo.description', priority: 1,
      goal: 'chapter:reward', chapters: [{
        id: 'chapter:reward', kind: 'reward', entry: true, required: true,
        descriptionKey: 'chapter.demo.description', rewards: [{ kind: 'gem', amount: 1 }],
      }],
      target: { ygomaster: { illust_id: 1 } },
    },
  }, null, 2)}\n`);
  await fs.writeFile(path.join(contentRoot, 'localization', 'catalog.json'), localization());
  await fs.writeFile(path.join(contentRoot, 'assets', 'manifest.json'), assetManifest());
  await fs.writeFile(path.join(contentRoot, 'assets', 'background.png'), png256);
  const registry = createEmptyRegistry();
  registry.namespaces.gate.assignments.demo = { id: 101 };
  registry.generation = computeRegistryGeneration(registry);
  return { root, contentRoot, registry, resolver: createCardResolver([]) };
};
const optionsFor = (value: Awaited<ReturnType<typeof makeFixture>>) => ({
  projectRoot: value.root, contentRoot: value.contentRoot, registry: value.registry, resolver: value.resolver,
});
const generationFor = async (value: Awaited<ReturnType<typeof makeFixture>>) =>
  ((await inspectCampaignLocalizationAssets(optionsFor(value))).data as { contentGeneration: string }).contentGeneration;

describe('EDITOR-015 localization and asset authoring UI boundary', () => {
  it('reports referenced-key language gaps and bounded read-only background previews with target mapping', async () => {
    const value = await makeFixture();
    try {
      const beforeBytes = await fs.readFile(path.join(value.contentRoot, 'assets', 'background.png'));
      const inspected = await inspectCampaignLocalizationAssets(optionsFor(value));
      assert.equal(inspected.ok, true, JSON.stringify(inspected.problems));
      const data = inspected.data as {
        localization: { languages: string[]; referencedKeys: Array<{ key: string; missingLanguages: string[] }> };
        assets: Array<{ dimensions: { width: number; height: number }; targetPaths: string[]; previewDataUrl: string; previewReadOnly: boolean }>;
        authority: { generatedIrEditable: boolean; previewMutatesSource: boolean };
      };
      assert.deepEqual(data.localization.languages, ['en', 'ko']);
      assert.deepEqual(data.localization.referencedKeys.find((entry) => entry.key === 'gate.demo.description')?.missingLanguages, ['ko']);
      assert.deepEqual(data.assets[0]?.dimensions, { width: 256, height: 256 });
      assert.deepEqual(data.assets[0]?.targetPaths, ['Data/ClientData/SoloGateBackgrounds/101.png']);
      assert.match(data.assets[0]?.previewDataUrl || '', /^data:image\/png;base64,/u);
      assert.equal(data.assets[0]?.previewReadOnly, true);
      assert.equal(data.authority.generatedIrEditable, false);
      assert.equal(data.authority.previewMutatesSource, false);
      assert.deepEqual(await fs.readFile(path.join(value.contentRoot, 'assets', 'background.png')), beforeBytes);
      assert.equal(await fs.stat(path.join(value.root, 'campaign', 'source')).then(() => true, () => false), false);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('blocks unsafe path, missing provenance, unsupported role, and invalid dimensions before save', async () => {
    const value = await makeFixture();
    try {
      const manifestPath = path.join(value.contentRoot, 'assets', 'manifest.json');
      const original = await fs.readFile(manifestPath, 'utf8');
      const generation = await generationFor(value);
      const mutate = (content: string) => mutateCampaignLocalizationAssetDocument(optionsFor(value), {
        sourcePath: 'assets/manifest.json', operation: 'update', content,
        expectedContentGeneration: generation, confirmApply: false,
      });
      const escaped = await mutate(assetManifest({ source: '../outside.png' }));
      assert.equal(escaped.ok, false);
      assert.ok(escaped.problems.some((entry) => entry.code === 'ASSET_PATH_INVALID'));
      const noProvenance = await mutate(assetManifest({ provenance: '' }));
      assert.ok(noProvenance.problems.some((entry) => entry.code === 'ASSET_PROVENANCE_MISSING'));
      const unsupported = await mutate(assetManifest({ role: 'general' }));
      assert.ok(unsupported.problems.some((entry) => entry.code === 'CLIENT_ASSET_UNSUPPORTED'));
      await fs.writeFile(path.join(value.contentRoot, 'assets', 'background.png'), Uint8Array.from(png256.map((byte, index) => index === 23 ? 0x80 : byte)));
      const invalidDimensions = await mutateCampaignLocalizationAssetDocument(optionsFor(value), {
        sourcePath: 'assets/manifest.json', operation: 'update', content: assetManifest(),
        expectedContentGeneration: await generationFor(value), confirmApply: false,
      });
      assert.ok(invalidDimensions.problems.some((entry) => entry.code === 'GATE_BACKGROUND_DIMENSIONS_INVALID'));
      assert.equal(await fs.readFile(manifestPath, 'utf8'), original);
      assert.equal(await fs.stat(path.join(value.root, 'campaign', 'source')).then(() => true, () => false), false);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('previews without writing, applies with confirmation, rejects stale generation and family escape', async () => {
    const value = await makeFixture();
    try {
      const sourcePath = 'localization/catalog.json';
      const filePath = path.join(value.contentRoot, sourcePath);
      const original = await fs.readFile(filePath, 'utf8');
      const next = localization('Updated Demo Gate');
      const request = {
        sourcePath, operation: 'update' as const, content: next,
        expectedContentGeneration: await generationFor(value), confirmApply: false,
      };
      const preview = await mutateCampaignLocalizationAssetDocument(optionsFor(value), request);
      assert.equal(preview.ok, true, JSON.stringify(preview.problems));
      assert.equal((preview.data as { requiresConfirmation: boolean }).requiresConfirmation, true);
      assert.equal(await fs.readFile(filePath, 'utf8'), original);
      const applied = await mutateCampaignLocalizationAssetDocument(optionsFor(value), { ...request, confirmApply: true });
      assert.equal(applied.ok, true, JSON.stringify(applied.problems));
      assert.equal(await fs.readFile(filePath, 'utf8'), next);
      assert.equal((applied.data as { preview: { authority: { generatedIrEditable: boolean } } }).preview.authority.generatedIrEditable, false);
      const stale = await mutateCampaignLocalizationAssetDocument(optionsFor(value), request);
      assert.equal(stale.problems[0]?.code, 'CONTENT_GENERATION_STALE');
      const escaped = await mutateCampaignLocalizationAssetDocument(optionsFor(value), {
        ...request, sourcePath: 'gates/demo.json', expectedContentGeneration: await generationFor(value),
      });
      assert.equal(escaped.problems[0]?.code, 'CONTENT_LOCALIZATION_ASSET_PATH_UNAUTHORIZED');
      const gatePath = path.join(value.contentRoot, 'gates', 'demo.json');
      const gateBytes = await fs.readFile(gatePath);
      const traversal = await mutateCampaignLocalizationAssetDocument(optionsFor(value), {
        ...request, sourcePath: 'localization/../gates/demo.json', expectedContentGeneration: await generationFor(value),
      });
      assert.equal(traversal.problems[0]?.code, 'CONTENT_LOCALIZATION_ASSET_PATH_UNAUTHORIZED');
      assert.deepEqual(await fs.readFile(gatePath), gateBytes);

      const frenchPath = 'localization/fr.json';
      const french = `${JSON.stringify({
        'gate.demo.name': 'Porte démo',
        'gate.demo.description': 'Description démo',
        'chapter.demo.description': 'Description récompense',
      }, null, 2)}\n`;
      const createRequest = {
        sourcePath: frenchPath, operation: 'create' as const, content: french,
        expectedContentGeneration: await generationFor(value), confirmApply: false,
      };
      assert.equal((await mutateCampaignLocalizationAssetDocument(optionsFor(value), createRequest)).ok, true);
      assert.equal((await mutateCampaignLocalizationAssetDocument(optionsFor(value), { ...createRequest, confirmApply: true })).ok, true);
      assert.equal(await fs.readFile(path.join(value.contentRoot, frenchPath), 'utf8'), french);
      const deleteRequest = {
        sourcePath: frenchPath, operation: 'delete' as const,
        expectedContentGeneration: await generationFor(value), confirmApply: false,
      };
      assert.equal((await mutateCampaignLocalizationAssetDocument(optionsFor(value), deleteRequest)).ok, true);
      assert.equal((await mutateCampaignLocalizationAssetDocument(optionsFor(value), { ...deleteRequest, confirmApply: true })).ok, true);
      assert.equal(await fs.stat(path.join(value.contentRoot, frenchPath)).then(() => true, () => false), false);
      assert.equal(await fs.stat(path.join(value.root, 'campaign', 'source')).then(() => true, () => false), false);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('renderer uses preload only and cannot read files, fetch assets, or edit generated output', async () => {
    const source = await fs.readFile(path.join(editorRoot, 'src', 'renderer', 'components', 'localization', 'LocalizationAssetAuthoring.tsx'), 'utf8');
    assert.match(source, /contentLocalizationAssetInspect/u);
    assert.match(source, /contentLocalizationAssetMutate/u);
    for (const forbidden of ['node:fs', 'fetch(', 'campaign/source', 'writeFile(', 'readFile(']) assert.equal(source.includes(forbidden), false, forbidden);
  });
});
