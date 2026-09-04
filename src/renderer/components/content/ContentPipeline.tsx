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
import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  ContentCompileRequest,
  ContentPathsRequest,
  CoreOperationProblem,
  CoreOperationResult,
} from '../../../common/type';
import { RuntimePolicyEditor, type RuntimePolicyFieldDefinition } from './RuntimePolicyEditor';

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
type RegistryReviewChange = {
  key: string;
  action: 'add' | 'remove' | 'update' | 'retire';
  before?: number;
  after?: number;
  metadataChanged?: boolean;
  dependentKeys: string[];
  beforeChapter?: { expression: string; gateKey?: string };
  afterChapter?: { expression: string; gateKey?: string };
};
type RegistryReview = {
  baseGeneration: string;
  plannedGeneration: string;
  changeCount: number;
  contentGeneration: string;
  namespaces: Array<{
    namespace: string;
    range: { min: number; max: number };
    assignmentCount: number;
    tombstoneCount: number;
    changes: RegistryReviewChange[];
  }>;
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
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [gameRoot, setGameRoot] = useState('');
  const [result, setResult] = useState<Result>();
  const [contentGeneration, setContentGeneration] = useState('');
  const [generationStatus, setGenerationStatus] = useState<GenerationStatus>();
  const [confirmApply, setConfirmApply] = useState(false);
  const [registryReview, setRegistryReview] = useState<RegistryReview>();
  const [busy, setBusy] = useState(false);
  const [runtimePolicy, setRuntimePolicy] = useState('{\n  "settings": {},\n  "shop": {},\n  "client": {}\n}');
  const [runtimePolicyDefinitions, setRuntimePolicyDefinitions] = useState<RuntimePolicyFieldDefinition[]>([]);
  const [confirmRuntimePolicy, setConfirmRuntimePolicy] = useState(false);
  const [confirmSaveCarryover, setConfirmSaveCarryover] = useState(false);

  const paths = useMemo<ContentPathsRequest>(() => ({}), []);

  useEffect(() => {
    void window.electron.configShow().then((response) => {
      const config = recordData(response)?.config;
      if (!config || typeof config !== 'object' || Array.isArray(config)) return;
      const values = config as Record<string, unknown>;
      if (typeof values.workspaceRoot === 'string') setWorkspaceRoot(values.workspaceRoot);
      if (typeof values.gameRoot === 'string') setGameRoot(values.gameRoot);
    });
  }, []);

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

  const clearRegistryReview = useCallback(() => {
    setRegistryReview(undefined);
    setConfirmApply(false);
  }, []);
  const inspect = useCallback(() => { clearRegistryReview(); return run(() => window.electron.contentInspect(paths)); }, [clearRegistryReview, paths, run]);
  const resolve = useCallback(() => { clearRegistryReview(); return run(() => window.electron.contentResolve(paths)); }, [clearRegistryReview, paths, run]);
  const validate = useCallback(() => { clearRegistryReview(); return run(() => window.electron.contentValidate(paths)); }, [clearRegistryReview, paths, run]);
  const diff = useCallback(() => { clearRegistryReview(); return run(() => window.electron.contentDiff(paths)); }, [clearRegistryReview, paths, run]);
  const compileCheck = useCallback(async () => {
    clearRegistryReview();
    const next = await run(() => window.electron.contentCompile({ ...paths, apply: false }));
    const data = recordData(next);
    const review = data?.registryReview;
    const generation = data?.contentGeneration;
    if (next.ok && review && typeof review === 'object' && !Array.isArray(review) && typeof generation === 'string') {
      setRegistryReview({ ...(review as Omit<RegistryReview, 'contentGeneration'>), contentGeneration: generation });
    }
    return next;
  }, [clearRegistryReview, paths, run]);
  const compileApply = useCallback(() => {
    if (!contentGeneration || !confirmApply || !registryReview || registryReview.contentGeneration !== contentGeneration) return;
    const request: ContentCompileRequest = {
      ...paths,
      apply: true,
      confirmApply: true,
      expectedContentGeneration: contentGeneration,
      expectedRegistryGeneration: registryReview.baseGeneration,
      expectedPlannedRegistryGeneration: registryReview.plannedGeneration,
    };
    void run(() => window.electron.contentCompile(request)).finally(clearRegistryReview);
  }, [clearRegistryReview, confirmApply, contentGeneration, paths, registryReview, run]);
  const deploy = useCallback(() => {
    if (!contentGeneration || !gameRoot || generationStatus?.state !== 'current') return;
    void run(() => window.electron.contentDeploy({ ...paths, gameRoot, confirmSaveCarryover }));
  }, [confirmSaveCarryover, contentGeneration, gameRoot, generationStatus?.state, paths, run]);
  const loadRuntimePolicy = useCallback(() => run(async () => {
    const next = await window.electron.contentRuntimePolicyRead(paths);
    const policy = recordData(next)?.policy;
    if (policy && typeof policy === 'object') setRuntimePolicy(JSON.stringify(policy, null, 2));
    const definitions = recordData(next)?.fieldDefinitions;
    if (Array.isArray(definitions)) setRuntimePolicyDefinitions(definitions as RuntimePolicyFieldDefinition[]);
    setConfirmRuntimePolicy(false);
    return next;
  }), [paths, run]);
  const saveRuntimePolicy = useCallback(() => run(async () => {
    clearRegistryReview();
    try {
      const policy = JSON.parse(runtimePolicy) as Record<string, Record<string, unknown>>;
      return await window.electron.contentRuntimePolicyWrite({
        ...paths,
        policy,
        expectedContentGeneration: contentGeneration,
        confirmApply: confirmRuntimePolicy,
      });
    } catch (error) {
      return { ok: false, exitCode: 2, exitName: 'USAGE_ERROR', warnings: [], problems: [{ code: 'RUNTIME_POLICY_JSON_INVALID', message: String(error) }] };
    }
  }), [clearRegistryReview, confirmRuntimePolicy, contentGeneration, paths, run, runtimePolicy]);
  const runtimePolicyObject = useMemo<Record<'settings' | 'shop' | 'client', Record<string, unknown>>>(() => {
    try {
      const parsed = JSON.parse(runtimePolicy) as Record<string, unknown>;
      return Object.fromEntries(['settings', 'shop', 'client'].map((family) => [family, parsed[family] && typeof parsed[family] === 'object' && !Array.isArray(parsed[family]) ? parsed[family] : {}])) as Record<'settings' | 'shop' | 'client', Record<string, unknown>>;
    } catch {
      return { settings: {}, shop: {}, client: {} };
    }
  }, [runtimePolicy]);

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
          description={<Caption1>One campaign workspace supplies content, generated IR, and the ID registry. Generated IR is read-only here.</Caption1>}
        />
        <Caption1>Campaign workspace: {workspaceRoot || 'Not configured — set it in Settings.'}</Caption1>
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
          header={<Body1>ID registry allocation review</Body1>}
          description={<Caption1>Compile check proposes symbolic key allocations. Numeric IDs and registry JSON are read-only; no assignment is silently reallocated.</Caption1>}
        />
        {!registryReview && <Caption1>Run Compile check to create a generation-bound allocation review before apply.</Caption1>}
        {registryReview && (
          <>
            <Caption1 className={classes.generation}>Base generation: {registryReview.baseGeneration}</Caption1>
            <Caption1 className={classes.generation}>Planned generation: {registryReview.plannedGeneration}</Caption1>
            <Caption1>Proposed changes: {registryReview.changeCount}</Caption1>
            {registryReview.namespaces.map((namespace) => (
              <section key={namespace.namespace}>
                <Body1>{namespace.namespace} — range {namespace.range.min}–{namespace.range.max}</Body1>
                <Caption1>Assignments: {namespace.assignmentCount}; retired tombstones: {namespace.tombstoneCount}</Caption1>
                {namespace.changes.length > 0 && (
                  <ul className={classes.diagnostic}>
                    {namespace.changes.map((change, index) => {
                      const chapter = change.afterChapter || change.beforeChapter;
                      return (
                        <li key={`${change.key}-${change.action}-${index}`}>
                          {change.action.toUpperCase()}: {change.key}
                          {change.before !== undefined ? ` ${change.before}` : ''}
                          {change.after !== undefined ? ` → ${change.after}` : ''}
                          {change.metadataChanged ? ' (metadata changed)' : ''}
                          {chapter ? `; chapter composite ${chapter.expression}${chapter.gateKey ? ` via ${chapter.gateKey}` : ''}` : ''}
                          {change.dependentKeys.length ? `; dependent chapters: ${change.dependentKeys.join(', ')}` : ''}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            ))}
          </>
        )}
      </Card>

      <Card className={classes.card}>
        <CardHeader
          header={<Body1>Campaign runtime policy</Body1>}
          description={<Caption1>Settings, Shop policy, and ClientSettings belong to this campaign. Only documented allowlisted keys validate and deploy. Initial gems/CP apply only before Player.json exists.</Caption1>}
        />
        <Caption1>All changes patch only a fresh deployment baseline. They never edit Player.json, an existing runtime, client files, or saves.</Caption1>
        <RuntimePolicyEditor policy={runtimePolicyObject} definitions={runtimePolicyDefinitions} onChange={(policy) => {
          setRuntimePolicy(JSON.stringify(policy, null, 2));
          setConfirmRuntimePolicy(false);
        }} />
        <Field label="Advanced policy JSON (bidirectional escape hatch and exact review)">
          <textarea className={classes.output} value={runtimePolicy} onChange={(event) => {
            setRuntimePolicy(event.currentTarget.value);
            setConfirmRuntimePolicy(false);
          }} aria-label="Campaign runtime policy JSON" />
        </Field>
        <label className={classes.check}>
          <input type="checkbox" checked={confirmRuntimePolicy} onChange={(event) => setConfirmRuntimePolicy(event.currentTarget.checked)} />
          I reviewed the semantic diff and confirm this authored policy write.
        </label>
        <CardFooter className={classes.row}>
          <Button disabled={busy} onClick={() => void loadRuntimePolicy()}>Load policy</Button>
          <Button disabled={busy || !contentGeneration} onClick={() => void saveRuntimePolicy()}>{confirmRuntimePolicy ? 'Save policy' : 'Preview policy diff'}</Button>
        </CardFooter>
      </Card>

      <Card className={classes.card}>
        <CardHeader
          header={<Body1>Apply and deploy</Body1>}
          description={<Caption1>Apply requires the current inspected content generation and an explicit confirmation. Deploy is generation-guarded before runtime access.</Caption1>}
        />
        <label className={classes.check}>
          <input type="checkbox" checked={confirmApply} onChange={(event) => setConfirmApply(event.currentTarget.checked)} />
          I reviewed the exact content and ID registry generations and approve this compiler-managed IR and registry write.
        </label>
        <Caption1>Game root: {gameRoot || 'Not configured — set it in Settings.'}</Caption1>
        <label className={classes.check}>
          <input type="checkbox" checked={confirmSaveCarryover} onChange={(event) => setConfirmSaveCarryover(event.currentTarget.checked)} />
          Carry the compatible Local save into the stable current deployment. The source remains in the timestamp archive and a verified backup is kept.
        </label>
        <CardFooter className={classes.row}>
          <Button
            appearance="primary"
            disabled={busy || !contentGeneration || !confirmApply || !registryReview || registryReview.contentGeneration !== contentGeneration}
            onClick={compileApply}
          >
            Compile and apply
          </Button>
          <Button
            appearance="primary"
            disabled={busy || !contentGeneration || !gameRoot || generationStatus?.state !== 'current'}
            onClick={deploy}
          >
            Deploy stable current
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
