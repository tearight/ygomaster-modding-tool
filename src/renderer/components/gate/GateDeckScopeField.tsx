import { Caption1, Field, MessageBar, MessageBarBody, MessageBarTitle, Select } from '@fluentui/react-components';

import type { DeckFolderView } from '../deck/DeckFolderWorkspace';

interface GateDeckScopeFieldProps {
  value?: string;
  folders: readonly DeckFolderView[];
  scopedDeckCount: number;
  outOfScopeCount: number;
  disabled?: boolean;
  onChange: (folderId: string) => void;
}

export const GateDeckScopeField = ({
  value = '',
  folders,
  scopedDeckCount,
  outOfScopeCount,
  disabled,
  onChange,
}: GateDeckScopeFieldProps) => {
  const exists = folders.some((folder) => folder.id === value);
  return <div>
    <Field
      label="Deck folder · authoring scope"
      required
      hint="Chapter Deck candidates include this logical folder and every descendant. Folder metadata is never projected to YgoMaster."
      validationState={value && exists ? 'none' : 'error'}
    >
      <Select value={value} disabled={disabled} onChange={(_, data) => onChange(data.value)}>
        {!value && <option value="">Choose a Gate Deck folder</option>}
        {value && !exists && <option value={value}>Missing folder · {value}</option>}
        {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.breadcrumb.join(' / ')} · {folder.recursiveDeckCount} Decks</option>)}
      </Select>
    </Field>
    <Caption1>{scopedDeckCount} scoped Decks · child folders included</Caption1>
    {outOfScopeCount > 0 && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>{outOfScopeCount} existing Chapter references are outside this scope</MessageBarTitle>References remain unchanged. Use each Chapter picker to review and remap them before candidate apply.</MessageBarBody></MessageBar>}
  </div>;
};
