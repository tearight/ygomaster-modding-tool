import type { JsonObject, Problem } from './types';
import { problem } from './types';

export type RuntimePolicyFamily = 'settings' | 'shop' | 'client';
export type RuntimePolicy = Partial<Record<RuntimePolicyFamily, JsonObject>>;
export type RuntimePolicyFieldKind = 'boolean' | 'integer' | 'positive-number' | 'object';
export interface RuntimePolicyFieldDefinition {
  family: RuntimePolicyFamily;
  key: string;
  kind: RuntimePolicyFieldKind;
  group: 'profile' | 'tutorial-rules' | 'progression' | 'packs' | 'craft-rewards' | 'client';
  description: string;
  caveat?: string;
}

const booleanFields: Record<RuntimePolicyFamily, readonly string[]> = {
  settings: ['SoloRemoveDuelTutorials', 'UnlockAllCards', 'UnlockAllCardsShine', 'UnlockAllCardsHighestRarity', 'UnlockAllItems', 'UnlockAllSoloChapters', 'CardCraftableAll', 'DisableNoDismantle', 'DisableBanList'],
  shop: ['DisableCardStyleRarity', 'UnlockAllSecrets', 'PutAllCardsInStandardPack', 'NoDuplicatesPerPack'],
  client: ['DeckEditorDisableLimits', 'DeckEditorShowStats', 'DeckEditorConvertStyleRarity', 'DuelClientShowRemainingCardsInDeck', 'DuelClientMillenniumEye', 'ReplayControlsAlwaysEnabled'],
};

export const RUNTIME_POLICY_ALLOWLIST: Readonly<Record<RuntimePolicyFamily, ReadonlySet<string>>> = Object.freeze({
  settings: new Set([...booleanFields.settings, 'DefaultGems', 'DefaultCraftPoints', 'DuelRewards', 'Craft']),
  shop: new Set(booleanFields.shop),
  client: new Set([...booleanFields.client, 'DuelClientTimeMultiplier', 'ReplayControlsTimeMultiplier']),
});

const descriptions: Record<string, string> = {
  DefaultGems: 'Initial gems for a newly created profile.',
  DefaultCraftPoints: 'Initial craft points for a newly created profile.',
  SoloRemoveDuelTutorials: 'Turn Solo tutorial duels into normal duels.',
  UnlockAllCards: 'Give three Normal-style copies of every card.',
  UnlockAllCardsShine: 'Give three Shine-style copies of every card.',
  UnlockAllCardsHighestRarity: 'Give three copies using the highest supported style.',
  UnlockAllItems: 'Unlock every item.',
  UnlockAllSoloChapters: 'Unlock all Solo chapters.',
  CardCraftableAll: 'Allow every card to be crafted.',
  DisableNoDismantle: 'Allow granted cards to be dismantled going forward.',
  DisableBanList: 'Disable ban-list enforcement.',
  DuelRewards: 'Structured custom win/loss duel rewards; remove the field to use no custom reward patch.',
  Craft: 'Structured crafting costs and dismantling rewards.',
  DisableCardStyleRarity: 'Disable Shine/Royal styles when packs are opened.',
  UnlockAllSecrets: 'Unlock all secret packs.',
  PutAllCardsInStandardPack: 'Place all cards in the standard pack.',
  NoDuplicatesPerPack: 'Avoid duplicate cards within one opened pack.',
  DeckEditorDisableLimits: 'Disable deck editor limits.',
  DeckEditorShowStats: 'Show deck statistics in the deck editor.',
  DeckEditorConvertStyleRarity: 'Adjust imported deck styles to owned cards.',
  DuelClientShowRemainingCardsInDeck: 'Show ordered cards remaining in a deck.',
  DuelClientMillenniumEye: 'Reveal cards selected in the duel client.',
  ReplayControlsAlwaysEnabled: 'Keep replay controls visible.',
  DuelClientTimeMultiplier: 'Duel animation and client speed multiplier.',
  ReplayControlsTimeMultiplier: 'Replay fast-forward speed multiplier.',
};

const progressionKeys = new Set(['UnlockAllCards', 'UnlockAllCardsShine', 'UnlockAllCardsHighestRarity', 'UnlockAllItems', 'UnlockAllSoloChapters', 'CardCraftableAll']);
const packKeys = new Set(booleanFields.shop);
const profileKeys = new Set(['DefaultGems', 'DefaultCraftPoints']);
const objectKeys = new Set(['Craft', 'DuelRewards']);

/** Renderer metadata derived from the same allowlist used by validation. */
export const RUNTIME_POLICY_FIELD_DEFINITIONS: readonly RuntimePolicyFieldDefinition[] = Object.freeze(
  (Object.entries(RUNTIME_POLICY_ALLOWLIST) as Array<[RuntimePolicyFamily, ReadonlySet<string>]>).flatMap(([family, keys]) =>
    [...keys].map((key): RuntimePolicyFieldDefinition => ({
      family,
      key,
      kind: objectKeys.has(key) ? 'object' : profileKeys.has(key) ? 'integer' : key.endsWith('Multiplier') ? 'positive-number' : 'boolean',
      group: objectKeys.has(key) ? 'craft-rewards' : profileKeys.has(key) ? 'profile' : progressionKeys.has(key) ? 'progression' : packKeys.has(key) ? 'packs' : family === 'client' ? 'client' : 'tutorial-rules',
      description: descriptions[key],
      ...(profileKeys.has(key) ? { caveat: 'Only used before Player.json is created; this editor never changes Player.json.' } : {}),
    })),
  ),
);

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const at = (sourcePath: string | undefined, family: RuntimePolicyFamily, field: string) =>
  `${sourcePath || `runtime-policy/${family}.json`}#/payload/${field}`;

/** Validate the intentionally small campaign-experience subset of Settings.md. */
export const validateRuntimePolicyPatch = (
  family: RuntimePolicyFamily,
  patch: unknown,
  sourcePath?: string,
): Problem[] => {
  if (!isObject(patch)) return [problem('RUNTIME_POLICY_INVALID', 'Runtime policy patch must be an object', sourcePath)];
  const problems: Problem[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (!RUNTIME_POLICY_ALLOWLIST[family].has(field)) {
      problems.push(problem('RUNTIME_POLICY_KEY_UNSUPPORTED', `Runtime policy key is not supported: ${family}.${field}`, at(sourcePath, family, field)));
      continue;
    }
    if (booleanFields[family].includes(field) && typeof value !== 'boolean') {
      problems.push(problem('RUNTIME_POLICY_TYPE_INVALID', `${family}.${field} must be a boolean`, at(sourcePath, family, field)));
    }
    if (['DefaultGems', 'DefaultCraftPoints'].includes(field) && (!Number.isInteger(value) || (value as number) < 0)) {
      problems.push(problem('RUNTIME_POLICY_VALUE_INVALID', `${family}.${field} must be a non-negative integer`, at(sourcePath, family, field)));
    }
    if (['DuelClientTimeMultiplier', 'ReplayControlsTimeMultiplier'].includes(field) && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      problems.push(problem('RUNTIME_POLICY_VALUE_INVALID', `${family}.${field} must be a positive number`, at(sourcePath, family, field)));
    }
    if (['Craft', 'DuelRewards'].includes(field) && !isObject(value)) {
      problems.push(problem('RUNTIME_POLICY_TYPE_INVALID', `${family}.${field} must be an object`, at(sourcePath, family, field)));
    }
  }
  if (family === 'settings') {
    const allCardStyles = ['UnlockAllCards', 'UnlockAllCardsShine', 'UnlockAllCardsHighestRarity'].filter((field) => patch[field] === true);
    if (allCardStyles.length > 1) problems.push(problem('RUNTIME_POLICY_CONFLICT', `Only one all-card style policy may be enabled: ${allCardStyles.join(', ')}`, sourcePath));
    for (const field of ['UnlockAllCards', 'UnlockAllCardsShine', 'UnlockAllCardsHighestRarity', 'UnlockAllItems', 'UnlockAllSoloChapters', 'CardCraftableAll', 'DisableBanList']) {
      if (patch[field] === true) problems.push({ ...problem('RUNTIME_POLICY_PROGRESS_BYPASS', `${field} can bypass campaign progression; verify this is intentional`, at(sourcePath, family, field)), severity: 'warning' });
    }
  }
  return problems;
};
