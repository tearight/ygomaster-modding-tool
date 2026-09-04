export const DECK_AUTHORING_SECTIONS = ['main', 'extra', 'side'] as const;
export type DeckAuthoringSection = (typeof DECK_AUTHORING_SECTIONS)[number];
export type DeckAuthoringSections = Record<DeckAuthoringSection, string>;

export const emptyDeckAuthoringSections = (): DeckAuthoringSections => ({ main: '', extra: '', side: '' });

/** UI-only text projection. The core parser remains the schema authority. */
export const parseDeckAuthoringSections = (source: string): DeckAuthoringSections => {
  const sections = emptyDeckAuthoringSections();
  let current: DeckAuthoringSection | undefined;
  const seen = new Set<DeckAuthoringSection>();
  const lines: Record<DeckAuthoringSection, string[]> = { main: [], extra: [], side: [] };
  for (const [index, original] of source.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n').entries()) {
    const header = /^\s*\[(main|extra|side)\]\s*(?:#.*)?$/iu.exec(original);
    if (header) {
      current = header[1]?.toLowerCase() as DeckAuthoringSection;
      if (seen.has(current)) throw new Error(`Duplicate [${current}] section at line ${index + 1}`);
      seen.add(current);
      continue;
    }
    if (!current && original.trim()) throw new Error(`Content outside a Deck section at line ${index + 1}`);
    if (current && (original.trim() || lines[current].length)) lines[current].push(original.replace(/\s+$/u, ''));
  }
  for (const section of DECK_AUTHORING_SECTIONS) {
    while (lines[section].at(-1) === '') lines[section].pop();
    sections[section] = lines[section].join('\n');
  }
  return sections;
};

export const formatDeckAuthoringSections = (sections: DeckAuthoringSections): string =>
  `${DECK_AUTHORING_SECTIONS.map((section) => {
    const body = sections[section].replace(/\r\n?/gu, '\n').split('\n').map((line) => line.replace(/\s+$/u, '')).filter((line, index, lines) => line || (index > 0 && index < lines.length - 1)).join('\n').trim();
    return `[${section}]${body ? `\n${body}` : ''}`;
  }).join('\n\n')}\n`;

export const insertDeckAuthoringCard = (
  sections: DeckAuthoringSections,
  section: DeckAuthoringSection,
  englishName: string,
  count = 1,
): DeckAuthoringSections => {
  const name = englishName.trim();
  if (!name || !Number.isSafeInteger(count) || count < 1) return sections;
  return { ...sections, [section]: `${sections[section].trimEnd()}${sections[section].trim() ? '\n' : ''}${count} ${name}` };
};

export const deckAuthoringLineLocation = (sections: DeckAuthoringSections, line: number): { section: DeckAuthoringSection; line: number } | undefined => {
  if (!Number.isSafeInteger(line) || line < 1) return undefined;
  let offset = 1;
  for (const section of DECK_AUTHORING_SECTIONS) {
    const count = sections[section] ? sections[section].split(/\r?\n/u).length : 0;
    if (line > offset && line <= offset + count) return { section, line: line - offset };
    offset += count + 2;
  }
  return undefined;
};
