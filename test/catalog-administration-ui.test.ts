import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  CATALOG_CUSTOM_VALIDATE,
  CATALOG_REFRESH,
  CATALOG_SEARCH,
  CATALOG_STATUS,
} from '../src/common/channel';
import { createContentIpcHandlers } from '../src/main/ipc';

const roots: string[] = [];
const editorRoot = path.resolve(__dirname, '..');

const writeJson = async (filePath: string, value: unknown) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const fixture = async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'catalog-admin-ui-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  await Promise.all([
    fs.mkdir(path.join(root, 'src', 'core'), { recursive: true }),
    fs.mkdir(path.join(root, '.local'), { recursive: true }),
    fs.mkdir(path.join(workspace, '.db'), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(root, 'package.json'), '{}\n'),
    writeJson(path.join(root, '.local', 'modding-tool.json'), { workspaceRoot: workspace }),
    writeJson(path.join(workspace, '.db', 'catalog.json'), {
      schemaVersion: 1,
      cards: [{
        id: 1001,
        ydkId: 9001,
        names: { display: 'Fixture Dragon', english: 'Fixture Dragon' },
        texts: { display: 'Draw one.', english: 'Draw one.' },
        original: {},
        stats: { type: 1, race: 1, attribute: 1, level: 8, atk: 3000, def: 2500 },
        autoTags: ['type:monster', 'race:dragon'],
        availability: 1,
      }],
    }),
    writeJson(path.join(workspace, '.db', 'metadata.json'), {
      schemaVersion: 1,
      generatedAt: '2026-08-30T00:00:00.000Z',
      cardCount: 1,
      matchedRuntimeIdCount: 1,
      missingRuntimeIds: [],
      sources: [{ id: 'fixture-en', language: 'english', url: 'fixture://approved', format: 'json', path: path.join(workspace, '.db', 'sources', 'english', 'cards.cdb'), usedFrom: 'local', revision: 'fixture-r1', fetchedAt: '2026-08-30T00:00:00.000Z', recordCount: 1 }],
      ygoMaster: { runtimeTag: 'v1.77', runtimeIdCount: 1, bridgeCount: 1 },
    }),
    writeJson(path.join(workspace, 'campaign', 'source', 'card-db', 'manifest.json'), {
      schemaVersion: 1,
      revision: 1,
      layers: [{ id: 'reviewed', priority: 10, kind: 'reviewed', directory: 'reviewed' }],
    }),
    writeJson(path.join(workspace, 'campaign', 'source', 'card-db', 'reviewed', '1001.json'), {
      schemaVersion: 0,
      id: 1001,
      revision: 1,
      tags: ['fixture'],
    }),
  ]);
  const app = { isPackaged: false, getAppPath: () => root, getPath: () => root };
  return { workspace, handlers: createContentIpcHandlers(app as never) as Record<string, (...args: unknown[]) => Promise<unknown>> };
};

afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe('catalog administration UI boundary', () => {
  it('exposes shared status/search/custom validation and reports generation, provenance, and source paths', async () => {
    const value = await fixture();
    for (const channel of [CATALOG_STATUS, CATALOG_REFRESH, CATALOG_SEARCH, CATALOG_CUSTOM_VALIDATE]) {
      assert.equal(typeof value.handlers[channel], 'function', channel);
    }
    const status = await value.handlers[CATALOG_STATUS]?.() as { ok: boolean; data?: { generation?: string; metadata?: { sources?: Array<{ revision?: string; usedFrom?: string }> } } };
    assert.equal(status.ok, true);
    assert.match(status.data?.generation || '', /^ygomaster-catalog-/u);
    assert.deepEqual(status.data?.metadata?.sources?.map((source) => [source.revision, source.usedFrom]), [['fixture-r1', 'local']]);

    const searched = await value.handlers[CATALOG_SEARCH]?.({}, { query: 'race:dragon atk>=2500', limit: 10 }) as { ok: boolean; data?: { cards?: Array<{ id: number }> } };
    assert.equal(searched.ok, true);
    assert.deepEqual(searched.data?.cards?.map((card) => card.id), [1001]);

    const custom = await value.handlers[CATALOG_CUSTOM_VALIDATE]?.() as { ok: boolean; warnings: Array<{ code: string; path?: string }> };
    assert.equal(custom.ok, true);
    const migration = custom.warnings.find((entry) => entry.code === 'CUSTOM_CARD_MIGRATION_AVAILABLE');
    assert.match(migration?.path || '', /reviewed[\\/]1001\.json$/u);
  });

  it('requires an exact reviewed generation and separate online confirmation before refresh', async () => {
    const value = await fixture();
    const missingReview = await value.handlers[CATALOG_REFRESH]?.({}, { online: false }) as { ok: boolean; problems: Array<{ code: string }> };
    assert.equal(missingReview.ok, false);
    assert.equal(missingReview.problems[0]?.code, 'CATALOG_REFRESH_REVIEW_REQUIRED');

    const stale = await value.handlers[CATALOG_REFRESH]?.({}, { online: false, confirmRefresh: true, expectedCatalogGeneration: 'stale' }) as { ok: boolean; problems: Array<{ code: string }> };
    assert.equal(stale.ok, false);
    assert.equal(stale.problems[0]?.code, 'CATALOG_GENERATION_STALE');

    const onlineUnconfirmed = await value.handlers[CATALOG_REFRESH]?.({}, { online: true, confirmRefresh: true, expectedCatalogGeneration: 'reviewed' }) as { ok: boolean; problems: Array<{ code: string }> };
    assert.equal(onlineUnconfirmed.ok, false);
    assert.equal(onlineUnconfirmed.problems[0]?.code, 'CATALOG_ONLINE_CONFIRMATION_REQUIRED');
  });

  it('keeps renderer filesystem/network-free and the Deck picker on the same catalog search API', async () => {
    const renderer = await fs.readFile(path.join(editorRoot, 'src', 'renderer', 'components', 'catalog', 'CatalogAdministration.tsx'), 'utf8');
    const deck = await fs.readFile(path.join(editorRoot, 'src', 'renderer', 'components', 'deck', 'DeckList.tsx'), 'utf8');
    assert.equal(renderer.includes('catalogStatus()'), true);
    assert.equal(renderer.includes('catalogRefresh({'), true);
    assert.equal(renderer.includes('catalogSearch({'), true);
    assert.equal(renderer.includes('catalogCustomValidate()'), true);
    assert.equal(renderer.includes("from 'node:fs"), false);
    assert.equal(renderer.includes('fetch('), false);
    assert.equal(deck.includes('window.electron.catalogSearch({'), true);
  });
});
