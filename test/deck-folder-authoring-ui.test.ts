import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  findOutOfScopeDeckReferences,
  normalizeScopedDeckCandidates,
  scopedDeckCandidateReferences,
  scopedDeckValueIsValid,
} from '../src/renderer/components/chapter/ScopedDeckPicker';
import {
  buildDeckFolderBootstrapRequest,
  createDeckFolderBootstrapDraft,
  deckFolderRecoveryKey,
  decksForFolder,
  folderParentCandidates,
  normalizeDeckFolderWorkspace,
  patchDeckFolderAssignment,
  patchDeckFolderCatalog,
} from '../src/renderer/components/deck/DeckFolderWorkspace';
import { buildAuthoredChapterGraph } from '../src/renderer/components/gate/GateGraphQuickEditor';

const editorRoot = path.resolve(__dirname, '..');

describe('Gate-scoped logical Deck folder renderer model', () => {
  const workspace = normalizeDeckFolderWorkspace({
    contentGeneration: 'generation-1',
    catalogState: { state: 'present', sourcePath: 'decks/_folders.json' },
    folders: [
      { id: 'deck-folder:gate-a', name: 'Gate A' },
      { id: 'deck-folder:gate-a-cpu', name: 'CPU', parent: 'deck-folder:gate-a' },
      { id: 'deck-folder:gate-a-rental', name: 'Rental', parent: 'deck-folder:gate-a' },
      { id: 'deck-folder:gate-b', name: 'Gate B' },
      { id: 'deck-folder:shared', name: 'Shared' },
    ],
    decks: [
      { key: 'a-cpu', reference: 'deck:a-cpu', sourcePath: 'decks/a-cpu.decklist', adapterPath: 'decks/a-cpu.json', identityOrigin: 'explicit', sidecarPath: 'decks/a-cpu.json', metadata: { folder: 'deck-folder:gate-a-cpu', role: 'cpu' }, consumers: [{ gateId: 'gate:a', chapterId: 'chapter:a' }] },
      { key: 'a-rental', reference: 'deck:a-rental', sourcePath: 'decks/a-rental.decklist', adapterPath: 'decks/a-rental.json', identityOrigin: 'explicit', metadata: { folder: 'deck-folder:gate-a-rental', role: 'rental' } },
      { key: 'b-cpu', reference: 'deck:b-cpu', sourcePath: 'decks/b-cpu.decklist', adapterPath: 'decks/b-cpu.json', identityOrigin: 'legacy-flat', metadata: { folder: 'deck-folder:gate-b', role: 'cpu' } },
      { key: 'loose', reference: 'deck:loose', sourcePath: 'decks/loose.decklist', adapterPath: 'decks/loose.json', identityOrigin: 'legacy-flat', role: 'cpu' },
    ],
    gates: [{ gateId: 'gate:a', sourcePath: 'gates/a.json', folderId: 'deck-folder:gate-a', scope: { deckCount: 2, candidates: {}, outOfScopeReferences: [] } }],
  });

  it('normalizes current core aliases and derives recursive breadcrumbs, counts, and Gate consumers', () => {
    assert.equal(workspace.catalog.exists, true);
    assert.equal(workspace.gates[0]?.id, 'gate:a');
    assert.equal(workspace.gates[0]?.deckFolder, 'deck-folder:gate-a');
    assert.equal(workspace.gates[0]?.scopedDeckCount, 2);
    assert.deepEqual(workspace.folders.find((folder) => folder.id === 'deck-folder:gate-a-cpu')?.breadcrumb, ['Gate A', 'CPU']);
    assert.equal(workspace.folders.find((folder) => folder.id === 'deck-folder:gate-a')?.recursiveDeckCount, 2);
    assert.deepEqual(workspace.folders.find((folder) => folder.id === 'deck-folder:gate-a')?.consumerGateIds, ['gate:a']);
  });

  it('combines recursive folder and role filters while keeping Unassigned out of Gate scope', () => {
    assert.deepEqual(decksForFolder(workspace, 'deck-folder:gate-a', 'all').map((deck) => deck.key), ['a-cpu', 'a-rental']);
    assert.deepEqual(decksForFolder(workspace, 'deck-folder:gate-a', 'cpu').map((deck) => deck.key), ['a-cpu']);
    assert.deepEqual(decksForFolder(workspace, 'deck-folder:gate-a', 'rental').map((deck) => deck.key), ['a-rental']);
    assert.deepEqual(decksForFolder(workspace, 'unassigned', 'all').map((deck) => deck.key), ['loose']);
  });

  it('excludes the selected folder and every actual descendant from parent candidates', () => {
    assert.deepEqual(
      folderParentCandidates(workspace.folders, 'deck-folder:gate-a').map((folder) => folder.id),
      ['deck-folder:gate-b', 'deck-folder:shared'],
    );
  });

  it('patches only logical metadata and preserves stable Deck keys plus unknown siblings', () => {
    const catalog = { formatVersion: 1, kind: 'deck-folders', opaque: { keep: 7 }, payload: { x: true, folders: [{ id: 'deck-folder:gate-a', name: 'Gate A', opaque: 'keep' }] } };
    const renamed = patchDeckFolderCatalog(catalog, { action: 'update', id: 'deck-folder:gate-a', name: 'Renamed', parent: 'deck-folder:shared' });
    assert.deepEqual(renamed.opaque, { keep: 7 });
    assert.equal((renamed.payload as { x: boolean }).x, true);
    assert.deepEqual((renamed.payload as { folders: Array<Record<string, unknown>> }).folders[0], { id: 'deck-folder:gate-a', name: 'Renamed', parent: 'deck-folder:shared', opaque: 'keep' });
    const sidecar = patchDeckFolderAssignment({ opaque: { keep: true }, metadata: { role: 'cpu', custom: 3 } }, 'deck-folder:gate-a-cpu');
    assert.deepEqual(sidecar.opaque, { keep: true });
    assert.deepEqual(sidecar.metadata, { role: 'cpu', custom: 3, folder: 'deck-folder:gate-a-cpu' });
    assert.equal(workspace.decks[0]?.key, 'a-cpu');
    assert.equal(workspace.decks[0]?.reference, 'deck:a-cpu');
  });

  it('builds one exhaustive legacy bootstrap candidate without using Unassigned as a scope', () => {
    const legacy = normalizeDeckFolderWorkspace({
      contentGeneration: 'legacy-generation',
      catalog: { sourcePath: 'decks/_folders.json', exists: false },
      decks: [
        { key: 'alpha', reference: 'deck:alpha', sourcePath: 'decks/alpha.decklist', adapterPath: 'decks/alpha.json', identityOrigin: 'legacy-flat', role: 'cpu' },
        { key: 'beta', reference: 'deck:beta', sourcePath: 'decks/beta.decklist', adapterPath: 'decks/beta.json', identityOrigin: 'legacy-flat', role: 'rental' },
      ],
      gates: [
        { id: 'gate:a', sourcePath: 'gates/a.json' },
        { id: 'gate:b', sourcePath: 'gates/b.json' },
      ],
    });
    const draft = createDeckFolderBootstrapDraft(legacy, 'Starter Campaign');
    assert.equal(draft.folderId, 'deck-folder:starter-campaign');
    assert.deepEqual(draft.deckAssignments, [
      { sourcePath: 'decks/alpha.decklist', folderId: draft.folderId },
      { sourcePath: 'decks/beta.decklist', folderId: draft.folderId },
    ]);
    assert.deepEqual(draft.gateAssignments, [
      { sourcePath: 'gates/a.json', folderId: draft.folderId },
      { sourcePath: 'gates/b.json', folderId: draft.folderId },
    ]);
    assert.equal(JSON.stringify(draft).includes('unassigned'), false);
    assert.equal(JSON.stringify(draft).includes('role'), false);
  });

  it('requires a preview signature only on the explicit atomic apply request', () => {
    const draft = createDeckFolderBootstrapDraft(workspace, 'Reviewed scope');
    const preview = buildDeckFolderBootstrapRequest(draft, workspace.contentGeneration, false);
    assert.equal(preview.confirmApply, false);
    assert.equal(preview.previewSignature, undefined);
    assert.throws(() => buildDeckFolderBootstrapRequest(draft, workspace.contentGeneration, true), /preview signature is required/u);
    const apply = buildDeckFolderBootstrapRequest(draft, workspace.contentGeneration, true, 'reviewed-signature');
    assert.equal(apply.confirmApply, true);
    assert.equal(apply.previewSignature, 'reviewed-signature');
    assert.deepEqual(apply.catalog.payload.folders, [{ id: 'deck-folder:reviewed-scope', name: 'Reviewed scope' }]);
  });

  it('rejects an incomplete path model before atomic bootstrap preview', () => {
    const incomplete = normalizeDeckFolderWorkspace({
      decks: [{ key: 'alpha', reference: 'deck:alpha', sourcePath: 'decks/alpha.decklist', adapterPath: 'decks/alpha.json', identityOrigin: 'legacy-flat' }],
      gates: [{ id: 'gate:a' }],
    });
    assert.throws(() => createDeckFolderBootstrapDraft(incomplete, 'Starter'), /Gate must have one unique source path/u);
  });

  it('keeps required empty or out-of-scope references invalid until an explicit compatible selection', () => {
    const candidates = normalizeScopedDeckCandidates([
      { key: 'a-cpu', reference: 'deck:a-cpu', role: 'cpu' },
      { key: 'legacy-both', reference: 'deck:legacy-both', role: 'both' },
      { key: 'missing-role', reference: 'deck:missing-role' },
    ]);
    const chapters = [{ id: 'chapter:a', kind: 'duel', duel: { playerMode: 'mydeck', cpuDeck: 'deck:b-cpu' } }];
    assert.deepEqual(scopedDeckCandidateReferences(candidates, 'cpu'), ['deck:a-cpu']);
    assert.equal(scopedDeckValueIsValid(undefined, candidates, 'cpu', true), false);
    assert.equal(scopedDeckValueIsValid(undefined, candidates, 'cpu', false), true);
    assert.equal(scopedDeckValueIsValid('a-cpu', candidates, 'cpu', true), false);
    assert.equal(scopedDeckValueIsValid('deck:a-rental', candidates, 'cpu', true), false);
    assert.equal(scopedDeckValueIsValid('deck:a-cpu', candidates, 'cpu', true), true);
    assert.deepEqual(findOutOfScopeDeckReferences(chapters, candidates, []), [{ chapterId: 'chapter:a', role: 'cpu', reference: 'deck:b-cpu' }]);
    chapters[0]!.duel.cpuDeck = 'deck:a-cpu';
    assert.deepEqual(findOutOfScopeDeckReferences(chapters, candidates, []), []);
  });

  it('builds an authored parent graph and highlights the routed Chapter', () => {
    const graph = buildAuthoredChapterGraph([
      { id: 'chapter:start', kind: 'duel' },
      { id: 'chapter:branch', kind: 'duel', parent: 'chapter:start' },
    ], 'chapter:branch');
    assert.deepEqual(graph.edges.map((edge) => [edge.source, edge.target]), [['chapter:start', 'chapter:branch']]);
    assert.equal(graph.nodes.find((node) => node.id === 'chapter:branch')?.selected, true);
  });

  it('separates Deck folder recovery by workspace identity, entity, and generation', () => {
    const current = deckFolderRecoveryKey('workspace-a', 'deck-folder-workspace', 'generation-1');
    assert.notEqual(current, deckFolderRecoveryKey('workspace-b', 'deck-folder-workspace', 'generation-1'));
    assert.notEqual(current, deckFolderRecoveryKey('workspace-a', 'another-entity', 'generation-1'));
    assert.notEqual(current, deckFolderRecoveryKey('workspace-a', 'deck-folder-workspace', 'generation-2'));
  });

  it('wires graph quick edit and full Chapter edit to the same ScopedDeckPicker implementation', async () => {
    const composer = await fs.readFile(path.join(editorRoot, 'src/renderer/components/gate/ChapterComposer.tsx'), 'utf8');
    const graph = await fs.readFile(path.join(editorRoot, 'src/renderer/components/gate/GateGraphQuickEditor.tsx'), 'utf8');
    const gate = await fs.readFile(path.join(editorRoot, 'src/renderer/components/gate/GateAuthoring.tsx'), 'utf8');
    assert.match(composer, /ScopedDeckPicker/u);
    assert.match(composer, /export const ChapterDuelFields/u);
    assert.match(graph, /ChapterDuelFields/u);
    assert.match(graph, /ReactFlow/u);
    assert.match(gate, /GateGraphQuickEditor/u);
    assert.match(gate, /ChapterComposer/u);
    assert.match(gate, /contentDeckWorkspaceRead/u);
    assert.match(gate, /routeGateId/u);
    assert.match(gate, /routeChapterId/u);
    assert.match(gate, /chapterRoute/u);
    assert.equal(gate.includes('<Textarea'), false);
    const deckList = await fs.readFile(path.join(editorRoot, 'src/renderer/components/deck/DeckList.tsx'), 'utf8');
    const folderWorkspace = await fs.readFile(path.join(editorRoot, 'src/renderer/components/deck/DeckFolderWorkspace.tsx'), 'utf8');
    assert.match(deckList, /contentDeckFoldersBootstrap/u);
    assert.match(deckList, /Preview atomic migration/u);
    assert.match(deckList, /Confirm atomic apply/u);
    assert.doesNotMatch(deckList, /contentDeckMovePreview|contentDeckMoveApply|Physical Deck move/u);
    assert.doesNotMatch(folderWorkspace, /onStagePhysicalMove|Authored Deck directory|Review physical move/u);
    assert.equal(/node:fs|node:path/u.test(deckList), false);
  });
});
