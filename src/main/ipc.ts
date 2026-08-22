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
  deleteDocument,
  deployCampaign,
  getWorkspacePaths,
  inspectDeployment,
  inspectWorkspace,
  initWorkspace,
  launchDeployment,
  listDeployments,
  listDocuments,
  loadManifest,
  readConfig,
  readDocument,
  runtimeFetch,
  runtimeStatus,
  result,
  resolveProjectRoot,
  updateConfig,
  validateCampaign,
  writeDocument,
} from '../core';
import type { CoreOperationResult, CorePathRequest, CorePathsRequest } from '../common/type';
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

const handleCreateGate = (app: App) => async (_event: IpcMainInvokeEvent, { gate }: CreateGateRequest): Promise<CreateGateResponse> => {
  const projectRoot = getCoreProjectRoot(app);
  requireCoreData(await writeDocument(projectRoot, await coreSourceRoot(app), 'gate', `${gate.id}.json`, gate as never, false));
  return { gate };
};

const handleUpdateGate = (app: App) => async (_event: IpcMainInvokeEvent, { gate, prevId }: UpdateGateRequest): Promise<{ gate: Gate }> => {
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

const handleDeleteGate = (app: App) => async (_event: IpcMainInvokeEvent, { id }: DeleteGateRequest): Promise<void> => {
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

const handleCreateStructureDeck = (app: App) => async (_event: IpcMainInvokeEvent, { structureDeck }: CreateStructureDeckRequest): Promise<CreateStructureDeckResponse> => {
  requireCoreData(await writeDocument(getCoreProjectRoot(app), await coreSourceRoot(app), 'structure', `${structureDeck.id}.json`, structureDeck as never, false));
  return { structureDeck };
};

const handleUpdateStructureDeck = (app: App) => async (_event: IpcMainInvokeEvent, { structureDeck, prevId }: UpdateStructureDeckRequest): Promise<{ structureDeck: StructureDeck }> => {
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

const handleDeleteStructureDeck = (app: App) => async (_event: IpcMainInvokeEvent, { id }: DeleteStructureDeckRequest): Promise<void> => {
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
  { path: relativePath, value }: DeckWriteRequest,
): Promise<CoreOperationResult<{ path: string }>> => {
  const projectRoot = getCoreProjectRoot(app);
  const data = requireCoreData(await writeDocument(projectRoot, await coreSourceRoot(app), 'deck', relativePath, value as never, false));
  return result(data);
};

const handleUpdateDeck = (app: App) => async (
  _event: IpcMainInvokeEvent,
  { path: relativePath, value }: DeckWriteRequest,
): Promise<CoreOperationResult<{ path: string }>> => {
  const projectRoot = getCoreProjectRoot(app);
  const data = requireCoreData(await writeDocument(projectRoot, await coreSourceRoot(app), 'deck', relativePath, value as never, true));
  return result(data);
};

const handleDeleteDeck = (app: App) => async (
  _event: IpcMainInvokeEvent,
  { path: relativePath }: DeckPathRequest,
): Promise<CoreOperationResult<{ trashPath: string }>> => {
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

const handleCampaignDeploy = (app: App) => async (
  _event: IpcMainInvokeEvent,
  request: CorePathsRequest = {},
) => {
  const projectRoot = getCoreProjectRoot(app);
  const config = await readConfig(projectRoot);
  const gameRoot = request.gameRoot || config.gameRoot;
  if (!gameRoot) throw new Error('Game root is not configured');
  return deployCampaign({ projectRoot, sourceRoot: request.sourceRoot || config.sourceRoot, gameRoot, logger: coreLogger });
};

const handleRuntimeStatus = (app: App) => async () => runtimeStatus(getCoreProjectRoot(app));
const handleRuntimeFetch = (app: App) => async () => runtimeFetch(getCoreProjectRoot(app), { logger: coreLogger });

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
  handleWithLog(RUNTIME_STATUS, handleRuntimeStatus(app));
  handleWithLog(RUNTIME_FETCH, handleRuntimeFetch(app));
  handleWithLog(DEPLOYMENT_LIST, handleDeploymentList(app));
  handleWithLog(DEPLOYMENT_INSPECT, handleDeploymentInspect);
  handleWithLog(DEPLOYMENT_LAUNCH, handleDeploymentLaunch);
};
