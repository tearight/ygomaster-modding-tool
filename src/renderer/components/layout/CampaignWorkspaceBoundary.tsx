import { Body1, Button, Card, CardFooter, CardHeader, Caption1, Spinner, makeStyles, tokens } from '@fluentui/react-components';
import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import type { CoreOperationResult } from '../../../common/type';

const useStyles = makeStyles({
  container: { height: '100%', display: 'grid', placeItems: 'center', padding: tokens.spacingHorizontalL },
  card: { maxWidth: '560px' },
});

/** Keeps legacy deep links from attempting to render compiler-owned IR without a campaign workspace. */
export const CampaignWorkspaceBoundary = () => {
  const classes = useStyles();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [status, setStatus] = useState<CoreOperationResult>();

  useEffect(() => {
    if (pathname === '/settings') return;
    setStatus(undefined);
    void window.electron.campaignWorkspaceStatus().then(setStatus);
  }, [pathname]);

  if (pathname === '/settings') return <Outlet />;
  if (!status) return <div className={classes.container}><Spinner label="Checking campaign workspace" /></div>;
  if (status.ok) return <Outlet />;

  const issue = status.problems[0];
  return (
    <div className={classes.container}>
      <Card className={classes.card}>
        <CardHeader
          header={<Body1>Campaign workspace needs attention</Body1>}
          description={<Caption1>{issue?.message || 'Set the campaign workspace before opening campaign tools.'}</Caption1>}
        />
        <Caption1>Campaign tools author only campaign/content. campaign/source is compiler-managed generated IR and cannot be edited here.</Caption1>
        <CardFooter>
          <Button appearance="primary" onClick={() => navigate('/settings')}>Open campaign path settings</Button>
        </CardFooter>
      </Card>
    </div>
  );
};
