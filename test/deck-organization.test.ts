import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DECK_ORGANIZATION_CODES,
  parseDeckFolderCatalog,
  resolveDeckIdentity,
  validateDeckOrganization,
  type DeckOrganizationDeck,
} from '../src/core/deck-organization';

const catalog = (folders: unknown[]) => ({
  formatVersion: 1,
  kind: 'deck-folders',
  payload: { folders },
});

const deck = (
  key: string,
  role?: string,
  folder?: string,
): DeckOrganizationDeck => ({
  key: `${key}.decklist`,
  reference: `deck:${key}`,
  sourcePath: `decks/${key}.decklist`,
  sidecarPath: `decks/${key}.json`,
  metadata: { ...(role ? { role } : {}), ...(folder ? { folder } : {}), preserved: { future: true } },
});

describe('logical Deck folder organization', () => {
  it('accepts an empty catalog and rejects duplicate, orphan, self, and cyclic parents', () => {
    assert.equal(parseDeckFolderCatalog(catalog([]), 'decks/_folders.json').ok, true);

    const duplicate = parseDeckFolderCatalog(catalog([
      { id: 'deck-folder:Foo', name: 'One' },
      { id: 'deck-folder:Ｆoo', name: 'Two' },
    ]), 'decks/_folders.json');
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.problems.some((entry) => entry.code === DECK_ORGANIZATION_CODES.FOLDER_ID_DUPLICATE), true);

    const invalidGraph = parseDeckFolderCatalog(catalog([
      { id: 'deck-folder:self', name: 'Self', parent: 'deck-folder:self' },
      { id: 'deck-folder:orphan', name: 'Orphan', parent: 'deck-folder:missing' },
      { id: 'deck-folder:a', name: 'A', parent: 'deck-folder:b' },
      { id: 'deck-folder:b', name: 'B', parent: 'deck-folder:a' },
    ]), 'decks/_folders.json');
    const codes = new Set(invalidGraph.problems.map((entry) => entry.code));
    assert.equal(codes.has(DECK_ORGANIZATION_CODES.FOLDER_PARENT_SELF), true);
    assert.equal(codes.has(DECK_ORGANIZATION_CODES.FOLDER_PARENT_ORPHAN), true);
    assert.equal(codes.has(DECK_ORGANIZATION_CODES.FOLDER_PARENT_CYCLE), true);
  });

  it('includes direct and descendant Decks, filters roles, and preserves invalid current references', () => {
    const parsed = parseDeckFolderCatalog(catalog([
      { id: 'deck-folder:gate-a', name: 'Gate A' },
      { id: 'deck-folder:gate-a-child', name: 'Child', parent: 'deck-folder:gate-a' },
      { id: 'deck-folder:gate-b', name: 'Gate B' },
      { id: 'deck-folder:shared', name: 'Shared' },
    ]), 'decks/_folders.json');
    assert.ok(parsed.catalog);
    const decks = [
      deck('direct-cpu', 'cpu', 'deck-folder:gate-a'),
      deck('child-rental', 'rental', 'deck-folder:gate-a-child'),
      deck('wrong-role', 'cpu', 'deck-folder:gate-a'),
      deck('other-cpu', 'cpu', 'deck-folder:gate-b'),
      deck('unassigned', 'cpu'),
    ];
    const result = validateDeckOrganization(parsed.catalog, decks, [{
      id: 'gate:a',
      sourcePath: 'gates/a.json',
      deckFolder: 'deck-folder:gate-a',
      chapters: [{
        id: 'chapter:a',
        cpuDeck: 'deck:other-cpu',
        rentalDeck: 'deck:wrong-role',
      }],
    }]);
    const scope = result.scopes[0];
    assert.deepEqual(scope?.descendantFolderIds, ['deck-folder:gate-a', 'deck-folder:gate-a-child']);
    assert.deepEqual(scope?.candidateReferences.cpu, ['deck:direct-cpu', 'deck:wrong-role']);
    assert.deepEqual(scope?.candidateReferences.rental, ['deck:child-rental']);
    assert.equal(scope?.references.find((entry) => entry.reference === 'deck:other-cpu')?.reference, 'deck:other-cpu');
    assert.equal(scope?.references.find((entry) => entry.reference === 'deck:other-cpu')?.problem?.code, DECK_ORGANIZATION_CODES.GATE_DECK_OUT_OF_SCOPE);
    assert.equal(scope?.references.find((entry) => entry.reference === 'deck:other-cpu')?.problem?.jsonPointer, '/payload/chapters/0/duel/cpuDeck');
    assert.equal(scope?.references.find((entry) => entry.reference === 'deck:wrong-role')?.problem?.code, DECK_ORGANIZATION_CODES.GATE_DECK_ROLE_MISMATCH);
    assert.equal(scope?.references.find((entry) => entry.reference === 'deck:wrong-role')?.problem?.jsonPointer, '/payload/chapters/0/duel/rentalDeck');
    assert.equal(scope?.candidateReferences.cpu.includes('deck:unassigned'), false);
    assert.equal(scope?.candidateReferences.cpu.includes('deck:other-cpu'), false);
    assert.equal(result.ok, false);
  });

  it('keeps Deck keys stable across folder rename/move and blocks deleted references', () => {
    const stableDeck = deck('stable', 'cpu', 'deck-folder:child');
    const before = parseDeckFolderCatalog(catalog([
      { id: 'deck-folder:root-a', name: 'Root A' },
      { id: 'deck-folder:root-b', name: 'Root B' },
      { id: 'deck-folder:child', name: 'Before', parent: 'deck-folder:root-a' },
    ])).catalog;
    const after = parseDeckFolderCatalog(catalog([
      { id: 'deck-folder:root-a', name: 'Root A' },
      { id: 'deck-folder:root-b', name: 'Root B' },
      { id: 'deck-folder:child', name: 'After', parent: 'deck-folder:root-b' },
    ])).catalog;
    assert.ok(before && after);
    assert.equal(stableDeck.key, 'stable.decklist');
    assert.equal(stableDeck.reference, 'deck:stable');
    assert.equal(before.folders.find((entry) => entry.id === 'deck-folder:child')?.id, after.folders.find((entry) => entry.id === 'deck-folder:child')?.id);

    const deleted = parseDeckFolderCatalog(catalog([{ id: 'deck-folder:root-a', name: 'Root A' }])).catalog;
    assert.ok(deleted);
    const result = validateDeckOrganization(deleted, [stableDeck], [{
      id: 'gate:a',
      deckFolder: 'deck-folder:child',
      chapters: [],
    }]);
    const codes = new Set(result.problems.map((entry) => entry.code));
    assert.equal(codes.has(DECK_ORGANIZATION_CODES.DECK_FOLDER_REF_ORPHAN), true);
    assert.equal(codes.has(DECK_ORGANIZATION_CODES.GATE_FOLDER_ORPHAN), true);
    assert.equal(result.problems.find((entry) => entry.code === DECK_ORGANIZATION_CODES.DECK_FOLDER_REF_ORPHAN)?.jsonPointer, '/metadata/folder');
    assert.equal(result.problems.find((entry) => entry.code === DECK_ORGANIZATION_CODES.GATE_FOLDER_ORPHAN)?.jsonPointer, '/payload/deckFolder');
  });

  it('requires a Gate folder with a precise authored pointer once the catalog exists', () => {
    const parsed = parseDeckFolderCatalog(catalog([{ id: 'deck-folder:root', name: 'Root' }])).catalog;
    assert.ok(parsed);
    const result = validateDeckOrganization(parsed, [deck('stable', 'cpu', 'deck-folder:root')], [{
      id: 'gate:missing-scope',
      sourcePath: 'gates/missing-scope.json',
      chapters: [],
    }]);
    const missing = result.problems.find((entry) => entry.code === DECK_ORGANIZATION_CODES.GATE_FOLDER_REQUIRED);
    assert.equal(missing?.sourcePath, 'gates/missing-scope.json');
    assert.equal(missing?.jsonPointer, '/payload/deckFolder');
  });

  it('keeps legacy content without a catalog readable as an empty recovery model', () => {
    const result = validateDeckOrganization(undefined, [deck('legacy', 'cpu')], [{
      id: 'gate:legacy',
      chapters: [{ id: 'chapter:legacy', cpuDeck: 'deck:legacy' }],
    }]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.scopes, []);
    assert.deepEqual(result.problems, []);
  });

  it('keeps an explicit stable identity while flat filename fallback remains the current loader contract', () => {
    const legacy = resolveDeckIdentity(undefined, { sourcePath: 'decks/flat.decklist', legacyFlatStem: 'flat' });
    assert.deepEqual({ reference: legacy.reference, adapterPath: legacy.adapterPath, origin: legacy.origin }, {
      reference: 'deck:flat', adapterPath: 'decks/flat.json', origin: 'legacy-flat',
    });
    const explicit = resolveDeckIdentity({ identity: { formatVersion: 1, reference: 'deck:flat' } }, { sourcePath: 'decks/nested/renamed.decklist' });
    assert.deepEqual({ reference: explicit.reference, adapterPath: explicit.adapterPath, origin: explicit.origin }, {
      reference: 'deck:flat', adapterPath: 'decks/flat.json', origin: 'explicit',
    });
    const missing = resolveDeckIdentity(undefined, { sourcePath: 'decks/nested/renamed.decklist' });
    assert.equal(missing.problems[0]?.code, DECK_ORGANIZATION_CODES.DECK_IDENTITY_REQUIRED);
  });
});
