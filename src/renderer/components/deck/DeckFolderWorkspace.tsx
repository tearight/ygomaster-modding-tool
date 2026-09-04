import {
  Body1,
  Button,
  Caption1,
  Field,
  Input,
  Select,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useMemo, useState } from 'react';

export type DeckFolderRole = 'cpu' | 'rental' | 'structure' | 'unknown';

export interface DeckFolderView {
  id: string;
  name: string;
  parent?: string;
  breadcrumb: string[];
  depth: number;
  directDeckCount: number;
  recursiveDeckCount: number;
  consumerGateIds: string[];
}

export interface DeckConsumerView {
  gateId?: string;
  chapterId?: string;
  kind?: string;
  sourcePath?: string;
}

export interface DeckWorkspaceDeck {
  key: string;
  reference: string;
  sourcePath: string;
  adapterPath: string;
  identityOrigin: 'explicit' | 'legacy-flat';
  sidecarSourcePath?: string;
  sidecarPath?: string;
  folderId?: string;
  folderStatus?: string;
  role: DeckFolderRole;
  consumers: DeckConsumerView[];
  deepLink?: string;
}

export interface DeckFolderCatalogView {
  sourcePath: string;
  exists: boolean;
  document: Record<string, unknown>;
}

export interface DeckWorkspaceGate {
  id: string;
  sourcePath: string;
  deckFolder?: string;
  scopedDeckCount?: number;
  scope?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DeckFolderWorkspaceModel {
  contentGeneration: string;
  catalog: DeckFolderCatalogView;
  folders: DeckFolderView[];
  decks: DeckWorkspaceDeck[];
  gates: DeckWorkspaceGate[];
  diagnostics: Array<{ code: string; message: string }>;
}

export interface DeckFolderBootstrapDraft {
  folderId: string;
  folderName: string;
  deckAssignments: Array<{ sourcePath: string; folderId: string }>;
  gateAssignments: Array<{ sourcePath: string; folderId: string }>;
}

export interface DeckFolderBootstrapRequest {
  catalog: {
    formatVersion: 1;
    kind: 'deck-folders';
    payload: { folders: Array<{ id: string; name: string }> };
  };
  deckAssignments: Array<{ sourcePath: string; folderId: string }>;
  gateAssignments: Array<{ sourcePath: string; folderId: string }>;
  expectedContentGeneration: string;
  confirmApply: boolean;
  previewSignature?: string;
}

export const deckFolderRecoveryKey = (workspace: string, entity: string, generation: string) =>
  `ygomaster:recovery:${encodeURIComponent(workspace)}:${encodeURIComponent(entity)}:${encodeURIComponent(generation)}`;

const stableFolderId = (name: string) => `deck-folder:${name.toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'campaign'}`;

/** Builds the exhaustive, path-based bootstrap mapping; no Deck or Gate is left virtually Unassigned. */
export const createDeckFolderBootstrapDraft = (workspace: DeckFolderWorkspaceModel, folderName: string): DeckFolderBootstrapDraft => {
  const name = folderName.trim();
  if (!name) throw new Error('Starter folder name is required.');
  const folderId = stableFolderId(name);
  const deckPaths = workspace.decks.map((deck) => deck.sourcePath);
  const gatePaths = workspace.gates.map((gate) => gate.sourcePath);
  if (deckPaths.some((sourcePath) => !sourcePath) || new Set(deckPaths).size !== deckPaths.length) throw new Error('Every discovered Deck must have one unique source path.');
  if (gatePaths.some((sourcePath) => !sourcePath) || new Set(gatePaths).size !== gatePaths.length) throw new Error('Every discovered Gate must have one unique source path.');
  return {
    folderId,
    folderName: name,
    deckAssignments: deckPaths.map((sourcePath) => ({ sourcePath, folderId })),
    gateAssignments: gatePaths.map((sourcePath) => ({ sourcePath, folderId })),
  };
};

export const buildDeckFolderBootstrapRequest = (
  draft: DeckFolderBootstrapDraft,
  expectedContentGeneration: string,
  confirmApply: boolean,
  previewSignature?: string,
): DeckFolderBootstrapRequest => {
  if (confirmApply && !previewSignature) throw new Error('A reviewed preview signature is required for atomic apply.');
  return {
    catalog: { formatVersion: 1, kind: 'deck-folders', payload: { folders: [{ id: draft.folderId, name: draft.folderName }] } },
    deckAssignments: draft.deckAssignments.map((assignment) => ({ ...assignment })),
    gateAssignments: draft.gateAssignments.map((assignment) => ({ ...assignment })),
    expectedContentGeneration,
    confirmApply,
    ...(previewSignature ? { previewSignature } : {}),
  };
};

export type DeckFolderChange = { action: 'create' | 'update' | 'delete'; id: string; name?: string; parent?: string };
const cloneJson = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const patchDeckFolderCatalog = (input: unknown, change: DeckFolderChange, existingIds: readonly string[] = []): Record<string, unknown> => {
  const document = Object.keys(asRecord(input)).length ? cloneJson(asRecord(input)) : { formatVersion: 1, kind: 'deck-folders', payload: { folders: [] } };
  const payload = asRecord(document.payload);
  const folders = (Array.isArray(payload.folders) ? payload.folders : []).map((folder) => cloneJson(asRecord(folder)));
  if (change.action === 'create') {
    const slug = (change.name || 'folder').toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'folder';
    let id = `deck-folder:${slug}`;
    let suffix = 2;
    while (existingIds.includes(id) || folders.some((folder) => folder.id === id)) { id = `deck-folder:${slug}-${suffix}`; suffix += 1; }
    folders.push({ id, name: change.name || slug, ...(change.parent ? { parent: change.parent } : {}) });
  } else if (change.action === 'update') {
    const index = folders.findIndex((folder) => folder.id === change.id);
    if (index < 0) throw new Error(`Deck folder does not exist: ${change.id}`);
    const current = folders[index] as Record<string, unknown>;
    folders[index] = { ...current, name: change.name || current.name, ...(change.parent ? { parent: change.parent } : { parent: undefined }) };
  } else {
    const index = folders.findIndex((folder) => folder.id === change.id);
    if (index < 0) throw new Error(`Deck folder does not exist: ${change.id}`);
    folders.splice(index, 1);
  }
  return { ...document, payload: { ...payload, folders } };
};

export const patchDeckFolderAssignment = (input: unknown, folderId?: string): Record<string, unknown> => {
  const document = cloneJson(asRecord(input));
  const existingMetadata = asRecord(document.metadata);
  const inheritedRole = typeof document.role === 'string' && existingMetadata.role === undefined ? document.role : undefined;
  const metadata = { ...existingMetadata, ...(inheritedRole ? { role: inheritedRole } : {}), ...(folderId ? { folder: folderId } : { folder: undefined }) };
  return { ...document, metadata };
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asText = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const asNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const asTexts = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

export const normalizeDeckFolderWorkspace = (value: unknown): DeckFolderWorkspaceModel => {
  const root = asRecord(value);
  const catalog = Object.keys(asRecord(root.catalog)).length ? asRecord(root.catalog) : asRecord(root.catalogState);
  const rawFolders = (Array.isArray(root.folders) ? root.folders : []).map((entry) => {
      const folder = asRecord(entry);
      const breadcrumb = asTexts(folder.breadcrumb);
      return {
        id: asText(folder.id),
        name: asText(folder.name, asText(folder.id)),
        ...(asText(folder.parent) ? { parent: asText(folder.parent) } : {}),
        breadcrumb,
        depth: asNumber(folder.depth),
        directDeckCount: asNumber(folder.directDeckCount),
        recursiveDeckCount: asNumber(folder.recursiveDeckCount),
        consumerGateIds: asTexts(folder.consumerGateIds),
      };
    }).filter((entry) => entry.id);
  const rawDecks = (Array.isArray(root.decks) ? root.decks : []).map((entry) => {
      const deck = asRecord(entry);
      const metadata = asRecord(deck.metadata);
      const role = asText(deck.role, asText(metadata.role, 'unknown'));
      return {
        key: asText(deck.key),
        reference: asText(deck.reference),
        sourcePath: asText(deck.sourcePath),
        adapterPath: asText(deck.adapterPath),
        identityOrigin: asText(deck.identityOrigin) === 'explicit' ? 'explicit' as const : 'legacy-flat' as const,
        sidecarSourcePath: asText(deck.sidecarSourcePath, asText(deck.sidecarPath)) || undefined,
        sidecarPath: asText(deck.sidecarPath, asText(deck.sidecarSourcePath)) || undefined,
        folderId: asText(deck.folderId, asText(metadata.folder)) || undefined,
        folderStatus: asText(deck.folderStatus) || undefined,
        role: ['cpu', 'rental', 'structure'].includes(role) ? role as DeckFolderRole : 'unknown',
        consumers: (Array.isArray(deck.consumers) ? deck.consumers : []).map((consumer) => asRecord(consumer) as DeckConsumerView),
        deepLink: asText(deck.deepLink) || undefined,
      };
    }).filter((entry) => entry.key && entry.reference && entry.sourcePath && entry.adapterPath);
  const rawGates = (Array.isArray(root.gates) ? root.gates : []).map((entry) => {
    const gate = asRecord(entry);
    const scope = asRecord(gate.scope);
    return {
      ...gate,
      id: asText(gate.id, asText(gate.gateId)),
      sourcePath: asText(gate.sourcePath),
      deckFolder: asText(gate.deckFolder, asText(gate.folderId, asText(scope.folderId))) || undefined,
      scopedDeckCount: asNumber(gate.scopedDeckCount) || asNumber(scope.deckCount),
      scope,
    } as DeckWorkspaceGate;
  });
  const byId = new Map(rawFolders.map((folder) => [folder.id, folder]));
  const breadcrumbFor = (folder: DeckFolderView): string[] => {
    const names: string[] = [folder.name];
    const seen = new Set([folder.id]);
    let parent = folder.parent ? byId.get(folder.parent) : undefined;
    while (parent && !seen.has(parent.id)) {
      names.unshift(parent.name);
      seen.add(parent.id);
      parent = parent.parent ? byId.get(parent.parent) : undefined;
    }
    return names;
  };
  const folders = rawFolders.map((folder) => {
    const descendants = descendantFolderIds(rawFolders, folder.id);
    const scopedDecks = rawDecks.filter((deck) => deck.folderId && descendants.has(deck.folderId));
    const consumerGateIds = [...new Set([
      ...folder.consumerGateIds,
      ...rawGates.filter((gate) => gate.deckFolder === folder.id).map((gate) => gate.id),
      ...scopedDecks.flatMap((deck) => deck.consumers.map((consumer) => consumer.gateId).filter((id): id is string => Boolean(id))),
    ])];
    const breadcrumb = folder.breadcrumb.length ? folder.breadcrumb : breadcrumbFor(folder);
    return {
      ...folder,
      breadcrumb,
      depth: folder.depth || Math.max(0, breadcrumb.length - 1),
      directDeckCount: folder.directDeckCount || rawDecks.filter((deck) => deck.folderId === folder.id).length,
      recursiveDeckCount: folder.recursiveDeckCount || scopedDecks.length,
      consumerGateIds,
    };
  });
  return {
    contentGeneration: asText(root.contentGeneration),
    catalog: {
      sourcePath: asText(catalog.sourcePath, 'decks/_folders.json'),
      exists: catalog.exists === true || asText(catalog.state) === 'present',
      document: asRecord(catalog.document),
    },
    folders,
    decks: rawDecks,
    gates: rawGates,
    diagnostics: (Array.isArray(root.diagnostics) ? root.diagnostics : []).map((entry) => {
      const diagnostic = asRecord(entry);
      return { code: asText(diagnostic.code), message: asText(diagnostic.message) };
    }),
  };
};

export const descendantFolderIds = (folders: readonly DeckFolderView[], folderId: string): Set<string> => {
  const ids = new Set<string>([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (folder.parent && ids.has(folder.parent) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
  return ids;
};

export const folderParentCandidates = (
  folders: readonly DeckFolderView[],
  selectedFolderId?: string,
): DeckFolderView[] => {
  const unavailable = selectedFolderId ? descendantFolderIds(folders, selectedFolderId) : new Set<string>();
  return folders.filter((folder) => !unavailable.has(folder.id));
};

export const decksForFolder = (
  workspace: DeckFolderWorkspaceModel,
  folderId: string,
  role: 'all' | 'cpu' | 'rental',
): DeckWorkspaceDeck[] => {
  const descendants = folderId === '*' || folderId === 'unassigned'
    ? undefined
    : descendantFolderIds(workspace.folders, folderId);
  return workspace.decks.filter((deck) => {
    const inFolder = folderId === '*'
      || (folderId === 'unassigned' ? !deck.folderId || deck.folderStatus === 'unassigned' : Boolean(deck.folderId && descendants?.has(deck.folderId)));
    const inRole = role === 'all' || deck.role === role;
    return inFolder && inRole;
  });
};

const useStyles = makeStyles({
  container: { display: 'grid', gap: tokens.spacingVerticalM },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  tree: { display: 'grid', gap: tokens.spacingVerticalXXS },
  treeButton: { justifyContent: 'space-between', width: '100%' },
  group: { marginTop: tokens.spacingVerticalS },
  deckList: { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: tokens.spacingVerticalXS },
  deckRow: { display: 'grid', gap: tokens.spacingVerticalXXS, padding: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  folderEditor: { display: 'grid', gap: tokens.spacingVerticalS },
});

interface DeckFolderWorkspaceProps {
  workspace: DeckFolderWorkspaceModel;
  selectedFolderId: string;
  selectedDeckKey?: string;
  busy?: boolean;
  onSelectFolder: (folderId: string) => void;
  onSelectDeck: (deck: DeckWorkspaceDeck) => void;
  onCreateDeck: () => void;
  onStageFolder: (change: DeckFolderChange) => void;
  onStageAssignment: (deck: DeckWorkspaceDeck, folderId?: string) => void;
  onStageBootstrap: (draft: DeckFolderBootstrapDraft) => void;
}

export const DeckFolderWorkspace = ({
  workspace,
  selectedFolderId,
  selectedDeckKey,
  busy,
  onSelectFolder,
  onSelectDeck,
  onCreateDeck,
  onStageFolder,
  onStageAssignment,
  onStageBootstrap,
}: DeckFolderWorkspaceProps) => {
  const classes = useStyles();
  const [role, setRole] = useState<'all' | 'cpu' | 'rental'>('all');
  const [folderName, setFolderName] = useState('New folder');
  const [parent, setParent] = useState('');
  const [starterFolderName, setStarterFolderName] = useState('Campaign decks');
  const decks = useMemo(() => decksForFolder(workspace, selectedFolderId, role), [role, selectedFolderId, workspace]);
  const selectedFolder = workspace.folders.find((folder) => folder.id === selectedFolderId);
  const selectedDeck = workspace.decks.find((deck) => deck.key === selectedDeckKey);
  const roots = workspace.folders.filter((folder) => !folder.parent);
  const sharedRoots = roots.filter((folder) => /shared/iu.test(`${folder.id} ${folder.name}`));
  const gateRoots = roots.filter((folder) => !sharedRoots.includes(folder));
  const orderedFolders = useMemo(() => workspace.folders.slice().sort((left, right) =>
    left.breadcrumb.join('\u0000').localeCompare(right.breadcrumb.join('\u0000'))
    || left.id.localeCompare(right.id)), [workspace.folders]);
  const renderFolder = (folder: DeckFolderView) => <Button
    key={folder.id}
    className={classes.treeButton}
    appearance={selectedFolderId === folder.id ? 'primary' : 'subtle'}
    style={{ paddingLeft: `${12 + folder.depth * 18}px` }}
    disabled={busy}
    onClick={() => { onSelectFolder(folder.id); setFolderName(folder.name); setParent(folder.parent || ''); }}
  >
    <span>{folder.name}</span><Caption1>{folder.recursiveDeckCount}</Caption1>
  </Button>;

  const selectedHasChildren = workspace.folders.some((folder) => folder.parent === selectedFolder?.id);
  const canDelete = Boolean(selectedFolder && !selectedFolder.recursiveDeckCount && !selectedFolder.consumerGateIds.length && !selectedHasChildren);
  const parentCandidates = folderParentCandidates(orderedFolders, selectedFolder?.id);

  if (!workspace.catalog.exists) {
    const starterFolderId = stableFolderId(starterFolderName);
    const deckPaths = workspace.decks.map((deck) => deck.sourcePath);
    const gatePaths = workspace.gates.map((gate) => gate.sourcePath);
    const exhaustivePaths = deckPaths.every(Boolean) && gatePaths.every(Boolean) && new Set(deckPaths).size === deckPaths.length && new Set(gatePaths).size === gatePaths.length;
    return <div className={classes.container}>
      <Body1>Initialize logical folders</Body1>
      <Caption1>The catalog is absent. Single-file folder writes are blocked because every current Deck and Gate must move into a valid authored scope together.</Caption1>
      <Field label="Starter folder name"><Input value={starterFolderName} onChange={(_, data) => setStarterFolderName(data.value)} /></Field>
      <Caption1>Stable folder ID: {starterFolderId}</Caption1>
      <Body1>Explicit Deck assignments ({workspace.decks.length})</Body1>
      <ul className={classes.deckList}>{workspace.decks.map((deck) => <li className={classes.deckRow} key={deck.sourcePath}><span>{deck.key} · role {deck.role}</span><Caption1>{deck.sourcePath} → {starterFolderId}</Caption1></li>)}</ul>
      <Body1>Explicit Gate scopes ({workspace.gates.length})</Body1>
      <ul className={classes.deckList}>{workspace.gates.map((gate) => <li className={classes.deckRow} key={gate.sourcePath}><span>{gate.id}</span><Caption1>{gate.sourcePath} → {starterFolderId}</Caption1></li>)}</ul>
      <Button
        appearance="primary"
        disabled={busy || !starterFolderName.trim() || !exhaustivePaths}
        onClick={() => onStageBootstrap(createDeckFolderBootstrapDraft(workspace, starterFolderName))}
      >Review atomic initialization</Button>
      {!exhaustivePaths && <Caption1>Initialization is blocked because every discovered Deck and Gate needs one unique source path.</Caption1>}
      <Caption1>Nothing is written until this complete candidate passes preview and you explicitly confirm apply. Unassigned is not a Gate scope.</Caption1>
    </div>;
  }

  return <div className={classes.container}>
    <div className={classes.actions}>
      <Button disabled={busy} onClick={onCreateDeck}>＋ Deck</Button>
      <Button disabled={busy || !folderName.trim()} onClick={() => onStageFolder({ action: 'create', id: '', name: folderName.trim(), ...(parent ? { parent } : {}) })}>＋ Folder</Button>
    </div>
    <Field label="Role filter"><Select value={role} onChange={(_, data) => setRole(data.value as 'all' | 'cpu' | 'rental')}><option value="all">All roles</option><option value="cpu">CPU-compatible</option><option value="rental">Rental-compatible</option></Select></Field>
    <nav className={classes.tree} aria-label="Logical Deck folder tree">
      <Button className={classes.treeButton} appearance={selectedFolderId === '*' ? 'primary' : 'subtle'} onClick={() => { onSelectFolder('*'); setParent(''); }}><span>All Decks</span><Caption1>{workspace.decks.length}</Caption1></Button>
      {gateRoots.length > 0 && <Caption1 className={classes.group}>Gate folders</Caption1>}
      {orderedFolders.filter((folder) => gateRoots.some((root) => descendantFolderIds(workspace.folders, root.id).has(folder.id))).map(renderFolder)}
      {sharedRoots.length > 0 && <Caption1 className={classes.group}>Shared</Caption1>}
      {orderedFolders.filter((folder) => sharedRoots.some((root) => descendantFolderIds(workspace.folders, root.id).has(folder.id))).map(renderFolder)}
      <Button className={classes.treeButton} appearance={selectedFolderId === 'unassigned' ? 'primary' : 'subtle'} onClick={() => { onSelectFolder('unassigned'); setParent(''); }}><span>Unassigned</span><Caption1>{workspace.decks.filter((deck) => !deck.folderId || deck.folderStatus === 'unassigned').length}</Caption1></Button>
    </nav>
    <div className={classes.folderEditor}>
      <Field label="Folder name"><Input value={folderName} onChange={(_, data) => setFolderName(data.value)} /></Field>
      <Field label="Parent folder"><Select value={parent} onChange={(_, data) => setParent(data.value)}><option value="">Root</option>{parentCandidates.map((folder) => <option key={folder.id} value={folder.id}>{folder.breadcrumb.join(' / ')}</option>)}</Select></Field>
      <div className={classes.actions}>
        <Button disabled={busy || !selectedFolder || !folderName.trim()} onClick={() => onStageFolder({ action: 'update', id: selectedFolder?.id || '', name: folderName.trim(), ...(parent ? { parent } : {}) })}>Review rename/move</Button>
        <Button disabled={busy || !canDelete} onClick={() => onStageFolder({ action: 'delete', id: selectedFolder?.id || '' })}>Review delete</Button>
      </div>
      {selectedFolder && !canDelete && <Caption1>Delete is blocked while the folder has Decks, child folders, or consumer Gates.</Caption1>}
    </div>
    <Body1>{selectedFolder ? selectedFolder.breadcrumb.join(' / ') : selectedFolderId === 'unassigned' ? 'Unassigned' : 'All Decks'} · {decks.length} Decks</Body1>
    <ul className={classes.deckList}>{decks.map((deck) => <li className={classes.deckRow} key={deck.key}>
      <Button appearance={deck.key === selectedDeckKey ? 'primary' : 'subtle'} onClick={() => onSelectDeck(deck)}>{deck.key}</Button>
      <Caption1>{deck.role} · {deck.folderId ? workspace.folders.find((folder) => folder.id === deck.folderId)?.breadcrumb.join(' / ') || deck.folderId : 'Unassigned'}</Caption1>
      <Caption1>Source: {deck.sourcePath} · adapter: {deck.adapterPath}</Caption1>
      <Caption1>Used by: {deck.consumers.length ? deck.consumers.map((consumer) => [consumer.gateId, consumer.chapterId].filter(Boolean).join(' / ')).join(', ') : 'none'}</Caption1>
    </li>)}</ul>
    {selectedDeck && <Field label={`Logical folder assignment · stable key ${selectedDeck.key}`}><Select value={selectedDeck.folderId || 'unassigned'} onChange={(_, data) => onStageAssignment(selectedDeck, data.value === 'unassigned' ? undefined : data.value)}><option value="unassigned">Unassigned</option>{workspace.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.breadcrumb.join(' / ')}</option>)}</Select></Field>}
  </div>;
};
