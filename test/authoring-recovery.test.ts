import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deckFolderRecoveryKey } from '../src/renderer/components/deck/DeckFolderWorkspace';
import {
  authoredCandidateSignature,
  clearRecoveryDraft,
  readRecoveryDraft,
  recoveryKey,
  type RecoveryStorage,
  writeRecoveryDraft,
} from '../src/renderer/components/gate/useGateAuthoringDraft';

const memoryStorage = (): RecoveryStorage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    keys: () => [...values.keys()],
  };
};

describe('authored recovery draft boundary', () => {
  it('uses the same workspace, entity, and generation isolation for Deck folder drafts', () => {
    const current = deckFolderRecoveryKey('workspace-a', 'deck-folder-workspace', 'generation-1');
    assert.notEqual(current, deckFolderRecoveryKey('workspace-b', 'deck-folder-workspace', 'generation-1'));
    assert.notEqual(current, deckFolderRecoveryKey('workspace-a', 'another-entity', 'generation-1'));
    assert.notEqual(current, deckFolderRecoveryKey('workspace-a', 'deck-folder-workspace', 'generation-2'));
  });

  it('keys recovery by workspace, entity, and generation without touching authored source', () => {
    const storage = memoryStorage();
    const draft = { payload: { id: 'gate:a', deckFolder: 'deck-folder:a' } };
    writeRecoveryDraft(storage, 'workspace-a', 'gates/a.json', 'generation-1', draft);
    assert.deepEqual(readRecoveryDraft<typeof draft>(storage, 'workspace-a', 'gates/a.json', 'generation-1').record?.draft, draft);
    assert.equal(readRecoveryDraft(storage, 'workspace-b', 'gates/a.json', 'generation-1').record, undefined);
    assert.equal(storage.keys().length, 1);
  });

  it('marks another generation stale and never treats its candidate signature as current', () => {
    const storage = memoryStorage();
    writeRecoveryDraft(storage, 'workspace-a', 'gates/a.json', 'generation-1', { value: 1 });
    const next = readRecoveryDraft(storage, 'workspace-a', 'gates/a.json', 'generation-2');
    assert.equal(next.record, undefined);
    assert.equal(next.stale, true);
    assert.notEqual(authoredCandidateSignature('generation-1', { value: 1 }), authoredCandidateSignature('generation-2', { value: 1 }));
    assert.notEqual(authoredCandidateSignature('generation-2', { value: 1 }), authoredCandidateSignature('generation-2', { value: 2 }));
  });

  it('discards only the exact recovery draft selected for explicit review', () => {
    const storage = memoryStorage();
    writeRecoveryDraft(storage, 'workspace-a', 'gates/a.json', 'generation-1', { value: 1 });
    writeRecoveryDraft(storage, 'workspace-a', 'gates/a.json', 'generation-2', { value: 2 });
    clearRecoveryDraft(storage, 'workspace-a', 'gates/a.json', 'generation-2');
    assert.equal(storage.getItem(recoveryKey('workspace-a', 'gates/a.json', 'generation-2')), null);
    assert.notEqual(storage.getItem(recoveryKey('workspace-a', 'gates/a.json', 'generation-1')), null);
  });
});
