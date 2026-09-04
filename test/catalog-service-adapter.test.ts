import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  CatalogServiceAdapter,
  CatalogSupervisorFacade,
  ServiceResponse,
  bindCatalogServiceLifecycle,
} from '../src/main/catalog-service-adapter';

const generationId = 'g-service-fixture';

const summaryCard = {
  runtimeCardId: 4007,
  availability: 3,
  lifecycleState: 'available',
  name: 'Blue-Eyes White Dragon',
  locale: 'en',
  ydkIds: ['89631139'],
  mechanics: { cardType: 1, attribute: 16, race: 8192, atk: 3000, def: 2500, level: 8 },
  image: {
    imageId: 'fixture-image',
    provider: 'ygoprodeck',
    requestedProviderId: '89631139',
    artifactProviderId: '89631139',
    imageSize: 'small',
    locale: 'en',
    localRelativePath: '.db/card-images/ygoprodeck/89631139-small.jpg',
    sha256: 'fixture-sha',
    status: 'available',
    fallbackRuntimeCardId: null,
    fallbackReason: null,
    sourceSnapshotId: 'fixture-source',
  },
};

const queryData = {
  generationId,
  total: 1,
  offset: 0,
  limit: 50,
  cards: [summaryCard],
};

class FakeSupervisor implements CatalogSupervisorFacade {
  starts = 0;
  stops = 0;
  statusCalls = 0;
  getCalls = 0;
  queryCalls = 0;
  startError?: unknown;
  statusResponse: Awaited<ReturnType<CatalogSupervisorFacade['status']>> = {
    ok: true,
    generationId,
    data: {
      catalog: { ready: true, generationId, servingPreviousGood: false },
      sources: { freshness: 'current', healthy: true },
      diagnostics: [],
    },
    diagnostics: [],
  };
  getResponse: Awaited<ReturnType<CatalogSupervisorFacade['get']>> = {
    ok: true,
    generationId,
    data: queryData,
    diagnostics: [],
  };
  queryResponse: Awaited<ReturnType<CatalogSupervisorFacade['query']>> = {
    ok: true,
    generationId,
    data: queryData,
    diagnostics: [],
  };

  async start() {
    this.starts += 1;
    if (this.startError !== undefined) throw this.startError;
    return { catalog: { ready: true, generationId } };
  }

  async status<T = unknown>(): Promise<ServiceResponse<T>> {
    this.statusCalls += 1;
    return this.statusResponse as ServiceResponse<T>;
  }

  async get<T = unknown>(): Promise<ServiceResponse<T>> {
    this.getCalls += 1;
    return this.getResponse as ServiceResponse<T>;
  }

  async query<T = unknown>(): Promise<ServiceResponse<T>> {
    this.queryCalls += 1;
    return this.queryResponse as ServiceResponse<T>;
  }

  async stop(options?: { mode?: 'stdin' | 'protocol' }) {
    assert.equal(options?.mode, 'protocol');
    this.stops += 1;
  }
}

const legacyStatus = async () => ({
  ok: true,
  exitCode: 0,
  exitName: 'SUCCESS',
  warnings: [],
  problems: [],
  data: {
    valid: true,
    generation: 'legacy-generation',
    cardCount: 7,
    catalogPath: 'must-not-cross-preload',
    metadata: { ygoMaster: { cardListPath: 'must-not-cross-preload' } },
  },
});

const legacySearch = async (_workspaceRoot: string, request: { query: string; limit?: number }) => ({
  ok: true,
  exitCode: 0,
  exitName: 'SUCCESS',
  warnings: [],
  problems: [],
  data: { query: request.query, total: 0, cards: [] },
});

const adapterFor = (supervisor: FakeSupervisor) => new CatalogServiceAdapter({
  workspaceRoot: () => path.resolve(__dirname, '../../..'),
  createSupervisor: () => supervisor,
  legacyStatus,
  legacySearch,
});

describe('card catalog service adapter', () => {
  it('starts one owned supervisor, reuses it, and stops only that owned lifecycle', async () => {
    const supervisor = new FakeSupervisor();
    const adapter = adapterFor(supervisor);

    assert.equal((await adapter.status()).ok, true);
    assert.equal((await adapter.search({ query: 'dragon' })).ok, true);
    assert.equal(supervisor.starts, 1);
    assert.equal(supervisor.statusCalls, 1);
    assert.equal(supervisor.queryCalls, 1);

    await adapter.stop();
    assert.equal(supervisor.stops, 1);
    await adapter.stop();
    assert.equal(supervisor.stops, 1);
  });

  it('uses an explicit path-free read-only fallback when the service is unavailable', async () => {
    const supervisor = new FakeSupervisor();
    supervisor.startError = {
      diagnostics: [{ code: 'CLIENT_SPAWN_FAILED', message: 'portable release missing', severity: 'error' }],
    };
    const result = await adapterFor(supervisor).status();

    assert.equal(result.ok, true);
    assert.equal(result.warnings[0]?.code, 'CATALOG_SERVICE_UNAVAILABLE_LEGACY_FALLBACK');
    assert.deepEqual(result.data, {
      valid: true,
      generation: 'legacy-generation',
      cardCount: 7,
      catalogService: { backend: 'legacy-fallback', fallback: true, reason: 'unavailable' },
    });
    assert.equal(JSON.stringify(result).includes('must-not-cross-preload'), false);
  });

  it('uses fallback on request timeout and preserves the timeout diagnostic as metadata', async () => {
    const supervisor = new FakeSupervisor();
    supervisor.queryResponse = {
      ok: false,
      diagnostics: [{ code: 'CLIENT_REQUEST_TIMEOUT', message: 'request timed out', severity: 'error', details: { timeoutMs: 5 } }],
    };
    const result = await adapterFor(supervisor).search({ query: 'dragon' });

    assert.equal(result.ok, true);
    assert.equal(result.warnings[0]?.code, 'CATALOG_SERVICE_TIMEOUT_LEGACY_FALLBACK');
    assert.equal(result.warnings[0]?.details?.reason, 'timeout');
    assert.equal((result.data as { catalogService: { backend: string } }).catalogService.backend, 'legacy-fallback');
  });

  it('fails closed on service, protocol, and capability mismatch', async () => {
    for (const code of ['CLIENT_SERVICE_MISMATCH', 'CLIENT_PROTOCOL_VERSION_MISMATCH', 'CLIENT_CAPABILITY_OPERATION_MISSING']) {
      const supervisor = new FakeSupervisor();
      supervisor.startError = { diagnostics: [{ code, message: 'mismatch', severity: 'error' }] };
      const adapter = adapterFor(supervisor);
      const result = await adapter.status();
      assert.equal(result.ok, false, code);
      assert.equal(result.problems[0]?.code, code);
      assert.equal(result.warnings.some((item) => item.code.includes('FALLBACK')), false);
      const legacyExpression = await adapter.search({ query: 'race:dragon' });
      assert.equal(legacyExpression.ok, false, `${code} legacy expression`);
      assert.equal(legacyExpression.problems[0]?.code, code);
    }
  });

  it('retains the active generation and reports stale sources and previous-good service state', async () => {
    const supervisor = new FakeSupervisor();
    supervisor.statusResponse = {
      ok: true,
      generationId,
      data: {
        catalog: { ready: true, generationId, pointerGenerationId: 'g-rejected', servingPreviousGood: true },
        sources: { freshness: 'stale', healthy: false },
        diagnostics: [{ code: 'CATALOG_RELOAD_DEFERRED', message: 'candidate rejected', severity: 'warning' }],
      },
      diagnostics: [{ code: 'CATALOG_RELOAD_DEFERRED', message: 'candidate rejected', severity: 'warning' }],
    };
    const result = await adapterFor(supervisor).status();

    assert.equal(result.ok, true);
    assert.equal((result.data as { generation: string }).generation, generationId);
    assert.deepEqual(result.warnings.map((item) => item.code), [
      'CATALOG_RELOAD_DEFERRED',
      'CATALOG_SERVICE_SOURCE_STALE',
      'CATALOG_SERVICE_PREVIOUS_GOOD_GENERATION',
    ]);
  });

  it('maps status, search, get, and structured query data without exposing service paths', async () => {
    const supervisor = new FakeSupervisor();
    const adapter = adapterFor(supervisor);

    const search = await adapter.search({ query: 'dragon', limit: 50 });
    assert.equal(search.ok, true);
    assert.equal((search.data as { generationId: string }).generationId, generationId);
    assert.equal((search.data as { cards: Array<{ id: number; names: { english?: string } }> }).cards[0]?.id, 4007);

    const get = await adapter.get({ runtimeId: 4007, expectedGenerationId: generationId });
    assert.equal(get.ok, true);
    assert.equal(get.data?.cards[0]?.runtimeCardId, 4007);
    assert.equal(JSON.stringify(get).includes('localRelativePath'), false);
    assert.equal(JSON.stringify(get).includes('.db/card-images'), false);

    const query = await adapter.query({ expression: { kind: 'range', field: 'atk', gte: 3000 }, limit: 5 });
    assert.equal(query.ok, true);
    assert.equal(query.data?.catalogService.generationId, generationId);

    const stale = await adapter.get({ runtimeId: 4007, expectedGenerationId: 'g-reviewed' });
    assert.equal(stale.ok, false);
    assert.equal(stale.problems[0]?.code, 'CATALOG_SERVICE_GENERATION_STALE');
  });

  it('routes non-equivalent legacy expression syntax through the marked legacy adapter', async () => {
    const supervisor = new FakeSupervisor();
    const result = await adapterFor(supervisor).search({ query: 'race:dragon atk>=2500' });

    assert.equal(result.ok, true);
    assert.equal(supervisor.starts, 1);
    assert.equal(result.warnings[0]?.code, 'CATALOG_SERVICE_LEGACY_EXPRESSION_FALLBACK');
    assert.equal((result.data as { catalogService: { reason: string } }).catalogService.reason, 'legacy-expression');
  });

  it('blocks the first app quit until the owned service shutdown has completed', async () => {
    let listener: ((event: { preventDefault(): void }) => void) | undefined;
    let quitCalls = 0;
    let preventCalls = 0;
    let releaseStop: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => { releaseStop = resolve; });
    const adapter = { stop: () => stopped };
    bindCatalogServiceLifecycle({
      on: (_event, value) => { listener = value; },
      quit: () => { quitCalls += 1; },
    }, adapter);

    assert.ok(listener);
    listener({ preventDefault: () => { preventCalls += 1; } });
    listener({ preventDefault: () => { preventCalls += 1; } });
    assert.equal(preventCalls, 2);
    assert.equal(quitCalls, 0);
    releaseStop?.();
    await stopped;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(quitCalls, 1);
  });

  it('keeps filesystem, SQLite, and Electron dependencies behind the main/service boundaries', async () => {
    const editorRoot = path.resolve(__dirname, '..');
    const [preload, rendererDeclaration, serviceClient, servicePackage] = await Promise.all([
      readFile(path.join(editorRoot, 'src', 'preload', 'index.ts'), 'utf8'),
      readFile(path.join(editorRoot, 'src', 'renderer', 'renderer.d.ts'), 'utf8'),
      readFile(path.resolve(editorRoot, '..', '..', 'tools', 'card-catalog-service', 'src', 'client', 'index.ts'), 'utf8'),
      readFile(path.resolve(editorRoot, '..', '..', 'tools', 'card-catalog-service', 'package.json'), 'utf8'),
    ]);

    assert.doesNotMatch(preload, /node:(?:fs|sqlite)|from ['"](?:fs|path)['"]/u);
    assert.doesNotMatch(rendererDeclaration, /node:(?:fs|sqlite)|from ['"](?:fs|path)['"]/u);
    assert.doesNotMatch(serviceClient, /electron/u);
    assert.doesNotMatch(servicePackage, /electron/u);
    assert.doesNotMatch(preload, /shutdown|sync|migration|rawSql|databasePath/u);
  });
});
