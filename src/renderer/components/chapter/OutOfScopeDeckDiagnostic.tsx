import { Button, Caption1, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { useNavigate } from 'react-router-dom';

interface OutOfScopeDeckDiagnosticProps {
  deckReference: string;
  role: 'cpu' | 'rental';
  folderLabel: string;
}

export const OutOfScopeDeckDiagnostic = ({
  deckReference,
  role,
  folderLabel,
}: OutOfScopeDeckDiagnosticProps) => {
  const navigate = useNavigate();
  const key = deckReference.replace(/^deck:/u, '');
  return <MessageBar intent="error">
    <MessageBarBody>
      <MessageBarTitle>Current {role.toUpperCase()} Deck is outside the Gate scope</MessageBarTitle>
      <Caption1>{deckReference} is preserved. It was not replaced when the Gate folder changed to {folderLabel}. Choose a scoped Deck explicitly before applying this candidate.</Caption1>
    </MessageBarBody>
    <MessageBarActions>
      <Button appearance="subtle" onClick={() => navigate(`/decks?deck=${encodeURIComponent(key)}`)}>Open Deck</Button>
    </MessageBarActions>
  </MessageBar>;
};
