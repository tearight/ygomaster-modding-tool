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
  CONTENT_VALIDATE,
  CREATE_DECK,
} from '../src/common/channel';
import { defaultContentManifest } from '../src/core/layers';
import {
  compileCampaignContentOperation,
  diffCampaignContent,
  inspectCampaignContent,
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
    for (const channel of [CONTENT_INSPECT, CONTENT_RESOLVE, CONTENT_VALIDATE, CONTENT_COMPILE, CONTENT_DIFF, CONTENT_DEPLOY, CONTENT_REVEAL_SOURCE]) {
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
