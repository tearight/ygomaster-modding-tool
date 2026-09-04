import { Body1, Caption1, Field, Input, Select, makeStyles, tokens } from '@fluentui/react-components';

import { ScopedDeckCandidate, ScopedDeckPicker } from '../chapter/ScopedDeckPicker';

export interface AuthoredChapterDraft {
  id: string;
  kind: string;
  parent?: string;
  descriptionKey?: unknown;
  nameKey?: unknown;
  duel?: {
    playerMode?: string;
    cpuDeck?: string;
    rentalDeck?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const useStyles = makeStyles({
  container: { display: 'grid', gap: tokens.spacingVerticalM },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: tokens.spacingHorizontalM },
});

interface ChapterDuelFieldsProps {
  chapter: AuthoredChapterDraft;
  chapters: readonly AuthoredChapterDraft[];
  folderLabel: string;
  cpuCandidates: readonly ScopedDeckCandidate[];
  rentalCandidates: readonly ScopedDeckCandidate[];
  onChange: (chapter: AuthoredChapterDraft) => void;
}

/** One implementation is rendered in both Graph quick edit and full Chapter edit. */
export const ChapterDuelFields = ({ chapter, chapters, folderLabel, cpuCandidates, rentalCandidates, onChange }: ChapterDuelFieldsProps) => {
  const classes = useStyles();
  const duel = chapter.duel || {};
  const changeDuel = (patch: Record<string, unknown>) => onChange({ ...chapter, duel: { ...duel, ...patch } });
  return <div className={classes.container}>
    <Field label="Gate Deck folder · read-only scope" hint="Configured on the Gate; all descendant logical folders are included.">
      <Input value={`${folderLabel} / **`} readOnly />
    </Field>
    <div className={classes.grid}>
      <Field label="Previous Chapter"><Select value={chapter.parent || ''} onChange={(_, data) => onChange({ ...chapter, ...(data.value ? { parent: data.value } : { parent: undefined }) })}><option value="">Gate entry</option>{chapters.filter((candidate) => candidate.id !== chapter.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id}</option>)}</Select></Field>
      <Field label="Player mode"><Select value={typeof duel.playerMode === 'string' ? duel.playerMode : 'mydeck'} onChange={(_, data) => changeDuel({ playerMode: data.value })}><option value="mydeck">My Deck</option><option value="rental">Rental</option><option value="both">Both</option></Select></Field>
    </div>
    <ScopedDeckPicker label="CPU Deck" role="cpu" required value={typeof duel.cpuDeck === 'string' ? duel.cpuDeck : ''} candidates={cpuCandidates} folderLabel={folderLabel} onChange={(cpuDeck) => changeDuel({ cpuDeck })} />
    {(duel.playerMode === 'rental' || duel.playerMode === 'both' || duel.rentalDeck) && <ScopedDeckPicker label="Rental Deck" role="rental" required={duel.playerMode === 'rental' || duel.playerMode === 'both'} value={typeof duel.rentalDeck === 'string' ? duel.rentalDeck : ''} candidates={rentalCandidates} folderLabel={folderLabel} onChange={(rentalDeck) => changeDuel({ rentalDeck })} />}
  </div>;
};

interface ChapterComposerProps extends ChapterDuelFieldsProps {
  title?: string;
}

export const ChapterComposer = ({ title = 'Full Chapter editor', chapter, ...props }: ChapterComposerProps) => {
  const classes = useStyles();
  return <section className={classes.container} aria-label="Full Chapter editor">
    <Body1>{title}</Body1>
    <Caption1>Symbolic Chapter {chapter.id}. Numeric target IDs and folder metadata are program-managed.</Caption1>
    <Field label="Chapter symbolic key"><Input value={chapter.id} readOnly /></Field>
    <ChapterDuelFields chapter={chapter} {...props} />
  </section>;
};
