import {
  App,
  BrowserWindow,
  IpcMainInvokeEvent,
  dialog,
  ipcMain,
  shell,
} from 'electron';
import log from 'electron-log/main';
import path from 'node:path';

import {
  CREATE_GATE,
  CREATE_DECK,
  CREATE_STRUCTURE_DECK,
  DELETE_DECK,
  DELETE_GATE,
  DELETE_STRUCTURE_DECK,
  LOAD_SETTINGS,
  OPEN_DIRECTORY,
  OPEN_FILE,
  OPEN_LOG_FILE,
  OPEN_SETTINGS_FILE,
  READ_GATE,
  READ_GATES,
  READ_DECK,
  READ_DECKS,
  READ_STRUCTURE_DECK,
  READ_STRUCTURE_DECKS,
  SAVE_SETTINGS,
  SHOW_MESSAGE_BOX,
  UPDATE_DECK,
  UPDATE_GATE,
  UPDATE_STRUCTURE_DECK,
  CAMPAIGN_DEPLOY,
  CAMPAIGN_VALIDATE,
  CONTENT_COMPILE,
  CONTENT_DEPLOY,
  CONTENT_DIFF,
  CONTENT_INSPECT,
  CONTENT_RESOLVE,
  CONTENT_REVEAL_SOURCE,
  CONTENT_VALIDATE,
  CATALOG_REFRESH,
  CATALOG_SEARCH,
  CATALOG_STATUS,
  CONFIG_SET_GAME_ROOT,
  CONFIG_SET_SOURCE_ROOT,
  CONFIG_SHOW,
  CORE_INFO,
  DEPLOYMENT_INSPECT,
  DEPLOYMENT_LAUNCH,
  DEPLOYMENT_LIST,
  RUNTIME_FETCH,
  RUNTIME_STATUS,
  WORKSPACE_INIT,
  WORKSPACE_INSPECT,
} from '../common/channel';
import {
  CreateGateRequest,
  CreateGateResponse,
  DeckListResponse,
  DeckPathRequest,
  DeckReadResponse,
  DeckWriteRequest,
  CreateStructureDeckRequest,
  CreateStructureDeckResponse,
  ContentCompileRequest,
  ContentDeployRequest,
  ContentOperationRequest,
  ContentPathsRequest,
  ContentRevealSourceRequest,
  DeleteGateRequest,
  DeleteStructureDeckRequest,
  Gate,
  GateSummary,
  LoadSettingsResponse,
  ReadGateRequest,
  ReadGateResponse,
  ReadGatesResponse,
  ReadStructureDeckRequest,
  ReadStructureDeckResponse,
  ReadStructureDecksResponse,
  Settings,
  ShowMessageBoxRequest,
  StructureDeck,
  UpdateGateRequest,
  UpdateStructureDeckRequest,
} from '../common/type';
import {
  CONTRACT_VERSION,
  TOOL_VERSION,
  IR_COMPILER_VERSION,
  YGOMASTER_TARGET_CONTRACT_VERSION,
  createEmptyRegistry,
  discoverContentSnapshot,
  deleteDocument,
  deployCampaign,
  catalogSearch,
  catalogStatus,
  refreshCatalog,
  getWorkspacePaths,
  inspectDeployment,
  inspectWorkspace,
  initWorkspace,
  launchDeployment,
  listDeployments,
  listDocuments,
  loadCardResolver,
  loadManifest,
  readConfig,
  readRegistry,
  readDocument,
  runtimeFetch,
  runtimeStatus,
  result,
  resolveProjectRoot,
  updateConfig,
  validateCampaign,
  compileCampaignContentOperation,
  diffCampaignContent,
  exists,
  inspectCampaignContent,
  resolveCampaignContent,
  validateCampaignContentOperation,
  failure,
  problem,
  writeDocument,
} from '../core';
import type { CatalogRefreshRequest, CatalogSearchRequest, CoreOperationResult, CorePathRequest, CorePathsRequest } from '../common/type';
import { readJson, saveJson } from './utils';

const handleOpenDirectory = async (
  event: IpcMainInvokeEvent,
  path?: string,
) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    defaultPath: path || undefined,
    properties: ['openDirectory'],
  });
  if (canceled) return;

  return filePaths[0];
};

const handleOpenFile = async (event: IpcMainInvokeEvent, path?: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    defaultPath: path || undefined,
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled) return;

  return filePaths[0];
};

// const handleSaveFile = async (event: IpcMainInvokeEvent, path?: string) => {
//   const win = BrowserWindow.fromWebContents(event.sender);
//   if (!win) return;

//   const { canceled, filePath } = await dialog.showSaveDialog(win, {
//     defaultPath: path || undefined,
//     filters: [{ name: 'JSON', extensions: ['json'] }],
//   });
//   if (canceled) return;

//   return filePath;
// };

const handleShowMessageBox = async (
  event: IpcMainInvokeEvent,
  { message, detail, buttons, cancelId, type }: ShowMessageBoxRequest,
) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  const { response } = await dialog.showMessageBox(win, {
    message,
    detail,
    buttons,
    cancelId,
    type,
  });

  return response;
};

const handleSaveSettings =
  (app: App) => async (_event: IpcMainInvokeEvent, settings: Settings) => {
    await saveJson(
      path.resolve(app.getPath('userData'), 'settings.json'),
      settings,
      { pretty: true },
    );
  };

const handleLoadSettings =
  (app: App) => async (): Promise<LoadSettingsResponse> => {
    const settings = await readJson<Settings>(
      path.resolve(app.getPath('userData'), 'settings.json'),
    ).catch(() => undefined);

    const projectRoot = getCoreProjectRoot(app);
    const sourceRoot = (await readConfig(projectRoot)).sourceRoot || path.join(projectRoot, 'campaign', 'source');
    let paths: LoadSettingsResponse['paths'];
    try {
      const manifest = await loadManifest(sourceRoot);
      const workspace = getWorkspacePaths(projectRoot, sourceRoot, manifest);
      paths = { gatePath: workspace.gateRoot, deckPath: workspace.deckRoot, structureDeckPath: workspace.structureRoot };
    } catch {
      paths = { gatePath: path.join(sourceRoot, 'gate'), deckPath: path.join(sourceRoot, 'deck'), structureDeckPath: path.join(sourceRoot, 'structure') };
    }
    return { settings, paths };
  };

const handleOpenSettingsFile = (app: App) => async (): Promise<string> => {
  return await shell.openPath(
    path.resolve(app.getPath('userData'), 'settings.json'),
  );
};

const handleOpenLogFile = (app: App) => async (): Promise<string> => {
  return await shell.openPath(
    path.resolve(app.getPath('userData'), 'main.log'),
  );
};

const getCoreProjectRoot = (app: App) =>
  resolveProjectRoot(app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath());

const coreSourceRoot = async (app: App): Promise<string | undefined> =>
  (await readConfig(getCoreProjectRoot(app))).sourceRoot;

const requireCoreData = <T>(operation: CoreOperationResult<T>): T => {
  if (!operation.ok || operation.data === undefined) {
    throw new Error(operation.problems.map((entry) => `${entry.code}: ${entry.message}`).join('; ') || operation.exitName);
  }
  return operation.data;
};

const generatedIrWriteBlocked = <T = never>(): CoreOperationResult<T> => failure<T>([
  problem(
    'GENERATED_IR_READ_ONLY',
    'Generated Gate/Deck/Structure IR is compiler-owned and cannot be edited through the UI; edit campaign content instead.',
  ),
], 'COMMAND_FAILED');

const allowLegacyIrWrite = (request: { allowLegacyIrWrite?: boolean }): boolean => request.allowLegacyIrWrite === true;

const contentOptions = (app: App, request: ContentPathsRequest = {}) => ({
  projectRoot: getCoreProjectRoot(app),
  ...(request.contentRoot ? { contentRoot: request.contentRoot } : {}),
  ...(request.irRoot ? { irRoot: request.irRoot } : {}),
  ...(request.registryPath ? { registryPath: request.registryPath } : {}),
});

const handleReadGates = (app: App) => async (): Promise<ReadGatesResponse> => {
  const projectRoot = getCoreProjectRoot(app);
  const sourceRoot = await coreSourceRoot(app);
  const relativePaths = requireCoreData(await listDocuments(projectRoot, sourceRoot, 'gate'));
  const gates = await Promise.all(relativePaths.map(async (relativePath) => {
    const gate = requireCoreData(await readDocument(projectRoot, sourceRoot, 'gate', relativePath)) as unknown as Gate;
    return { id: gate.id, parent_id: gate.parent_id, name: gate.name, priority: gate.priority } satisfies GateSummary;
  }));
  return { gates: gates.sort((left, right) => left.id - right.id) };
};

const handleReadGate = (app: App) => async (_event: IpcMainInvokeEvent, { id }: ReadGateRequest): Promise<ReadGateResponse> => {
  const projectRoot = getCoreProjectRoot(app);
  const gate = requireCoreData(await readDocument(projectRoot, await coreSourceRoot(app), 'gate', `${id}.json`)) as unknown as Gate;
  return { gate };
};

const handleCreateGate = (app: App) => async (_event: IpcMainInvokeEvent, request: CreateGateRequest): Promise<CreateGateResponse | CoreOperationResult> => {
  if (!allowLegacyIrWrite(request)) return generatedIrWriteBlocked();
  const { gate } = request;
  const projectRoot = getCoreProjectRoot(app);
  requireCoreData(await writeDocument(projectRoot, await coreSourceRoot(app), 'gate', `${gate.id}.json`, gate as never, false));
  return { gate };
};

const handleUpdateGate = (app: App) => async (_event: IpcMainInvokeEvent, request: UpdateGateRequest): Promise<{ gate: Gate } | CoreOperationResult> => {
  if (!allowLegacyIrWrite(request)) return generatedIrWriteBlocked();
  const { gate, prevId } = request;
  const projectRoot = getCoreProjectRoot(app);
  const sourceRoot = await coreSourceRoot(app);
  if (prevId === gate.id) {
    requireCoreData(await writeDocument(projectRoot, sourceRoot, 'gate', `${gate.id}.json`, gate as never, true));
  } else {
    requireCoreData(await writeDocument(projectRoot, sourceRoot, 'gate', `${gate.id}.json`, gate as never, false));
    requireCoreData(await deleteDocument(projectRoot, sourceRoot, 'gate', `${prevId}.json`));
  }
  return { gate };
};

const handleDeleteGate = (app: App) => async (_event: IpcMainInvokeEvent, request: DeleteGateRequest): Promise<void | CoreOperationResult> => {
  if (!allowLegacyIrWrite(request)) return generatedIrWriteBlocked();
  const { id } = request;
  requireCoreData(await deleteDocument(getCoreProjectRoot(app), await coreSourceRoot(app), 'gate', `${id}.json`));
};

const handleReadStructureDecks = (app: App) => async (): Promise<ReadStructureDecksResponse> => {
  const projectRoot = getCoreProjectRoot(app);
  const sourceRoot = await coreSourceRoot(app);
  const relativePaths = requireCoreData(await listDocuments(projectRoot, sourceRoot, 'structure'));
  const structureDecks = await Promise.all(relativePaths.map(async (relativePath) =>
    requireCoreData(await readDocument(projectRoot, sourceRoot, 'structure', relativePath)) as unknown as StructureDeck,
  ));
  return { structureDecks: structureDecks.sort((left, right) => left.id - right.id) };
};

const handleReadStructureDeck = (app: App) => async (_event: IpcMainInvokeEvent, { id }: ReadStructureDeckRequest): Promise<ReadStructureDeckResponse> => {
  const structureDeck = requireCoreData(await readDocument(getCoreProjectRoot(app), await coreSourceRoot(app), 'structure', `${id}.json`)) as unknown as StructureDeck;
  return { structureDeck };
};

const handleCreateStructureDeck = (app: App) => async (_event: IpcMainInvokeEvent, request: CreateStructureDeckRequest): Promise<CreateStructureDeckResponse | CoreOperationResult> => {
  if (!allowLegacyIrWrite(request)) return generatedIrWriteBlocked();
  const { structureDeck } = request;
  requireCoreData(await writeDocument(getCoreProjectRoot(app), await coreSourceRoot(app), 'structure', `${structureDeck.id}.json`, structureDeck as never, false));
  return { structureDeck };
};

const handleUpdateStructureDeck = (app: App) => async (_event: IpcMainInvokeEvent, request: UpdateStructureDeckRequest): Promise<{ structureDeck: StructureDeck } | CoreOperationResult> => {
  if (!allowLegacyIrWrite(request)) return generatedIrWriteBlocked();
  const { structureDeck, prevId } = request;
  const projectRoot = getCoreProjectRoot(app);
  const sourceRoot = await coreSourceRoot(app);
  if (prevId === structureDeck.id) {
    requireCoreData(await writeDocument(projectRoot, sourceRoot, 'structure', `${structureDeck.id}.json`, structureDeck as never, true));
  } else {
    requireCoreData(await writeDocument(projectRoot, sourceRoot, 'structure', `${structureDeck.id}.json`, structureDeck as never, false));
    requireCoreData(await deleteDocument(projectRoot, sourceRoot, 'structure', `${prevId}.json`));
  }
  return { structureDeck };
};

const handleDeleteStructureDeck = (app: App) => async (_event: IpcMainInvokeEvent, request: DeleteStructureDeckRequest): Promise<void | CoreOperationResult> => {
  if (!allowLegacyIrWrite(request)) return generatedIrWriteBlocked();
  const { id } = request;
  requireCoreData(await deleteDocument(getCoreProjectRoot(app), await coreSourceRoot(app), 'structure', `${id}.json`));
};

const handleReadDecks = (app: App) => async (): Promise<CoreOperationResult<DeckListResponse>> => {
  const projectRoot = getCoreProjectRoot(app);
  const paths = requireCoreData(await listDocuments(projectRoot, await coreSourceRoot(app), 'deck'));
  return result({ paths });
};

const handleReadDeck = (app: App) => async (
  _event: IpcMainInvokeEvent,
  { path: relativePath }: DeckPathRequest,
): Promise<CoreOperationResult<DeckReadResponse>> => {
  const projectRoot = getCoreProjectRoot(app);
  const value = requireCoreData(await readDocument(projectRoot, await coreSourceRoot(app), 'deck', relativePath));
  return result({ path: relativePath, value });
};

const handleCreateDeck = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: DeckWriteRequest,
): Promise<CoreOperationResult<{ path: string }>> => {
  if (!allowLegacyIrWrite(request)) return generatedIrWriteBlocked<{ path: string }>();
  const { path: relativePath, value } = request;
  const projectRoot = getCoreProjectRoot(app);
  const data = requireCoreData(await writeDocument(projectRoot, await coreSourceRoot(app), 'deck', relativePath, value as never, false));
  return result(data);
};

const handleUpdateDeck = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: DeckWriteRequest,
): Promise<CoreOperationResult<{ path: string }>> => {
  if (!allowLegacyIrWrite(request)) return generatedIrWriteBlocked<{ path: string }>();
  const { path: relativePath, value } = request;
  const projectRoot = getCoreProjectRoot(app);
  const data = requireCoreData(await writeDocument(projectRoot, await coreSourceRoot(app), 'deck', relativePath, value as never, true));
  return result(data);
};

const handleDeleteDeck = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: DeckPathRequest,
): Promise<CoreOperationResult<{ trashPath: string }>> => {
  if (!allowLegacyIrWrite(request)) return generatedIrWriteBlocked<{ trashPath: string }>();
  const { path: relativePath } = request;
  const data = requireCoreData(await deleteDocument(getCoreProjectRoot(app), await coreSourceRoot(app), 'deck', relativePath));
  return result(data);
};

const coreLogger = {
  info: (...values: unknown[]) => log.info(...values),
  warn: (...values: unknown[]) => log.warn(...values),
  error: (...values: unknown[]) => log.error(...values),
};

const handleCoreInfo = async () => ({
  ok: true,
  exitCode: 0,
  exitName: 'SUCCESS',
  warnings: [],
  problems: [],
  data: { name: 'ygomaster-modding-tool', version: TOOL_VERSION, contractVersion: CONTRACT_VERSION, node: process.version },
});

const handleConfigShow = async (app: App) => {
  const projectRoot = getCoreProjectRoot(app);
  return {
    ok: true,
    exitCode: 0,
    exitName: 'SUCCESS',
    warnings: [],
    problems: [],
    data: { projectRoot, path: path.resolve(projectRoot, '.local', 'modding-tool.json'), config: await readConfig(projectRoot) },
  } satisfies CoreOperationResult;
};

const handleConfigSet = (app: App, field: 'gameRoot' | 'sourceRoot') => async (
  _event: IpcMainInvokeEvent,
  request: CorePathRequest,
) => updateConfig(getCoreProjectRoot(app), { [field]: request.path }).then((config) => result(config));

const handleWorkspaceInit = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: CorePathsRequest = {},
) => initWorkspace(getCoreProjectRoot(app), request.sourceRoot).then((workspace) => result(workspace));

const handleWorkspaceInspect = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: CorePathsRequest = {},
) => inspectWorkspace(getCoreProjectRoot(app), request.sourceRoot);

const handleCampaignValidate = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: CorePathsRequest = {},
) => validateCampaign(getCoreProjectRoot(app), request.sourceRoot);

const handleContentInspect = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: ContentOperationRequest = {},
) => inspectCampaignContent(contentOptions(app, request));

const handleContentResolve = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: ContentOperationRequest = {},
) => resolveCampaignContent(contentOptions(app, request));

const handleContentValidate = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: ContentOperationRequest = {},
) => validateCampaignContentOperation(contentOptions(app, request));

const handleContentDiff = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: ContentOperationRequest = {},
) => diffCampaignContent(contentOptions(app, request));

const handleContentRevealSource = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: ContentRevealSourceRequest,
) => {
  const projectRoot = getCoreProjectRoot(app);
  const contentRoot = path.resolve(request.contentRoot || path.join(projectRoot, 'campaign', 'content'));
  if (!request.sourcePath || path.isAbsolute(request.sourcePath)) {
    return failure([problem('CONTENT_SOURCE_PATH_INVALID', 'Authored source path must be relative to the content root')], 'PATH_ERROR');
  }
  const sourcePath = path.resolve(contentRoot, request.sourcePath);
  const relative = path.relative(contentRoot, sourcePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return failure([problem('CONTENT_SOURCE_PATH_ESCAPE', 'Authored source path escapes the content root', request.sourcePath)], 'PATH_ERROR');
  }
  shell.showItemInFolder(sourcePath);
  return result({ path: sourcePath });
};

const handleContentCompile = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: ContentCompileRequest = {},
) => {
  if (request.apply === true && request.confirmApply !== true) {
    return failure([
      problem('CONTENT_APPLY_CONFIRMATION_REQUIRED', 'Applied content compile requires explicit UI confirmation.'),
    ], 'USAGE_ERROR');
  }
  const { contentRoot, irRoot, registryPath } = request;
  return compileCampaignContentOperation({
    ...contentOptions(app, { contentRoot, irRoot, registryPath }),
    apply: request.apply === true,
    ...(request.expectedContentGeneration ? { expectedContentGeneration: request.expectedContentGeneration } : {}),
  });
};

const managedDeploy = async (app: App, request: ContentDeployRequest = {}): Promise<CoreOperationResult> => {
  const projectRoot = getCoreProjectRoot(app);
  const config = await readConfig(projectRoot);
  const gameRoot = request.gameRoot || config.gameRoot;
  if (!gameRoot) return failure([problem('GAME_ROOT_REQUIRED', 'Configure a game root before managed campaign deploy')], 'PATH_ERROR');

  const sourceRoot = path.resolve(request.sourceRoot || config.sourceRoot || path.join(projectRoot, 'campaign', 'source'));
  const generationPath = path.join(sourceRoot, 'generation.json');
  if (!(await exists(generationPath))) {
    if (request.allowLegacyIr === true) return deployCampaign({ projectRoot, sourceRoot, gameRoot, logger: coreLogger });
    return failure([
      problem('IR_GENERATION_METADATA_MISSING', 'Managed UI deploy requires compiler generation metadata; legacy deploy must be explicitly enabled.', 'generation.json'),
    ], 'COMMAND_FAILED');
  }

  const contentRoot = path.resolve(request.contentRoot || path.join(projectRoot, 'campaign', 'content'));
  const registryPath = path.resolve(request.registryPath || path.join(projectRoot, 'campaign', 'id-registry.json'));
  const snapshot = await discoverContentSnapshot(contentRoot, { projectRoot });
  if (!snapshot.ok || !snapshot.snapshot) return failure(snapshot.problems, 'COMMAND_FAILED');
  const resolver = await loadCardResolver(projectRoot);
  const registry = await exists(registryPath) ? await readRegistry(registryPath) : createEmptyRegistry();
  return deployCampaign({
    projectRoot,
    sourceRoot,
    gameRoot,
    logger: coreLogger,
    requireGenerationMetadata: true,
    expectedGeneration: {
      contentGeneration: snapshot.snapshot.contentGeneration,
      compilerVersion: IR_COMPILER_VERSION,
      catalogGeneration: resolver.catalogGeneration,
      idRegistryGeneration: registry.generation,
      targetContractVersion: YGOMASTER_TARGET_CONTRACT_VERSION,
    },
  });
};

const handleContentDeploy = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: ContentDeployRequest = {},
) => managedDeploy(app, request);

const handleCampaignDeploy = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: CorePathsRequest = {},
) => {
  return managedDeploy(app, request);
};

const handleRuntimeStatus = (app: App) => async () => runtimeStatus(getCoreProjectRoot(app));
const handleRuntimeFetch = (app: App) => async () => runtimeFetch(getCoreProjectRoot(app), { logger: coreLogger });
const handleCatalogStatus = (app: App) => async () => catalogStatus(getCoreProjectRoot(app));
const handleCatalogRefresh = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: CatalogRefreshRequest = {},
) => refreshCatalog(getCoreProjectRoot(app), { online: request.online === true, logger: coreLogger });
const handleCatalogSearch = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: CatalogSearchRequest,
) => catalogSearch(getCoreProjectRoot(app), request.query, request.limit);

const handleDeploymentList = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: CorePathsRequest = {},
) => {
  const config = await readConfig(getCoreProjectRoot(app));
  const gameRoot = request.gameRoot || config.gameRoot;
  if (!gameRoot) throw new Error('Game root is not configured');
  return listDeployments(gameRoot);
};

const handleDeploymentInspect = async (
  _event: IpcMainInvokeEvent,
  request: CorePathRequest,
) => inspectDeployment(request.path);

const handleDeploymentLaunch = async (
  _event: IpcMainInvokeEvent,
  request: CorePathRequest,
) => launchDeployment(request.path);

const handleWithLog: typeof ipcMain.handle = (chanel, handler) => {
  return ipcMain.handle(chanel, async (event, ...args) => {
    log.info('[REQUEST]', chanel, ...args);
    const result = await handler(event, ...args);
    log.info('[RESPONSE]', chanel, result);
    return result;
  });
};

/** Injectable handler surface used by the renderer boundary tests. */
export const createContentIpcHandlers = (app: App) => ({
  [CONTENT_INSPECT]: handleContentInspect(app),
  [CONTENT_RESOLVE]: handleContentResolve(app),
  [CONTENT_VALIDATE]: handleContentValidate(app),
  [CONTENT_COMPILE]: handleContentCompile(app),
  [CONTENT_DIFF]: handleContentDiff(app),
  [CONTENT_DEPLOY]: handleContentDeploy(app),
  [CONTENT_REVEAL_SOURCE]: handleContentRevealSource(app),
  [CREATE_DECK]: handleCreateDeck(app),
});

export const handleIpc = (app: App) => {
  handleWithLog(OPEN_DIRECTORY, handleOpenDirectory);
  handleWithLog(OPEN_FILE, handleOpenFile);
  handleWithLog(SHOW_MESSAGE_BOX, handleShowMessageBox);

  handleWithLog(SAVE_SETTINGS, handleSaveSettings(app));
  handleWithLog(LOAD_SETTINGS, handleLoadSettings(app));
  handleWithLog(OPEN_SETTINGS_FILE, handleOpenSettingsFile(app));
  handleWithLog(OPEN_LOG_FILE, handleOpenLogFile(app));

  handleWithLog(READ_GATES, handleReadGates(app));
  handleWithLog(READ_GATE, handleReadGate(app));
  handleWithLog(CREATE_GATE, handleCreateGate(app));
  handleWithLog(UPDATE_GATE, handleUpdateGate(app));
  handleWithLog(DELETE_GATE, handleDeleteGate(app));

  handleWithLog(READ_STRUCTURE_DECKS, handleReadStructureDecks(app));
  handleWithLog(READ_STRUCTURE_DECK, handleReadStructureDeck(app));
  handleWithLog(CREATE_STRUCTURE_DECK, handleCreateStructureDeck(app));
  handleWithLog(UPDATE_STRUCTURE_DECK, handleUpdateStructureDeck(app));
  handleWithLog(DELETE_STRUCTURE_DECK, handleDeleteStructureDeck(app));

  handleWithLog(READ_DECKS, handleReadDecks(app));
  handleWithLog(READ_DECK, handleReadDeck(app));
  handleWithLog(CREATE_DECK, handleCreateDeck(app));
  handleWithLog(UPDATE_DECK, handleUpdateDeck(app));
  handleWithLog(DELETE_DECK, handleDeleteDeck(app));

  handleWithLog(CORE_INFO, handleCoreInfo);
  handleWithLog(CONFIG_SHOW, () => handleConfigShow(app));
  handleWithLog(CONFIG_SET_GAME_ROOT, handleConfigSet(app, 'gameRoot'));
  handleWithLog(CONFIG_SET_SOURCE_ROOT, handleConfigSet(app, 'sourceRoot'));
  handleWithLog(WORKSPACE_INIT, handleWorkspaceInit(app));
  handleWithLog(WORKSPACE_INSPECT, handleWorkspaceInspect(app));
  handleWithLog(CAMPAIGN_VALIDATE, handleCampaignValidate(app));
  handleWithLog(CAMPAIGN_DEPLOY, handleCampaignDeploy(app));
  handleWithLog(CONTENT_INSPECT, handleContentInspect(app));
  handleWithLog(CONTENT_RESOLVE, handleContentResolve(app));
  handleWithLog(CONTENT_VALIDATE, handleContentValidate(app));
  handleWithLog(CONTENT_COMPILE, handleContentCompile(app));
  handleWithLog(CONTENT_DIFF, handleContentDiff(app));
  handleWithLog(CONTENT_DEPLOY, handleContentDeploy(app));
  handleWithLog(CONTENT_REVEAL_SOURCE, handleContentRevealSource(app));
  handleWithLog(RUNTIME_STATUS, handleRuntimeStatus(app));
  handleWithLog(RUNTIME_FETCH, handleRuntimeFetch(app));
  handleWithLog(CATALOG_STATUS, handleCatalogStatus(app));
  handleWithLog(CATALOG_REFRESH, handleCatalogRefresh(app));
  handleWithLog(CATALOG_SEARCH, handleCatalogSearch(app));
  handleWithLog(DEPLOYMENT_LIST, handleDeploymentList(app));
  handleWithLog(DEPLOYMENT_INSPECT, handleDeploymentInspect);
  handleWithLog(DEPLOYMENT_LAUNCH, handleDeploymentLaunch);
};
