import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TARGET_CAPABILITIES,
  validateTargetCapabilities,
  validateTargetCapability,
} from '../src/core/target-contract';
import { YGOMASTER_TARGET_CONTRACT_VERSION } from '../src/core/layers';

describe('campaign YgoMaster target contract', () => {
  it('keeps documented families open and separates approved Shop examples from undocumented Solo progression', () => {
    assert.equal(YGOMASTER_TARGET_CONTRACT_VERSION, 'ygomaster-campaign-target/v3');
    assert.deepEqual(validateTargetCapability('solo'), []);
    assert.deepEqual(validateTargetCapability('duel'), []);
    assert.deepEqual(validateTargetCapability('clientData'), []);
    assert.deepEqual(validateTargetCapability('shop').map((entry) => entry.code), ['SHOP_TARGET_UNVERIFIED']);
    assert.deepEqual(validateTargetCapability('shop', undefined, true), []);
    assert.deepEqual(validateTargetCapability('unlockSecret').map((entry) => entry.code), ['UNLOCK_SECRET_UNVERIFIED']);
    assert.deepEqual(validateTargetCapability('regulationTarget').map((entry) => entry.code), ['REGULATION_TARGET_UNSUPPORTED']);
  });

  it('requires explicit opt-in for fixture-backed assumed projections', () => {
    assert.equal(TARGET_CAPABILITIES.structure.status, 'assumed');
    assert.deepEqual(validateTargetCapability('structure').map((entry) => entry.code), ['STRUCTURE_TARGET_UNVERIFIED']);
    assert.deepEqual(validateTargetCapability('structure', undefined, true), []);
    assert.deepEqual(
      validateTargetCapabilities(['unlockSecret', 'shop', 'unlockSecret']).map((entry) => entry.code),
      ['SHOP_TARGET_UNVERIFIED', 'UNLOCK_SECRET_UNVERIFIED'],
    );
  });
});
