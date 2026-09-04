import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateRuntimePolicyPatch } from '../src/core/runtime-policy';

describe('campaign runtime policy validation', () => {
  it('accepts documented typed campaign settings', () => {
    const problems = validateRuntimePolicyPatch('settings', {
      DefaultGems: 1000,
      DefaultCraftPoints: 0,
      SoloRemoveDuelTutorials: true,
      Craft: {},
      DuelRewards: {},
    });
    assert.deepEqual(problems, []);
  });

  it('rejects unsupported keys and invalid scalar values', () => {
    const problems = validateRuntimePolicyPatch('client', {
      DuelClientTimeMultiplier: 0,
      DeckEditorShowStats: 'yes',
      ArbitraryRuntimeSwitch: true,
    });
    assert.deepEqual(problems.map((entry) => entry.code).sort(), ['RUNTIME_POLICY_KEY_UNSUPPORTED', 'RUNTIME_POLICY_TYPE_INVALID', 'RUNTIME_POLICY_VALUE_INVALID']);
  });

  it('rejects conflicting all-card styles and warns about progression bypasses', () => {
    const problems = validateRuntimePolicyPatch('settings', {
      UnlockAllCards: true,
      UnlockAllCardsShine: true,
      DisableBanList: true,
    });
    assert.equal(problems.some((entry) => entry.code === 'RUNTIME_POLICY_CONFLICT'), true);
    assert.equal(problems.filter((entry) => entry.code === 'RUNTIME_POLICY_PROGRESS_BYPASS').length, 3);
  });
});
