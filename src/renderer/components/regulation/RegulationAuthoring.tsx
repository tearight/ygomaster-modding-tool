import {
  Body1,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Caption1,
  Field,
  Input,
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
  layout: { display: 'grid', gridTemplateColumns: 'minmax(220px, 0.3fr) minmax(560px, 1fr)', gap: tokens.spacingHorizontalL },
  card: { marginBottom: tokens.spacingVerticalL },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  list: { margin: 0, paddingLeft: tokens.spacingHorizontalM },
  listButton: { width: '100%', justifyContent: 'flex-start' },
  metadata: { minHeight: '260px', fontFamily: 'monospace' },
  rules: { minHeight: '360px', fontFamily: 'monospace' },
  output: { maxHeight: '460px', overflow: 'auto', whiteSpace: 'pre-wrap' },
});

const resultData = (value: CoreOperationResult | undefined): Record<string, unknown> =>
  value?.data && typeof value.data === 'object' && !Array.isArray(value.data)
    ? value.data as Record<string, unknown>
    : {};
const diagnosticKey = (entry: CoreOperationProblem) => `${entry.code}:${entry.sourcePath || entry.path || ''}:${entry.line || entry.sourceSpan?.line || 0}:${entry.jsonPointer || ''}`;
const location = (entry: CoreOperationProblem) => `${entry.sourcePath || entry.path || ''}${entry.line || entry.sourceSpan?.line ? `:${entry.line || entry.sourceSpan?.line}` : ''}${entry.jsonPointer ? ` ${entry.jsonPointer}` : ''}`;
const metadataTemplate = (key: string) => `${JSON.stringify({
  formatVersion: 1,
  kind: 'regulation',
  payload: {
    regulationId: `regulation:${key}`,
    name: key,
    cutoffRef: `release:${key}`,
    allowedRef: `card-pool:${key}`,
  },
}, null, 2)}\n`;
const rulesTemplate = '[allowed]\n3 Card English Name\n[forbidden]\n[limited]\n[semi-limited]\n';

type MutationOperation = 'create' | 'update' | 'delete';

/** Authors paired campaign/content Regulation documents. Runtime Regulation
 * target output is deliberately unsupported and never presented as published. */
export const RegulationAuthoring = () => {
  const classes = useStyles();
  const [documents, setDocuments] = useState<string[]>([]);
  const [generation, setGeneration] = useState('');
  const [metadataPath, setMetadataPath] = useState('');
  const [rulesPath, setRulesPath] = useState('');
  const [metadataContent, setMetadataContent] = useState('');
  const [rulesContent, setRulesContent] = useState('');
  const [newKey, setNewKey] = useState('new-regulation');
  const [result, setResult] = useState<CoreOperationResult>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewSignature, setPreviewSignature] = useState('');
  const [previewOperation, setPreviewOperation] = useState<MutationOperation>();
  const signature = useCallback((operation: MutationOperation) => JSON.stringify([
    operation, metadataPath, rulesPath, metadataContent, rulesContent, generation,
  ]), [generation, metadataContent, metadataPath, rulesContent, rulesPath]);

  const refresh = useCallback(async () => {
    const next = await window.electron.contentDocumentList();
    setResult(next);
    const data = resultData(next);
    setDocuments(((data.documents as string[] | undefined) || [])
      .filter((entry) => entry.startsWith('regulations/') && entry.endsWith('.json')));
    if (typeof data.contentGeneration === 'string') setGeneration(data.contentGeneration);
  }, []);

  const read = useCallback(async (sourcePath: string) => {
    setBusy(true);
    try {
      const next = await window.electron.contentRegulationRead({ sourcePath });
      setResult(next);
      const data = resultData(next);
      const metadata = data.metadata as { sourcePath?: string; content?: string } | undefined;
      const rules = data.rules as { sourcePath?: string; content?: string } | undefined;
      if (next.ok && metadata && rules) {
        setMetadataPath(String(metadata.sourcePath || sourcePath));
        setRulesPath(String(rules.sourcePath || sourcePath.replace(/\.json$/u, '.regulation')));
        setMetadataContent(String(metadata.content || ''));
        setRulesContent(String(rules.content || ''));
        if (typeof data.contentGeneration === 'string') setGeneration(data.contentGeneration);
        setPreviewSignature(''); setPreviewOperation(undefined); setMessage(`Loaded authored Regulation pair ${sourcePath}`);
      }
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const startNew = () => {
    const key = newKey.trim() || 'new-regulation';
    setMetadataPath(`regulations/${key}.json`);
    setRulesPath(`regulations/${key}.regulation`);
    setMetadataContent(metadataTemplate(key));
    setRulesContent(rulesTemplate);
    setResult(undefined); setPreviewSignature(''); setPreviewOperation(undefined);
    setMessage('New paired Regulation metadata and rules. Add the reviewed allowed card pool before validation.');
  };

  const runMutation = useCallback(async (operation: MutationOperation, confirmApply: boolean) => {
    setBusy(true);
    try {
      const next = await window.electron.contentRegulationMutate({
        metadata: { sourcePath: metadataPath, content: metadataContent },
        rules: { sourcePath: rulesPath, content: rulesContent },
        operation,
        expectedContentGeneration: generation,
        confirmApply,
      });
      setResult(next);
      if (!next.ok) {
        setPreviewSignature(''); setPreviewOperation(undefined);
        setMessage('Regulation content validation or an affected Deck/Gate/Structure legality check blocked this change.');
        return;
      }
      if (!confirmApply) {
        setPreviewSignature(signature(operation)); setPreviewOperation(operation);
        setMessage(operation === 'delete'
          ? 'Pair removal validates. Confirm recoverable removal from campaign/content.'
          : 'Content legality validates. Runtime Regulation Data remains unsupported; confirm only the authored pair change.');
        return;
      }
      setMessage(operation === 'delete'
        ? 'Removed the authored Regulation pair through the recoverable atomic boundary.'
        : 'Saved the authored Regulation pair through the atomic document boundary. No runtime Regulation Data was published.');
      setPreviewSignature(''); setPreviewOperation(undefined);
      await refresh();
      if (operation === 'delete') {
        setMetadataPath(''); setRulesPath(''); setMetadataContent(''); setRulesContent('');
      } else await read(metadataPath);
    } finally { setBusy(false); }
  }, [generation, metadataContent, metadataPath, read, refresh, rulesContent, rulesPath, signature]);

  const operation: MutationOperation = documents.includes(metadataPath) ? 'update' : 'create';
  const canApply = previewOperation !== undefined && previewSignature === signature(previewOperation) && result?.ok === true;
  const diagnostics = [...(result?.problems || []), ...(result?.warnings || [])]
    .filter((entry, index, values) => values.findIndex((candidate) => diagnosticKey(candidate) === diagnosticKey(entry)) === index);
  const preview = useMemo(() => resultData(result), [result]);

  return <div className={classes.container}>
    <Title1 className={classes.title}>Regulation authoring</Title1>
    <div className={classes.layout}>
      <Card className={classes.card}>
        <CardHeader header={<Body1>campaign/content/regulations</Body1>} description={<Caption1>Paired metadata and rules are authored together. Generated IR and runtime Regulation Data are never editable here.</Caption1>} />
        <div className={classes.actions}><Button disabled={busy} onClick={() => void refresh()}>Reload list</Button></div>
        <Field label="New symbolic key"><Input value={newKey} onChange={(_, value) => setNewKey(value.value)} /></Field>
        <Button disabled={busy} onClick={startNew}>New Regulation pair</Button>
        <ul className={classes.list}>{documents.map((entry) => <li key={entry}><Button className={classes.listButton} appearance={entry === metadataPath ? 'primary' : 'subtle'} disabled={busy} onClick={() => void read(entry)}>{entry}</Button></li>)}</ul>
      </Card>

      <Card className={classes.card}>
        <CardHeader header={<Body1>Card pool and copy limits</Body1>} description={<Caption1>The shared parser and catalog resolver validate [allowed], [forbidden], [limited], and [semi-limited] rules with source lines.</Caption1>} />
        <Field label="Metadata path"><Input value={metadataPath} onChange={(_, value) => { setMetadataPath(value.value); setPreviewSignature(''); setPreviewOperation(undefined); }} /></Field>
        <Field label="Metadata JSON (cutoffRef and allowedRef)"><Textarea className={classes.metadata} value={metadataContent} onChange={(_, value) => { setMetadataContent(value.value); setPreviewSignature(''); setPreviewOperation(undefined); }} /></Field>
        <Field label="Paired rules path"><Input value={rulesPath} onChange={(_, value) => { setRulesPath(value.value); setPreviewSignature(''); setPreviewOperation(undefined); }} /></Field>
        <Field label="English card-name rules"><Textarea className={classes.rules} value={rulesContent} onChange={(_, value) => { setRulesContent(value.value); setPreviewSignature(''); setPreviewOperation(undefined); }} /></Field>
        <CardFooter className={classes.actions}>
          <Button disabled={busy || !generation || !metadataPath || !rulesPath} onClick={() => void runMutation(operation, false)}>Validate legality impact</Button>
          <Button appearance="primary" disabled={busy || !canApply || previewOperation === 'delete'} onClick={() => void runMutation(operation, true)}>Confirm authored save</Button>
          <Button disabled={busy || !generation || !documents.includes(metadataPath)} onClick={() => void runMutation('delete', false)}>Validate delete</Button>
          <Button appearance="primary" disabled={busy || !canApply || previewOperation !== 'delete'} onClick={() => void runMutation('delete', true)}>Confirm delete</Button>
        </CardFooter>
        {message && <Caption1>{message}</Caption1>}
      </Card>
    </div>

    <Card className={classes.card}>
      <CardHeader header={<Body1>Content legality and affected consumers</Body1>} description={<Caption1>Deck and Gate checks use the shared regulation hook; Structure impact is shown only via its referenced Deck. Runtime target capability is unsupported and deployable is false.</Caption1>} />
      {diagnostics.length > 0 && <ul>{diagnostics.map((entry) => <li key={diagnosticKey(entry)}>{entry.code}: {entry.message}{location(entry) ? ` (${location(entry)})` : ''}</li>)}</ul>}
      <pre className={classes.output}>{result ? JSON.stringify(preview, null, 2) : 'No Regulation preview yet.'}</pre>
    </Card>
  </div>;
};
