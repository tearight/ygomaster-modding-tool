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
  editor: { minHeight: '480px', fontFamily: 'monospace' },
  output: { maxHeight: '440px', overflow: 'auto', whiteSpace: 'pre-wrap' },
});

const resultData = (value: CoreOperationResult | undefined): Record<string, unknown> =>
  value?.data && typeof value.data === 'object' && !Array.isArray(value.data)
    ? value.data as Record<string, unknown>
    : {};
const diagnosticKey = (entry: CoreOperationProblem) => `${entry.code}:${entry.sourcePath || entry.path || ''}:${entry.line || entry.sourceSpan?.line || 0}:${entry.jsonPointer || ''}`;
const location = (entry: CoreOperationProblem) => `${entry.sourcePath || entry.path || ''}${entry.line || entry.sourceSpan?.line ? `:${entry.line || entry.sourceSpan?.line}` : ''}${entry.jsonPointer ? ` ${entry.jsonPointer}` : ''}`;
const template = (key: string) => `${JSON.stringify({
  formatVersion: 1,
  kind: 'structure',
  payload: {
    key,
    nameKey: `structure.${key}.name`,
    descriptionKey: `structure.${key}.description`,
    deck: `deck:${key}`,
    focus: ['Card English Name'],
    accessory: { box: 0, sleeve: 0 },
    reward: { quantity: 1, oneCopy: true },
  },
}, null, 2)}\n`;

type MutationOperation = 'create' | 'update' | 'delete';

/** Authors campaign/content/structures through the shared content compiler.
 * Generated Structure IR is exposed only as a read-only preview. */
export const StructureAuthoring = () => {
  const classes = useStyles();
  const [documents, setDocuments] = useState<string[]>([]);
  const [generation, setGeneration] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [content, setContent] = useState('');
  const [newKey, setNewKey] = useState('new-structure');
  const [result, setResult] = useState<CoreOperationResult>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewSignature, setPreviewSignature] = useState('');
  const [previewOperation, setPreviewOperation] = useState<MutationOperation>();
  const signature = useCallback((operation: MutationOperation) => JSON.stringify([operation, sourcePath, content, generation]), [content, generation, sourcePath]);

  const refresh = useCallback(async () => {
    const next = await window.electron.contentDocumentList();
    setResult(next);
    const data = resultData(next);
    setDocuments(((data.documents as string[] | undefined) || []).filter((entry) => entry.startsWith('structures/') && entry.endsWith('.json')));
    if (typeof data.contentGeneration === 'string') setGeneration(data.contentGeneration);
  }, []);

  const read = useCallback(async (path: string) => {
    setBusy(true);
    try {
      const next = await window.electron.contentDocumentRead({ sourcePath: path });
      setResult(next);
      const data = resultData(next);
      if (next.ok) {
        setSourcePath(String(data.sourcePath || path));
        setContent(String(data.content || ''));
        if (typeof data.contentGeneration === 'string') setGeneration(data.contentGeneration);
        setPreviewSignature(''); setPreviewOperation(undefined); setMessage(`Loaded authored Structure metadata ${path}`);
      }
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const startNew = () => {
    const key = newKey.trim() || 'new-structure';
    setSourcePath(`structures/${key}.json`);
    setContent(template(key));
    setResult(undefined); setPreviewSignature(''); setPreviewOperation(undefined);
    setMessage('New authored Structure metadata. Create its referenced .decklist separately in Decks.');
  };

  const runMutation = useCallback(async (operation: MutationOperation, confirmApply: boolean) => {
    setBusy(true);
    try {
      const next = await window.electron.contentStructureMutate({
        sourcePath,
        operation,
        ...(operation === 'delete' ? {} : { content }),
        expectedContentGeneration: generation,
        confirmApply,
      });
      setResult(next);
      if (!next.ok) {
        setPreviewSignature(''); setPreviewOperation(undefined);
        setMessage('Structure validation blocked this change. Follow the source-located deck, focus, reward, or metadata diagnostics.');
        return;
      }
      if (!confirmApply) {
        setPreviewSignature(signature(operation)); setPreviewOperation(operation);
        setMessage(operation === 'delete' ? 'Deletion validates. Confirm removal from campaign/content/structures.' : 'Structure metadata and compiled projection validate. Confirm the authored change.');
        return;
      }
      setMessage(operation === 'delete' ? 'Deleted authored Structure metadata through the recoverable document boundary.' : 'Saved authored Structure metadata through the atomic document boundary.');
      setPreviewSignature(''); setPreviewOperation(undefined);
      await refresh();
      if (operation === 'delete') { setSourcePath(''); setContent(''); }
      else await read(sourcePath);
    } finally { setBusy(false); }
  }, [content, generation, read, refresh, signature, sourcePath]);

  const operation: MutationOperation = documents.includes(sourcePath) ? 'update' : 'create';
  const canApply = previewOperation !== undefined && previewSignature === signature(previewOperation) && result?.ok === true;
  const diagnostics = [...(result?.problems || []), ...(result?.warnings || [])]
    .filter((entry, index, values) => values.findIndex((candidate) => diagnosticKey(candidate) === diagnosticKey(entry)) === index);
  const preview = useMemo(() => resultData(result), [result]);

  return <div className={classes.container}>
    <Title1 className={classes.title}>Structure authoring</Title1>
    <div className={classes.layout}>
      <Card className={classes.card}>
        <CardHeader header={<Body1>campaign/content/structures</Body1>} description={<Caption1>Generated structure/*.json and StructureDecks/*.json are compiler-owned, read-only output.</Caption1>} />
        <div className={classes.actions}><Button disabled={busy} onClick={() => void refresh()}>Reload list</Button></div>
        <Field label="New symbolic key"><Input value={newKey} onChange={(_, value) => setNewKey(value.value)} /></Field>
        <Button disabled={busy} onClick={startNew}>New Structure metadata</Button>
        <ul className={classes.list}>{documents.map((entry) => <li key={entry}><Button className={classes.listButton} appearance={entry === sourcePath ? 'primary' : 'subtle'} disabled={busy} onClick={() => void read(entry)}>{entry}</Button></li>)}</ul>
      </Card>

      <Card className={classes.card}>
        <CardHeader header={<Body1>Metadata, deck, focus, accessory, and reward references</Body1>} description={<Caption1>The shared Structure parser, catalog resolver, validator, ID registry, and compiler are authoritative. Unknown JSON fields remain intact.</Caption1>} />
        <Field label="Authored metadata path"><Input value={sourcePath} onChange={(_, value) => { setSourcePath(value.value); setPreviewSignature(''); setPreviewOperation(undefined); }} /></Field>
        <Field label="Structure metadata JSON"><Textarea className={classes.editor} value={content} onChange={(_, value) => { setContent(value.value); setPreviewSignature(''); setPreviewOperation(undefined); }} /></Field>
        <CardFooter className={classes.actions}>
          <Button disabled={busy || !generation || !sourcePath} onClick={() => void runMutation(operation, false)}>Validate compiled preview</Button>
          <Button appearance="primary" disabled={busy || !canApply || previewOperation === 'delete'} onClick={() => void runMutation(operation, true)}>Confirm authored save</Button>
          <Button disabled={busy || !generation || !documents.includes(sourcePath)} onClick={() => void runMutation('delete', false)}>Validate delete</Button>
          <Button appearance="primary" disabled={busy || !canApply || previewOperation !== 'delete'} onClick={() => void runMutation('delete', true)}>Confirm delete</Button>
        </CardFooter>
        {message && <Caption1>{message}</Caption1>}
      </Card>
    </div>

    <Card className={classes.card}>
      <CardHeader header={<Body1>Catalog resolution and compiled Structure projection</Body1>} description={<Caption1>Target capability is fixture-backed and assumed. Reward quantity/one-copy behavior still requires runtime QA and is never presented as confirmed.</Caption1>} />
      {diagnostics.length > 0 && <ul>{diagnostics.map((entry) => <li key={diagnosticKey(entry)}>{entry.code}: {entry.message}{location(entry) ? ` (${location(entry)})` : ''}</li>)}</ul>}
      <pre className={classes.output}>{result ? JSON.stringify(preview, null, 2) : 'No Structure preview yet.'}</pre>
    </Card>
  </div>;
};
