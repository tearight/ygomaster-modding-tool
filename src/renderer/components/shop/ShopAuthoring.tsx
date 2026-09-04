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

import type { ContentShopDocumentDraft, CoreOperationProblem, CoreOperationResult } from '../../../common/type';

const useStyles = makeStyles({
  container: { height: '100vh', overflowY: 'auto', padding: tokens.spacingHorizontalL },
  title: { marginBottom: tokens.spacingVerticalL },
  layout: { display: 'grid', gridTemplateColumns: 'minmax(220px, 0.3fr) minmax(560px, 1fr)', gap: tokens.spacingHorizontalL },
  card: { marginBottom: tokens.spacingVerticalL },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  list: { margin: 0, paddingLeft: tokens.spacingHorizontalM },
  listButton: { width: '100%', justifyContent: 'flex-start' },
  editors: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: tokens.spacingHorizontalM },
  editor: { minHeight: '320px', fontFamily: 'monospace' },
  output: { maxHeight: '420px', overflow: 'auto', whiteSpace: 'pre-wrap' },
  paths: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: tokens.spacingHorizontalS },
});

const data = (value: CoreOperationResult | undefined): Record<string, unknown> => value?.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data as Record<string, unknown> : {};
const draft = (value: unknown): ContentShopDocumentDraft => value && typeof value === 'object' && !Array.isArray(value)
  ? { sourcePath: String((value as Record<string, unknown>).sourcePath || ''), content: String((value as Record<string, unknown>).content || '') }
  : { sourcePath: '', content: '' };
const diagnosticKey = (entry: CoreOperationProblem) => `${entry.code}:${entry.sourcePath || entry.path || ''}:${entry.line || entry.sourceSpan?.line || 0}:${entry.jsonPointer || ''}`;
const location = (entry: CoreOperationProblem) => `${entry.sourcePath || entry.path || ''}${entry.line || entry.sourceSpan?.line ? `:${entry.line || entry.sourceSpan?.line}` : ''}${entry.jsonPointer ? ` ${entry.jsonPointer}` : ''}`;

const newDrafts = (key: string) => ({
  metadata: { sourcePath: `shop/packs/${key}.json`, content: `${JSON.stringify({ formatVersion: 1, kind: 'shop-pack', payload: { shopId: `shop:${key}`, name: key, price: 100, availability: 'always', packlist: `pools/${key}.packlist`, odds: `odds/${key}.json`, oddsName: key, packSize: 8 } }, null, 2)}\n` },
  packList: { sourcePath: `shop/pools/${key}.packlist`, content: '[common]\nCard English Name\n' },
  odds: { sourcePath: `shop/odds/${key}.json`, content: `${JSON.stringify({ formatVersion: 1, kind: 'shop-odds', payload: { slots: [{ name: 'base', count: 8, entries: [{ rarity: 'common', probability: 1 }] }], collation: [{ slot: 'base', count: 8 }] } }, null, 2)}\n` },
});

/** Authors only campaign/content/shop. Generated Shop IR and deploy Data are read-only previews. */
export const ShopAuthoring = () => {
  const classes = useStyles();
  const [documents, setDocuments] = useState<string[]>([]);
  const [generation, setGeneration] = useState('');
  const [metadata, setMetadata] = useState<ContentShopDocumentDraft>({ sourcePath: '', content: '' });
  const [packList, setPackList] = useState<ContentShopDocumentDraft>({ sourcePath: '', content: '' });
  const [odds, setOdds] = useState<ContentShopDocumentDraft>({ sourcePath: '', content: '' });
  const [result, setResult] = useState<CoreOperationResult>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState('new-pack');
  const [previewSignature, setPreviewSignature] = useState('');
  const signature = useMemo(() => JSON.stringify([metadata, packList, odds, generation]), [generation, metadata, odds, packList]);

  const refresh = useCallback(async () => {
    const next = await window.electron.contentDocumentList();
    setResult(next);
    const values = data(next);
    setDocuments(((values.documents as string[] | undefined) || []).filter((entry) => entry.startsWith('shop/packs/') && entry.endsWith('.json')));
    if (typeof values.contentGeneration === 'string') setGeneration(values.contentGeneration);
  }, []);

  const read = useCallback(async (sourcePath: string) => {
    setBusy(true);
    try {
      const next = await window.electron.contentShopRead({ sourcePath });
      setResult(next);
      const values = data(next);
      if (next.ok) {
        setMetadata(draft(values.metadata)); setPackList(draft(values.packList)); setOdds(draft(values.odds));
        if (typeof values.contentGeneration === 'string') setGeneration(values.contentGeneration);
        setPreviewSignature(''); setMessage(`Loaded linked Shop documents for ${sourcePath}`);
      }
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const startNew = () => {
    const next = newDrafts(newKey.trim() || 'new-pack');
    setMetadata(next.metadata); setPackList(next.packList); setOdds(next.odds);
    setResult(undefined); setPreviewSignature(''); setMessage('New linked authored Shop pack');
  };

  const runMutation = useCallback(async (confirmApply: boolean) => {
    setBusy(true);
    try {
      const next = await window.electron.contentShopMutate({ metadata, packList, odds, expectedContentGeneration: generation, confirmApply });
      setResult(next);
      if (!next.ok) { setPreviewSignature(''); setMessage('Shop validation blocked this change. Follow the source-located diagnostics.'); return; }
      if (!confirmApply) { setPreviewSignature(signature); setMessage('All three authored documents and the target preview validate. Confirm the atomic save.'); return; }
      setMessage('Saved metadata, pool, and odds atomically through the content document boundary.');
      await refresh(); await read(metadata.sourcePath);
    } finally { setBusy(false); }
  }, [generation, metadata, odds, packList, read, refresh, signature]);

  const diagnostics = [...(result?.problems || []), ...(result?.warnings || [])]
    .filter((entry, index, values) => values.findIndex((candidate) => diagnosticKey(candidate) === diagnosticKey(entry)) === index);
  const canSave = result?.ok === true && previewSignature === signature;

  return <div className={classes.container}>
    <Title1 className={classes.title}>Shop pack, pool, and odds authoring</Title1>
    <div className={classes.layout}>
      <Card className={classes.card}>
        <CardHeader header={<Body1>campaign/content Shop packs</Body1>} description={<Caption1>Generated PackShop and ShopPackOdds IR are compiler-owned and cannot be edited here.</Caption1>} />
        <div className={classes.actions}><Button disabled={busy} onClick={() => void refresh()}>Reload list</Button></div>
        <Field label="New symbolic key"><Input value={newKey} onChange={(_, value) => setNewKey(value.value)} /></Field>
        <Button disabled={busy} onClick={startNew}>New linked pack</Button>
        <ul className={classes.list}>{documents.map((entry) => <li key={entry}><Button className={classes.listButton} appearance={entry === metadata.sourcePath ? 'primary' : 'subtle'} disabled={busy} onClick={() => void read(entry)}>{entry}</Button></li>)}</ul>
      </Card>

      <Card className={classes.card}>
        <CardHeader header={<Body1>Linked authored documents</Body1>} description={<Caption1>Edit raw-preserving metadata JSON, rarity pool text, and named odds JSON together. Shared core parsing and compilation remain authoritative.</Caption1>} />
        <div className={classes.paths}>
          <Field label="Metadata path"><Input value={metadata.sourcePath} onChange={(_, value) => { setMetadata((current) => ({ ...current, sourcePath: value.value })); setPreviewSignature(''); }} /></Field>
          <Field label="Pool path"><Input value={packList.sourcePath} onChange={(_, value) => { setPackList((current) => ({ ...current, sourcePath: value.value })); setPreviewSignature(''); }} /></Field>
          <Field label="Odds path"><Input value={odds.sourcePath} onChange={(_, value) => { setOdds((current) => ({ ...current, sourcePath: value.value })); setPreviewSignature(''); }} /></Field>
        </div>
        <div className={classes.editors}>
          <Field label="Pack metadata JSON"><Textarea className={classes.editor} value={metadata.content} onChange={(_, value) => { setMetadata((current) => ({ ...current, content: value.value })); setPreviewSignature(''); }} /></Field>
          <Field label="Rarity pool .packlist"><Textarea className={classes.editor} value={packList.content} onChange={(_, value) => { setPackList((current) => ({ ...current, content: value.value })); setPreviewSignature(''); }} /></Field>
          <Field label="Named slot odds JSON"><Textarea className={classes.editor} value={odds.content} onChange={(_, value) => { setOdds((current) => ({ ...current, content: value.value })); setPreviewSignature(''); }} /></Field>
        </div>
        <CardFooter><Button disabled={busy || !generation} onClick={() => void runMutation(false)}>Validate linked preview</Button><Button appearance="primary" disabled={busy || !canSave} onClick={() => void runMutation(true)}>Confirm atomic save</Button></CardFooter>
        {message && <Caption1>{message}</Caption1>}
      </Card>
    </div>

    <Card className={classes.card}>
      <CardHeader header={<Body1>Resolution, progression, capability, and target preview</Body1>} description={<Caption1>Card runtime IDs and generated PackShop/odds objects are read-only diagnostic output. Unsupported target fields never produce a successful preview.</Caption1>} />
      {diagnostics.length > 0 && <ul>{diagnostics.map((entry) => <li key={diagnosticKey(entry)}>{entry.code}: {entry.message}{location(entry) ? ` (${location(entry)})` : ''}</li>)}</ul>}
      <pre className={classes.output}>{result ? JSON.stringify(data(result), null, 2) : 'No linked preview yet.'}</pre>
    </Card>
  </div>;
};
