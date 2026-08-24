import {
  Body1,
  Button,
  Caption1,
  Card,
  CardFooter,
  CardHeader,
  Field,
  Title1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAppStore } from '../../store';
import { FileInput } from '../input/FileInput';

const useStyles = makeStyles({
  container: { height: '100vh', overflowY: 'auto', padding: tokens.spacingHorizontalL },
  title: { marginBottom: tokens.spacingVerticalL },
  card: { marginBottom: tokens.spacingVerticalL },
  row: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  deploymentList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: 0 },
  deploymentRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS },
  deploymentPath: { flex: '1 1 420px', textAlign: 'left', whiteSpace: 'normal', overflowWrap: 'anywhere' },
  output: { whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: '240px', padding: tokens.spacingHorizontalS },
});

interface CoreResultLike {
  ok: boolean;
  warnings?: unknown[];
  problems?: unknown[];
  data?: unknown;
}

const displayResult = (value: CoreResultLike | undefined) =>
  value ? JSON.stringify(value, null, 2) : 'No operation run yet.';

interface DeploymentEntry {
  path: string;
  metadata?: {
    campaign?: { name?: string; version?: string };
    deployedAt?: string;
  };
}

const deploymentEntries = (value: CoreResultLike | undefined): DeploymentEntry[] => {
  if (!Array.isArray(value?.data)) return [];
  return value.data.filter((entry): entry is DeploymentEntry => {
    if (!entry || typeof entry !== 'object') return false;
    return typeof (entry as { path?: unknown }).path === 'string';
  });
};

export const Utilities = () => {
  const classes = useStyles();
  const navigate = useNavigate();
  const paths = useAppStore((state) => state.paths);
  const [sourceRoot, setSourceRoot] = useState('');
  const [gameRoot, setGameRoot] = useState('');
  const [lastResult, setLastResult] = useState<CoreResultLike>();
  const [deployments, setDeployments] = useState<CoreResultLike>();
  const [selectedDeployment, setSelectedDeployment] = useState<string>();
  const [deploymentAction, setDeploymentAction] = useState<CoreResultLike>();
  const [loading, setLoading] = useState(false);

  const run = useCallback(async (operation: () => Promise<CoreResultLike>) => {
    setLoading(true);
    try {
      const value = await operation();
      setLastResult(value);
      return value;
    } finally {
      setLoading(false);
    }
  }, []);

  const loadConfig = useCallback(async () => {
    const value = await window.electron.configShow();
    const config = (value.data as { config?: { sourceRoot?: string; gameRoot?: string } } | undefined)?.config;
    if (config?.sourceRoot) setSourceRoot(config.sourceRoot);
    if (config?.gameRoot) setGameRoot(config.gameRoot);
  }, []);

  const refreshDeployments = useCallback(async () => {
    const value = await run(() => window.electron.deploymentList({ gameRoot }));
    setDeployments(value);
    const entries = deploymentEntries(value);
    setSelectedDeployment((current) =>
      current && entries.some((entry) => entry.path === current) ? current : entries[0]?.path,
    );
    setDeploymentAction(undefined);
  }, [gameRoot, run]);

  const inspectDeployment = useCallback(async (deploymentPath: string) => {
    setSelectedDeployment(deploymentPath);
    const value = await run(() => window.electron.deploymentInspect({ path: deploymentPath }));
    setDeploymentAction(value);
  }, [run]);

  const launchSelectedDeployment = useCallback(async () => {
    if (!selectedDeployment) return;
    const value = await run(() => window.electron.deploymentLaunch({ path: selectedDeployment }));
    setDeploymentAction(value);
  }, [run, selectedDeployment]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  return (
    <div className={classes.container}>
      <Title1 className={classes.title}>Campaign</Title1>
      <Card className={classes.card}>
        <CardHeader
          header={<Body1>Workspace</Body1>}
          description={<Caption1>Configure source/game roots, initialize the source tree, and validate additive overlays.</Caption1>}
        />
        <Field label="Source root">
          <FileInput value={sourceRoot} onChange={setSourceRoot} directory placeholder="Select campaign/source" />
        </Field>
        <Field label="Game root">
          <FileInput value={gameRoot} onChange={setGameRoot} directory placeholder="Select a game root" />
        </Field>
        <CardFooter className={classes.row}>
          <Button disabled={loading} onClick={() => navigate('/content')}>Content pipeline</Button>
          <Button disabled={loading} onClick={() => run(() => window.electron.configSetSourceRoot({ path: sourceRoot }))}>Save source root</Button>
          <Button disabled={loading} onClick={() => run(() => window.electron.configSetGameRoot({ path: gameRoot }))}>Save game root</Button>
          <Button disabled={loading} onClick={() => run(() => window.electron.workspaceInit({ sourceRoot }))}>Workspace init</Button>
          <Button disabled={loading} onClick={() => run(() => window.electron.workspaceInspect({ sourceRoot }))}>Inspect</Button>
          <Button appearance="primary" disabled={loading} onClick={() => run(() => window.electron.campaignValidate({ sourceRoot }))}>Validate</Button>
        </CardFooter>
      </Card>

      <Card className={classes.card}>
        <CardHeader
          header={<Body1>Runtime and deployment</Body1>}
          description={<Caption1>Fetch the latest official runtime, deploy a new sibling folder, and launch only an inspected deployment.</Caption1>}
        />
        <CardFooter className={classes.row}>
          <Button disabled={loading} onClick={() => run(() => window.electron.runtimeStatus())}>Runtime status</Button>
          <Button disabled={loading} onClick={() => run(() => window.electron.runtimeFetch())}>Fetch latest runtime</Button>
          <Button appearance="primary" disabled={loading || !gameRoot} onClick={() => run(() => window.electron.campaignDeploy({ sourceRoot, gameRoot }))}>Deploy</Button>
          <Button disabled={loading || !gameRoot} onClick={() => void refreshDeployments()}>Refresh deployments</Button>
        </CardFooter>
        {deployments && (
          <>
            <ul className={classes.deploymentList}>
              {deploymentEntries(deployments).map((deployment) => (
                <li key={deployment.path} className={classes.deploymentRow}>
                  <Button
                    className={classes.deploymentPath}
                    appearance={deployment.path === selectedDeployment ? 'primary' : 'subtle'}
                    disabled={loading}
                    onClick={() => setSelectedDeployment(deployment.path)}
                  >
                    {deployment.path}
                  </Button>
                  <Button disabled={loading} onClick={() => void inspectDeployment(deployment.path)}>Inspect</Button>
                </li>
              ))}
            </ul>
            {!deploymentEntries(deployments).length && <Caption1>No inspected deployments found.</Caption1>}
            <CardFooter className={classes.row}>
              <Button
                appearance="primary"
                disabled={loading || !selectedDeployment}
                onClick={() => void launchSelectedDeployment()}
              >
                Launch selected deployment
              </Button>
              {selectedDeployment && <Caption1>{selectedDeployment}</Caption1>}
            </CardFooter>
            {deploymentAction && <pre className={classes.output}>{displayResult(deploymentAction)}</pre>}
            <pre className={classes.output}>{displayResult(deployments)}</pre>
          </>
        )}
      </Card>

      <Card className={classes.card}>
        <CardHeader header={<Body1>Result</Body1>} description={<Caption1>CLI and UI operations return the same structured result contract.</Caption1>} />
        <pre className={classes.output}>{displayResult(lastResult)}</pre>
      </Card>
      <Caption1>Authoring path: {paths.gatePath || 'not initialized'}</Caption1>
    </div>
  );
};
