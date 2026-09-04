import { ContentFormatError, normalizeSymbolicReference } from './content-format';
import type { JsonObject, Problem } from './types';

export const DECK_FOLDER_CATALOG_VERSION = 1 as const;
export const DECK_FOLDER_CATALOG_KIND = 'deck-folders' as const;
export const DECK_FOLDER_CATALOG_FILE = '_folders.json' as const;
export const DECK_IDENTITY_VERSION = 1 as const;
export const DECK_ADAPTER_DIRECTORY = 'decks' as const;

export const DECK_ORGANIZATION_CODES = Object.freeze({
  CATALOG_INVALID: 'DECK_FOLDER_CATALOG_INVALID',
  FORMAT_VERSION_INVALID: 'DECK_FOLDER_FORMAT_VERSION_INVALID',
  KIND_INVALID: 'DECK_FOLDER_KIND_INVALID',
  FIELD_UNKNOWN: 'DECK_FOLDER_FIELD_UNKNOWN',
  FOLDERS_INVALID: 'DECK_FOLDERS_INVALID',
  FOLDER_INVALID: 'DECK_FOLDER_INVALID',
  FOLDER_ID_INVALID: 'DECK_FOLDER_ID_INVALID',
  FOLDER_ID_DUPLICATE: 'DECK_FOLDER_ID_DUPLICATE',
  FOLDER_NAME_INVALID: 'DECK_FOLDER_NAME_INVALID',
  FOLDER_PARENT_INVALID: 'DECK_FOLDER_PARENT_INVALID',
  FOLDER_PARENT_SELF: 'DECK_FOLDER_PARENT_SELF',
  FOLDER_PARENT_ORPHAN: 'DECK_FOLDER_PARENT_ORPHAN',
  FOLDER_PARENT_CYCLE: 'DECK_FOLDER_PARENT_CYCLE',
  DECK_FOLDER_REF_INVALID: 'DECK_FOLDER_REF_INVALID',
  DECK_FOLDER_REF_ORPHAN: 'DECK_FOLDER_REF_ORPHAN',
  GATE_FOLDER_REQUIRED: 'GATE_DECK_FOLDER_REQUIRED',
  GATE_FOLDER_ORPHAN: 'GATE_DECK_FOLDER_ORPHAN',
  GATE_DECK_OUT_OF_SCOPE: 'GATE_DECK_OUT_OF_SCOPE',
  GATE_DECK_ROLE_MISMATCH: 'GATE_DECK_ROLE_MISMATCH',
  DECK_IDENTITY_INVALID: 'DECK_IDENTITY_INVALID',
  DECK_IDENTITY_VERSION_INVALID: 'DECK_IDENTITY_VERSION_INVALID',
  DECK_IDENTITY_REQUIRED: 'DECK_IDENTITY_REQUIRED',
} as const);

export interface DeckIdentityContract {
  formatVersion: typeof DECK_IDENTITY_VERSION;
  reference: string;
}

export interface DeckIdentityResolution {
  reference?: string;
  key?: string;
  adapterPath?: string;
  origin?: 'explicit' | 'legacy-flat';
  contract?: DeckIdentityContract;
  problems: Problem[];
}

export interface DeckFolderDefinition {
  id: string;
  key: string;
  name: string;
  parent?: string;
  sourceIndex: number;
}

export interface DeckFolderCatalog {
  formatVersion: typeof DECK_FOLDER_CATALOG_VERSION;
  kind: typeof DECK_FOLDER_CATALOG_KIND;
  sourcePath?: string;
  original: JsonObject;
  folders: DeckFolderDefinition[];
}

export interface DeckFolderCatalogParseResult {
  ok: boolean;
  catalog?: DeckFolderCatalog;
  problems: Problem[];
}

export interface DeckOrganizationDeck {
  /** Stable authored identity. Folder edits must never change this value. */
  key: string;
  reference: string;
  aliases?: readonly string[];
  sourcePath: string;
  sidecarPath?: string;
  metadata?: Readonly<Record<string, unknown>>;
  adapterPath?: string;
  identityOrigin?: 'explicit' | 'legacy-flat';
}

export interface GateDeckScopeChapter {
  id: string;
  cpuDeck?: string;
  rentalDeck?: string;
}

export interface GateDeckScopeGate {
  id: string;
  sourcePath?: string;
  deckFolder?: string;
  chapters: readonly GateDeckScopeChapter[];
}

export interface ScopedDeckReference {
  gateId: string;
  chapterId: string;
  role: 'cpu' | 'rental';
  reference: string;
  folderId?: string;
  expectedRole: 'cpu' | 'rental';
  actualRole?: string;
  problem?: Problem;
}

export interface GateDeckScopeResult {
  gateId: string;
  folderId?: string;
  descendantFolderIds: string[];
  candidateReferences: { cpu: string[]; rental: string[] };
  references: ScopedDeckReference[];
  problems: Problem[];
}

export interface DeckOrganizationValidationResult {
  ok: boolean;
  scopes: GateDeckScopeResult[];
  problems: Problem[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const compareOrdinal = (left: string, right: string): number => {
  if (left === right) return 0;
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0) || 0;
    const rightPoint = rightPoints[index]?.codePointAt(0) || 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
};

const pointer = (base: string, key: string | number): string =>
  `${base}/${String(key).replace(/~/gu, '~0').replace(/\//gu, '~1')}`;

const diagnostic = (
  code: string,
  message: string,
  sourcePath?: string,
  jsonPointer?: string,
): Problem => ({
  code,
  message,
  severity: 'error',
  ...(sourcePath ? { sourcePath, path: sourcePath } : {}),
  ...(jsonPointer ? { jsonPointer } : {}),
});

const sortProblems = (problems: readonly Problem[]): Problem[] => [...problems].sort((left, right) =>
  compareOrdinal(left.sourcePath || left.path || '', right.sourcePath || right.path || '')
  || compareOrdinal(left.jsonPointer || '', right.jsonPointer || '')
  || compareOrdinal(left.code, right.code)
  || compareOrdinal(left.message, right.message));

/**
 * Resolve the versioned authored Deck identity. Physical source paths are never
 * accepted as identity. The legacy fallback is deliberately limited to a flat
 * basename supplied by the loader, so nested content cannot silently acquire a
 * new identity.
 */
export const resolveDeckIdentity = (
  metadata: Readonly<Record<string, unknown>> | undefined,
  options: { sourcePath?: string; legacyFlatStem?: string } = {},
): DeckIdentityResolution => {
  const raw = metadata?.identity;
  if (raw === undefined) {
    if (!options.legacyFlatStem) {
      return { problems: [diagnostic(DECK_ORGANIZATION_CODES.DECK_IDENTITY_REQUIRED, 'Nested Deck sources require metadata.identity with a stable versioned reference', options.sourcePath, '/metadata/identity')] };
    }
    try {
      const normalized = normalizeSymbolicReference(`deck:${options.legacyFlatStem}`);
      return {
        reference: normalized.normalized,
        key: normalized.key,
        adapterPath: `${DECK_ADAPTER_DIRECTORY}/${normalized.key}.json`,
        origin: 'legacy-flat',
        problems: [],
      };
    } catch (error) {
      const message = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
      return { problems: [diagnostic(DECK_ORGANIZATION_CODES.DECK_IDENTITY_INVALID, message || 'Legacy flat Deck identity is invalid', options.sourcePath, '/metadata/identity')] };
    }
  }
  if (!isRecord(raw)) {
    return { problems: [diagnostic(DECK_ORGANIZATION_CODES.DECK_IDENTITY_INVALID, 'metadata.identity must be an object', options.sourcePath, '/metadata/identity')] };
  }
  const problems: Problem[] = [];
  if (raw.formatVersion !== DECK_IDENTITY_VERSION) {
    problems.push(diagnostic(DECK_ORGANIZATION_CODES.DECK_IDENTITY_VERSION_INVALID, `Deck identity formatVersion must be ${DECK_IDENTITY_VERSION}`, options.sourcePath, '/metadata/identity/formatVersion'));
  }
  if (typeof raw.reference !== 'string' || !raw.reference.trim()) {
    problems.push(diagnostic(DECK_ORGANIZATION_CODES.DECK_IDENTITY_INVALID, 'Deck identity reference must be a non-empty deck:<stable-key> reference', options.sourcePath, '/metadata/identity/reference'));
    return { problems: sortProblems(problems) };
  }
  try {
    const normalized = normalizeSymbolicReference(raw.reference);
    if (normalized.namespace !== 'deck' || normalized.normalized !== raw.reference) {
      problems.push(diagnostic(DECK_ORGANIZATION_CODES.DECK_IDENTITY_INVALID, 'Deck identity reference must be the canonical deck:<stable-key> spelling', options.sourcePath, '/metadata/identity/reference'));
    }
    const contract: DeckIdentityContract = { formatVersion: DECK_IDENTITY_VERSION, reference: normalized.normalized };
    return {
      reference: normalized.normalized,
      key: normalized.key,
      adapterPath: `${DECK_ADAPTER_DIRECTORY}/${normalized.key}.json`,
      origin: 'explicit',
      contract,
      problems: sortProblems(problems),
    };
  } catch (error) {
    const message = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
    problems.push(diagnostic(DECK_ORGANIZATION_CODES.DECK_IDENTITY_INVALID, message || 'Deck identity reference is invalid', options.sourcePath, '/metadata/identity/reference'));
    return { problems: sortProblems(problems) };
  }
};

const unknownFields = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  sourcePath: string | undefined,
  jsonPointer: string,
): Problem[] => Object.keys(value)
  .filter((key) => !allowed.includes(key))
  .sort(compareOrdinal)
  .map((key) => diagnostic(
    DECK_ORGANIZATION_CODES.FIELD_UNKNOWN,
    `Unknown Deck folder field is not allowed: ${key}`,
    sourcePath,
    pointer(jsonPointer, key),
  ));

export const normalizeDeckFolderReference = (
  value: unknown,
  sourcePath?: string,
  jsonPointer = '',
): { value?: string; key?: string; problems: Problem[] } => {
  if (typeof value !== 'string' || !value.trim()) {
    return { problems: [diagnostic(DECK_ORGANIZATION_CODES.DECK_FOLDER_REF_INVALID, 'Deck folder reference must be a non-empty deck-folder:<key> reference', sourcePath, jsonPointer)] };
  }
  try {
    const normalized = normalizeSymbolicReference(value);
    if (normalized.namespace !== 'deck-folder' || /^\d+$/u.test(normalized.key)) {
      return { problems: [diagnostic(DECK_ORGANIZATION_CODES.DECK_FOLDER_REF_INVALID, 'Deck folder reference must use the deck-folder: namespace with a non-numeric key', sourcePath, jsonPointer)] };
    }
    return { value: normalized.normalized, key: normalized.key, problems: [] };
  } catch (error) {
    const message = error instanceof ContentFormatError ? error.problems[0]?.message : String(error);
    return { problems: [diagnostic(DECK_ORGANIZATION_CODES.DECK_FOLDER_REF_INVALID, message || 'Invalid Deck folder reference', sourcePath, jsonPointer)] };
  }
};

export const parseDeckFolderCatalog = (
  input: unknown,
  sourcePath?: string,
): DeckFolderCatalogParseResult => {
  if (!isRecord(input)) {
    return { ok: false, problems: [diagnostic(DECK_ORGANIZATION_CODES.CATALOG_INVALID, 'Deck folder catalog must be a JSON object', sourcePath, '')] };
  }
  const problems = unknownFields(input, ['formatVersion', 'kind', 'payload'], sourcePath, '');
  if (input.formatVersion !== DECK_FOLDER_CATALOG_VERSION) {
    problems.push(diagnostic(DECK_ORGANIZATION_CODES.FORMAT_VERSION_INVALID, `Deck folder catalog formatVersion must be ${DECK_FOLDER_CATALOG_VERSION}`, sourcePath, '/formatVersion'));
  }
  if (input.kind !== DECK_FOLDER_CATALOG_KIND) {
    problems.push(diagnostic(DECK_ORGANIZATION_CODES.KIND_INVALID, `Deck folder catalog kind must be ${DECK_FOLDER_CATALOG_KIND}`, sourcePath, '/kind'));
  }
  if (!isRecord(input.payload)) {
    problems.push(diagnostic(DECK_ORGANIZATION_CODES.CATALOG_INVALID, 'Deck folder catalog payload must be an object', sourcePath, '/payload'));
    return { ok: false, problems: sortProblems(problems) };
  }
  problems.push(...unknownFields(input.payload, ['folders'], sourcePath, '/payload'));
  if (!Array.isArray(input.payload.folders)) {
    problems.push(diagnostic(DECK_ORGANIZATION_CODES.FOLDERS_INVALID, 'Deck folder catalog payload.folders must be an array', sourcePath, '/payload/folders'));
    return { ok: false, problems: sortProblems(problems) };
  }

  const folders: DeckFolderDefinition[] = [];
  const ids = new Set<string>();
  input.payload.folders.forEach((raw, index) => {
    const base = `/payload/folders/${index}`;
    if (!isRecord(raw)) {
      problems.push(diagnostic(DECK_ORGANIZATION_CODES.FOLDER_INVALID, 'Deck folder must be an object', sourcePath, base));
      return;
    }
    problems.push(...unknownFields(raw, ['id', 'name', 'parent'], sourcePath, base));
    const id = normalizeDeckFolderReference(raw.id, sourcePath, `${base}/id`);
    problems.push(...id.problems.map((entry) => ({ ...entry, code: DECK_ORGANIZATION_CODES.FOLDER_ID_INVALID })));
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      problems.push(diagnostic(DECK_ORGANIZATION_CODES.FOLDER_NAME_INVALID, 'Deck folder name must be non-empty text', sourcePath, `${base}/name`));
    }
    const parent = raw.parent === undefined
      ? { problems: [] as Problem[] }
      : normalizeDeckFolderReference(raw.parent, sourcePath, `${base}/parent`);
    problems.push(...parent.problems.map((entry) => ({ ...entry, code: DECK_ORGANIZATION_CODES.FOLDER_PARENT_INVALID })));
    if (!id.value || typeof raw.name !== 'string' || !raw.name.trim() || parent.problems.length) return;
    if (ids.has(id.value)) {
      problems.push(diagnostic(DECK_ORGANIZATION_CODES.FOLDER_ID_DUPLICATE, `Duplicate normalized Deck folder identity: ${id.value}`, sourcePath, `${base}/id`));
      return;
    }
    ids.add(id.value);
    folders.push({
      id: id.value,
      key: id.key || '',
      name: raw.name.trim(),
      ...(parent.value ? { parent: parent.value } : {}),
      sourceIndex: index,
    });
  });

  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  for (const folder of folders) {
    if (!folder.parent) continue;
    if (folder.parent === folder.id) {
      problems.push(diagnostic(DECK_ORGANIZATION_CODES.FOLDER_PARENT_SELF, `Deck folder cannot parent itself: ${folder.id}`, sourcePath, `/payload/folders/${folder.sourceIndex}/parent`));
    } else if (!byId.has(folder.parent)) {
      problems.push(diagnostic(DECK_ORGANIZATION_CODES.FOLDER_PARENT_ORPHAN, `Deck folder parent does not exist: ${folder.parent}`, sourcePath, `/payload/folders/${folder.sourceIndex}/parent`));
    }
  }

  const state = new Map<string, number>();
  const cycleMembers = new Set<string>();
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      const start = trail.indexOf(id);
      for (const member of trail.slice(start < 0 ? 0 : start)) cycleMembers.add(member);
      cycleMembers.add(id);
      return;
    }
    state.set(id, 1);
    const parent = byId.get(id)?.parent;
    if (parent && byId.has(parent) && parent !== id) visit(parent, [...trail, id]);
    state.set(id, 2);
  };
  [...byId.keys()].sort(compareOrdinal).forEach((id) => visit(id, []));
  for (const id of [...cycleMembers].sort(compareOrdinal)) {
    const folder = byId.get(id);
    problems.push(diagnostic(DECK_ORGANIZATION_CODES.FOLDER_PARENT_CYCLE, `Deck folder parent graph contains a cycle at ${id}`, sourcePath, `/payload/folders/${folder?.sourceIndex ?? 0}/parent`));
  }

  const catalog: DeckFolderCatalog = {
    formatVersion: DECK_FOLDER_CATALOG_VERSION,
    kind: DECK_FOLDER_CATALOG_KIND,
    ...(sourcePath ? { sourcePath } : {}),
    original: clone(input) as JsonObject,
    folders: folders.sort((left, right) => compareOrdinal(left.id, right.id)),
  };
  return { ok: problems.length === 0, catalog, problems: sortProblems(problems) };
};

export const deckFolderFromMetadata = (
  metadata: Readonly<Record<string, unknown>> | undefined,
  sourcePath?: string,
): { folderId?: string; explicit: boolean; problems: Problem[] } => {
  if (!metadata || metadata.folder === undefined || metadata.folder === null || metadata.folder === '') {
    return { explicit: false, problems: [] };
  }
  const normalized = normalizeDeckFolderReference(metadata.folder, sourcePath, '/metadata/folder');
  return { folderId: normalized.value, explicit: true, problems: normalized.problems };
};

export const descendantDeckFolderIds = (
  catalog: DeckFolderCatalog,
  rootId: string,
): string[] => {
  const included = new Set<string>();
  const children = new Map<string, string[]>();
  for (const folder of catalog.folders) {
    if (folder.parent) children.set(folder.parent, [...(children.get(folder.parent) || []), folder.id]);
  }
  const visit = (id: string): void => {
    if (included.has(id)) return;
    included.add(id);
    for (const child of (children.get(id) || []).sort(compareOrdinal)) visit(child);
  };
  visit(rootId);
  return [...included].sort(compareOrdinal);
};

const deckReferenceMap = (decks: readonly DeckOrganizationDeck[]): Map<string, DeckOrganizationDeck> => {
  const output = new Map<string, DeckOrganizationDeck>();
  for (const deck of decks) {
    for (const reference of [deck.reference, deck.key, deck.sourcePath, ...(deck.aliases || [])]) {
      if (reference) output.set(reference.replace(/\\/gu, '/'), deck);
    }
  }
  return output;
};

/**
 * Validate authoring-only Gate scope. With no catalog the legacy project stays
 * readable/compilable and callers can render an empty recovery view. Once a
 * catalog exists, every explicit folder/reference is fail-closed.
 */
export const validateDeckOrganization = (
  catalog: DeckFolderCatalog | undefined,
  decks: readonly DeckOrganizationDeck[],
  gates: readonly GateDeckScopeGate[],
): DeckOrganizationValidationResult => {
  if (!catalog) return { ok: true, scopes: [], problems: [] };
  const problems: Problem[] = [];
  const folderIds = new Set(catalog.folders.map((folder) => folder.id));
  const deckByReference = deckReferenceMap(decks);
  const deckFolders = new Map<DeckOrganizationDeck, string | undefined>();
  for (const deck of decks) {
    const assigned = deckFolderFromMetadata(deck.metadata, deck.sidecarPath || deck.sourcePath);
    problems.push(...assigned.problems);
    if (assigned.folderId && !folderIds.has(assigned.folderId)) {
      problems.push(diagnostic(DECK_ORGANIZATION_CODES.DECK_FOLDER_REF_ORPHAN, `Deck references a missing folder: ${assigned.folderId}`, deck.sidecarPath || deck.sourcePath, '/metadata/folder'));
    }
    deckFolders.set(deck, assigned.folderId);
  }

  const scopes: GateDeckScopeResult[] = [];
  for (const gate of gates) {
    const gateProblems: Problem[] = [];
    const gateFolder = gate.deckFolder
      ? normalizeDeckFolderReference(gate.deckFolder, gate.sourcePath, '/payload/deckFolder')
      : { problems: [diagnostic(DECK_ORGANIZATION_CODES.GATE_FOLDER_REQUIRED, `Gate ${gate.id} requires payload.deckFolder when a Deck folder catalog exists`, gate.sourcePath, '/payload/deckFolder')] };
    gateProblems.push(...gateFolder.problems);
    if (gateFolder.value && !folderIds.has(gateFolder.value)) {
      gateProblems.push(diagnostic(DECK_ORGANIZATION_CODES.GATE_FOLDER_ORPHAN, `Gate references a missing Deck folder: ${gateFolder.value}`, gate.sourcePath, '/payload/deckFolder'));
    }
    const descendantFolderIds = gateFolder.value && folderIds.has(gateFolder.value)
      ? descendantDeckFolderIds(catalog, gateFolder.value)
      : [];
    const scopedFolders = new Set(descendantFolderIds);
    const candidateReferences = { cpu: [] as string[], rental: [] as string[] };
    for (const deck of decks) {
      const folderId = deckFolders.get(deck);
      if (!folderId || !scopedFolders.has(folderId)) continue;
      const role = typeof deck.metadata?.role === 'string' ? deck.metadata.role.trim().toLowerCase() : undefined;
      if (role === 'cpu') candidateReferences.cpu.push(deck.reference);
      if (role === 'rental') candidateReferences.rental.push(deck.reference);
    }
    candidateReferences.cpu.sort(compareOrdinal);
    candidateReferences.rental.sort(compareOrdinal);

    const references: ScopedDeckReference[] = [];
    for (const [chapterIndex, chapter] of gate.chapters.entries()) {
      for (const [role, reference] of [['cpu', chapter.cpuDeck], ['rental', chapter.rentalDeck]] as const) {
        if (!reference) continue;
        const deck = deckByReference.get(reference.replace(/\\/gu, '/'));
        if (!deck) continue; // Existing Gate validation owns missing Deck references.
        const folderId = deckFolders.get(deck);
        const actualRole = typeof deck.metadata?.role === 'string' ? deck.metadata.role.trim().toLowerCase() : undefined;
        const jsonPointer = `/payload/chapters/${chapterIndex}/duel/${role === 'cpu' ? 'cpuDeck' : 'rentalDeck'}`;
        let referenceProblem: Problem | undefined;
        if (!folderId || !scopedFolders.has(folderId)) {
          referenceProblem = diagnostic(
            DECK_ORGANIZATION_CODES.GATE_DECK_OUT_OF_SCOPE,
            `Gate ${gate.id} ${role} Deck reference is outside folder scope and was preserved: ${reference}`,
            gate.sourcePath,
            jsonPointer,
          );
        } else if (actualRole !== role) {
          referenceProblem = diagnostic(
            DECK_ORGANIZATION_CODES.GATE_DECK_ROLE_MISMATCH,
            `Gate ${gate.id} ${role} Deck requires metadata.role ${role}; received ${actualRole || 'unassigned'} for ${reference}`,
            gate.sourcePath,
            jsonPointer,
          );
        }
        if (referenceProblem) gateProblems.push(referenceProblem);
        references.push({
          gateId: gate.id,
          chapterId: chapter.id,
          role,
          reference,
          ...(folderId ? { folderId } : {}),
          expectedRole: role,
          ...(actualRole ? { actualRole } : {}),
          ...(referenceProblem ? { problem: referenceProblem } : {}),
        });
      }
    }
    problems.push(...gateProblems);
    scopes.push({
      gateId: gate.id,
      ...(gateFolder.value ? { folderId: gateFolder.value } : {}),
      descendantFolderIds,
      candidateReferences,
      references,
      problems: sortProblems(gateProblems),
    });
  }
  return { ok: problems.length === 0, scopes, problems: sortProblems(problems) };
};
