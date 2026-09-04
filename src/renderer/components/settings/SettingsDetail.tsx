import { Button, Card, CardFooter, CardHeader, Caption1, Field, Toaster, makeStyles, tokens } from '@fluentui/react-components';
import { useCallback, useEffect, useState } from 'react';

import { Settings } from '../../../common/type';
import { useToast } from '../../hooks/useToast';
import { useAppStore } from '../../store';
import { SettingsDetailView } from './SettingsDetailView';
import { FileInput } from '../input/FileInput';

const useStyles = makeStyles({
  container: {
    height: '100vh',
    overflowY: 'auto',
  },
  campaignPaths: {
    margin: tokens.spacingHorizontalL,
  },
  pathFields: {
    display: 'grid',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalM,
  },
});

export const SettingsDetail = () => {
  const classes = useStyles();
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const { toasterId, withToast } = useToast('Success Save', 'Fail Save');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [gameRoot, setGameRoot] = useState('');

  useEffect(() => {
    void window.electron.configShow().then((response) => {
      const data = response.data;
      const config = data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>).config
        : undefined;
      if (!config || typeof config !== 'object' || Array.isArray(config)) return;
      const values = config as Record<string, unknown>;
      if (typeof values.workspaceRoot === 'string') setWorkspaceRoot(values.workspaceRoot);
      if (typeof values.gameRoot === 'string') setGameRoot(values.gameRoot);
    });
  }, []);

  const handleSubmit = useCallback(
    (settings: Settings) =>
      withToast(async () => {
        await saveSettings(settings);
      }),
    [saveSettings, withToast],
  );

  const handleClickOpenSettingsFile = useCallback(
    () => window.electron.openSettingsFile(),
    [],
  );

  const handleClickOpenLogFile = useCallback(
    () => window.electron.openLogFile(),
    [],
  );

  const saveCampaignPaths = useCallback(
    () => withToast(async () => {
      if (!workspaceRoot) throw new Error('Select the campaign workspace folder first.');
      const workspace = await window.electron.configSetWorkspaceRoot({ path: workspaceRoot });
      if (!workspace.ok) throw new Error(workspace.problems.map((entry) => entry.message).join('\n'));
      if (gameRoot) {
        const game = await window.electron.configSetGameRoot({ path: gameRoot });
        if (!game.ok) throw new Error(game.problems.map((entry) => entry.message).join('\n'));
      }
    }),
    [gameRoot, withToast, workspaceRoot],
  );

  return (
    <>
      <div className={classes.container}>
        <SettingsDetailView
          settings={settings}
          onSubmit={handleSubmit}
          onClickOpenSettingsFile={handleClickOpenSettingsFile}
          onClickOpenLogFile={handleClickOpenLogFile}
        />
        <Card className={classes.campaignPaths}>
          <CardHeader
            header="Campaign paths"
            description={<Caption1>Choose the workspace that contains campaign/content. The app derives campaign/source and campaign/id-registry.json automatically.</Caption1>}
          />
          <div className={classes.pathFields}>
            <Field label="Campaign workspace" required>
              <FileInput value={workspaceRoot} onChange={setWorkspaceRoot} directory placeholder="Select the folder containing campaign" />
            </Field>
            <Field label="Game root (for managed deploy)">
              <FileInput value={gameRoot} onChange={setGameRoot} directory placeholder="Select the YgoMaster game root" />
            </Field>
          </div>
          <CardFooter>
            <Button appearance="primary" onClick={() => void saveCampaignPaths()}>Save campaign paths</Button>
          </CardFooter>
        </Card>
      </div>
      <Toaster toasterId={toasterId} />
    </>
  );
};
