import {
  Body1,
  Button,
  Caption1,
  Card,
  CardHeader,
  Field,
  Input,
  Subtitle1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useCallback, useEffect, useState } from 'react';

import { CoreOperationResult } from '../../../common/type';

interface CatalogProblem {
  code?: string;
  message?: string;
  path?: string;
  severity?: string;
}

interface CatalogSourceStatus {
  id?: string;
  language?: string;
  path?: string;
  usedFrom?: 'local' | 'download';
  revision?: string;
  url?: string;
  fetchedAt?: string;
  recordCount?: number;
}

interface CatalogStatusData {
  valid?: boolean;
  generation?: string;
  cardCount?: number;
  missingRuntimeIdCount?: number;
  lastUpdated?: string;
  catalogPath?: string;
  metadataPath?: string;
  sourcePaths?: Record<string, string>;
  metadata?: {
    sources?: CatalogSourceStatus[];
    ygoMaster?: { runtimeTag?: string; cardListPath?: string; ydkIdsPath?: string; runtimeIdCount?: number; bridgeCount?: number };
  };
}

interface CatalogCardResult {
  id: number;
  ydkId?: number;
  names?: { display?: string; english?: string };
  autoTags?: string[];
}

const data = (operation: CoreOperationResult | undefined): Record<string, unknown> =>
  operation?.data && typeof operation.data === 'object' ? operation.data as Record<string, unknown> : {};

const diagnostics = (operation: CoreOperationResult | undefined): CatalogProblem[] => [
  ...(operation?.problems || []),
  ...(operation?.warnings || []),
] as CatalogProblem[];

const useStyles = makeStyles({
  root: { height: '100%', overflowY: 'auto', padding: '24px', boxSizing: 'border-box' },
  column: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '1100px' },
  row: { display: 'flex', gap: '8px', alignItems: 'end', flexWrap: 'wrap' },
  grow: { flexGrow: 1, minWidth: '280px' },
  grid: { display: 'grid', gridTemplateColumns: 'minmax(160px, 240px) 1fr', gap: '6px 12px' },
  path: { fontFamily: 'monospace', overflowWrap: 'anywhere' },
  list: { margin: 0, paddingLeft: '20px' },
  problem: { borderLeft: `3px solid ${tokens.colorPaletteRedBorder2}`, paddingLeft: '8px', marginBottom: '8px' },
  warning: { borderLeft: `3px solid ${tokens.colorPaletteYellowBorder2}`, paddingLeft: '8px', marginBottom: '8px' },
});

export const CatalogAdministration = () => {
  const classes = useStyles();
  const [statusOperation, setStatusOperation] = useState<CoreOperationResult>();
  const [refreshOperation, setRefreshOperation] = useState<CoreOperationResult>();
  const [customOperation, setCustomOperation] = useState<CoreOperationResult>();
  const [searchOperation, setSearchOperation] = useState<CoreOperationResult>();
  const [query, setQuery] = useState('race:dragon atk>=2500');
  const [busy, setBusy] = useState(false);
  const status = data(statusOperation) as CatalogStatusData;

  const loadStatus = useCallback(async () => {
    setStatusOperation(await window.electron.catalogStatus());
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const refresh = useCallback(async (online: boolean) => {
    if (online) {
      const response = await window.electron.showMessageBox({
        message: 'Update the catalog from the internet?',
        detail: 'This explicitly downloads only the approved Korean and English CDB sources. Existing valid cache files are preserved if refresh fails.',
        buttons: ['Update from internet', 'Cancel'],
        cancelId: 1,
        type: 'warning',
      });
      if (response !== 0) return;
    }
    setBusy(true);
    try {
      const operation = await window.electron.catalogRefresh({
        online,
        confirmRefresh: true,
        expectedCatalogGeneration: status.generation || 'missing',
        ...(online ? { confirmOnline: true } : {}),
      });
      setRefreshOperation(operation);
      await loadStatus();
    } finally {
      setBusy(false);
    }
  }, [loadStatus, status.generation]);

  const validateCustom = useCallback(async () => {
    setBusy(true);
    try { setCustomOperation(await window.electron.catalogCustomValidate()); } finally { setBusy(false); }
  }, []);

  const search = useCallback(async () => {
    setBusy(true);
    try { setSearchOperation(await window.electron.catalogSearch({ query, limit: 50 })); } finally { setBusy(false); }
  }, [query]);

  const sources = status.metadata?.sources || [];
  const searchData = data(searchOperation) as { total?: number; cards?: CatalogCardResult[] };
  const customData = data(customOperation) as { root?: string; sourceRecordCount?: number; materializedCards?: unknown[]; files?: string[]; errorCount?: number; warningCount?: number };

  return (
    <main className={classes.root}>
      <div className={classes.column}>
        <div><Subtitle1>Catalog administration</Subtitle1><br /><Caption1>Display/search cache only. Runtime IDs remain YgoMaster authority; no catalog or custom record is exported from this screen.</Caption1></div>

        <Card>
          <CardHeader header={<Body1>Status and refresh</Body1>} description={<Caption1>Status is offline. Local-first refresh reuses valid local raw sources; only a missing approved source may be downloaded. Internet refresh always re-downloads after confirmation.</Caption1>} />
          <div className={classes.row}>
            <Button disabled={busy} onClick={() => void loadStatus()}>Check status (offline)</Button>
            <Button disabled={busy} onClick={() => void refresh(false)}>Refresh local-first</Button>
            <Button appearance="primary" disabled={busy} onClick={() => void refresh(true)}>Update from internet…</Button>
          </div>
          <div className={classes.grid}>
            <Caption1>Cache state</Caption1><Body1>{status.valid ? 'Valid' : 'Missing or invalid'}</Body1>
            <Caption1>Catalog generation</Caption1><span className={classes.path}>{status.generation || 'Unavailable until a valid catalog is loaded'}</span>
            <Caption1>Cards / missing runtime IDs</Caption1><Body1>{status.cardCount || 0} / {status.missingRuntimeIdCount || 0}</Body1>
            <Caption1>Generated</Caption1><Body1>{status.lastUpdated || '—'}</Body1>
            <Caption1>Catalog / metadata</Caption1><span className={classes.path}>{status.catalogPath || '—'}<br />{status.metadataPath || '—'}</span>
            <Caption1>YgoMaster provenance</Caption1><Body1>{status.metadata?.ygoMaster?.runtimeTag || '—'} · {status.metadata?.ygoMaster?.runtimeIdCount || 0} runtime IDs · {status.metadata?.ygoMaster?.bridgeCount || 0} bridges</Body1>
          </div>
          {sources.map((source) => <div key={`${source.language}-${source.id}`} className={classes.grid}>
            <Caption1>{source.language} raw source</Caption1>
            <span><span className={classes.path}>{source.path}</span><br /><Caption1>{source.usedFrom || 'unknown'} · revision {source.revision || 'unreported'} · {source.recordCount || 0} records · {source.fetchedAt || 'unknown time'}</Caption1><br /><Caption1 className={classes.path}>{source.url || 'source URL unreported'}</Caption1></span>
          </div>)}
          {diagnostics(statusOperation).map((entry, index) => <div className={entry.severity === 'warning' ? classes.warning : classes.problem} key={`${entry.code}-${index}`}><Body1>{entry.code}: {entry.message}</Body1>{entry.path && <><br /><Caption1 className={classes.path}>{entry.path}</Caption1></>}</div>)}
          {diagnostics(refreshOperation).map((entry, index) => <div className={entry.severity === 'warning' ? classes.warning : classes.problem} key={`refresh-${entry.code}-${index}`}><Body1>{entry.code}: {entry.message}</Body1>{entry.path && <><br /><Caption1 className={classes.path}>{entry.path}</Caption1></>}</div>)}
        </Card>

        <Card>
          <CardHeader header={<Body1>Expression search preview</Body1>} description={<Caption1>The same catalog parser and search store used by Deck card insertion handles tags, custom facets, ranges, negation, quotes, and name prefixes.</Caption1>} />
          <div className={classes.row}><Field className={classes.grow} label="Expression"><Input value={query} onChange={(_, value) => setQuery(value.value)} onKeyDown={(event) => { if (event.key === 'Enter') void search(); }} /></Field><Button disabled={busy} onClick={() => void search()}>Search</Button></div>
          <Caption1>Examples: <span className={classes.path}>type:monster level&gt;=8 -attribute:dark</span> · <span className={classes.path}>&quot;draw one&quot;</span> · <span className={classes.path}>custom.role:engine</span></Caption1>
          {searchOperation && <Body1>{searchOperation.ok ? `${searchData.total || 0} matches` : 'Search failed'}</Body1>}
          <ul className={classes.list}>{(searchData.cards || []).map((card) => <li key={card.id}><Body1>{card.names?.display || card.names?.english || `#${card.id}`} · runtime #{card.id}</Body1><br /><Caption1>{card.names?.english || 'English name unavailable'} · {(card.autoTags || []).slice(0, 8).join(' · ')}</Caption1></li>)}</ul>
          {diagnostics(searchOperation).map((entry, index) => <div className={entry.severity === 'warning' ? classes.warning : classes.problem} key={`${entry.code}-${index}`}><Body1>{entry.code}: {entry.message}</Body1>{entry.path && <><br /><Caption1 className={classes.path}>{entry.path}</Caption1></>}</div>)}
        </Card>

        <Card>
          <CardHeader header={<Body1>Custom card database validation</Body1>} description={<Caption1>Read-only validation uses the same versioned migration, layer, runtime-ID, reserved-field, namespace, claim, and containment checks as the CLI. Source paths identify the manifest or record to fix.</Caption1>} />
          <Button disabled={busy || !status.valid} onClick={() => void validateCustom()}>Validate custom database</Button>
          {customOperation && <div className={classes.grid}>
            <Caption1>Result</Caption1><Body1>{customOperation.ok ? 'Valid' : 'Invalid'}</Body1>
            <Caption1>Database root</Caption1><span className={classes.path}>{customData.root || diagnostics(customOperation)[0]?.path || '—'}</span>
            <Caption1>Source / materialized records</Caption1><Body1>{customData.sourceRecordCount ?? '—'} / {customData.materializedCards?.length ?? '—'}</Body1>
          </div>}
          {diagnostics(customOperation).map((entry, index) => <div className={entry.severity === 'warning' ? classes.warning : classes.problem} key={`${entry.code}-${index}`}><Body1>{entry.code}: {entry.message}</Body1>{entry.path && <><br /><Caption1 className={classes.path}>Source record: {entry.path}</Caption1></>}</div>)}
        </Card>
      </div>
    </main>
  );
};
