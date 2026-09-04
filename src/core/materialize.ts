import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  atomicWriteJson,
  atomicWriteText,
  assertRealPathInside,
  ensureDirectory,
  exists,
  listFiles,
  pathInside,
  readJsonFile,
  removeExact,
  resolveInside,
} from './fs';
import { cloneJson, serializePayload, unwrapPayload } from './json';
import { getWorkspacePaths, loadManifest } from './manifest';
import { validateRuntimePolicyPatch, type RuntimePolicyFamily } from './runtime-policy';
import { CoreLogger, JsonObject, Problem, SourceManifest, problem } from './types';

type LooseObject = Record<string, unknown>;

const object = (value: unknown): LooseObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as LooseObject) : {};
const number = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const string = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const numericKeys = (value: LooseObject) => Object.keys(value).map(Number).filter(Number.isInteger);
const INT32_MAX = 2147483647;
const GATE_MIN = 100;
const GATE_MAX = 2101;
const STRUCTURE_MIN = 1129000;
const STRUCTURE_MAX = 1129999;
const SHOP_MIN = 1130000;
const SHOP_MAX = 1130999;
const LOCAL_CHAPTER_MAX = 9999;
const compositeChapterId = (gateId: number, localId: number) => {
  const result = gateId * 10000 + localId;
  if (!Number.isInteger(result) || result > INT32_MAX) throw new Error(`Composite chapter id exceeds Int32: ${result}`);
  return result;
};
const localChapterId = (gateId: number, chapterId: number) => {
  if (!Number.isInteger(chapterId)) throw new Error(`Chapter id is not an integer: ${chapterId}`);
  if (chapterId >= 1 && chapterId <= LOCAL_CHAPTER_MAX) return chapterId;
  const local = chapterId - gateId * 10000;
  if (local >= 1 && local <= LOCAL_CHAPTER_MAX) return local;
  throw new Error(`Chapter id is outside the local range: ${chapterId}`);
};

const itemMap = (items: unknown[]): LooseObject => {
  const result: LooseObject = {};
  for (const item of items) {
    const value = object(item);
    const category = number(value.category, NaN);
    const id = number(value.id, NaN);
    if (!Number.isFinite(category) || !Number.isFinite(id)) continue;
    const categoryMap = object(result[String(category)]);
    categoryMap[String(id)] = number(value.counts, 1);
    result[String(category)] = categoryMap;
  }
  return result;
};

const deckPart = (deck: LooseObject, short: string, long: string): { ids: number[]; rare: number[] } => {
  const value = object(deck[short] || deck[long]);
  const ids = array(value.ids || value.CardIds).filter((entry): entry is number => typeof entry === 'number');
  const rare = array(value.r || value.Rare).filter((entry): entry is number => typeof entry === 'number');
  return { ids, rare: rare.length ? rare : ids.map(() => 1) };
};

const loadDeck = async (deckRoot: string, reference: string): Promise<LooseObject> => {
  const normalized = reference.replaceAll('\\', '/');
  const candidates = [resolveInside(deckRoot, normalized)];
  if (path.basename(normalized) !== normalized) candidates.push(resolveInside(deckRoot, path.basename(normalized)));
  for (const candidate of candidates) if (await exists(candidate)) return object(await readJsonFile(candidate));
  throw new Error(`Deck reference does not resolve: ${reference}`);
};

const safeComposite = (value: unknown, gateId: number, fallback: number) => {
  const id = number(value, fallback);
  return compositeChapterId(gateId, localChapterId(gateId, id));
};

const appendText = async (filePath: string, value: string): Promise<void> => {
  const original = (await exists(filePath)) ? await fs.readFile(filePath, 'utf8') : '';
  const separator = original && !original.endsWith('\n') ? '\n' : '';
  await atomicWriteText(filePath, `${original}${separator}${value}${value.endsWith('\n') ? '' : '\n'}`);
};

export const isUnsupportedTargetFile = (relative: string): boolean => {
  const lower = relative.toLowerCase().replaceAll('\\', '/');
  const parts = lower.split('/');
  const basename = parts.at(-1) || lower;
  const category = parts[0] || '';
  if (['shop.json', 'shoppackodds.json', 'data/settings.json', 'data/shop.policy.json', 'data/clientdata/clientsettings.json'].includes(lower)) return false;
  return category === 'shop'
    || category === 'settings'
    || category === 'regulation'
    || basename === 'shop.json'
    || basename.startsWith('shoppackodds')
    || basename === 'settings.json'
    || basename.startsWith('regulation');
};

/** Patch only declared, documented campaign-policy keys into the fresh runtime baseline. */
const materializeRuntimePolicy = async (targetRoot: string, runtimeRoot: string, changedFiles: string[]): Promise<Set<string>> => {
  const consumed = new Set<string>();
  const policies = [
    { family: 'settings', targetRelative: 'Data/Settings.json', sourceRelative: 'Data/Settings.json' },
    { family: 'shop', targetRelative: 'Data/Shop.json', sourceRelative: 'Data/Shop.policy.json' },
    { family: 'client', targetRelative: 'Data/ClientData/ClientSettings.json', sourceRelative: 'Data/ClientData/ClientSettings.json' },
  ] as const;
  for (const policy of policies) {
    const sourcePath = path.join(targetRoot, ...policy.sourceRelative.split('/'));
    if (!(await exists(sourcePath))) continue;
    consumed.add(policy.sourceRelative.toLowerCase());
    const managed = object(await readJsonFile(sourcePath));
    const patch = object(managed.patch);
    if (Object.keys(managed).some((key) => key !== 'patch')) throw new Error(`Managed runtime policy must contain only patch: ${policy.sourceRelative}`);
    const validation = validateRuntimePolicyPatch(policy.family as RuntimePolicyFamily, patch, policy.sourceRelative);
    const errors = validation.filter((entry) => entry.severity !== 'warning');
    if (errors.length) throw new Error(errors.map((entry) => entry.message).join('; '));
    const runtimePath = path.join(runtimeRoot, ...policy.targetRelative.split('/'));
    await assertRealPathInside(runtimeRoot, runtimePath);
    if (!(await exists(runtimePath))) throw new Error(`Runtime ${policy.targetRelative} is missing`);
    const document = await readJsonFile<JsonObject>(runtimePath);
    // Settings and ClientSettings are normally raw key-value files.  Some
    // runtime snapshots wrap them, so patch the named envelope only when it
    // exists; otherwise patch the root without inventing an envelope.
    const payloadKey = policy.family === 'settings' ? 'Settings' : policy.family === 'client' ? 'ClientSettings' : 'Shop';
    let generated: JsonObject;
    try {
      const source = unwrapPayload<JsonObject>(document, payloadKey);
      generated = replaceObjectPayload(source, { ...object(source.payload), ...cloneJson(patch) } as JsonObject);
    } catch {
      generated = { ...object(document), ...cloneJson(patch) } as JsonObject;
    }
    await atomicWriteJson(runtimePath, generated);
    changedFiles.push(policy.targetRelative);
  }
  return consumed;
};

const findNamedArray = (value: unknown, key: string): unknown[] | undefined => {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findNamedArray(child, key);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as LooseObject;
  if (Array.isArray(record[key])) return record[key] as unknown[];
  for (const child of Object.values(record)) {
    const found = findNamedArray(child, key);
    if (found) return found;
  }
  return undefined;
};

const replaceNamedArray = (value: unknown, key: string, replacement: unknown[]): boolean => {
  if (Array.isArray(value)) return value.some((child) => replaceNamedArray(child, key, replacement));
  if (!value || typeof value !== 'object') return false;
  const record = value as LooseObject;
  if (Array.isArray(record[key])) {
    record[key] = replacement;
    return true;
  }
  return Object.values(record).some((child) => replaceNamedArray(child, key, replacement));
};

/** Replace one owned object exactly while preserving its raw/wrapped envelope. */
const replaceObjectPayload = (source: ReturnType<typeof unwrapPayload>, replacement: JsonObject): JsonObject => {
  if (source.shape === 'wrapped') return serializePayload({ [source.payloadKey]: replacement } as JsonObject, source);
  const document = cloneJson(source.document);
  document[source.payloadKey] = cloneJson(replacement);
  return document;
};

const materializeShopData = async (
  targetRoot: string,
  runtimeRoot: string,
  changedFiles: string[],
): Promise<Set<string>> => {
  const consumed = new Set<string>();
  const shopTargetPath = path.join(targetRoot, 'Data', 'Shop.json');
  if (await exists(shopTargetPath)) {
    consumed.add('data/shop.json');
    const managed = object(await readJsonFile(shopTargetPath));
    const replacement = object(managed.PackShop);
    if (!managed.PackShop || Object.keys(managed).some((key) => key !== 'PackShop')) {
      throw new Error('Managed Shop target must contain only a PackShop object');
    }
    const runtimePath = path.join(runtimeRoot, 'Data', 'Shop.json');
    await assertRealPathInside(runtimeRoot, runtimePath);
    if (!(await exists(runtimePath))) throw new Error('Runtime Data/Shop.json is missing');
    const runtimeDocument = await readJsonFile<JsonObject>(runtimePath);
    const source = unwrapPayload<JsonObject>(runtimeDocument, 'PackShop');
    const generatedPacks: JsonObject = {};
    for (const [id, entry] of Object.entries(replacement).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
      const pack = object(entry);
      if (number(pack.packId, NaN) !== Number(id)) throw new Error(`Managed Shop packId does not match key: ${id}`);
      if (Number(id) < SHOP_MIN || Number(id) > SHOP_MAX) throw new Error(`Managed Shop packId is outside the campaign range: ${id}`);
      generatedPacks[id] = cloneJson(pack) as never;
    }
    const withPacks = replaceObjectPayload(source, generatedPacks);
    const structureSource = unwrapPayload<JsonObject>(withPacks, 'StructureShop');
    await atomicWriteJson(runtimePath, replaceObjectPayload(structureSource, {}));
    changedFiles.push('Data/Shop.json');
  }

  const oddsTargetPath = path.join(targetRoot, 'Data', 'ShopPackOdds.json');
  if (await exists(oddsTargetPath)) {
    consumed.add('data/shoppackodds.json');
    const managed = object(await readJsonFile(oddsTargetPath));
    const replacements = array(managed.entries);
    if (!Array.isArray(managed.entries) || Object.keys(managed).some((key) => key !== 'entries')) {
      throw new Error('Managed ShopPackOdds target must contain only an entries array');
    }
    const runtimePath = path.join(runtimeRoot, 'Data', 'ShopPackOdds.json');
    await assertRealPathInside(runtimeRoot, runtimePath);
    const runtimeDocument: unknown = await exists(runtimePath) ? await readJsonFile(runtimePath) : [];
    const existing = Array.isArray(runtimeDocument) ? runtimeDocument : findNamedArray(runtimeDocument, 'ShopPackOdds');
    if (!existing) throw new Error('Runtime ShopPackOdds must be a raw array or contain a ShopPackOdds array');
    const names = new Set<string>();
    const ids = new Set<number>();
    for (const entry of replacements) {
      const odds = object(entry);
      const name = string(odds.name);
      const packIds = array(odds.packShopIds).filter((id): id is number => Number.isInteger(id));
      if (!name || !packIds.length || !Array.isArray(odds.cardRateList)) throw new Error('Managed Shop odds entry requires name, packShopIds, and cardRateList');
      if (names.has(name)) throw new Error(`Managed Shop odds name is duplicated: ${name}`);
      if (packIds.some((id) => ids.has(id))) throw new Error(`Managed Shop odds packShopId is duplicated: ${packIds.find((id) => ids.has(id))}`);
      names.add(name);
      packIds.forEach((id) => ids.add(id));
    }
    const generatedEntries = replacements.map((entry) => cloneJson(entry));
    let generated: unknown = generatedEntries;
    if (!Array.isArray(runtimeDocument)) {
      generated = cloneJson(runtimeDocument);
      if (!replaceNamedArray(generated, 'ShopPackOdds', generatedEntries)) throw new Error('Could not preserve ShopPackOdds wrapper shape');
    }
    await atomicWriteJson(runtimePath, generated);
    changedFiles.push('Data/ShopPackOdds.json');
  }
  if (!consumed.has('data/shop.json') || !consumed.has('data/shoppackodds.json')) {
    throw new Error('Campaign target must provide Shop.json and ShopPackOdds.json');
  }
  return consumed;
};

export const unsupportedChapterPackFields = [
  'unlock_pack',
  'secretType',
  'unlockSecrets',
  'secret_type',
  'unlock_secrets',
] as const;

const buildDuel = async (
  chapter: LooseObject,
  chapterId: number,
  deckRoot: string,
): Promise<JsonObject> => {
  const cpuDeck = await loadDeck(deckRoot, string(chapter.cpu_deck));
  const rentalReference = string(chapter.rental_deck);
  const rentalDeck = rentalReference ? await loadDeck(deckRoot, rentalReference) : cpuDeck;
  const cpu = deckPart(cpuDeck, 'm', 'Main');
  const cpuExtra = deckPart(cpuDeck, 'e', 'Extra');
  const cpuSide = deckPart(cpuDeck, 's', 'Side');
  const rental = deckPart(rentalDeck, 'm', 'Main');
  const rentalExtra = deckPart(rentalDeck, 'e', 'Extra');
  const rentalSide = deckPart(rentalDeck, 's', 'Side');
  const pair = (player: string, opponent: number): [number, number] => [numberValue(player, opponent), opponent];
  const numberValue = (key: string, fallback: number) => number(chapter[key], fallback);
  return {
    Duel: {
      chapter: chapterId,
      name: [string(chapter.player_name), string(chapter.cpu_name, 'CPU')],
      mat: pair('player_mat', 0),
      avatar: pair('player_avatar', 0),
      avatar_home: pair('player_avatar_home', 0),
      duel_object: pair('player_duel_object', 0),
      icon: pair('player_icon', 0),
      icon_frame: pair('player_icon_frame', 0),
      sleeve: pair('player_sleeve', 0),
      hnum: pair('player_hand', 5),
      life: pair('player_life', 8000),
      cpu: number(chapter.cpu_value, 98),
      cpuflag: string(chapter.cpu_flag, 'None'),
      Deck: [
        { Main: { CardIds: rental.ids, Rare: rental.rare }, Extra: { CardIds: rentalExtra.ids, Rare: rentalExtra.rare }, Side: { CardIds: rentalSide.ids, Rare: rentalSide.rare } },
        { Main: { CardIds: cpu.ids, Rare: cpu.rare }, Extra: { CardIds: cpuExtra.ids, Rare: cpuExtra.rare }, Side: { CardIds: cpuSide.ids, Rare: cpuSide.rare } },
      ],
    },
  } as JsonObject;
};

const addReward = (rewardMap: LooseObject, rewards: unknown[], id: number) => {
  if (!rewards.length) return 0;
  rewardMap[String(id)] = itemMap(rewards);
  return id;
};

const addChapterUnlock = (unlockMap: LooseObject, unlockItemMap: LooseObject, unlockId: number, unlocks: unknown[], nextUnlockItem: { value: number }) => {
  const unlock: LooseObject = {};
  for (const entry of unlocks) {
    const value = object(entry);
    const type = number(value.type, 3);
    if (type === 2 || type === 4) {
      const chapterId = number(value.chapterId, NaN);
      const gateId = number(value.gateId, NaN);
      if (!Number.isInteger(chapterId)) continue;
      const targetChapterId = chapterId >= 10000
        ? chapterId
        : Number.isInteger(gateId)
          ? safeComposite(chapterId, gateId, 1)
          : NaN;
      if (!Number.isInteger(targetChapterId)) continue;
      unlock[String(type)] = [...array(unlock[String(type)]), targetChapterId];
      continue;
    }
    if (type !== 3) continue;
    const items = itemMap([entry]);
    if (!Object.keys(items).length) continue;
    const itemId = nextUnlockItem.value++;
    unlock[String(type)] = [...array(unlock[String(type)]), itemId];
    unlockItemMap[String(itemId)] = items;
  }
  if (Object.keys(unlock).length) unlockMap[String(unlockId)] = unlock;
  return Object.keys(unlock).length ? unlockId : 0;
};

export interface DataMaterializationResult {
  warnings: Problem[];
  changedFiles: string[];
}

export const materializeCampaignData = async (
  sourceRoot: string,
  runtimeRoot: string,
  options: { projectRoot?: string; logger?: CoreLogger } = {},
): Promise<DataMaterializationResult> => {
  const warnings: Problem[] = [];
  const changedFiles: string[] = [];
  const manifest: SourceManifest = await loadManifest(sourceRoot);
  const paths = getWorkspacePaths(options.projectRoot || path.dirname(sourceRoot), sourceRoot, manifest);
  await Promise.all([paths.gateRoot, paths.deckRoot, paths.structureRoot, paths.targetRoot].map((root) => assertRealPathInside(sourceRoot, root)));
  const dataRoot = path.resolve(runtimeRoot, 'Data');
  const soloPath = path.join(dataRoot, 'Solo.json');
  await assertRealPathInside(runtimeRoot, soloPath);
  if (!(await exists(soloPath))) throw new Error('Runtime Data/Solo.json is missing');
  const soloDocument = await readJsonFile<JsonObject>(soloPath);
  const soloSource = unwrapPayload<{ Master?: JsonObject }>(soloDocument, 'Master');
  const master = object(soloSource.payload);
  const runtimeSolo = object(master.Solo);
  if (!Object.keys(runtimeSolo).length) throw new Error('Runtime Solo.json does not contain Master.Solo');
  const gates: LooseObject = {};
  const chapters: LooseObject = {};
  const unlocks: LooseObject = {};
  const unlockItems: LooseObject = {};
  const rewards: LooseObject = {};
  const solo: LooseObject = { ...runtimeSolo, gate: gates, chapter: chapters, unlock: unlocks, unlock_item: unlockItems, reward: rewards };
  solo.gate = gates;
  solo.chapter = chapters;
  solo.unlock = unlocks;
  solo.unlock_item = unlockItems;
  solo.reward = rewards;
  let unlockId = 1;
  let unlockItemId = 1;
  let rewardId = 1;
  const duelOutputs: Array<{ chapterId: number; document: JsonObject }> = [];
  const gateCardLines: string[] = [];
  const soloIdSections: string[] = [];

  const gateFiles = await listFiles(paths.gateRoot, '.json');
  for (const gateFile of gateFiles) {
    const relative = path.relative(sourceRoot, gateFile).split(path.sep).join('/');
    const sourceGate = object(await readJsonFile(gateFile));
    const gateId = number(sourceGate.id, NaN);
    if (!Number.isInteger(gateId)) throw new Error(`Gate id is invalid: ${relative}`);
    if (gateId < GATE_MIN || gateId > GATE_MAX) throw new Error(`Gate id is outside the campaign range: ${gateId}`);
    if (gates[String(gateId)]) throw new Error(`Campaign gate id is duplicated: ${gateId}`);
    const gateRecord: LooseObject = { ...sourceGate };
    delete gateRecord.id;
    // `parent_id` belongs to the generated source format. The runtime
    // contract uses `parent_gate`; retaining both fields leaks a legacy
    // linkage key into Solo.json and can make the client resolve a custom
    // gate against the wrong list entry.
    delete gateRecord.parent_id;
    delete gateRecord.name;
    delete gateRecord.description;
    delete gateRecord.illust_id;
    delete gateRecord.illust_x;
    delete gateRecord.illust_y;
    delete gateRecord.chapters;
    delete gateRecord.unlock;
    gateRecord.priority = number(sourceGate.priority);
    gateRecord.parent_gate = number(sourceGate.parent_id);
    gateRecord.view_gate = number(sourceGate.view_gate);
    gateRecord.unlock_id = 0;
    const clear = object(sourceGate.clear_chapter);
    gateRecord.clear_chapter = compositeChapterId(gateId, number(clear.chapterId, number(sourceGate.clear_chapter, 1)));
    const gateUnlocks = array(sourceGate.unlock);
    if (gateUnlocks.length) {
      gateRecord.unlock_id = unlockId;
      const unlock: LooseObject = {};
      for (const entry of gateUnlocks) {
        const value = object(entry);
        const type = number(value.type, 2);
        unlock[String(type)] = [...array(unlock[String(type)]), safeComposite(value.chapterId, number(value.gateId, gateId), 1)];
      }
      unlocks[String(unlockId)] = unlock;
      unlockId += 1;
      if (unlockId > INT32_MAX) throw new Error('unlock allocator exceeded Int32');
    }
    gates[String(gateId)] = gateRecord;
    const chapterMap: LooseObject = {};
    const sourceChapters = array(sourceGate.chapters);
    for (const sourceChapterValue of sourceChapters) {
      const sourceChapter = object(sourceChapterValue);
      const localId = localChapterId(gateId, number(sourceChapter.id, 1));
      const chapterId = compositeChapterId(gateId, localId);
      if (chapterMap[String(chapterId)]) throw new Error(`Campaign chapter id is duplicated: ${chapterId}`);
      const chapterRecord: LooseObject = { ...sourceChapter };
      delete chapterRecord.id;
      delete chapterRecord.parent_id;
      delete chapterRecord.description;
      delete chapterRecord.type;
      delete chapterRecord.unlock;
      delete chapterRecord.reward;
      delete chapterRecord.mydeck_reward;
      delete chapterRecord.rental_reward;
      // Deck references belong to the generated Modding Tool IR. Runtime
      // Solo.json chapters point at the materialized SoloDuels payload via
      // their chapter id; the private TCG/LE comparators do not carry these
      // source paths in Master.Solo.chapter.
      delete chapterRecord.cpu_deck;
      delete chapterRecord.rental_deck;
      for (const field of unsupportedChapterPackFields) {
        if (sourceChapter[field] === undefined) continue;
        delete chapterRecord[field];
        warnings.push(problem(
          'UNSUPPORTED_PACK_FIELD',
          `${field} is not generated by the campaign Data materializer`,
          `${relative}:chapters.${localId}`,
          'warning',
        ));
      }
      chapterRecord.parent_chapter = sourceChapter.parent_id ? safeComposite(sourceChapter.parent_id, gateId, 1) : 0;
      chapterRecord.mydeck_set_id = 0;
      chapterRecord.set_id = 0;
      chapterRecord.unlock_id = 0;
      // The generated source format carries chapter descriptions for IDS,
      // while `begin_sn` is reserved for Scenario scripts.  The current
      // compiler has no Scenario kind; never let stale/generated/handwritten
      // source data reclassify a chapter as Scenario at the runtime boundary.
      chapterRecord.begin_sn = '';
      const duel = sourceChapter.type === 'Duel' || typeof sourceChapter.cpu_deck === 'string';
      chapterRecord.npc_id = duel ? 1 : 0;
      if (sourceChapter.difficulty !== undefined) chapterRecord.difficulty = number(sourceChapter.difficulty);
      if (array(sourceChapter.unlock).length) {
        const nextUnlockItem = { value: unlockItemId };
        const addedUnlockId = addChapterUnlock(unlocks, unlockItems, unlockId, array(sourceChapter.unlock), nextUnlockItem);
        unlockItemId = nextUnlockItem.value;
        if (addedUnlockId) {
          chapterRecord.unlock_id = addedUnlockId;
          unlockId += 1;
        }
        if (unlockItemId > INT32_MAX || unlockId > INT32_MAX) throw new Error('unlock allocator exceeded Int32');
      }
      const rewardItems = array(sourceChapter.reward);
      if (rewardItems.length) chapterRecord.set_id = addReward(rewards, rewardItems, rewardId++);
      const myRewards = array(sourceChapter.mydeck_reward);
      if (myRewards.length) chapterRecord.mydeck_set_id = addReward(rewards, myRewards, rewardId++);
      const rentalRewards = array(sourceChapter.rental_reward);
      if (rentalRewards.length) chapterRecord.set_id = addReward(rewards, rentalRewards, rewardId++);
      if (rewardId > INT32_MAX) throw new Error('reward allocator exceeded Int32');
      chapterMap[String(chapterId)] = chapterRecord;
      if (duel) duelOutputs.push({ chapterId, document: await buildDuel(sourceChapter, chapterId, paths.deckRoot) });
    }
    if (sourceChapters.length) chapters[String(gateId)] = chapterMap;
    gateCardLines.push(`${gateId},${number(sourceGate.illust_id, 4027)},${number(sourceGate.illust_x)},${number(sourceGate.illust_y)}`);
    let ids = `[IDS_SOLO.GATE${String(gateId).padStart(3, '0')}]\n${string(sourceGate.name)}\n[IDS_SOLO.GATE${String(gateId).padStart(3, '0')}_EXPLANATION]\n${string(sourceGate.description)}\n`;
    for (const sourceChapterValue of sourceChapters) {
      const sourceChapter = object(sourceChapterValue);
      const chapterId = compositeChapterId(gateId, localChapterId(gateId, number(sourceChapter.id, 1)));
      ids += `[IDS_SOLO.CHAPTER${chapterId}_EXPLANATION]\n${string(sourceChapter.description)}\n`;
    }
    soloIdSections.push(ids.trimEnd());
  }

  const gateCardsPath = path.join(dataRoot, 'ClientData', 'SoloGateCards.txt');
  const soloIdsPath = path.join(dataRoot, 'ClientData', 'IDS', 'IDS_SOLO.txt');
  await Promise.all([assertRealPathInside(runtimeRoot, gateCardsPath), assertRealPathInside(runtimeRoot, soloIdsPath)]);
  await atomicWriteText(gateCardsPath, `${gateCardLines.join('\n')}\n`);
  await atomicWriteText(soloIdsPath, `${soloIdSections.join('\n')}\n`);
  changedFiles.push('Data/ClientData/SoloGateCards.txt', 'Data/ClientData/IDS/IDS_SOLO.txt');

  const duelRoot = path.join(dataRoot, 'SoloDuels');
  await assertRealPathInside(runtimeRoot, duelRoot);
  await removeExact(duelRoot);
  await ensureDirectory(duelRoot);
  for (const duel of duelOutputs) {
    const target = path.join(duelRoot, `${duel.chapterId}.json`);
    await assertRealPathInside(runtimeRoot, target);
    await atomicWriteJson(target, duel.document);
    changedFiles.push(path.relative(runtimeRoot, target).split(path.sep).join('/'));
  }

  const structureRoot = path.join(dataRoot, 'StructureDecks');
  await assertRealPathInside(runtimeRoot, structureRoot);
  await removeExact(structureRoot);
  await ensureDirectory(structureRoot);
  const structureFiles = await listFiles(paths.structureRoot, '.json');
  for (const structureFile of structureFiles) {
    const source = object(await readJsonFile(structureFile));
    const id = number(source.id, NaN);
    if (!Number.isInteger(id)) throw new Error(`Structure id is invalid: ${path.basename(structureFile)}`);
    if (id < STRUCTURE_MIN || id > STRUCTURE_MAX) throw new Error(`Structure id is outside the campaign range: ${id}`);
    const target = path.join(structureRoot, `${id}.json`);
    await assertRealPathInside(runtimeRoot, target);
    const deck = await loadDeck(paths.deckRoot, string(source.deck));
    const main = deckPart(deck, 'm', 'Main');
    const extra = deckPart(deck, 'e', 'Extra');
    const side = deckPart(deck, 's', 'Side');
    await atomicWriteJson(target, {
      structure_id: id,
      accessory: { box: number(source.box), sleeve: number(source.sleeve) },
      focus: { ids: array(source.focus).filter((entry): entry is number => typeof entry === 'number').slice(0, 3), r: [1, 1, 1] },
      contents: { m: { ids: main.ids, r: main.rare }, e: { ids: extra.ids, r: extra.rare }, s: { ids: side.ids, r: side.rare } },
    });
    changedFiles.push(path.relative(runtimeRoot, target).split(path.sep).join('/'));
    const itemIdsPath = path.join(dataRoot, 'ClientData', 'IDS', 'IDS_ITEM.txt');
    const itemDescPath = path.join(dataRoot, 'ClientData', 'IDS', 'IDS_ITEMDESC.txt');
    await assertRealPathInside(runtimeRoot, itemIdsPath);
    await assertRealPathInside(runtimeRoot, itemDescPath);
    await ensureDirectory(path.dirname(itemIdsPath));
    await appendText(itemIdsPath, `[IDS_ITEM.ID${id}]\n${string(source.name)}\n`);
    await appendText(itemDescPath, `[IDS_ITEMDESC.ID${id}]\n${string(source.description)}\n`);
  }

  const generatedSolo = replaceObjectPayload(soloSource, { ...master, Solo: solo } as unknown as JsonObject);
  await atomicWriteJson(soloPath, generatedSolo);
  changedFiles.push('Data/Solo.json');

  const managedTargetFiles = new Set([
    ...(await materializeShopData(paths.targetRoot, runtimeRoot, changedFiles)),
    ...(await materializeRuntimePolicy(paths.targetRoot, runtimeRoot, changedFiles)),
  ]);

  const targetFiles = await listFiles(paths.targetRoot);
  const backgroundRoot = path.join(dataRoot, 'ClientData', 'SoloGateBackgrounds');
  await assertRealPathInside(runtimeRoot, backgroundRoot);
  await removeExact(backgroundRoot);
  await ensureDirectory(backgroundRoot);
  for (const file of targetFiles) {
    const relative = path.relative(paths.targetRoot, file).split(path.sep).join('/');
    if (managedTargetFiles.has(relative.toLowerCase())) continue;
    if (isUnsupportedTargetFile(relative)) {
      throw new Error(`Unsupported campaign target file: ${relative}`);
    }
    if (!relative.toLowerCase().startsWith('data/clientdata/sologatebackgrounds/')) {
      throw new Error(`Unsupported campaign target file: ${relative}`);
    }
    if (!relative.toLowerCase().endsWith('.png')) {
      throw new Error(`Campaign Gate background must be a PNG: ${relative}`);
    }
    const basename = path.basename(relative);
    if (!/^\d+\.png$/u.test(basename)) {
      throw new Error(`Campaign Gate background must use a numeric Gate id filename: ${relative}`);
    }
    const targetRelative = `Data/ClientData/SoloGateBackgrounds/${basename}`;
    const target = path.resolve(runtimeRoot, ...targetRelative.split('/'));
    await assertRealPathInside(runtimeRoot, target);
    if (!pathInside(runtimeRoot, target)) throw new Error(`Campaign target path escapes runtime: ${relative}`);
    await fs.copyFile(file, target);
    changedFiles.push(targetRelative);
  }
  const backgroundIds = new Set(targetFiles
    .map((file) => path.relative(paths.targetRoot, file).split(path.sep).join('/'))
    .filter((relative) => relative.toLowerCase().startsWith('data/clientdata/sologatebackgrounds/'))
    .map((relative) => Number(path.basename(relative, '.png'))));
  for (const gateId of numericKeys(gates)) {
    if (!backgroundIds.has(gateId)) throw new Error(`Campaign Gate background is missing: ${gateId}.png`);
  }
  const uniqueChangedFiles = [...new Set(changedFiles)];
  options.logger?.info?.('Materialized authoritative campaign Data', { changedFiles: uniqueChangedFiles });
  return { warnings, changedFiles: uniqueChangedFiles };
};
