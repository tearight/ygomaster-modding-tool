import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  CONTENT_COMPILE,
  CONTENT_DEPLOY,
  CONTENT_DIFF,
  CONTENT_INSPECT,
  CONTENT_RESOLVE,
  CONTENT_REVEAL_SOURCE,
  CONTENT_DOCUMENT_LIST,
  CONTENT_DOCUMENT_READ,
  CONTENT_DOCUMENT_MUTATE,
  CONTENT_DECK_PREVIEW,
  CONTENT_DECK_WORKSPACE_READ,
  CONTENT_DECK_FOLDERS_BOOTSTRAP,
  CONTENT_STRUCTURE_MUTATE,
  CONTENT_REGULATION_READ,
  CONTENT_REGULATION_MUTATE,
  CONTENT_LOCALIZATION_ASSET_INSPECT,
  CONTENT_LOCALIZATION_ASSET_MUTATE,
  CONTENT_RUNTIME_POLICY_READ,
  CONTENT_RUNTIME_POLICY_WRITE,
  CONTENT_VALIDATE,
  CAMPAIGN_WORKSPACE_STATUS,
  CREATE_DECK,
} from '../src/common/channel';
import { defaultContentManifest } from '../src/core/layers';
import {
  compileCampaignContentOperation,
  diffCampaignContent,
  inspectCampaignContent,
  listCampaignContentDocuments,
  mutateCampaignContentDocument,
  readCampaignContentDocument,
} from '../src/core/content-operations';
import { createCardResolver } from '../src/core/card-resolver';
import { createEmptyRegistry } from '../src/core/id-registry';
import { createContentIpcHandlers } from '../src/main/ipc';

const editorRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(editorRoot, '..', '..');

const captureIpcHandlers = () => {
  const app = {
    isPackaged: false,
    getAppPath: () => editorRoot,
    getPath: () => editorRoot,
  };
  return createContentIpcHandlers(app as never) as Record<string, (...args: unknown[]) => Promise<unknown>>;
};

const fixture = async () => {
  const root = await fs.mkdtemp(path.join(editorRoot, '.ui-content-boundary-'));
  const contentRoot = path.join(root, 'content');
  const irRoot = path.join(root, 'source');
  const registryPath = path.join(root, 'id-registry.json');
  await fs.mkdir(contentRoot, { recursive: true });
  await fs.writeFile(path.join(contentRoot, 'manifest.json'), `${JSON.stringify(defaultContentManifest(), null, 2)}\n`);
  return {
    root,
    contentRoot,
    irRoot,
    registryPath,
    resolver: createCardResolver([], { catalogGeneration: 'ui-fixture-catalog' }),
    registry: createEmptyRegistry(),
  };
};

describe('UI content boundary', () => {
  it('registers the shared content channels and returns the stable inspect envelope', async () => {
    const handlers = captureIpcHandlers();
    for (const channel of [CAMPAIGN_WORKSPACE_STATUS, CONTENT_INSPECT, CONTENT_RESOLVE, CONTENT_VALIDATE, CONTENT_COMPILE, CONTENT_DIFF, CONTENT_DEPLOY, CONTENT_REVEAL_SOURCE, CONTENT_DOCUMENT_LIST, CONTENT_DOCUMENT_READ, CONTENT_DOCUMENT_MUTATE, CONTENT_DECK_PREVIEW, CONTENT_DECK_WORKSPACE_READ, CONTENT_DECK_FOLDERS_BOOTSTRAP, CONTENT_STRUCTURE_MUTATE, CONTENT_REGULATION_READ, CONTENT_REGULATION_MUTATE, CONTENT_LOCALIZATION_ASSET_INSPECT, CONTENT_LOCALIZATION_ASSET_MUTATE, CONTENT_RUNTIME_POLICY_READ, CONTENT_RUNTIME_POLICY_WRITE]) {
      assert.equal(typeof handlers[channel], 'function', channel);
    }
    const inspected = await handlers[CONTENT_INSPECT]?.({}, {
      contentRoot: path.join(workspaceRoot, 'campaign', 'content'),
    }) as { ok: boolean; exitName: string; warnings: unknown[]; problems: unknown[]; data?: { contentGeneration?: string; generationStatus?: { state: string } } };
    assert.equal(inspected.ok, true);
    assert.equal(inspected.exitName, 'SUCCESS');
    assert.equal(Array.isArray(inspected.warnings), true);
    assert.equal(Array.isArray(inspected.problems), true);
    assert.equal(typeof inspected.data?.contentGeneration, 'string');
    assert.equal(['missing', 'current', 'stale'].includes(inspected.data?.generationStatus?.state || ''), true);
  });

  it('derives authored content, generated IR, and registry paths from the configured campaign workspace', async () => {
    const root = await fs.mkdtemp(path.join(editorRoot, '.ui-workspace-status-'));
    const workspace = path.join(root, 'workspace');
    try {
      await Promise.all([
        fs.mkdir(path.join(root, 'src', 'core'), { recursive: true }),
        fs.mkdir(path.join(root, '.local'), { recursive: true }),
        fs.mkdir(path.join(workspace, 'campaign', 'content'), { recursive: true }),
      ]);
      await Promise.all([
        fs.writeFile(path.join(root, 'package.json'), '{}\n'),
        fs.writeFile(path.join(root, '.local', 'modding-tool.json'), JSON.stringify({ workspaceRoot: workspace, sourceRoot: path.join(root, 'legacy-source') })),
        fs.writeFile(path.join(workspace, 'campaign', 'content', 'manifest.json'), '{}\n'),
      ]);
      const handlers = createContentIpcHandlers({ isPackaged: false, getAppPath: () => root, getPath: () => root } as never) as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const status = await handlers[CAMPAIGN_WORKSPACE_STATUS]?.() as { ok: boolean; data?: { workspaceRoot: string; contentRoot: string; irRoot: string; registryPath: string } };
      assert.equal(status.ok, true);
      assert.deepEqual(status.data, {
        state: 'ready',
        workspaceRoot: workspace,
        contentRoot: path.join(workspace, 'campaign', 'content'),
        irRoot: path.join(workspace, 'campaign', 'source'),
        registryPath: path.join(workspace, 'campaign', 'id-registry.json'),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects authored source navigation outside the selected content root', async () => {
    const handlers = captureIpcHandlers();
    const escaped = await handlers[CONTENT_REVEAL_SOURCE]?.({}, {
      contentRoot: path.join(workspaceRoot, 'campaign', 'content'),
      sourcePath: '../source/manifest.json',
    }) as { ok: boolean; problems: Array<{ code: string }> };
    assert.equal(escaped.ok, false);
    assert.equal(escaped.problems[0]?.code, 'CONTENT_SOURCE_PATH_ESCAPE');
  });

  it('blocks generated IR writes unless the legacy escape hatch is explicit', async () => {
    const handlers = captureIpcHandlers();
    const blocked = await handlers[CREATE_DECK]?.({}, { path: 'fixture.json', value: {} }) as { ok: boolean; exitName: string; problems: Array<{ code: string }> };
    assert.equal(blocked.ok, false);
    assert.equal(blocked.exitName, 'COMMAND_FAILED');
    assert.equal(blocked.problems[0]?.code, 'GENERATED_IR_READ_ONLY');
  });

  it('keeps check/diff read-only, requires expected generation for apply, and surfaces capability problems', async () => {
    const value = await fixture();
    try {
      const common = {
        projectRoot: value.root,
        contentRoot: value.contentRoot,
        irRoot: value.irRoot,
        registryPath: value.registryPath,
        resolver: value.resolver,
        registry: value.registry,
      };
      const inspected = await inspectCampaignContent(common);
      assert.equal(inspected.ok, true);
      assert.equal((inspected.data as { generationStatus: { state: string } }).generationStatus.state, 'missing');
      const generation = (inspected.data as { contentGeneration: string }).contentGeneration;
      const checked = await compileCampaignContentOperation(common);
      assert.equal(checked.ok, true, JSON.stringify(checked.problems));
      assert.equal((checked.data as { mode: string }).mode, 'check');
      const registryReview = (checked.data as { registryReview: { baseGeneration: string; plannedGeneration: string; namespaces: Array<{ namespace: string; range: { min: number; max: number } }> } }).registryReview;
      assert.equal(registryReview.baseGeneration, value.registry.generation);
      assert.equal(typeof registryReview.plannedGeneration, 'string');
      assert.deepEqual(registryReview.namespaces[0], { namespace: 'gate', range: { min: 100, max: 2101 }, assignmentCount: 0, tombstoneCount: 0, changes: [] });
      assert.equal(await fs.stat(value.irRoot).then(() => true, () => false), false);
      const diffed = await diffCampaignContent(common);
      assert.equal(diffed.ok, true, JSON.stringify(diffed.problems));
      assert.equal(typeof (diffed.data as { contentGeneration: string }).contentGeneration, 'string');
      const missingGeneration = await compileCampaignContentOperation({ ...common, apply: true });
      assert.equal(missingGeneration.ok, false);
      assert.equal(missingGeneration.exitName, 'USAGE_ERROR');
      const stale = await compileCampaignContentOperation({ ...common, apply: true, expectedContentGeneration: 'stale' });
      assert.equal(stale.ok, false);
      assert.equal(stale.problems[0]?.code, 'CONTENT_GENERATION_STALE');
      const staleRegistry = await compileCampaignContentOperation({ ...common, apply: true, expectedContentGeneration: generation, expectedRegistryGeneration: 'stale' });
      assert.equal(staleRegistry.ok, false);
      assert.equal(staleRegistry.problems[0]?.code, 'ID_REGISTRY_STALE_PLAN');
      const stalePlan = await compileCampaignContentOperation({
        ...common,
        apply: true,
        expectedContentGeneration: generation,
        expectedRegistryGeneration: registryReview.baseGeneration,
        expectedPlannedRegistryGeneration: 'stale-plan',
      });
      assert.equal(stalePlan.ok, false);
      assert.equal(stalePlan.problems[0]?.code, 'ID_REGISTRY_STALE_PLAN');

      await fs.mkdir(path.join(value.contentRoot, 'target', 'ygomaster'), { recursive: true });
      await fs.writeFile(path.join(value.contentRoot, 'target', 'ygomaster', 'unsupported.json'), '{"formatVersion":1}\n');
      const capability = await compileCampaignContentOperation(common);
      assert.equal(capability.ok, false);
      assert.equal(capability.problems.some((entry) => entry.code === 'TARGET_CAPABILITY_UNSUPPORTED'), true);
      assert.equal(generation.length > 0, true);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('requires an exact registry review at the IPC apply boundary and keeps the renderer read-only', async () => {
    const handlers = captureIpcHandlers();
    const missingReview = await handlers[CONTENT_COMPILE]?.({}, {
      apply: true,
      confirmApply: true,
      expectedContentGeneration: 'content-generation',
    }) as { ok: boolean; exitName: string; problems: Array<{ code: string }> };
    assert.equal(missingReview.ok, false);
    assert.equal(missingReview.exitName, 'USAGE_ERROR');
    assert.equal(missingReview.problems[0]?.code, 'CONTENT_REGISTRY_REVIEW_REQUIRED');

    const renderer = await fs.readFile(path.join(editorRoot, 'src', 'renderer', 'components', 'content', 'ContentPipeline.tsx'), 'utf8');
    assert.equal(renderer.includes('expectedRegistryGeneration: registryReview.baseGeneration'), true);
    assert.equal(renderer.includes('expectedPlannedRegistryGeneration: registryReview.plannedGeneration'), true);
    assert.equal(renderer.includes('chapter composite'), true);
    assert.equal(renderer.includes("from 'node:fs"), false);
    assert.equal(renderer.includes('fetch('), false);
  });

  it('lists and reads authored documents, preserving unknown JSON fields without renderer filesystem access', async () => {
    const value = await fixture();
    try {
      const common = { projectRoot: value.root, contentRoot: value.contentRoot, resolver: value.resolver, registry: value.registry };
      const listed = await listCampaignContentDocuments(common);
      assert.equal(listed.ok, true);
      assert.deepEqual((listed.data as { documents: string[] }).documents, ['manifest.json']);
      const read = await readCampaignContentDocument({ ...common, sourcePath: 'manifest.json' });
      assert.equal(read.ok, true);
      assert.equal(typeof (read.data as { content: string }).content, 'string');
      const escaped = await readCampaignContentDocument({ ...common, sourcePath: '../source/manifest.json' });
      assert.equal(escaped.ok, false);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('requires approval and a current generation, validates in staging, and atomically leaves invalid edits untouched', async () => {
    const value = await fixture();
    try {
      const common = { projectRoot: value.root, contentRoot: value.contentRoot, resolver: value.resolver, registry: value.registry };
      const original = await fs.readFile(path.join(value.contentRoot, 'manifest.json'), 'utf8');
      const inspected = await inspectCampaignContent(common);
      const generation = (inspected.data as { contentGeneration: string }).contentGeneration;
      const unconfirmed = await mutateCampaignContentDocument(common, { sourcePath: 'manifest.json', operation: 'update', content: original, expectedContentGeneration: generation, confirmApply: false });
      assert.equal(unconfirmed.ok, true);
      assert.equal((unconfirmed.data as { requiresConfirmation: boolean }).requiresConfirmation, true);
      assert.equal(await fs.readFile(path.join(value.contentRoot, 'manifest.json'), 'utf8'), original);
      const invalid = await mutateCampaignContentDocument(common, { sourcePath: 'manifest.json', operation: 'update', content: '{', expectedContentGeneration: generation, confirmApply: true });
      assert.equal(invalid.ok, false);
      assert.equal(await fs.readFile(path.join(value.contentRoot, 'manifest.json'), 'utf8'), original);
      const stale = await mutateCampaignContentDocument(common, { sourcePath: 'manifest.json', operation: 'update', content: original, expectedContentGeneration: 'stale', confirmApply: true });
      assert.equal(stale.ok, false);
      assert.equal(stale.problems[0]?.code, 'CONTENT_GENERATION_STALE');
      const extended = original.replace('\n}', ',\n  "x-target-extension": { "code": 7 }\n}');
      const applied = await mutateCampaignContentDocument(common, { sourcePath: 'manifest.json', operation: 'update', content: extended, expectedContentGeneration: generation, confirmApply: true });
      assert.equal(applied.ok, true, JSON.stringify(applied.problems));
      assert.equal((await fs.readFile(path.join(value.contentRoot, 'manifest.json'), 'utf8')).includes('x-target-extension'), true);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('fails managed deploy before runtime access when generation metadata is absent', async () => {
    const handlers = captureIpcHandlers();
    const root = await fs.mkdtemp(path.join(editorRoot, '.ui-deploy-guard-'));
    try {
      const deployed = await handlers[CONTENT_DEPLOY]?.({}, {
        sourceRoot: path.join(root, 'source'),
        contentRoot: path.join(root, 'content'),
        gameRoot: path.join(root, 'game'),
      }) as { ok: boolean; problems: Array<{ code: string }> };
      assert.equal(deployed.ok, false);
      assert.equal(deployed.problems[0]?.code, 'IR_GENERATION_METADATA_MISSING');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
