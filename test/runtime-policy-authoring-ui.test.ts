import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createCardResolver } from '../src/core/card-resolver';
import { mutateCampaignRuntimePolicy, readCampaignRuntimePolicy } from '../src/core/content-operations';
import { createEmptyRegistry } from '../src/core/id-registry';
import { defaultContentManifest } from '../src/core/layers';
import { RUNTIME_POLICY_ALLOWLIST, RUNTIME_POLICY_FIELD_DEFINITIONS } from '../src/core/runtime-policy';

const editorRoot = path.resolve(__dirname, '..');
const makeFixture = async () => {
  const root = await fs.mkdtemp(path.join(editorRoot, '.runtime-policy-ui-'));
  const contentRoot = path.join(root, 'campaign', 'content');
  await fs.mkdir(path.join(contentRoot, 'runtime-policy'), { recursive: true });
  await fs.writeFile(path.join(contentRoot, 'manifest.json'), `${JSON.stringify(defaultContentManifest(), null, 2)}\n`);
  await fs.writeFile(path.join(contentRoot, 'runtime-policy', 'settings.json'), `${JSON.stringify({ code: 7, wrapperUnknown: { keep: true }, payload: { DefaultGems: 1000, Craft: { Craft: { Normal: { Normal: 10 } } }, DuelRewards: { win: [{ type: 'Gem', min: 1, max: 2, rate: 100 }] } } }, null, 2)}\n`);
  await fs.writeFile(path.join(contentRoot, 'runtime-policy', 'shop.json'), '{"NoDuplicatesPerPack":true}\n');
  return {
    root,
    contentRoot,
    resolver: createCardResolver([], { catalogGeneration: 'runtime-policy-ui' }),
    registry: createEmptyRegistry(),
  };
};

describe('EDITOR-016 runtime-policy authoring UI boundary', () => {
  it('publishes a typed descriptor for every core allowlist key, including structured Craft and DuelRewards', () => {
    const expected = Object.entries(RUNTIME_POLICY_ALLOWLIST).flatMap(([family, keys]) => [...keys].map((key) => `${family}.${key}`)).sort();
    const actual = RUNTIME_POLICY_FIELD_DEFINITIONS.map((entry) => `${entry.family}.${entry.key}`).sort();
    assert.deepEqual(actual, expected);
    assert.equal(RUNTIME_POLICY_FIELD_DEFINITIONS.find((entry) => entry.key === 'Craft')?.kind, 'object');
    assert.equal(RUNTIME_POLICY_FIELD_DEFINITIONS.find((entry) => entry.key === 'DuelRewards')?.kind, 'object');
    assert.equal(RUNTIME_POLICY_FIELD_DEFINITIONS.every((entry) => Boolean(entry.description)), true);
  });

  it('reads raw/wrapped documents and exposes fresh-deployment and Player.json caveats', async () => {
    const value = await makeFixture();
    try {
      const read = await readCampaignRuntimePolicy({ ...value, projectRoot: value.root });
      assert.equal(read.ok, true, JSON.stringify(read.problems));
      const data = read.data as {
        contentGeneration: string;
        policy: Record<string, Record<string, unknown>>;
        documents: Record<string, { shape: string }>;
        fieldDefinitions: unknown[];
        authority: { freshDeploymentPatchOnly: boolean; playerJsonEditable: boolean; generatedIrEditable: boolean };
      };
      assert.equal(data.policy.settings.DefaultGems, 1000);
      assert.equal(data.documents.settings.shape, 'wrapped');
      assert.equal(data.documents.shop.shape, 'raw');
      assert.equal(data.fieldDefinitions.length, RUNTIME_POLICY_FIELD_DEFINITIONS.length);
      assert.deepEqual(data.authority, { authoredRoot: 'campaign/content', generatedIrEditable: false, freshDeploymentPatchOnly: true, playerJsonEditable: false });
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('previews semantic diff, requires a current generation, validates through staging, and atomically preserves wrapper fields', async () => {
    const value = await makeFixture();
    try {
      const options = { ...value, projectRoot: value.root };
      const read = await readCampaignRuntimePolicy(options);
      const generation = (read.data as { contentGeneration: string }).contentGeneration;
      const policy = {
        settings: { DefaultGems: 2000, DefaultCraftPoints: 30, Craft: { Craft: { Normal: { Normal: 20, Shine: 10 } } }, DuelRewards: { win: [{ type: 'Gem', min: 2, max: 3, rate: 100 }], lose: [] } },
        shop: { NoDuplicatesPerPack: false },
        client: { DuelClientTimeMultiplier: 1.5, ReplayControlsTimeMultiplier: 3 },
      };
      const original = await fs.readFile(path.join(value.contentRoot, 'runtime-policy', 'settings.json'), 'utf8');
      const preview = await mutateCampaignRuntimePolicy(options, { policy, expectedContentGeneration: generation, confirmApply: false });
      assert.equal(preview.ok, true, JSON.stringify(preview.problems));
      assert.equal((preview.data as { requiresConfirmation: boolean; semanticDiff: unknown[] }).requiresConfirmation, true);
      assert.equal((preview.data as { semanticDiff: unknown[] }).semanticDiff.length > 0, true);
      assert.equal(await fs.readFile(path.join(value.contentRoot, 'runtime-policy', 'settings.json'), 'utf8'), original);

      const invalid = await mutateCampaignRuntimePolicy(options, { policy: { ...policy, client: { ArbitrarySetting: true } }, expectedContentGeneration: generation, confirmApply: true });
      assert.equal(invalid.ok, false);
      assert.equal(invalid.problems.some((entry) => entry.code === 'RUNTIME_POLICY_KEY_UNSUPPORTED'), true);
      const stale = await mutateCampaignRuntimePolicy(options, { policy, expectedContentGeneration: 'stale', confirmApply: true });
      assert.equal(stale.problems[0]?.code, 'CONTENT_GENERATION_STALE');

      const applied = await mutateCampaignRuntimePolicy(options, { policy, expectedContentGeneration: generation, confirmApply: true });
      assert.equal(applied.ok, true, JSON.stringify(applied.problems));
      const settings = JSON.parse(await fs.readFile(path.join(value.contentRoot, 'runtime-policy', 'settings.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(settings.code, 7);
      assert.deepEqual(settings.wrapperUnknown, { keep: true });
      assert.deepEqual(settings.payload, policy.settings);
      const shop = JSON.parse(await fs.readFile(path.join(value.contentRoot, 'runtime-policy', 'shop.json'), 'utf8')) as Record<string, unknown>;
      assert.deepEqual(shop, policy.shop);
      assert.equal(await fs.stat(path.join(value.root, 'campaign', 'source')).then(() => true, () => false), false);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });

  it('keeps renderer operations behind preload and provides structured nested controls plus the JSON escape hatch', async () => {
    const [pipeline, editor] = await Promise.all([
      fs.readFile(path.join(editorRoot, 'src', 'renderer', 'components', 'content', 'ContentPipeline.tsx'), 'utf8'),
      fs.readFile(path.join(editorRoot, 'src', 'renderer', 'components', 'content', 'RuntimePolicyEditor.tsx'), 'utf8'),
    ]);
    assert.match(pipeline, /contentRuntimePolicyRead/u);
    assert.match(pipeline, /expectedContentGeneration: contentGeneration/u);
    assert.match(pipeline, /confirmApply: confirmRuntimePolicy/u);
    assert.match(pipeline, /bidirectional escape hatch/u);
    assert.equal((pipeline.match(/setConfirmRuntimePolicy\(false\)/gu) || []).length >= 3, true);
    assert.match(editor, /Add property/u);
    assert.match(editor, /Add item/u);
    assert.doesNotMatch(`${pipeline}\n${editor}`, /node:fs|node:path|fetch\(/u);
  });
});
