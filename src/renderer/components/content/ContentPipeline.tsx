import {
  Body1,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Caption1,
  Field,
  Title1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useCallback, useMemo, useState } from 'react';

import type {
  ContentCompileRequest,
  ContentPathsRequest,
  CoreOperationProblem,
  CoreOperationResult,
} from '../../../common/type';
import { FileInput } from '../input/FileInput';

const useStyles = makeStyles({
  container: { height: '100vh', overflowY: 'auto', padding: tokens.spacingHorizontalL },
  title: { marginBottom: tokens.spacingVerticalL },
  card: { marginBottom: tokens.spacingVerticalL },
  row: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  output: { whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: '360px', padding: tokens.spacingHorizontalS },
  generation: { wordBreak: 'break-all' },
  check: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  diagnostic: { margin: 0, paddingLeft: tokens.spacingHorizontalM },
});

type Result = CoreOperationResult | undefined;
type GenerationStatus = {
  state: 'missing' | 'invalid' | 'stale' | 'current';
  contentGeneration: string;
  irGeneration: string | null;
  mismatches: string[];
};

const recordData = (result: Result): Record<string, unknown> | undefined =>
  result?.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : undefined;

const locationFor = (entry: CoreOperationProblem): string => {
  const source = entry.sourcePath || entry.path;
  if (!source) return '';
  const line = entry.line === undefined ? '' : `:${entry.line}${entry.column === undefined ? '' : `:${entry.column}`}`;
  return `${source}${line}${entry.jsonPointer ? ` ${entry.jsonPointer}` : ''}`;
};

const diagnosticsFor = (result: Result): CoreOperationProblem[] => [
  ...(result?.problems || []),
  ...(result?.warnings || []),
];

const capabilityFor = (result: Result): CoreOperationProblem[] => diagnosticsFor(result).filter((entry) =>
  entry.code.includes('UNSUPPORTED') || entry.code.includes('CAPABILITY'),
);

export const ContentPipeline = () => {
  const classes = useStyles();
  const [contentRoot, setContentRoot] = useState('');
  const [irRoot, setIrRoot] = useState('');
  const [registryPath, setRegistryPath] = useState('');
  const [gameRoot, setGameRoot] = useState('');
  const [result, setResult] = useState<Result>();
  const [contentGeneration, setContentGeneration] = useState('');
  const [generationStatus, setGenerationStatus] = useState<GenerationStatus>();
  const [confirmApply, setConfirmApply] = useState(false);
  const [busy, setBusy] = useState(false);

  const paths = useMemo<ContentPathsRequest>(() => ({
    ...(contentRoot ? { contentRoot } : {}),
    ...(irRoot ? { irRoot } : {}),
    ...(registryPath ? { registryPath } : {}),
  }), [contentRoot, irRoot, registryPath]);

  const run = useCallback(async (operation: () => Promise<CoreOperationResult>) => {
    setBusy(true);
    try {
      const next = await operation();
      setResult(next);
      const generation = recordData(next)?.contentGeneration;
      if (typeof generation === 'string') setContentGeneration(generation);
      const status = recordData(next)?.generationStatus;
      if (status && typeof status === 'object' && !Array.isArray(status)) {
        setGenerationStatus(status as GenerationStatus);
      }
      return next;
    } finally {
      setBusy(false);
    }
  }, []);

  const inspect = useCallback(() => run(() => window.electron.contentInspect(paths)), [paths, run]);
  const resolve = useCallback(() => run(() => window.electron.contentResolve(paths)), [paths, run]);
  const validate = useCallback(() => run(() => window.electron.contentValidate(paths)), [paths, run]);
  const diff = useCallback(() => run(() => window.electron.contentDiff(paths)), [paths, run]);
  const compileCheck = useCallback(() => run(() => window.electron.contentCompile({ ...paths, apply: false })), [paths, run]);
  const compileApply = useCallback(() => {
    if (!contentGeneration || !confirmApply) return;
    const request: ContentCompileRequest = {
      ...paths,
      apply: true,
      confirmApply: true,
      expectedContentGeneration: contentGeneration,
    };
    void run(() => window.electron.contentCompile(request));
  }, [confirmApply, contentGeneration, paths, run]);
  const deploy = useCallback(() => {
    if (!contentGeneration || !gameRoot || generationStatus?.state !== 'current') return;
    void run(() => window.electron.contentDeploy({ ...paths, gameRoot }));
  }, [contentGeneration, gameRoot, generationStatus?.state, paths, run]);

  const data = recordData(result);
  const diffCount = data?.diff && typeof data.diff === 'object'
    ? Object.values(data.diff).reduce((count, entries) => count + (Array.isArray(entries) ? entries.length : 0), 0)
    : 0;
  const capabilities = capabilityFor(result);
  const diagnostics = diagnosticsFor(result);

  return (
    <div className={classes.container}>
      <Title1 className={classes.title}>Content pipeline</Title1>
      <Card className={classes.card}>
        <CardHeader
          header={<Body1>Authored content</Body1>}
          description={<Caption1>All operations use the shared resolver, validator, and compiler. Generated IR is read-only here.</Caption1>}
        />
        <Field label="Content root">
          <FileInput value={contentRoot} onChange={setContentRoot} directory placeholder="Select campaign/content" />
        </Field>
        <Field label="Compiled IR root (optional)">
          <FileInput value={irRoot} onChange={setIrRoot} directory placeholder="Use the managed source root" />
        </Field>
        <Field label="ID registry (optional)">
          <FileInput value={registryPath} onChange={setRegistryPath} placeholder="Select campaign/id-registry.json" />
        </Field>
        <CardFooter className={classes.row}>
          <Button disabled={busy} onClick={() => void inspect()}>Inspect</Button>
          <Button disabled={busy} onClick={() => void resolve()}>Resolve</Button>
          <Button disabled={busy} onClick={() => void validate()}>Validate</Button>
          <Button disabled={busy} onClick={() => void diff()}>Diff</Button>
          <Button disabled={busy} onClick={() => void compileCheck()}>Compile check</Button>
        </CardFooter>
      </Card>

      <Card className={classes.card}>
        <CardHeader
          header={<Body1>Apply and deploy</Body1>}
          description={<Caption1>Apply requires the current inspected content generation and an explicit confirmation. Deploy is generation-guarded before runtime access.</Caption1>}
        />
        <label className={classes.check}>
          <input type="checkbox" checked={confirmApply} onChange={(event) => setConfirmApply(event.currentTarget.checked)} />
          I understand this writes compiler-managed IR and the ID registry.
        </label>
        <Field label="Game root">
          <FileInput value={gameRoot} onChange={setGameRoot} directory placeholder="Select a game root" />
        </Field>
        <CardFooter className={classes.row}>
          <Button
            appearance="primary"
            disabled={busy || !contentGeneration || !confirmApply}
            onClick={compileApply}
          >
            Compile and apply
          </Button>
          <Button
            appearance="primary"
            disabled={busy || !contentGeneration || !gameRoot || generationStatus?.state !== 'current'}
            onClick={deploy}
          >
            Managed deploy
          </Button>
        </CardFooter>
        <Caption1 className={classes.generation}>
          Current inspected content generation: {contentGeneration || 'not inspected'}
        </Caption1>
        <Caption1 className={classes.generation}>
          Compiled IR generation: {generationStatus?.irGeneration || 'missing'}
        </Caption1>
        <Caption1>
          Generation status: {generationStatus?.state || 'not inspected'}
          {generationStatus?.mismatches.length ? ` (${generationStatus.mismatches.join(', ')})` : ''}
        </Caption1>
      </Card>

      <Card className={classes.card}>
        <CardHeader header={<Body1>Diagnostics and semantic diff</Body1>} />
        {capabilities.length > 0 && (
          <>
            <Caption1>Blocking capabilities</Caption1>
            <ul className={classes.diagnostic}>
              {capabilities.map((entry, index) => <li key={`${entry.code}-${index}`}>{entry.code}: {entry.message}</li>)}
            </ul>
          </>
        )}
        {diagnostics.length > 0 && (
          <>
            <Caption1>Source diagnostics</Caption1>
            <ul className={classes.diagnostic}>
              {diagnostics.map((entry, index) => (
                <li key={`${entry.code}-${index}`}>
                  {entry.code}: {entry.message}{locationFor(entry) ? ` (${locationFor(entry)})` : ''}
                  {(entry.sourcePath || entry.path) && (
                    <Button
                      appearance="subtle"
                      size="small"
                      onClick={() => void window.electron.contentRevealSource({ ...paths, sourcePath: entry.sourcePath || entry.path || '' })}
                    >
                      Show source
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        <Caption1>Semantic diff entries: {diffCount}</Caption1>
        <pre className={classes.output}>{result ? JSON.stringify(result, null, 2) : 'No operation run yet.'}</pre>
      </Card>
    </div>
  );
};
