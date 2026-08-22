/// <reference types="vite/client" />
import {
  CreateGateRequest,
  CreateGateResponse,
  CreateStructureDeckRequest,
  CreateStructureDeckResponse,
  DeckPathRequest,
  DeckWriteRequest,
  DeleteGateRequest,
  DeleteStructureDeckRequest,
  LoadSettingsResponse,
  ReadGateRequest,
  ReadGateResponse,
  ReadGatesRequest,
  ReadGatesResponse,
  ReadStructureDeckRequest,
  ReadStructureDeckResponse,
  ReadStructureDecksRequest,
  ReadStructureDecksResponse,
  Settings,
  ShowMessageBoxRequest,
  UpdateGateRequest,
  UpdateGateResponse,
  UpdateStructureDeckRequest,
  UpdateStructureDeckResponse,
  CoreOperationResult,
  CorePathRequest,
  CorePathsRequest,
  CatalogRefreshRequest,
  CatalogSearchRequest,
} from '../common/type';

export interface ElectronAPI {
  openDirectory: (path?: string) => Promise<string | undefined>;
  openFile: (path?: string) => Promise<string | undefined>;
  showMessageBox: (request: ShowMessageBoxRequest) => Promise<number>;
  saveSettings: (settings: Settings) => Promise<void>;
  loadSettings: () => Promise<LoadSettingsResponse>;
  openSettingsFile: () => Promise<string>;
  openLogFile: () => Promise<string>;
  readGates: (request: ReadGatesRequest) => Promise<ReadGatesResponse>;
  readGate: (request: ReadGateRequest) => Promise<ReadGateResponse>;
  createGate: (request: CreateGateRequest) => Promise<CreateGateResponse>;
  updateGate: (request: UpdateGateRequest) => Promise<UpdateGateResponse>;
  deleteGate: (request: DeleteGateRequest) => Promise<void>;
  readStructureDecks: (
    request: ReadStructureDecksRequest,
  ) => Promise<ReadStructureDecksResponse>;
  readStructureDeck: (
    request: ReadStructureDeckRequest,
  ) => Promise<ReadStructureDeckResponse>;
  createStructureDeck: (
    request: CreateStructureDeckRequest,
  ) => Promise<CreateStructureDeckResponse>;
  updateStructureDeck: (
    request: UpdateStructureDeckRequest,
  ) => Promise<UpdateStructureDeckResponse>;
  deleteStructureDeck: (request: DeleteStructureDeckRequest) => Promise<void>;
  readDecks: () => Promise<CoreOperationResult>;
  readDeck: (request: DeckPathRequest) => Promise<CoreOperationResult>;
  createDeck: (request: DeckWriteRequest) => Promise<CoreOperationResult>;
  updateDeck: (request: DeckWriteRequest) => Promise<CoreOperationResult>;
  deleteDeck: (request: DeckPathRequest) => Promise<CoreOperationResult>;
  coreInfo: () => Promise<CoreOperationResult>;
  configShow: () => Promise<CoreOperationResult>;
  configSetGameRoot: (request: CorePathRequest) => Promise<CoreOperationResult>;
  configSetSourceRoot: (request: CorePathRequest) => Promise<CoreOperationResult>;
  workspaceInit: (request?: CorePathsRequest) => Promise<CoreOperationResult>;
  workspaceInspect: (request?: CorePathsRequest) => Promise<CoreOperationResult>;
  campaignValidate: (request?: CorePathsRequest) => Promise<CoreOperationResult>;
  campaignDeploy: (request?: CorePathsRequest) => Promise<CoreOperationResult>;
  runtimeStatus: () => Promise<CoreOperationResult>;
  runtimeFetch: () => Promise<CoreOperationResult>;
  catalogStatus: () => Promise<CoreOperationResult>;
  catalogRefresh: (request?: CatalogRefreshRequest) => Promise<CoreOperationResult>;
  catalogSearch: (request: CatalogSearchRequest) => Promise<CoreOperationResult>;
  deploymentList: (request?: CorePathsRequest) => Promise<CoreOperationResult>;
  deploymentInspect: (request: CorePathRequest) => Promise<CoreOperationResult>;
  deploymentLaunch: (request: CorePathRequest) => Promise<CoreOperationResult>;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
