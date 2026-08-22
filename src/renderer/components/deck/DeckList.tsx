import {
  Body1,
  Button,
  Caption1,
  Card,
  CardHeader,
  Field,
  Input,
  Textarea,
  Title1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useCallback, useEffect, useState } from 'react';

import { CoreOperationResult } from '../../../common/type';

const useStyles = makeStyles({
  container: {
    height: '100vh',
    overflowY: 'auto',
    padding: tokens.spacingHorizontalL,
  },
  title: {
    marginBottom: tokens.spacingVerticalL,
  },
  layout: {
    display: 'grid',
    gridTemplateColumns: 'minmax(180px, 0.35fr) minmax(420px, 1fr)',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
  },
  list: {
    minHeight: '420px',
  },
  listItem: {
    display: 'block',
    width: '100%',
    marginBottom: tokens.spacingVerticalXS,
    textAlign: 'left',
  },
  editor: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  catalog: {
    marginTop: tokens.spacingVerticalL,
  },
  catalogSearch: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    alignItems: 'end',
  },
  catalogInput: {
    flex: '1 1 360px',
  },
  catalogResults: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: 0,
    maxHeight: '320px',
    overflowY: 'auto',
  },
  catalogResult: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  catalogName: {
    flex: '1 1 280px',
  },
  json: {
    minHeight: '420px',
    fontFamily: 'Consolas, monospace',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
  },
  message: {
    whiteSpace: 'pre-wrap',
  },
});

const operationError = (operation: CoreOperationResult) =>
  operation.problems.map(({ code, message }) => `${code}: ${message}`).join('\n') || operation.exitName;

const readPaths = (operation: CoreOperationResult): string[] => {
  const paths = (operation.data as { paths?: unknown } | undefined)?.paths;
  return Array.isArray(paths) && paths.every((value): value is string => typeof value === 'string') ? paths : [];
};

interface CatalogCardResult {
  id: number;
  ydkId?: number;
  names?: { display?: string; korean?: string; english?: string };
  autoTags?: string[];
}

const readCatalogCards = (operation: CoreOperationResult): CatalogCardResult[] => {
  const cards = (operation.data as { cards?: unknown } | undefined)?.cards;
  return Array.isArray(cards) ? cards.filter((value): value is CatalogCardResult => Boolean(value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'number')) : [];
};

export const DeckList = () => {
  const classes = useStyles();
  const [paths, setPaths] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [jsonText, setJsonText] = useState('{\n  \n}');
  const [replace, setReplace] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogCards, setCatalogCards] = useState<CatalogCardResult[]>([]);
  const [catalogMessage, setCatalogMessage] = useState('');

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const operation = await window.electron.readDecks();
      if (!operation.ok) throw new Error(operationError(operation));
      setPaths(readPaths(operation));
      setMessage('');
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void window.electron.catalogStatus().then((operation) => {
      const data = operation.data as { valid?: boolean; cardCount?: number } | undefined;
      setCatalogMessage(data?.valid ? `Catalog cache: ${data.cardCount || 0} cards` : 'Catalog cache is not ready.');
    });
  }, []);

  const searchCatalog = useCallback(async () => {
    setBusy(true);
    try {
      const operation = await window.electron.catalogSearch({ query: catalogQuery, limit: 80 });
      if (!operation.ok) throw new Error(operationError(operation));
      setCatalogCards(readCatalogCards(operation));
      const total = (operation.data as { total?: unknown } | undefined)?.total;
      setCatalogMessage(`${typeof total === 'number' ? total : catalogCards.length} matching cards`);
    } catch (error) {
      setCatalogCards([]);
      setCatalogMessage(String(error));
    } finally {
      setBusy(false);
    }
  }, [catalogCards.length, catalogQuery]);

  const refreshCatalog = useCallback(async (online = false) => {
    setBusy(true);
    try {
      const operation = await window.electron.catalogRefresh(online ? { online: true } : undefined);
      if (!operation.ok) throw new Error(operationError(operation));
      const data = operation.data as { status?: { cardCount?: number }; sourceUsage?: Record<string, string> } | undefined;
      const warning = operation.warnings?.map(({ code, message }) => `${code}: ${message}`).join('\n');
      const usage = Object.values(data?.sourceUsage || {}).join(', ');
      setCatalogMessage(`${warning ? `Catalog warning: ${warning} ` : `Catalog ${online ? 'updated from internet' : 'rebuilt from local cache'}: `}${data?.status?.cardCount || 0} cards${usage ? ` (${usage})` : ''}`);
    } catch (error) {
      setCatalogMessage(String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const addCardToDeck = useCallback((id: number) => {
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const main = parsed.m && typeof parsed.m === 'object' && !Array.isArray(parsed.m)
        ? parsed.m as Record<string, unknown>
        : { ids: [], r: [] };
      const ids = Array.isArray(main.ids) ? main.ids.filter((value): value is number => typeof value === 'number') : [];
      const rarities = Array.isArray(main.r) ? main.r.filter((value): value is number => typeof value === 'number') : [];
      ids.push(id);
      rarities.push(1);
      parsed.m = { ...main, ids, r: rarities };
      setJsonText(JSON.stringify(parsed, null, 2));
      setMessage(`Added card ${id} to main deck. Save the document to persist it.`);
    } catch (error) {
      setMessage(`Create or load a JSON deck before adding a card: ${String(error)}`);
    }
  }, [jsonText]);

  const read = useCallback(async (relativePath: string) => {
    setBusy(true);
    try {
      const operation = await window.electron.readDeck({ path: relativePath });
      if (!operation.ok) throw new Error(operationError(operation));
      const value = (operation.data as { value?: unknown } | undefined)?.value;
      setSelectedPath(relativePath);
      setPathInput(relativePath);
      setJsonText(JSON.stringify(value ?? null, null, 2));
      setReplace(true);
      setMessage(`Loaded ${relativePath}`);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const startNew = useCallback(() => {
    setSelectedPath('');
    setPathInput('');
    setJsonText('{\n  \n}');
    setReplace(false);
    setMessage('New deck document');
  }, []);

  const save = useCallback(async () => {
    const relativePath = pathInput.trim();
    if (!relativePath || !relativePath.toLowerCase().endsWith('.json')) {
      setMessage('Deck path must be a non-empty .json path relative to the deck directory.');
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(jsonText);
    } catch (error) {
      setMessage(`Invalid JSON: ${String(error)}`);
      return;
    }

    setBusy(true);
    try {
      const operation = replace
        ? await window.electron.updateDeck({ path: relativePath, value })
        : await window.electron.createDeck({ path: relativePath, value });
      if (!operation.ok) throw new Error(operationError(operation));
      await refresh();
      await read(relativePath);
      setSelectedPath(relativePath);
      setMessage(`${replace ? 'Replaced' : 'Created'} ${relativePath}`);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }, [jsonText, pathInput, read, refresh, replace]);

  const remove = useCallback(async () => {
    if (!selectedPath) {
      setMessage('Select a deck before deleting.');
      return;
    }
    setBusy(true);
    try {
      const operation = await window.electron.deleteDeck({ path: selectedPath });
      if (!operation.ok) throw new Error(operationError(operation));
      const trashPath = (operation.data as { trashPath?: unknown } | undefined)?.trashPath;
      await refresh();
      startNew();
      setMessage(`Moved ${selectedPath} to trash${typeof trashPath === 'string' ? `: ${trashPath}` : ''}`);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }, [refresh, selectedPath, startNew]);

  return (
    <div className={classes.container}>
      <Title1 className={classes.title}>Decks</Title1>
      <div className={classes.layout}>
        <Card className={classes.list}>
          <CardHeader
            header={<Body1>Campaign deck documents</Body1>}
            description={<Caption1>Paths are relative to the manifest deck directory.</Caption1>}
          />
          <div className={classes.actions}>
            <Button disabled={busy} onClick={() => void refresh()}>Refresh</Button>
            <Button disabled={busy} onClick={startNew}>New document</Button>
          </div>
          <ul>
            {paths.map((relativePath) => (
              <li key={relativePath}>
                <Button
                  className={classes.listItem}
                  appearance={relativePath === selectedPath ? 'primary' : 'subtle'}
                  disabled={busy}
                  onClick={() => void read(relativePath)}
                >
                  {relativePath}
                </Button>
              </li>
            ))}
          </ul>
          {!paths.length && <Caption1>No deck documents yet.</Caption1>}
        </Card>

        <Card>
          <CardHeader
            header={<Body1>JSON document</Body1>}
            description={<Caption1>Create a new document, or load one and replace it atomically through the core store.</Caption1>}
          />
          <div className={classes.editor}>
            <Field label="Path" hint="Use a .json path relative to the deck directory." required>
              <Input value={pathInput} onChange={(_, data) => setPathInput(data.value)} placeholder="example.json" />
            </Field>
            <Field label="JSON" required>
              <Textarea className={classes.json} value={jsonText} onChange={(_, data) => setJsonText(data.value)} />
            </Field>
            <label>
              <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.currentTarget.checked)} />{' '}
              Replace existing (move the original to trash)
            </label>
            <div className={classes.actions}>
              <Button appearance="primary" disabled={busy} onClick={() => void save()}>Save document</Button>
              <Button disabled={busy || !selectedPath} onClick={() => void remove()}>Delete to trash</Button>
            </div>
            {message && <Caption1 className={classes.message}>{message}</Caption1>}
          </div>
        </Card>
      </div>
      <Card className={classes.catalog}>
        <CardHeader
          header={<Body1>Card catalog</Body1>}
          description={<Caption1>Search Korean/English names, effect tokens, type, attribute, race, level, rank, link, ATK, and DEF tags.</Caption1>}
        />
        <div className={classes.catalogSearch}>
          <Field className={classes.catalogInput} label="Search" hint="Examples: 블루 type:monster race:dragon level:4">
            <Input value={catalogQuery} onChange={(_, data) => setCatalogQuery(data.value)} onKeyDown={(event) => { if (event.key === 'Enter') void searchCatalog(); }} />
          </Field>
          <Button appearance="primary" disabled={busy} onClick={() => void searchCatalog()}>Search</Button>
          <Button disabled={busy} onClick={() => void refreshCatalog(false)}>Refresh local</Button>
          <Button disabled={busy} onClick={() => void refreshCatalog(true)}>Update from internet</Button>
        </div>
        {catalogMessage && <Caption1 className={classes.message}>{catalogMessage}</Caption1>}
        <ul className={classes.catalogResults}>
          {catalogCards.map((card) => (
            <li className={classes.catalogResult} key={card.id}>
              <Button className={classes.catalogName} appearance="subtle" onClick={() => addCardToDeck(card.id)} disabled={busy}>
                {card.names?.display || `#${card.id}`} (ID {card.id})
              </Button>
              <Caption1>{(card.autoTags || []).slice(0, 8).join(' · ')}</Caption1>
              <Button size="small" onClick={() => addCardToDeck(card.id)} disabled={busy}>Add main</Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
};
