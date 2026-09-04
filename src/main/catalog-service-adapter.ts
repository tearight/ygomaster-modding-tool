import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  CatalogSearchRequest,
  CatalogServiceCardSummary,
  CatalogServiceGetRequest,
  CatalogServiceQueryExpression,
  CatalogServiceQueryRequest,
  CatalogServiceQueryResult,
  CoreOperationProblem,
  CoreOperationResult,
} from '../common/type';

export interface ServiceDiagnostic {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  path?: string;
  details?: Record<string, unknown>;
}

export interface ServiceResponse<T = unknown> {
  ok: boolean;
  generationId?: string;
  data?: T;
  diagnostics: ServiceDiagnostic[];
}

interface ServiceCapabilities {
  catalog: { ready: boolean; generationId?: string };
}

export interface CatalogSupervisorFacade {
  start(): Promise<ServiceCapabilities>;
  status<T = unknown>(): Promise<ServiceResponse<T>>;
  get<T = unknown>(payload: unknown): Promise<ServiceResponse<T>>;
  query<T = unknown>(payload: unknown): Promise<ServiceResponse<T>>;
  stop(options?: { mode?: 'stdin' | 'protocol' }): Promise<void>;
}

interface ServiceStatusData {
  catalog?: {
    ready?: boolean;
    generationId?: string;
    pointerGenerationId?: string;
    servingPreviousGood?: boolean;
  };
  sources?: {
    stateAvailable?: boolean;
    observedGenerationId?: string;
    matchesActiveGeneration?: boolean;
    freshness?: 'current' | 'stale' | 'unknown';
    healthy?: boolean;
    observations?: unknown[];
  };
  diagnostics?: ServiceDiagnostic[];
}

interface ServiceQueryData {
  generationId?: string;
  total?: number;
  offset?: number;
  limit?: number;
  cards?: unknown[];
}

interface LegacyStatusData {
  valid?: boolean;
  generation?: string;
  cardCount?: number;
  missingRuntimeIdCount?: number;
  lastUpdated?: string;
  metadata?: {
    sources?: Array<Record<string, unknown>>;
    ygoMaster?: Record<string, unknown>;
  };
}

export interface CatalogServiceAdapterOptions {
  workspaceRoot: () => string | Promise<string>;
  createSupervisor?: (workspaceRoot: string) => CatalogSupervisorFacade | Promise<CatalogSupervisorFacade>;
  legacyStatus: (workspaceRoot: string) => Promise<CoreOperationResult<LegacyStatusData>>;
  legacySearch: (workspaceRoot: string, request: CatalogSearchRequest) => Promise<CoreOperationResult>;
}

type FallbackReason = 'unavailable' | 'timeout' | 'legacy-expression';

const success = <T>(data: T, warnings: CoreOperationProblem[] = []): CoreOperationResult<T> => ({
  ok: true,
  exitCode: 0,
  exitName: 'SUCCESS',
  warnings,
  problems: [],
  data,
});

const failed = <T = never>(problems: CoreOperationProblem[], warnings: CoreOperationProblem[] = []): CoreOperationResult<T> => ({
  ok: false,
  exitCode: 1,
  exitName: 'COMMAND_FAILED',
  warnings,
  problems,
});

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const toProblem = (input: ServiceDiagnostic): CoreOperationProblem => {
  const diagnostic = safeBoundaryDiagnostic(input);
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity === 'error' ? 'error' : 'warning',
    ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
    ...(diagnostic.details === undefined ? {} : { details: diagnostic.details }),
  };
};

const diagnosticsFromError = (error: unknown): ServiceDiagnostic[] => {
  const record = asRecord(error);
  if (Array.isArray(record?.diagnostics)) {
    return record.diagnostics.filter((item): item is ServiceDiagnostic => {
      const diagnostic = asRecord(item);
      return typeof diagnostic?.code === 'string' && typeof diagnostic.message === 'string';
    }).map((item) => safeBoundaryDiagnostic(item));
  }
  return [{
    code: 'CATALOG_SERVICE_UNAVAILABLE',
    message: 'The card catalog service portable client could not be loaded from the selected workspace.',
    severity: 'error',
    details: { boundary: 'selected-workspace-portable-release' },
  }];
};

const mismatchCode = (code: string): boolean =>
  code.includes('PROTOCOL')
  || code === 'CLIENT_SERVICE_MISMATCH'
  || code === 'CLIENT_PROCESS_MISMATCH'
  || code.startsWith('CLIENT_CAPABILITY_');

const timeoutCode = (code: string): boolean => code === 'CLIENT_REQUEST_TIMEOUT';

const unavailableCode = (code: string): boolean => [
  'CATALOG_SERVICE_UNAVAILABLE',
  'CATALOG_UNAVAILABLE',
  'CLIENT_NOT_RUNNING',
  'CLIENT_SPAWN_FAILED',
  'CLIENT_PROCESS_EXITED',
  'CLIENT_WRITE_FAILED',
  'CLIENT_RESTART_FAILED',
].includes(code);

const safeBoundaryDiagnostic = (diagnostic: ServiceDiagnostic): ServiceDiagnostic => {
  if (!unavailableCode(diagnostic.code)) return diagnostic;
  return {
    code: diagnostic.code,
    message: diagnostic.code === 'CATALOG_UNAVAILABLE'
      ? 'The card catalog service has no readable catalog generation.'
      : 'The card catalog service is unavailable from the selected workspace.',
    severity: diagnostic.severity,
    details: { boundary: 'selected-workspace-portable-release' },
  };
};

const classifyFallback = (diagnostics: ServiceDiagnostic[]): FallbackReason | undefined => {
  if (diagnostics.some((item) => mismatchCode(item.code))) return undefined;
  if (diagnostics.some((item) => timeoutCode(item.code))) return 'timeout';
  if (diagnostics.some((item) => unavailableCode(item.code))) return 'unavailable';
  return undefined;
};

const fallbackWarning = (reason: FallbackReason, diagnostics: ServiceDiagnostic[]): CoreOperationProblem => ({
  code: reason === 'timeout'
    ? 'CATALOG_SERVICE_TIMEOUT_LEGACY_FALLBACK'
    : reason === 'legacy-expression'
      ? 'CATALOG_SERVICE_LEGACY_EXPRESSION_FALLBACK'
      : 'CATALOG_SERVICE_UNAVAILABLE_LEGACY_FALLBACK',
  message: reason === 'legacy-expression'
    ? 'This legacy expression cannot be translated without changing its meaning; the read-only legacy catalog was used.'
    : `The card catalog service was ${reason === 'timeout' ? 'too slow to respond' : 'unavailable'}; the read-only legacy catalog was used.`,
  severity: 'warning',
  details: {
    fallback: true,
    reason,
    serviceDiagnostics: diagnostics.map(safeBoundaryDiagnostic).map((item) => ({ code: item.code, message: item.message, details: item.details })),
  },
});

const sanitizeLegacyStatus = (data: LegacyStatusData | undefined, reason: FallbackReason): Record<string, unknown> => {
  const sources = data?.metadata?.sources?.map((source) => ({
    ...(typeof source.id === 'string' ? { id: source.id } : {}),
    ...(typeof source.language === 'string' ? { language: source.language } : {}),
    ...(source.usedFrom === 'local' || source.usedFrom === 'download' ? { usedFrom: source.usedFrom } : {}),
    ...(typeof source.revision === 'string' ? { revision: source.revision } : {}),
    ...(typeof source.fetchedAt === 'string' ? { fetchedAt: source.fetchedAt } : {}),
    ...(typeof source.recordCount === 'number' ? { recordCount: source.recordCount } : {}),
  }));
  const ygoMaster = data?.metadata?.ygoMaster;
  const ygoMasterFields = ygoMaster === undefined ? {} : {
    ...(typeof ygoMaster.runtimeTag === 'string' ? { runtimeTag: ygoMaster.runtimeTag } : {}),
    ...(typeof ygoMaster.runtimeIdCount === 'number' ? { runtimeIdCount: ygoMaster.runtimeIdCount } : {}),
    ...(typeof ygoMaster.bridgeCount === 'number' ? { bridgeCount: ygoMaster.bridgeCount } : {}),
  };
  const safeYgoMaster = Object.keys(ygoMasterFields).length === 0 ? undefined : ygoMasterFields;
  const metadata = sources === undefined && safeYgoMaster === undefined
    ? undefined
    : {
      ...(sources === undefined ? {} : { sources }),
      ...(safeYgoMaster === undefined ? {} : { ygoMaster: safeYgoMaster }),
    };
  return {
    valid: data?.valid === true,
    ...(data?.generation === undefined ? {} : { generation: data.generation }),
    ...(data?.cardCount === undefined ? {} : { cardCount: data.cardCount }),
    ...(data?.missingRuntimeIdCount === undefined ? {} : { missingRuntimeIdCount: data.missingRuntimeIdCount }),
    ...(data?.lastUpdated === undefined ? {} : { lastUpdated: data.lastUpdated }),
    ...(metadata === undefined ? {} : { metadata }),
    catalogService: { backend: 'legacy-fallback', fallback: true, reason },
  };
};

const publicImage = (value: unknown): CatalogServiceCardSummary['image'] => {
  const image = asRecord(value);
  if (image === undefined) return null;
  if (
    typeof image.provider !== 'string'
    || typeof image.requestedProviderId !== 'string'
    || typeof image.artifactProviderId !== 'string'
    || typeof image.imageSize !== 'string'
    || typeof image.status !== 'string'
  ) return null;
  return {
    provider: image.provider,
    requestedProviderId: image.requestedProviderId,
    artifactProviderId: image.artifactProviderId,
    imageSize: image.imageSize,
    status: image.status,
    fallbackRuntimeCardId: typeof image.fallbackRuntimeCardId === 'number' ? image.fallbackRuntimeCardId : null,
    fallbackReason: typeof image.fallbackReason === 'string' ? image.fallbackReason : null,
  };
};

const publicCard = (value: unknown): CatalogServiceCardSummary | undefined => {
  const card = asRecord(value);
  if (
    card === undefined
    || !Number.isSafeInteger(card.runtimeCardId)
    || typeof card.availability !== 'number'
    || !['available', 'unavailable', 'tombstoned'].includes(String(card.lifecycleState))
    || !Array.isArray(card.ydkIds)
  ) return undefined;
  const mechanics = asRecord(card.mechanics);
  const publicMechanics = mechanics === undefined
    ? null
    : Object.fromEntries(Object.entries(mechanics).filter((entry): entry is [string, number | null] => entry[1] === null || typeof entry[1] === 'number'));
  return {
    runtimeCardId: card.runtimeCardId as number,
    availability: card.availability,
    lifecycleState: card.lifecycleState as CatalogServiceCardSummary['lifecycleState'],
    name: typeof card.name === 'string' ? card.name : null,
    locale: typeof card.locale === 'string' ? card.locale : null,
    ydkIds: card.ydkIds.filter((item): item is string => typeof item === 'string'),
    mechanics: publicMechanics,
    image: publicImage(card.image),
  };
};

const queryResult = (
  response: ServiceResponse<ServiceQueryData>,
  expectedGenerationId?: string,
): CoreOperationResult<CatalogServiceQueryResult> => {
  const data = response.data;
  const generationId = response.generationId ?? data?.generationId;
  if (generationId === undefined || (data?.generationId !== undefined && data.generationId !== generationId)) {
    return failed([{ code: 'CATALOG_SERVICE_GENERATION_MISMATCH', message: 'The service response did not identify one consistent catalog generation.', severity: 'error' }]);
  }
  if (expectedGenerationId !== undefined && expectedGenerationId !== generationId) {
    return failed([{
      code: 'CATALOG_SERVICE_GENERATION_STALE',
      message: `Expected catalog generation ${expectedGenerationId}, but the service returned ${generationId}.`,
      severity: 'error',
      details: { expectedGenerationId, generationId },
    }]);
  }
  const cards = (data?.cards ?? []).map(publicCard);
  if (cards.some((card) => card === undefined)) {
    return failed([{ code: 'CATALOG_SERVICE_RESPONSE_INVALID', message: 'The service returned a card outside the supported summary contract.', severity: 'error' }]);
  }
  const warnings = response.diagnostics.filter((item) => item.severity !== 'error').map(toProblem);
  return success({
    generationId,
    total: typeof data?.total === 'number' ? data.total : cards.length,
    offset: typeof data?.offset === 'number' ? data.offset : 0,
    limit: typeof data?.limit === 'number' ? data.limit : Math.max(1, cards.length),
    cards: cards as CatalogServiceCardSummary[],
    catalogService: { backend: 'service', generationId },
  }, warnings);
};

const simpleSearchExpression = (query: string): CatalogServiceQueryExpression | undefined => {
  const trimmed = query.trim();
  if (trimmed.length === 0) return { kind: 'all' };
  const tokens = trimmed.split(/\s+/u);
  if (!tokens.every((token) => /^[\p{L}\p{N}_]+$/u.test(token))) return undefined;
  const terms: CatalogServiceQueryExpression[] = tokens.map((value) => ({
    kind: 'text',
    field: 'any',
    value,
    mode: 'text',
  }));
  return terms.length === 1 ? terms[0] : { kind: 'and', terms };
};

const loadPortableSupervisor = async (workspaceRoot: string): Promise<CatalogSupervisorFacade> => {
  const portableRoot = path.resolve(workspaceRoot, 'release', 'card-catalog-service');
  const clientEntry = path.resolve(portableRoot, 'app', 'dist', 'src', 'client', 'index.js');
  const imported = await import(/* @vite-ignore */ pathToFileURL(clientEntry).href) as Record<string, unknown>;
  const createLaunch = imported.createPortableCatalogLaunch;
  const Supervisor = imported.CatalogProcessSupervisor;
  if (typeof createLaunch !== 'function' || typeof Supervisor !== 'function') {
    throw new Error('Portable card catalog release does not expose the supported client facade.');
  }
  const launch = (createLaunch as (root: string, workspace: string) => unknown)(portableRoot, workspaceRoot);
  return new (Supervisor as new (options: { launch: unknown }) => CatalogSupervisorFacade)({ launch });
};

export class CatalogServiceAdapter {
  readonly #options: CatalogServiceAdapterOptions;
  #workspaceRoot: string | undefined;
  #supervisorPromise: Promise<CatalogSupervisorFacade> | undefined;
  #stopped = false;

  constructor(options: CatalogServiceAdapterOptions) {
    this.#options = options;
  }

  async status(): Promise<CoreOperationResult> {
    const started = await this.#startedSupervisor();
    if ('diagnostics' in started) return await this.#statusFallback(started.diagnostics);
    const response = await started.supervisor.status<ServiceStatusData>();
    const fallback = classifyFallback(response.diagnostics);
    if (!response.ok) {
      if (fallback !== undefined) return await this.#statusFallback(response.diagnostics, fallback);
      return failed(response.diagnostics.map(toProblem));
    }
    const catalog = response.data?.catalog;
    if (catalog?.ready !== true) {
      const diagnostics = response.diagnostics.length > 0 ? response.diagnostics : [{ code: 'CATALOG_UNAVAILABLE', message: 'The service has no readable catalog generation.', severity: 'error' as const }];
      return await this.#statusFallback(diagnostics, 'unavailable');
    }
    const generationId = response.generationId ?? catalog.generationId;
    if (generationId === undefined || (catalog.generationId !== undefined && catalog.generationId !== generationId)) {
      return failed([{ code: 'CATALOG_SERVICE_GENERATION_MISMATCH', message: 'The service status did not identify one consistent catalog generation.', severity: 'error' }]);
    }
    const warnings = response.diagnostics.filter((item) => item.severity !== 'error').map(toProblem);
    if (response.data?.sources?.freshness === 'stale') {
      warnings.push({ code: 'CATALOG_SERVICE_SOURCE_STALE', message: 'Catalog source observations are stale; reads remain pinned to the reported active generation.', severity: 'warning', details: { generationId } });
    }
    if (catalog.servingPreviousGood === true) {
      warnings.push({ code: 'CATALOG_SERVICE_PREVIOUS_GOOD_GENERATION', message: 'The service rejected a newer candidate and is serving the previous good generation.', severity: 'warning', details: { generationId, pointerGenerationId: catalog.pointerGenerationId } });
    }
    return success({
      valid: true,
      generation: generationId,
      catalogService: { backend: 'service', generationId },
      service: {
        catalog,
        sources: response.data?.sources,
      },
    }, warnings);
  }

  async search(request: CatalogSearchRequest): Promise<CoreOperationResult> {
    const expression = simpleSearchExpression(request.query);
    const started = await this.#startedSupervisor();
    if ('diagnostics' in started) return await this.#searchFallback(request, classifyFallback(started.diagnostics), started.diagnostics);
    if (expression === undefined) {
      return await this.#searchFallback(request, 'legacy-expression', []);
    }
    const response = await started.supervisor.query<ServiceQueryData>({
      expression,
      projection: 'summary',
      locale: 'en',
      sort: [{ field: 'runtimeId', direction: 'asc' }],
      limit: Math.max(1, Math.min(500, Math.trunc(request.limit ?? 100))),
    });
    if (!response.ok) {
      const fallback = classifyFallback(response.diagnostics);
      if (fallback !== undefined) return await this.#searchFallback(request, fallback, response.diagnostics);
      return failed(response.diagnostics.map(toProblem));
    }
    const mapped = queryResult(response);
    if (!mapped.ok || mapped.data === undefined) return mapped;
    const cards = mapped.data.cards.map((card) => ({
      id: card.runtimeCardId,
      ydkId: Number(card.ydkIds[0] ?? 0),
      names: {
        display: card.name ?? `#${card.runtimeCardId}`,
        ...(card.locale?.toLowerCase().startsWith('en') && card.name !== null ? { english: card.name } : {}),
      },
      texts: {},
      original: {},
      stats: {
        type: card.mechanics?.cardType ?? undefined,
        attribute: card.mechanics?.attribute ?? undefined,
        race: card.mechanics?.race ?? undefined,
        level: card.mechanics?.level ?? undefined,
        rank: card.mechanics?.rank ?? undefined,
        link: card.mechanics?.link ?? undefined,
        scale: card.mechanics?.scale ?? undefined,
        atk: card.mechanics?.atk ?? undefined,
        def: card.mechanics?.def ?? undefined,
      },
      autoTags: [],
      availability: card.availability,
    }));
    return success({
      query: request.query,
      total: mapped.data.total,
      offset: mapped.data.offset,
      limit: mapped.data.limit,
      cards,
      generationId: mapped.data.generationId,
      catalogService: mapped.data.catalogService,
    }, mapped.warnings);
  }

  async get(request: CatalogServiceGetRequest): Promise<CoreOperationResult<CatalogServiceQueryResult>> {
    if ((request.runtimeId === undefined) === (request.ydkId === undefined)) {
      return failed([{ code: 'CATALOG_SERVICE_IDENTIFIER_INVALID', message: 'Provide exactly one runtimeId or ydkId.', severity: 'error' }]);
    }
    const started = await this.#startedSupervisor();
    if ('diagnostics' in started) return failed(started.diagnostics.map(toProblem));
    const response = await started.supervisor.get<ServiceQueryData>({
      ...(request.runtimeId === undefined ? { ydkId: request.ydkId } : { runtimeId: request.runtimeId }),
      projection: 'summary',
      ...(request.locale === undefined ? {} : { locale: request.locale }),
    });
    if (!response.ok) return failed(response.diagnostics.map(toProblem));
    return queryResult(response, request.expectedGenerationId);
  }

  async query(request: CatalogServiceQueryRequest): Promise<CoreOperationResult<CatalogServiceQueryResult>> {
    const started = await this.#startedSupervisor();
    if ('diagnostics' in started) return failed(started.diagnostics.map(toProblem));
    const { expectedGenerationId, ...payload } = request;
    const response = await started.supervisor.query<ServiceQueryData>({ ...payload, projection: 'summary' });
    if (!response.ok) return failed(response.diagnostics.map(toProblem));
    return queryResult(response, expectedGenerationId);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const pending = this.#supervisorPromise;
    this.#supervisorPromise = undefined;
    this.#workspaceRoot = undefined;
    if (pending === undefined) return;
    try {
      const supervisor = await pending;
      await supervisor.stop({ mode: 'protocol' });
    } catch {
      // Failed startup owns and terminates its exact child. There is no foreign process to stop.
    }
  }

  async #startedSupervisor(): Promise<{ supervisor: CatalogSupervisorFacade } | { diagnostics: ServiceDiagnostic[] }> {
    if (this.#stopped) return { diagnostics: [{ code: 'CATALOG_SERVICE_UNAVAILABLE', message: 'The catalog service adapter is stopped.', severity: 'error' }] };
    const workspaceRoot = path.resolve(await this.#options.workspaceRoot());
    if (this.#workspaceRoot !== undefined && this.#workspaceRoot !== workspaceRoot) {
      const previous = this.#supervisorPromise;
      this.#supervisorPromise = undefined;
      this.#workspaceRoot = undefined;
      if (previous !== undefined) {
        try { await (await previous).stop({ mode: 'protocol' }); } catch { /* startup cleanup owns its child */ }
      }
    }
    if (this.#supervisorPromise === undefined) {
      this.#workspaceRoot = workspaceRoot;
      const create = this.#options.createSupervisor ?? loadPortableSupervisor;
      this.#supervisorPromise = Promise.resolve(create(workspaceRoot)).then(async (supervisor) => {
        await supervisor.start();
        return supervisor;
      });
    }
    try {
      const supervisor = await this.#supervisorPromise;
      return { supervisor };
    } catch (error) {
      return { diagnostics: diagnosticsFromError(error) };
    }
  }

  async #statusFallback(diagnostics: ServiceDiagnostic[], reason = classifyFallback(diagnostics)): Promise<CoreOperationResult> {
    if (reason === undefined) return failed(diagnostics.map(toProblem));
    const workspaceRoot = path.resolve(await this.#options.workspaceRoot());
    const legacy = await this.#options.legacyStatus(workspaceRoot);
    const warning = fallbackWarning(reason, diagnostics);
    if (!legacy.ok) return failed([...diagnostics.map(toProblem), ...legacy.problems], [...legacy.warnings, warning]);
    return success(sanitizeLegacyStatus(legacy.data, reason), [...legacy.warnings, warning]);
  }

  async #searchFallback(
    request: CatalogSearchRequest,
    reason: FallbackReason | undefined,
    diagnostics: ServiceDiagnostic[],
  ): Promise<CoreOperationResult> {
    if (reason === undefined) return failed(diagnostics.map(toProblem));
    const workspaceRoot = path.resolve(await this.#options.workspaceRoot());
    const legacy = await this.#options.legacySearch(workspaceRoot, request);
    const warning = fallbackWarning(reason, diagnostics);
    if (!legacy.ok) return failed([...diagnostics.map(toProblem), ...legacy.problems], [...legacy.warnings, warning]);
    const data = asRecord(legacy.data) ?? {};
    return success({
      ...data,
      catalogService: { backend: 'legacy-fallback', fallback: true, reason },
    }, [...legacy.warnings, warning]);
  }
}

export interface CatalogServiceAppLifecycle {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}

/** Delay the first quit just long enough to flush protocol shutdown for this adapter's owned child. */
export const bindCatalogServiceLifecycle = (
  app: CatalogServiceAppLifecycle,
  adapter: Pick<CatalogServiceAdapter, 'stop'>,
): void => {
  let stopped = false;
  let stopping = false;
  app.on('before-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    void adapter.stop().finally(() => {
      stopped = true;
      app.quit();
    });
  });
};
