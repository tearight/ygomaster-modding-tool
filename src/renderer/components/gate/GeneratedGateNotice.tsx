import { Button, Card, CardFooter, CardHeader, Caption1, Title1, makeStyles, tokens } from '@fluentui/react-components';
import { useNavigate } from 'react-router-dom';

const useStyles = makeStyles({
  container: { height: '100vh', overflowY: 'auto', padding: tokens.spacingHorizontalL },
  title: { marginBottom: tokens.spacingVerticalL },
});

export const GeneratedGateNotice = ({ title }: { title: string }) => {
  const classes = useStyles();
  const navigate = useNavigate();
  return (
    <div className={classes.container}>
      <Title1 className={classes.title}>{title}</Title1>
      <Card>
        <CardHeader
          header="Gate editing has moved to the campaign source"
          description={<Caption1>These gates are compiler-generated from campaign/content and cannot safely be edited as standalone JSON. Use the Content pipeline to validate, compile, and deploy the authored campaign.</Caption1>}
        />
        <CardFooter>
          <Button appearance="primary" onClick={() => navigate('/content')}>Open Content pipeline</Button>
        </CardFooter>
      </Card>
    </div>
  );
};
