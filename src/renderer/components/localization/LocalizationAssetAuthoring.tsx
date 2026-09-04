import {
  Body1,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Caption1,
  Field,
  Input,
  Select,
  Textarea,
  Title1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { CoreOperationProblem, CoreOperationResult } from '../../../common/type';

const useStyles = makeStyles({
  container: { height: '100vh', overflowY: 'auto', padding: tokens.spacingHorizontalL },
  title: { marginBottom: tokens.spacingVerticalL },
  layout: { display: 'grid', gridTemplateColumns: 'minmax(320px, 0.55fr) minmax(520px, 1fr)', gap: tokens.spacingHorizontalL },
  card: { marginBottom: tokens.spacingVerticalL },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  editor: { minHeight: '420px', fontFamily: 'monospace' },
  output: { maxHeight: '500px', overflow: 'auto', whiteSpace: 'pre-wrap' },
  previewGrid: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM },
  preview: { maxWidth: '320px', maxHeight: '320px', objectFit: 'contain' },
});

type MutationOperation = 'create' | 'update' | 'delete';
type PreviewAsset = { key?: string; source?: string; role?: string; previewDataUrl?: string | null; dimensions?: { width: number; height: number } | null; targetPaths?: string[] };

const resultData = (value: CoreOperationResult | undefined): Record<string, unknown> =>
  value?.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data as Record<string, unknown> : {};
const diagnosticKey = (entry: CoreOperationProblem) => `${entry.code}:${entry.sourcePath || entry.path || ''}:${entry.line || entry.sourceSpan?.line || 0}:${entry.jsonPointer || ''}`;
const location = (entry: CoreOperationProblem) => `${entry.sourcePath || entry.path || ''}${entry.line || entry.sourceSpan?.line ? `:${entry.line || entry.sourceSpan?.line}` : ''}${entry.jsonPointer ? ` ${entry.jsonPointer}` : ''}`;
const languageTemplate = () => `${JSON.stringify({ 'gate.new.name': 'New Gate', 'gate.new.description': 'New Gate description' }, null, 2)}\n`;

/** Authors localization JSON and the asset manifest only. Asset bytes remain
 * immutable and previews come from snapshot-contained bytes through preload. */
export const LocalizationAssetAuthoring = () => {
  const classes = useStyles();
  const [documents, setDocuments] = useState<string[]>([]);
  const [generation, setGeneration] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [content, setContent] = useState('');
  const [newLanguage, setNewLanguage] = useState('en');
  const [result, setResult] = useState<CoreOperationResult>();
  const [inspection, setInspection] = useState<CoreOperationResult>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewSignature, setPreviewSignature] = useState('');
  const [previewOperation, setPreviewOperation] = useState<MutationOperation>();
  const signature = useCallback((operation: MutationOperation) => JSON.stringify([operation, sourcePath, content, generation]), [content, generation, sourcePath]);

  const inspect = useCallback(async () => {
    const next = await window.electron.contentLocalizationAssetInspect();
    setInspection(next);
    const data = resultData(next);
    if (typeof data.contentGeneration === 'string') setGeneration(data.contentGeneration);
  }, []);

  const refresh = useCallback(async () => {
    const next = await window.electron.contentDocumentList();
    setResult(next);
    const data = resultData(next);
    setDocuments(((data.documents as string[] | undefined) || []).filter((entry) =>
      (entry.startsWith('localization/') && entry.endsWith('.json')) || entry === 'assets/manifest.json'));
    if (typeof data.contentGeneration === 'string') setGeneration(data.contentGeneration);
    await inspect();
  }, [inspect]);

  const read = useCallback(async (nextPath: string) => {
    setBusy(true);
    try {
      const next = await window.electron.contentDocumentRead({ sourcePath: nextPath });
      setResult(next);
      const data = resultData(next);
      if (next.ok) {
        setSourcePath(String(data.sourcePath || nextPath));
        setContent(String(data.content || ''));
        if (typeof data.contentGeneration === 'string') setGeneration(data.contentGeneration);
        setPreviewSignature(''); setPreviewOperation(undefined); setMessage(`Loaded authored document ${nextPath}`);
      }
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const startLanguage = () => {
    const language = newLanguage.trim().toLowerCase().replace(/_/gu, '-') || 'en';
    setSourcePath(`localization/${language}.json`);
    setContent(languageTemplate());
    setPreviewSignature(''); setPreviewOperation(undefined); setMessage('New language document. Validation compares referenced keys across every authored language.');
  };

  const runMutation = useCallback(async (operation: MutationOperation, confirmApply: boolean) => {
    setBusy(true);
    try {
      const next = await window.electron.contentLocalizationAssetMutate({
        sourcePath, content, operation, expectedContentGeneration: generation, confirmApply,
      });
      setResult(next);
      if (!next.ok) {
        setPreviewSignature(''); setPreviewOperation(undefined);
        setMessage('Shared localization, provenance, path, role, background, or compiler validation blocked this change.');
        return;
      }
      if (!confirmApply) {
        setPreviewSignature(signature(operation)); setPreviewOperation(operation);
        setMessage('Candidate validates in isolated staging. Explicit confirmation is required to change campaign/content.');
        return;
      }
      setPreviewSignature(''); setPreviewOperation(undefined);
      setMessage(operation === 'delete' ? 'Authored JSON moved through the recoverable delete boundary.' : 'Authored JSON saved atomically. Asset bytes and generated IR were not edited.');
      await refresh();
      if (operation === 'delete') { setSourcePath(''); setContent(''); }
      else await read(sourcePath);
    } finally { setBusy(false); }
  }, [content, generation, read, refresh, signature, sourcePath]);

  const operation: MutationOperation = documents.includes(sourcePath) ? 'update' : 'create';
  const canApply = previewOperation !== undefined && previewSignature === signature(previewOperation) && result?.ok === true;
  const diagnostics = [...(result?.problems || []), ...(result?.warnings || [])]
    .filter((entry, index, values) => values.findIndex((candidate) => diagnosticKey(candidate) === diagnosticKey(entry)) === index);
  const inspectionData = useMemo(() => resultData(inspection), [inspection]);
  const assets = (inspectionData.assets as PreviewAsset[] | undefined) || [];

  return <div className={classes.container}>
    <Title1 className={classes.title}>Localization and asset authoring</Title1>
    <div className={classes.layout}>
      <Card className={classes.card}>
        <CardHeader header={<Body1>Authored localization and asset manifest</Body1>} description={<Caption1>Only campaign/content localization JSON and assets/manifest.json are editable. Binary assets and generated projections are read-only.</Caption1>} />
        <div className={classes.actions}><Button disabled={busy} onClick={() => void refresh()}>Reload and inspect</Button></div>
        <Field label="Authored document"><Select value={sourcePath} onChange={(_, value) => void read(value.value)}><option value="">Choose a document</option>{documents.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</Select></Field>
        <Field label="New language code"><Input value={newLanguage} onChange={(_, value) => setNewLanguage(value.value)} /></Field>
        <Button disabled={busy} onClick={startLanguage}>New language JSON</Button>
      </Card>
      <Card className={classes.card}>
        <CardHeader header={<Body1>{sourcePath || 'Select or create a document'}</Body1>} description={<Caption1>Raw JSON text is preserved; the Core parser owns schema and semantic validation.</Caption1>} />
        <Field label="Authored source path"><Input value={sourcePath} onChange={(_, value) => { setSourcePath(value.value); setPreviewSignature(''); setPreviewOperation(undefined); }} /></Field>
        <Field label="JSON content"><Textarea className={classes.editor} value={content} onChange={(_, value) => { setContent(value.value); setPreviewSignature(''); setPreviewOperation(undefined); }} /></Field>
        <CardFooter className={classes.actions}>
          <Button disabled={busy || !generation || !sourcePath} onClick={() => void runMutation(operation, false)}>Validate candidate</Button>
          <Button appearance="primary" disabled={busy || !canApply || previewOperation === 'delete'} onClick={() => void runMutation(operation, true)}>Confirm authored save</Button>
          <Button disabled={busy || !generation || !documents.includes(sourcePath)} onClick={() => void runMutation('delete', false)}>Validate delete</Button>
          <Button appearance="primary" disabled={busy || !canApply || previewOperation !== 'delete'} onClick={() => void runMutation('delete', true)}>Confirm delete</Button>
        </CardFooter>
        {message && <Caption1>{message}</Caption1>}
      </Card>
    </div>

    <Card className={classes.card}>
      <CardHeader header={<Body1>Referenced-key completeness and diagnostics</Body1>} description={<Caption1>Missing languages are direct-entry gaps even when fallback text permits compilation.</Caption1>} />
      {diagnostics.length > 0 && <ul>{diagnostics.map((entry) => <li key={diagnosticKey(entry)}>{entry.code}: {entry.message}{location(entry) ? ` (${location(entry)})` : ''}</li>)}</ul>}
      <pre className={classes.output}>{inspection ? JSON.stringify(inspectionData.localization || {}, null, 2) : 'No inspection yet.'}</pre>
    </Card>

    <Card className={classes.card}>
      <CardHeader header={<Body1>Read-only local asset previews</Body1>} description={<Caption1>Previews use the exact validated snapshot bytes. Dimensions, symbolic Gate references, and numeric target paths come from shared Core contracts.</Caption1>} />
      <div className={classes.previewGrid}>{assets.map((asset) => <div key={String(asset.key)}>
        <Body1>{asset.key} — {asset.role}</Body1>
        <Caption1>{asset.source} {asset.dimensions ? `${asset.dimensions.width}x${asset.dimensions.height}` : 'no PNG dimensions'}</Caption1>
        {asset.previewDataUrl && <img className={classes.preview} src={asset.previewDataUrl} alt={`Read-only preview of ${asset.key}`} />}
        <pre>{JSON.stringify(asset.targetPaths || [], null, 2)}</pre>
      </div>)}</div>
      {!assets.length && <Caption1>No supported authored assets are available for preview.</Caption1>}
    </Card>
  </div>;
};
