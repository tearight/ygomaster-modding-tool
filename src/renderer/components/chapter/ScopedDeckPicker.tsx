import { Caption1, Field, Select } from '@fluentui/react-components';

import { OutOfScopeDeckDiagnostic } from './OutOfScopeDeckDiagnostic';

export interface ScopedDeckCandidate {
  key: string;
  reference: string;
  role?: string;
  folderId?: string;
  breadcrumb?: string[];
  label?: string;
  deepLink?: string;
}

export const normalizeScopedDeckCandidates = (value: unknown): ScopedDeckCandidate[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string') {
      if (!entry.startsWith('deck:')) return [];
      const reference = entry;
      return [{ key: reference.replace(/^deck:/u, ''), reference }];
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const reference = typeof record.reference === 'string' && record.reference.startsWith('deck:') ? record.reference : '';
    const key = typeof record.key === 'string' ? record.key : reference.replace(/^deck:/u, '');
    if (!key || !reference) return [];
    return [{
      key,
      reference,
      ...(typeof record.role === 'string' ? { role: record.role } : {}),
      ...(typeof record.folderId === 'string' ? { folderId: record.folderId } : {}),
      ...(Array.isArray(record.breadcrumb) ? { breadcrumb: record.breadcrumb.filter((part): part is string => typeof part === 'string') } : {}),
      ...(typeof record.label === 'string' ? { label: record.label } : {}),
      ...(typeof record.deepLink === 'string' ? { deepLink: record.deepLink } : {}),
    }];
  });
};

export const scopedDeckCandidateReferences = (candidates: readonly ScopedDeckCandidate[], role: 'cpu' | 'rental') =>
  candidates.filter((candidate) => candidate.role === role).map((candidate) => candidate.reference);

export const scopedDeckValueIsValid = (
  value: string | undefined,
  candidates: readonly ScopedDeckCandidate[],
  role: 'cpu' | 'rental',
  required = false,
) => value
  ? candidates.some((candidate) => candidate.role === role && candidate.reference === value)
  : !required;

export interface ScopedDeckChapterReference {
  id: string;
  duel?: { cpuDeck?: string; rentalDeck?: string };
}

export const findOutOfScopeDeckReferences = (
  chapters: readonly ScopedDeckChapterReference[],
  cpuCandidates: readonly ScopedDeckCandidate[],
  rentalCandidates: readonly ScopedDeckCandidate[],
) => chapters.flatMap((chapter) => {
  const duel = chapter.duel || {};
  const missing: Array<{ chapterId: string; role: 'cpu' | 'rental'; reference: string }> = [];
  if (duel.cpuDeck && !cpuCandidates.some((candidate) => candidate.reference === duel.cpuDeck)) missing.push({ chapterId: chapter.id, role: 'cpu', reference: duel.cpuDeck });
  if (duel.rentalDeck && !rentalCandidates.some((candidate) => candidate.reference === duel.rentalDeck)) missing.push({ chapterId: chapter.id, role: 'rental', reference: duel.rentalDeck });
  return missing;
});

interface ScopedDeckPickerProps {
  label: string;
  role: 'cpu' | 'rental';
  value?: string;
  candidates: readonly ScopedDeckCandidate[];
  folderLabel: string;
  required?: boolean;
  disabled?: boolean;
  onChange: (reference: string) => void;
}

/** Shared by the Gate graph quick editor and the full Chapter editor. */
export const ScopedDeckPicker = ({
  label,
  role,
  value = '',
  candidates,
  folderLabel,
  required,
  disabled,
  onChange,
}: ScopedDeckPickerProps) => {
  const compatible = candidates.filter((candidate) => candidate.role === role);
  const currentInScope = scopedDeckValueIsValid(value, compatible, role, required);
  return <div>
    <Field label={label} required={required} hint={`Gate Deck folder: ${folderLabel} · descendants included`} validationState={currentInScope ? 'none' : 'error'}>
      <Select value={value} disabled={disabled} onChange={(_, data) => onChange(data.value)}>
        <option value="">{required ? `Choose ${label}` : 'None'}</option>
        {!currentInScope && value && <option value={value}>Invalid current value · {value}</option>}
        {compatible.map((candidate) => <option key={candidate.reference} value={candidate.reference}>{candidate.label || candidate.breadcrumb?.join(' / ') || candidate.key}</option>)}
      </Select>
    </Field>
    {!currentInScope && value && <OutOfScopeDeckDiagnostic deckReference={value} role={role} folderLabel={folderLabel} />}
    {!currentInScope && !value && required && <Caption1>Choose a {role.toUpperCase()} Deck from the current Gate scope.</Caption1>}
    {currentInScope && value && <Caption1>{compatible.find((candidate) => candidate.reference === value)?.breadcrumb?.join(' / ') || value}</Caption1>}
  </div>;
};
