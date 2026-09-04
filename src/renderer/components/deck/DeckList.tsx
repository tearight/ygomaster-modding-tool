import {
  Body1,
  Button,
  Caption1,
  Card,
  CardFooter,
  CardHeader,
  Field,
  Input,
  Select,
  Textarea,
  Title1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  DECK_AUTHORING_SECTIONS,
  DeckAuthoringSection,
  DeckAuthoringSections,
  deckAuthoringLineLocation,
  emptyDeckAuthoringSections,
  insertDeckAuthoringCard,
  parseDeckAuthoringSections,
} from '../../../common/deck-authoring';
import type { CoreOperationProblem, CoreOperationResult } from '../../../common/type';
import {
  DeckFolderWorkspace,
  DeckFolderChange,
  DeckFolderBootstrapDraft,
  DeckFolderBootstrapRequest,
  DeckFolderWorkspaceModel,
  DeckWorkspaceDeck,
  buildDeckFolderBootstrapRequest,
  deckFolderRecoveryKey,
  normalizeDeckFolderWorkspace,
  patchDeckFolderAssignment,
  patchDeckFolderCatalog,
} from './DeckFolderWorkspace';

const useStyles = makeStyles({
  container: { height: '100vh', overflowY: 'auto', padding: tokens.spacingHorizontalL },
  title: { marginBottom: tokens.spacingVerticalL },
  layout: { display: 'grid', gridTemplateColumns: 'minmax(320px, 0.48fr) minmax(520px, 1fr)', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  card: { marginBottom: tokens.spacingVerticalL },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  listItem: { display: 'block', width: '100%', marginBottom: tokens.spacingVerticalXS, textAlign: 'left' },
  sections: { display: 'grid', gap: tokens.spacingVerticalM },
  editor: { minHeight: '150px', fontFamily: 'Consolas, monospace' },
  search: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'end' },
  searchInput: { flex: '1 1 320px' },
  results: { maxHeight: '260px', overflowY: 'auto' },
  result: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  grow: { flex: '1 1 auto' },
  output: { whiteSpace: 'pre-wrap', overflowX: 'auto' },
});

const record = (value: CoreOperationResult | undefined): Record<string, unknown> =>
  value?.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data as Record<string, unknown> : {};

interface CatalogCardResult {
  id: number;
  names?: { display?: string; korean?: string; english?: string };
  autoTags?: string[];
}

interface DeckResolutionPreview {
  line: number;
  section: DeckAuthoringSection;
  count: number;
  sourceName: string;
  state: string;
  runtimeId?: number;
  candidates?: Array<{ runtimeId: number; name: string }>;
  suggestions?: Array<{ runtimeId: number; name: string }>;
}

const catalogCards = (operation: CoreOperationResult): CatalogCardResult[] => {
  const cards = record(operation).cards;
  return Array.isArray(cards) ? cards.filter((entry): entry is CatalogCardResult => Boolean(entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'number')) : [];
};

const diagnosticKey = (entry: CoreOperationProblem) => `${entry.code}:${entry.sourcePath || entry.path || ''}:${entry.line || entry.sourceSpan?.line || 0}:${entry.message}`;

interface PendingDocumentMutation { sourcePath: string; operation: 'create' | 'update'; content: string; label: string }

type DeckFolderBootstrapElectron = typeof window.electron & {
  contentDeckFoldersBootstrap?: (request: DeckFolderBootstrapRequest) => Promise<CoreOperationResult>;
};

/** Authors only campaign/content/decks/*.decklist. Runtime IDs and generated IR are read-only previews. */
export const DeckList = () => {
  const classes = useStyles();
  const [searchParams, setSearchParams] = useSearchParams();
  const [documents, setDocuments] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState<DeckFolderWorkspaceModel>(() => normalizeDeckFolderWorkspace({}));
  const [workspaceIdentity, setWorkspaceIdentity] = useState('campaign-workspace');
  const [selectedFolderId, setSelectedFolderId] = useState('*');
  const [sourcePath, setSourcePath] = useState('');
  const [deckKey, setDeckKey] = useState('');
  const [sections, setSections] = useState<DeckAuthoringSections>(emptyDeckAuthoringSections);
  const [generation, setGeneration] = useState('');
  const [deckPreview, setDeckPreview] = useState<CoreOperationResult>();
  const [validationPreview, setValidationPreview] = useState<CoreOperationResult>();
  const [previewSignature, setPreviewSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogSection, setCatalogSection] = useState<DeckAuthoringSection>('main');
  const [cards, setCards] = useState<CatalogCardResult[]>([]);
  const [pendingMutation, setPendingMutation] = useState<PendingDocumentMutation>();
  const [pendingResult, setPendingResult] = useState<CoreOperationResult>();
  const [pendingPreviewSignature, setPendingPreviewSignature] = useState('');
  const [bootstrapDraft, setBootstrapDraft] = useState<DeckFolderBootstrapDraft>();
  const [bootstrapResult, setBootstrapResult] = useState<CoreOperationResult>();
  const [bootstrapPreviewSignature, setBootstrapPreviewSignature] = useState('');
  const [bootstrapReviewedDraftSignature, setBootstrapReviewedDraftSignature] = useState('');

  const signature = useMemo(() => JSON.stringify({ sourcePath, sections, generation }), [generation, sections, sourcePath]);
  const canonicalContent = String(record(deckPreview).canonicalContent || '');
  const resolutions = Array.isArray(record(deckPreview).resolutions) ? record(deckPreview).resolutions as DeckResolutionPreview[] : [];
  const compiledRuntimeIds = record(deckPreview).compiledRuntimeIds;
  const canSave = Boolean(sourcePath && generation && deckPreview?.ok && validationPreview?.ok && previewSignature === signature && canonicalContent);
  const pendingRecoveryKey = useMemo(
    () => deckFolderRecoveryKey(workspaceIdentity, 'deck-folder-workspace', generation),
    [generation, workspaceIdentity],
  );

  const read = useCallback(async (path: string) => {
    setBusy(true);
    try {
      const operation = await window.electron.contentDocumentRead({ sourcePath: path });
      if (!operation.ok) { setMessage(operation.problems.map((entry) => `${entry.code}: ${entry.message}`).join('\n')); return; }
      const values = record(operation);
      setSourcePath(path);
      const nextKey = workspace.decks.find((deck) => deck.sourcePath === path)?.key || deckKey;
      setDeckKey(nextKey);
      if (nextKey) setSearchParams({ deck: nextKey }, { replace: true });
      try { setSections(parseDeckAuthoringSections(String(values.content || ''))); }
      catch (error) {
        setSections(emptyDeckAuthoringSections()); setDeckPreview(undefined); setValidationPreview(undefined); setPreviewSignature('');
        setMessage(`Decklist was not loaded into the structured editor because normalization would lose invalid source: ${String(error)}`);
        return;
      }
      if (typeof values.contentGeneration === 'string') setGeneration(values.contentGeneration);
      setDeckPreview(undefined); setValidationPreview(undefined); setPreviewSignature('');
      setMessage(`Loaded ${path}`);
    } finally { setBusy(false); }
  }, [deckKey, setSearchParams, workspace.decks]);

  const refresh = useCallback(async () => {
    const [operation, status] = await Promise.all([
      window.electron.contentDeckWorkspaceRead(),
      window.electron.campaignWorkspaceStatus(),
    ]);
    if (!operation.ok) { setMessage(operation.problems.map((entry) => `${entry.code}: ${entry.message}`).join('\n')); return; }
    const nextWorkspace = normalizeDeckFolderWorkspace(operation.data);
    const statusData = record(status);
    setWorkspace(nextWorkspace);
    setDocuments(nextWorkspace.decks.map((deck) => deck.sourcePath));
    setGeneration(nextWorkspace.contentGeneration);
    if (typeof statusData.workspaceRoot === 'string') setWorkspaceIdentity(statusData.workspaceRoot);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const requested = searchParams.get('deck');
    const requestedDeck = requested ? workspace.decks.find((deck) => deck.key === requested || deck.reference === requested) : undefined;
    if (requestedDeck && requestedDeck.sourcePath !== sourcePath) void read(requestedDeck.sourcePath);
  }, [read, searchParams, sourcePath, workspace.decks]);
  useEffect(() => {
    if (!generation || !workspaceIdentity) return;
    try {
      const saved = window.localStorage.getItem(pendingRecoveryKey);
      setPendingMutation(saved ? JSON.parse(saved) as PendingDocumentMutation : undefined);
      setPendingResult(undefined);
      setPendingPreviewSignature('');
    } catch { /* invalid recovery data is ignored and never applied */ }
  }, [generation, pendingRecoveryKey, workspaceIdentity]);
  const startNew = () => {
    setDeckKey('new-deck'); setSourcePath('decks/new-deck.decklist'); setSections(emptyDeckAuthoringSections());
    setDeckPreview(undefined); setValidationPreview(undefined); setPreviewSignature(''); setMessage('New authored decklist');
  };

  const preview = useCallback(async () => {
    if (!sourcePath.startsWith('decks/') || !sourcePath.endsWith('.decklist')) { setMessage('Use a decks/*.decklist path inside campaign/content.'); return; }
    setBusy(true);
    try {
      const resolved = await window.electron.contentDeckPreview({ sourcePath, sections, expectedContentGeneration: generation });
      setDeckPreview(resolved); setValidationPreview(undefined); setPreviewSignature('');
      if (!resolved.ok) { setMessage('Resolve the line-linked Deck problems before saving.'); return; }
      const content = String(record(resolved).canonicalContent || '');
      const validated = await window.electron.contentDocumentMutate({
        sourcePath,
        operation: documents.includes(sourcePath) ? 'update' : 'create',
        content,
        expectedContentGeneration: generation,
        confirmApply: false,
      });
      setValidationPreview(validated);
      if (validated.ok) { setPreviewSignature(signature); setMessage('Deck and campaign validation passed. Review the runtime-ID preview, then confirm save.'); }
      else setMessage('Campaign or regulation validation blocked this save.');
    } finally { setBusy(false); }
  }, [documents, generation, sections, signature, sourcePath]);

  const save = useCallback(async () => {
    if (!canSave) { setMessage('Run a successful current preview before confirming save.'); return; }
    setBusy(true);
    try {
      const operation = await window.electron.contentDocumentMutate({
        sourcePath,
        operation: documents.includes(sourcePath) ? 'update' : 'create',
        content: canonicalContent,
        expectedContentGeneration: generation,
        confirmApply: true,
      });
      if (!operation.ok) { setValidationPreview(operation); setMessage('Save was rejected; reload if the generation became stale.'); return; }
      await refresh(); await read(sourcePath); setMessage(`Saved canonical authored decklist ${sourcePath}`);
    } finally { setBusy(false); }
  }, [canSave, canonicalContent, documents, generation, read, refresh, sourcePath]);

  const search = useCallback(async () => {
    setBusy(true);
    try {
      const operation = await window.electron.catalogSearch({ query: catalogQuery, limit: 50 });
      setCards(operation.ok ? catalogCards(operation) : []);
      setMessage(operation.ok ? `${record(operation).total || 0} catalog matches` : operation.problems.map((entry) => entry.message).join('\n'));
    } finally { setBusy(false); }
  }, [catalogQuery]);

  const stageDocument = useCallback((mutation: PendingDocumentMutation) => {
    setPendingMutation(mutation);
    setPendingResult(undefined);
    setPendingPreviewSignature('');
    setMessage(`${mutation.label} is a recovery candidate. Review it before applying to campaign/content.`);
    try { window.localStorage.setItem(pendingRecoveryKey, JSON.stringify(mutation)); } catch { /* recovery remains in memory */ }
  }, [pendingRecoveryKey]);

  const stageFolder = useCallback(async (change: DeckFolderChange) => {
    setBusy(true);
    try {
      let original: unknown = workspace.catalog.document;
      if (workspace.catalog.exists) {
        const readResult = await window.electron.contentDocumentRead({ sourcePath: workspace.catalog.sourcePath });
        if (!readResult.ok) { setPendingResult(readResult); return; }
        original = JSON.parse(String(record(readResult).content || '{}')) as unknown;
      }
      const next = patchDeckFolderCatalog(original, change, workspace.folders.map((folder) => folder.id));
      stageDocument({
        sourcePath: workspace.catalog.sourcePath,
        operation: workspace.catalog.exists ? 'update' : 'create',
        content: `${JSON.stringify(next, null, 2)}\n`,
        label: change.action === 'delete' ? 'Folder delete' : change.action === 'update' ? 'Folder rename/move' : 'Folder create',
      });
    } catch (error) {
      setMessage(String(error));
    } finally { setBusy(false); }
  }, [stageDocument, workspace]);

  const stageAssignment = useCallback(async (deck: DeckWorkspaceDeck, folderId?: string) => {
    setBusy(true);
    try {
      const sidecarPath = deck.sidecarSourcePath || deck.sidecarPath || deck.sourcePath.replace(/\.decklist$/iu, '.json');
      let original: unknown = {};
      const exists = Boolean(deck.sidecarSourcePath || deck.sidecarPath);
      if (exists) {
        const readResult = await window.electron.contentDocumentRead({ sourcePath: sidecarPath });
        if (!readResult.ok) { setPendingResult(readResult); return; }
        original = JSON.parse(String(record(readResult).content || '{}')) as unknown;
      }
      const next = patchDeckFolderAssignment(original, folderId);
      stageDocument({ sourcePath: sidecarPath, operation: exists ? 'update' : 'create', content: `${JSON.stringify(next, null, 2)}\n`, label: `Move ${deck.key} without changing its stable key` });
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }, [stageDocument]);

  const pendingSignature = useMemo(() => pendingMutation ? JSON.stringify([generation, pendingMutation]) : '', [generation, pendingMutation]);
  const discardPending = useCallback(() => {
    try { window.localStorage.removeItem(pendingRecoveryKey); } catch { /* no-op */ }
    setPendingMutation(undefined);
    setPendingResult(undefined);
    setPendingPreviewSignature('');
    setMessage('Discarded the logical-folder recovery candidate. Authored content was unchanged.');
  }, [pendingRecoveryKey]);
  const reviewPending = useCallback(async (confirmApply: boolean) => {
    if (!workspace.catalog.exists) { setMessage('Initialize logical folders atomically before reviewing any single-document folder mutation.'); return; }
    if (!pendingMutation || (confirmApply && pendingPreviewSignature !== pendingSignature)) return;
    setBusy(true);
    try {
      const next = await window.electron.contentDocumentMutate({ ...pendingMutation, expectedContentGeneration: generation, confirmApply });
      setPendingResult(next);
      if (!next.ok) { setPendingPreviewSignature(''); setMessage('Folder candidate validation failed; authored content was not changed.'); return; }
      if (!confirmApply) { setPendingPreviewSignature(pendingSignature); setMessage('Folder candidate validates. Explicit apply is now available.'); return; }
      try { window.localStorage.removeItem(pendingRecoveryKey); } catch { /* no-op */ }
      setPendingMutation(undefined); setPendingPreviewSignature('');
      setMessage('Applied the reviewed authoring metadata candidate. Deck symbolic keys and consumer references were unchanged.');
      await refresh();
    } finally { setBusy(false); }
  }, [generation, pendingMutation, pendingPreviewSignature, pendingRecoveryKey, pendingSignature, refresh, workspace.catalog.exists]);

  const bootstrapDraftSignature = useMemo(() => bootstrapDraft ? JSON.stringify([generation, bootstrapDraft]) : '', [bootstrapDraft, generation]);
  const stageBootstrap = useCallback((draft: DeckFolderBootstrapDraft) => {
    setBootstrapDraft(draft);
    setBootstrapResult(undefined);
    setBootstrapPreviewSignature('');
    setBootstrapReviewedDraftSignature('');
    setMessage('Atomic logical-folder initialization candidate staged. Review every Deck assignment and Gate scope, then preview.');
  }, []);
  const reviewBootstrap = useCallback(async (confirmApply: boolean) => {
    if (!bootstrapDraft || workspace.catalog.exists) return;
    if (confirmApply && (!bootstrapPreviewSignature || bootstrapReviewedDraftSignature !== bootstrapDraftSignature)) {
      setMessage('Preview this exact initialization candidate before confirming apply.');
      return;
    }
    const bootstrap = (window.electron as DeckFolderBootstrapElectron).contentDeckFoldersBootstrap;
    if (!bootstrap) { setMessage('Atomic Deck folder initialization is not available in this application build.'); return; }
    setBusy(true);
    try {
      const request = buildDeckFolderBootstrapRequest(bootstrapDraft, generation, confirmApply, confirmApply ? bootstrapPreviewSignature : undefined);
      const next = await bootstrap(request);
      setBootstrapResult(next);
      if (!next.ok) {
        setBootstrapPreviewSignature('');
        setBootstrapReviewedDraftSignature('');
        setMessage('Atomic initialization was rejected; no authored document was changed.');
        return;
      }
      if (!confirmApply) {
        const nextSignature = String(record(next).previewSignature || '');
        if (!nextSignature || record(next).requiresConfirmation !== true) {
          setMessage('Initialization preview did not return the required confirmation signature; apply remains blocked.');
          return;
        }
        setBootstrapPreviewSignature(nextSignature);
        setBootstrapReviewedDraftSignature(bootstrapDraftSignature);
        setMessage('Atomic initialization preview passed. Confirm apply to publish the catalog, all Deck assignments, and all Gate scopes together.');
        return;
      }
      if (record(next).applied !== true) { setMessage('Core did not confirm atomic apply; reload before retrying.'); return; }
      setBootstrapDraft(undefined);
      setBootstrapPreviewSignature('');
      setBootstrapReviewedDraftSignature('');
      setMessage('Initialized logical folders atomically; every current Deck and Gate now has an explicit authored scope.');
      await refresh();
    } finally { setBusy(false); }
  }, [bootstrapDraft, bootstrapDraftSignature, bootstrapPreviewSignature, bootstrapReviewedDraftSignature, generation, refresh, workspace.catalog.exists]);

  const diagnostics = [...(deckPreview?.problems || []), ...(deckPreview?.warnings || []), ...(validationPreview?.problems || []), ...(validationPreview?.warnings || [])]
    .filter((entry, index, values) => values.findIndex((candidate) => diagnosticKey(candidate) === diagnosticKey(entry)) === index);

  return <div className={classes.container}>
    <Title1 className={classes.title}>Authored line decklists</Title1>
    <div className={classes.layout}>
      <Card className={classes.card}>
        <CardHeader header={<Body1>Deck folders</Body1>} description={<Caption1>Logical authoring metadata controls organization and Gate scope. Folder views include descendants; source files remain flat.</Caption1>} />
        <div className={classes.actions}><Button disabled={busy} onClick={() => void refresh()}>Reload workspace</Button></div>
        <DeckFolderWorkspace
          workspace={workspace}
          selectedFolderId={selectedFolderId}
          selectedDeckKey={deckKey}
          busy={busy}
          onSelectFolder={setSelectedFolderId}
          onSelectDeck={(deck) => void read(deck.sourcePath)}
          onCreateDeck={startNew}
          onStageFolder={(change) => void stageFolder(change)}
          onStageAssignment={(deck, folderId) => void stageAssignment(deck, folderId)}
          onStageBootstrap={stageBootstrap}
        />
      </Card>
      <Card className={classes.card}>
        <CardHeader header={<Body1>English-name line editor</Body1>} description={<Caption1>Use “count + English card name”. Exact names and reviewed aliases resolve; fuzzy suggestions are never selected automatically.</Caption1>} />
        <Field label="Stable Deck key" hint="Folder rename/move does not change this symbolic key or consumer references"><Input value={deckKey} readOnly={documents.includes(sourcePath)} onChange={(_, value) => { const key = value.value.toLowerCase().replace(/[^a-z0-9-]+/gu, '-'); setDeckKey(key); setSourcePath(`decks/${key}.decklist`); setPreviewSignature(''); }} /></Field>
        <Caption1>Logical folder: {workspace.folders.find((folder) => folder.id === workspace.decks.find((deck) => deck.key === deckKey)?.folderId)?.breadcrumb.join(' / ') || 'Unassigned'}</Caption1>
        <div className={classes.sections}>{DECK_AUTHORING_SECTIONS.map((section) => <Field key={section} label={`[${section}]`}><Textarea className={classes.editor} value={sections[section]} onChange={(_, value) => { setSections((current) => ({ ...current, [section]: value.value })); setPreviewSignature(''); }} /></Field>)}</div>
        <CardFooter><Button disabled={busy || !sourcePath || !generation} onClick={() => void preview()}>Resolve and validate preview</Button><Button appearance="primary" disabled={busy || !canSave} onClick={() => void save()}>Confirm canonical save</Button></CardFooter>
        {message && <Caption1>{message}</Caption1>}
      </Card>
    </div>

    {bootstrapDraft && !workspace.catalog.exists && <Card className={classes.card}>
      <CardHeader header={<Body1>Atomic initialization candidate review</Body1>} description={<Caption1>One catalog plus {bootstrapDraft.deckAssignments.length} explicit Deck assignments and {bootstrapDraft.gateAssignments.length} explicit Gate scopes. Deck roles and stable keys are not rewritten.</Caption1>} />
      <Caption1>{bootstrapDraft.folderName} · {bootstrapDraft.folderId} · generation {generation}</Caption1>
      <ul>
        {bootstrapDraft.deckAssignments.map((assignment) => <li key={`deck:${assignment.sourcePath}`}>Deck {assignment.sourcePath} → {assignment.folderId}</li>)}
        {bootstrapDraft.gateAssignments.map((assignment) => <li key={`gate:${assignment.sourcePath}`}>Gate {assignment.sourcePath} → {assignment.folderId}</li>)}
      </ul>
      {bootstrapResult && [...bootstrapResult.problems, ...bootstrapResult.warnings].map((entry) => <div key={diagnosticKey(entry)}>{entry.code}: {entry.message}</div>)}
      <CardFooter className={classes.actions}>
        <Button disabled={busy} onClick={() => { setBootstrapDraft(undefined); setBootstrapPreviewSignature(''); setBootstrapReviewedDraftSignature(''); }}>Discard candidate</Button>
        <Button disabled={busy} onClick={() => void reviewBootstrap(false)}>Preview atomic migration</Button>
        <Button appearance="primary" disabled={busy || !bootstrapPreviewSignature || bootstrapReviewedDraftSignature !== bootstrapDraftSignature || bootstrapResult?.ok !== true} onClick={() => void reviewBootstrap(true)}>Confirm atomic apply</Button>
      </CardFooter>
    </Card>}

    {pendingMutation && <Card className={classes.card}>
      <CardHeader header={<Body1>Folder metadata candidate review</Body1>} description={<Caption1>{pendingMutation.label}. Exact original JSON is deep-cloned and only the requested folder field is patched, preserving unknown siblings.</Caption1>} />
      <Caption1>{pendingMutation.operation} {pendingMutation.sourcePath} · generation {generation}</Caption1>
      {pendingResult && [...pendingResult.problems, ...pendingResult.warnings].map((entry) => <div key={diagnosticKey(entry)}>{entry.code}: {entry.message}</div>)}
      <CardFooter className={classes.actions}>
        <Button disabled={busy} onClick={discardPending}>Discard recovery candidate</Button>
        <Button disabled={busy || !workspace.catalog.exists} onClick={() => void reviewPending(false)}>Validate candidate</Button>
        <Button appearance="primary" disabled={busy || !workspace.catalog.exists || pendingPreviewSignature !== pendingSignature || pendingResult?.ok !== true} onClick={() => void reviewPending(true)}>Apply authored metadata</Button>
      </CardFooter>
      {!workspace.catalog.exists && <Caption1>This legacy single-document candidate is blocked until atomic logical-folder initialization completes.</Caption1>}
    </Card>}

    <Card className={classes.card}>
      <CardHeader header={<Body1>Catalog insertion</Body1>} description={<Caption1>Insertion writes the catalog English name into the selected authored section, never a runtime ID.</Caption1>} />
      <div className={classes.search}><Field className={classes.searchInput} label="Catalog search"><Input value={catalogQuery} onChange={(_, value) => setCatalogQuery(value.value)} onKeyDown={(event) => { if (event.key === 'Enter') void search(); }} /></Field><Field label="Insert into"><Select value={catalogSection} onChange={(_, value) => setCatalogSection(value.value as DeckAuthoringSection)}>{DECK_AUTHORING_SECTIONS.map((section) => <option key={section}>{section}</option>)}</Select></Field><Button disabled={busy} onClick={() => void search()}>Search</Button></div>
      <ul className={classes.results}>{cards.map((card) => <li className={classes.result} key={card.id}><span className={classes.grow}>{card.names?.display || card.names?.english || `#${card.id}`}<br /><Caption1>{card.names?.english || 'English name unavailable'} · {(card.autoTags || []).slice(0, 6).join(' · ')}</Caption1></span><Button disabled={!card.names?.english} onClick={() => { if (card.names?.english) setSections((current) => insertDeckAuthoringCard(current, catalogSection, card.names?.english || '')); setPreviewSignature(''); }}>Add {catalogSection}</Button></li>)}</ul>
    </Card>

    <Card className={classes.card}>
      <CardHeader header={<Body1>Resolution, legality and compiled preview</Body1>} description={<Caption1>Runtime IDs are diagnostic output only. Errors and regulation results retain authored line locations.</Caption1>} />
      {resolutions.length > 0 && <ul>{resolutions.map((entry) => <li key={`${entry.line}-${entry.sourceName}`}>line {entry.line} [{entry.section}] {entry.count} {entry.sourceName}: {entry.state}{entry.runtimeId === undefined ? '' : ` → runtime ${entry.runtimeId}`}{entry.candidates && entry.state === 'ambiguous' ? ` (${entry.candidates.map((candidate) => `${candidate.name} #${candidate.runtimeId}`).join(', ')})` : ''}{entry.suggestions?.length ? `; suggestions: ${entry.suggestions.map((candidate) => `${candidate.name} #${candidate.runtimeId}`).join(', ')}` : ''}</li>)}</ul>}
      {diagnostics.length > 0 && <ul>{diagnostics.map((entry) => { const line = entry.line || entry.sourceSpan?.line; const local = line ? deckAuthoringLineLocation(sections, line) : undefined; return <li key={diagnosticKey(entry)}>{entry.code}: {entry.message}{line ? ` (${entry.sourcePath || entry.path || sourcePath}:${line}${local ? `, ${local.section} line ${local.line}` : ''})` : ''}</li>; })}</ul>}
      <pre className={classes.output}>{compiledRuntimeIds ? JSON.stringify(compiledRuntimeIds, null, 2) : 'No compiled runtime-ID preview until every parser, resolver, count, legality and regulation check succeeds.'}</pre>
    </Card>
  </div>;
};
