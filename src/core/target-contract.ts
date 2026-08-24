import { Problem, problem } from './types';
import { YGOMASTER_TARGET_CONTRACT_VERSION } from './layers';

export type TargetCapabilityStatus = 'confirmed' | 'assumed' | 'unsupported';
export type TargetCapability =
  | 'solo'
  | 'duel'
  | 'structure'
  | 'clientData'
  | 'regulationRead'
  | 'regulationOverlay'
  | 'shop'
  | 'unlockSecret'
  | 'backgroundAsset';

export interface TargetCapabilityContract {
  status: TargetCapabilityStatus;
  blockingCode?: string;
  evidence: 'upstream-docs' | 'official-example' | 'compatibility-fixture' | 'undocumented';
}

export const TARGET_CAPABILITIES: Readonly<Record<TargetCapability, TargetCapabilityContract>> = Object.freeze({
  solo: { status: 'confirmed', evidence: 'upstream-docs' },
  duel: { status: 'confirmed', evidence: 'upstream-docs' },
  structure: { status: 'assumed', blockingCode: 'STRUCTURE_TARGET_UNVERIFIED', evidence: 'compatibility-fixture' },
  clientData: { status: 'confirmed', evidence: 'upstream-docs' },
  regulationRead: { status: 'confirmed', evidence: 'upstream-docs' },
  regulationOverlay: { status: 'unsupported', blockingCode: 'REGULATION_TARGET_UNSUPPORTED', evidence: 'undocumented' },
  shop: { status: 'assumed', blockingCode: 'SHOP_TARGET_UNVERIFIED', evidence: 'official-example' },
  unlockSecret: { status: 'unsupported', blockingCode: 'UNLOCK_SECRET_UNSUPPORTED', evidence: 'undocumented' },
  backgroundAsset: { status: 'confirmed', evidence: 'official-example' },
});

export const validateTargetCapability = (
  capability: TargetCapability,
  sourcePath?: string,
  allowAssumed = false,
): Problem[] => {
  const contract = TARGET_CAPABILITIES[capability];
  if (contract.status === 'confirmed' || (allowAssumed && contract.status === 'assumed')) return [];
  const code = contract.blockingCode || 'TARGET_CAPABILITY_UNSUPPORTED';
  const qualifier = contract.status === 'assumed' ? 'requires an explicit verified-adapter opt-in' : 'is unsupported';
  return [problem(code, `YgoMaster target capability ${capability} ${qualifier} under ${YGOMASTER_TARGET_CONTRACT_VERSION}`, sourcePath)];
};

export const validateTargetCapabilities = (
  capabilities: readonly TargetCapability[],
  sourcePath?: string,
  allowAssumed = false,
): Problem[] => [...new Set(capabilities)].sort().flatMap((capability) =>
  validateTargetCapability(capability, sourcePath, allowAssumed));
