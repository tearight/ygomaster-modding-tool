import {
  Body1,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Caption1,
  Field,
  Input,
  Title1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import type { CoreOperationProblem, CoreOperationResult } from '../../../common/type';
import { findOutOfScopeDeckReferences, normalizeScopedDeckCandidates, type ScopedDeckCandidate } from '../chapter/ScopedDeckPicker';
import {
  DeckFolderWorkspaceModel,
  decksForFolder,
  normalizeDeckFolderWorkspace,
} from '../deck/DeckFolderWorkspace';
import { AuthoredChapterDraft, ChapterComposer } from './ChapterComposer';
import { GateDeckScopeField } from './GateDeckScopeField';
import { GateGraphQuickEditor } from './GateGraphQuickEditor';
import { useGateAuthoringDraft } from './useGateAuthoringDraft';

const useStyles = makeStyles({
  container: { height: '100vh', overflowY: 'auto', padding: tokens.spacingHorizontalL },
  title: { marginBottom: tokens.spacingVerticalL },
  layout: { display: 'grid', gridTemplateColumns: 'minmax(240px, 0.32fr) minmax(640px, 1fr)', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  card: { marginBottom: tokens.spacingVerticalL },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  list: { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: tokens.spacingVerticalXS },
  listButton: { width: '100%', justifyContent: 'flex-start' },
  workbench: { display: 'grid', gap: tokens.spacingVerticalL },
  recovery: { position: 'sticky', bottom: 0, zIndex: 2 },
  diagnostics: { paddingLeft: tokens.spacingHorizontalL },
});

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const data = (value: CoreOperationResult | undefined) => asRecord(value?.data);
const diagnosticKey = (entry: CoreOperationProblem) => `${entry.code}:${entry.sourcePath || entry.path || ''}:${entry.jsonPointer || ''}:${entry.message}`;

const gateTemplate = (key: string): Record<string, unknown> => ({
  formatVersion: 1,
  kind: 'gate',
  payload: {
    id: `gate:${key}`,
    nameKey: `gate.${key}.name`,
    descriptionKey: `gate.${key}.description`,
    deckFolder: '',
    goal: `chapter:${key}-duel`,
    chapters: [{
      id: `chapter:${key}-duel`,
      kind: 'duel',
      descriptionKey: `chapter.${key}.duel.description`,
      duel: { playerMode: 'mydeck', cpuDeck: '' },
    }],
  },
});

const gatePayload = (document: Record<string, unknown>) => asRecord(document.payload);
const gateId = (document: Record<string, unknown>) => typeof gatePayload(document).id === 'string' ? gatePayload(document).id as string : '';
const gateChapters = (document: Record<string, unknown>): AuthoredChapterDraft[] =>
  (Array.isArray(gatePayload(document).chapters) ? gatePayload(document).chapters as unknown[] : [])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .map((entry) => entry as AuthoredChapterDraft);

const candidatesFor = (workspace: DeckFolderWorkspaceModel, folderId: string, role: 'cpu' | 'rental'): ScopedDeckCandidate[] =>
  normalizeScopedDeckCandidates(decksForFolder(workspace, folderId, role).map((deck) => ({
    key: deck.key,
    reference: deck.reference,
    role: deck.role,
    folderId: deck.folderId,
    breadcrumb: [...(workspace.folders.find((folder) => folder.id === deck.folderId)?.breadcrumb || []), deck.key],
    deepLink: deck.deepLink || `/decks?deck=${encodeURIComponent(deck.key)}`,
  })));

/** Structured authored Gate/Chapter editor. Folder metadata remains an authoring-only picker scope. */
export const GateAuthoring = () => {
  const classes = useStyles();
  const navigate = useNavigate();
  const params = useParams<{ id?: string; chapterId?: string }>();
  const routeGateId = params.id ? decodeURIComponent(params.id) : '';
  const routeChapterId = params.chapterId ? decodeURIComponent(params.chapterId) : '';
  const chapterRoute = Boolean(routeChapterId);
  const [workspace, setWorkspace] = useState<DeckFolderWorkspaceModel>(() => normalizeDeckFolderWorkspace({}));
  const [documents, setDocuments] = useState<string[]>([]);
  const [authored, setAuthored] = useState<Record<string, unknown>>({});
  const [sourcePath, setSourcePath] = useState('');
  const [workspaceIdentity, setWorkspaceIdentity] = useState('campaign-workspace');
  const [result, setResult] = useState<CoreOperationResult>();
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState('new-gate');
  const [selectedChapterId, setSelectedChapterId] = useState(routeChapterId);
  const draftState = useGateAuthoringDraft(workspaceIdentity, sourcePath || `new:${newKey}`, workspace.contentGeneration, authored);

  const read = useCallback(async (path: string) => {
    setBusy(true);
    try {
      const next = await window.electron.contentDocumentRead({ sourcePath: path });
      setResult(next);
      const values = data(next);
      if (!next.ok) return;
      try {
        const document = JSON.parse(String(values.content || '')) as Record<string, unknown>;
        setSourcePath(path);
        setAuthored(document);
        const firstChapter = gateChapters(document)[0]?.id || '';
        setSelectedChapterId((current) => gateChapters(document).some((chapter) => chapter.id === current) ? current : firstChapter);
      } catch (error) {
        setResult({ ok: false, exitCode: 1, exitName: 'COMMAND_FAILED', warnings: [], problems: [{ code: 'GATE_DOCUMENT_INVALID', message: String(error), sourcePath: path }] });
      }
    } finally { setBusy(false); }
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const [workspaceResult, listed, status] = await Promise.all([
        window.electron.contentDeckWorkspaceRead(),
        window.electron.contentDocumentList(),
        window.electron.campaignWorkspaceStatus(),
      ]);
      setResult(workspaceResult.ok ? listed : workspaceResult);
      const normalized = normalizeDeckFolderWorkspace(workspaceResult.data);
      if (workspaceResult.ok) setWorkspace(normalized);
      const listData = data(listed);
      const nextDocuments = (Array.isArray(listData.documents) ? listData.documents : []).filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('gates/') && entry.endsWith('.json'));
      setDocuments(nextDocuments);
      const statusData = data(status);
      if (typeof statusData.workspaceRoot === 'string') setWorkspaceIdentity(statusData.workspaceRoot);
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!documents.length) return;
    if (routeGateId && gateId(authored) === routeGateId && sourcePath) return;
    const routedGate = routeGateId
      ? workspace.gates.find((entry) => entry.id === routeGateId || entry.sourcePath === routeGateId || entry.sourcePath.endsWith(`/${routeGateId}.json`))
      : undefined;
    const nextPath = routedGate?.sourcePath || (!routeGateId ? documents[0] : undefined);
    if (nextPath && nextPath !== sourcePath) void read(nextPath);
  }, [authored, documents, read, routeGateId, sourcePath, workspace.gates]);
  useEffect(() => {
    if (routeChapterId && routeChapterId !== selectedChapterId) setSelectedChapterId(routeChapterId);
  }, [routeChapterId, selectedChapterId]);

  const draft = draftState.draft;
  const payload = gatePayload(draft);
  const chapters = gateChapters(draft);
  const folderId = typeof payload.deckFolder === 'string' ? payload.deckFolder : '';
  const folder = workspace.folders.find((entry) => entry.id === folderId);
  const folderLabel = folder?.breadcrumb.join(' / ') || folderId || 'No Gate Deck folder';
  const cpuCandidates = useMemo(() => candidatesFor(workspace, folderId, 'cpu'), [folderId, workspace]);
  const rentalCandidates = useMemo(() => candidatesFor(workspace, folderId, 'rental'), [folderId, workspace]);
  const scopedDeckCount = useMemo(() => decksForFolder(workspace, folderId, 'all').length, [folderId, workspace]);
  const outOfScope = useMemo(() => findOutOfScopeDeckReferences(chapters, cpuCandidates, rentalCandidates), [chapters, cpuCandidates, rentalCandidates]);
  const selectedChapter = chapters.find((chapter) => chapter.id === selectedChapterId) || chapters[0];

  const updatePayload = (patch: Record<string, unknown>) => draftState.setDraft((current) => ({ ...current, payload: { ...gatePayload(current), ...patch } }));
  const updateChapter = (chapter: AuthoredChapterDraft) => updatePayload({ chapters: chapters.map((entry) => entry.id === chapter.id ? chapter : entry) });
  const selectGate = (path: string) => {
    const entry = workspace.gates.find((gate) => gate.sourcePath === path);
    navigate(`/gates/${encodeURIComponent(entry?.id || path.replace(/^gates\//u, '').replace(/\.json$/u, ''))}`);
  };
  const create = () => {
    const key = newKey.trim().toLowerCase().replace(/[^a-z0-9-]+/gu, '-') || 'new-gate';
    const document = gateTemplate(key);
    setSourcePath(`gates/${key}.json`);
    setAuthored(document);
    setSelectedChapterId(gateChapters(document)[0]?.id || '');
    navigate(`/gates/${encodeURIComponent(`gate:${key}`)}`);
  };

  const preview = async () => {
    if (!sourcePath || !draftState.dirty || outOfScope.length || !folder) return;
    setBusy(true);
    try {
      const next = await window.electron.contentDocumentMutate({ sourcePath, operation: documents.includes(sourcePath) ? 'update' : 'create', content: pretty(draft), expectedContentGeneration: workspace.contentGeneration, confirmApply: false });
      setResult(next);
      if (next.ok) draftState.markPreviewed();
    } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!draftState.canApply || outOfScope.length || !folder) return;
    setBusy(true);
    try {
      const next = await window.electron.contentDocumentMutate({ sourcePath, operation: documents.includes(sourcePath) ? 'update' : 'create', content: pretty(draft), expectedContentGeneration: workspace.contentGeneration, confirmApply: true });
      setResult(next);
      if (!next.ok) return;
      draftState.applied();
      setAuthored(clone(draft));
      await refresh();
      await read(sourcePath);
    } finally { setBusy(false); }
  };

  const diagnostics = [...(result?.problems || []), ...(result?.warnings || [])]
    .filter((entry, index, values) => values.findIndex((candidate) => diagnosticKey(candidate) === diagnosticKey(entry)) === index);

  return <div className={classes.container}>
    <Title1 className={classes.title}>Gate and Chapter authoring</Title1>
    <div className={classes.layout}>
      <Card className={classes.card}>
        <CardHeader header={<Body1>Gates</Body1>} description={<Caption1>Typed authored units; generated Gate IR remains read-only.</Caption1>} />
        <Field label="New symbolic Gate key"><Input value={newKey} onChange={(_, value) => setNewKey(value.value)} /></Field>
        <div className={classes.actions}><Button disabled={busy} onClick={create}>＋ Gate</Button><Button disabled={busy} onClick={() => void refresh()}>Reload</Button></div>
        <ul className={classes.list}>{documents.map((entry) => <li key={entry}><Button className={classes.listButton} appearance={entry === sourcePath ? 'primary' : 'subtle'} onClick={() => selectGate(entry)}>{workspace.gates.find((gate) => gate.sourcePath === entry)?.id || entry.replace(/^gates\//u, '').replace(/\.json$/u, '')}</Button></li>)}</ul>
      </Card>
      <div className={classes.workbench}>
        <Card>
          <CardHeader header={<Body1>{gateId(draft) || 'Create or select a Gate'}</Body1>} description={<Caption1>Gate Deck folder is authoring metadata. Chapter Deck references remain explicit symbolic values.</Caption1>} />
          <GateDeckScopeField value={folderId} folders={workspace.folders} scopedDeckCount={scopedDeckCount} outOfScopeCount={outOfScope.length} disabled={busy || !sourcePath || chapterRoute} onChange={(deckFolder) => updatePayload({ deckFolder })} />
        </Card>
        {!chapterRoute && chapters.length > 0 && <Card>
          <CardHeader header={<Body1>Gate graph</Body1>} description={<Caption1>Quick edit and full edit use the same scoped Deck picker and the same recovery candidate.</Caption1>} />
          <GateGraphQuickEditor chapters={chapters} selectedChapterId={selectedChapter?.id} folderLabel={folderLabel} cpuCandidates={cpuCandidates} rentalCandidates={rentalCandidates} onSelect={setSelectedChapterId} onChange={updateChapter} onOpenFull={(chapterId) => navigate(`/gates/${encodeURIComponent(gateId(draft))}/chapters/${encodeURIComponent(chapterId)}`)} />
          {selectedChapter && <CardFooter><Button onClick={() => navigate(`/gates/${encodeURIComponent(gateId(draft))}/chapters/${encodeURIComponent(selectedChapter.id)}`)}>Open full Chapter editor</Button></CardFooter>}
        </Card>}
        {chapterRoute && selectedChapter && <Card>
          <CardHeader header={<Body1>Chapter</Body1>} description={<Caption1>All edits remain in the Gate recovery draft until reviewed and explicitly applied.</Caption1>} />
          <ChapterComposer chapter={selectedChapter} chapters={chapters} folderLabel={folderLabel} cpuCandidates={cpuCandidates} rentalCandidates={rentalCandidates} onChange={updateChapter} />
          <CardFooter><Button onClick={() => navigate(`/gates/${encodeURIComponent(gateId(draft))}`)}>Back to Gate graph</Button></CardFooter>
        </Card>}
        <Card>
          <CardHeader header={<Body1>Candidate review</Body1>} description={<Caption1>Staging validation checks graph, references, folders, Deck roles, compiler capability, and current generation.</Caption1>} />
          <Caption1>Changed authored Gate: {draftState.dirty ? 'yes' : 'no'} · out-of-scope references: {outOfScope.length} · preview signature: {draftState.previewSignature ? 'current' : 'required'}</Caption1>
          {outOfScope.length > 0 && <ul>{outOfScope.map((entry) => <li key={`${entry.chapterId}-${entry.role}`}>{entry.chapterId}: {entry.role} {entry.reference}</li>)}</ul>}
          {diagnostics.length > 0 && <ul className={classes.diagnostics}>{diagnostics.map((entry) => <li key={diagnosticKey(entry)}>{entry.code}: {entry.message}</li>)}</ul>}
        </Card>
      </div>
    </div>
    <Card className={classes.recovery}>
      <CardHeader header={<Body1>Recovery draft</Body1>} description={<Caption1>{draftState.recovered ? 'Recovered for this workspace, entity, and content generation.' : draftState.staleRecoveryExists ? 'A stale draft exists for another generation; it was not applied.' : draftState.dirty ? 'Saved locally only. Authored source is unchanged.' : 'Authored source and draft are synchronized.'}</Caption1>} />
      <CardFooter className={classes.actions}>
        <Button disabled={busy || !draftState.dirty} onClick={draftState.discard}>Discard draft</Button>
        <Button disabled={busy || !draftState.dirty || outOfScope.length > 0 || !folder} onClick={() => void preview()}>Review candidate</Button>
        <Button appearance="primary" disabled={busy || !draftState.canApply || outOfScope.length > 0 || !folder} onClick={() => void apply()}>Apply to authored source</Button>
      </CardFooter>
    </Card>
  </div>;
};
