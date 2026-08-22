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
  resolveInside,
} from './fs';
import { serializePayload, unwrapPayload } from './json';
import { getWorkspacePaths, loadManifest } from './manifest';
import { CoreLogger, JsonObject, Problem, SourceManifest, problem } from './types';

type LooseObject = Record<string, unknown>;

const object = (value: unknown): LooseObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as LooseObject) : {};
const number = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const string = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const numericKeys = (value: LooseObject) => Object.keys(value).map(Number).filter(Number.isInteger);
const INT32_MAX = 2147483647;
const GATE_MIN = 90000;
const GATE_MAX = 90999;
const STRUCTURE_MIN = 1129000;
const STRUCTURE_MAX = 1129999;
const LOCAL_CHAPTER_MAX = 9999;
const nextId = (value: LooseObject, label: string) => {
  let candidate = Math.max(0, ...numericKeys(value)) + 1;
  while (Object.prototype.hasOwnProperty.call(value, String(candidate))) candidate += 1;
  if (!Number.isInteger(candidate) || candidate > INT32_MAX) throw new Error(`${label} allocator exceeded Int32`);
  return candidate;
};
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

export const isForbiddenOverlay = (relative: string): boolean => {
  const lower = relative.toLowerCase().replaceAll('\\', '/');
  const parts = lower.split('/');
  const basename = parts.at(-1) || lower;
  const category = parts[0] || '';
  return category === 'shop'
    || category === 'settings'
    || category === 'regulation'
    || basename === 'shop.json'
    || basename.startsWith('shoppackodds')
    || basename === 'settings.json'
    || basename.startsWith('regulation');
};

export const unsupportedChapterPackFields = [
  'unlock_secret',
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
    const itemId = nextUnlockItem.value++;
    unlock[String(type)] = [...array(unlock[String(type)]), itemId];
    unlockItemMap[String(itemId)] = itemMap([entry]);
  }
  if (Object.keys(unlock).length) unlockMap[String(unlockId)] = unlock;
  return Object.keys(unlock).length ? unlockId : 0;
};

export interface OverlayApplyResult {
  warnings: Problem[];
  changedFiles: string[];
}

export const applyCampaignOverlay = async (
  sourceRoot: string,
  runtimeRoot: string,
  options: { projectRoot?: string; logger?: CoreLogger } = {},
): Promise<OverlayApplyResult> => {
  const warnings: Problem[] = [];
  const changedFiles: string[] = [];
  const manifest: SourceManifest = await loadManifest(sourceRoot);
  const paths = getWorkspacePaths(options.projectRoot || path.dirname(sourceRoot), sourceRoot, manifest);
  await Promise.all([paths.gateRoot, paths.deckRoot, paths.structureRoot, paths.overlayRoot].map((root) => assertRealPathInside(sourceRoot, root)));
  const dataRoot = path.resolve(runtimeRoot, 'Data');
  const soloPath = path.join(dataRoot, 'Solo.json');
  await assertRealPathInside(runtimeRoot, soloPath);
  if (!(await exists(soloPath))) throw new Error('Runtime Data/Solo.json is missing');
  const soloDocument = await readJsonFile<JsonObject>(soloPath);
  const soloSource = unwrapPayload<{ Master?: JsonObject }>(soloDocument, 'Master');
  const master = object(soloSource.payload);
  const solo = object(master.Solo);
  if (!Object.keys(solo).length) throw new Error('Runtime Solo.json does not contain Master.Solo');
  const gates = object(solo.gate);
  const chapters = object(solo.chapter);
  const unlocks = object(solo.unlock);
  const unlockItems = object(solo.unlock_item);
  const rewards = object(solo.reward);
  solo.gate = gates;
  solo.chapter = chapters;
  solo.unlock = unlocks;
  solo.unlock_item = unlockItems;
  solo.reward = rewards;
  let unlockId = nextId(unlocks, 'unlock');
  let unlockItemId = nextId(unlockItems, 'unlock item');
  let rewardId = nextId(rewards, 'reward');
  const duelOutputs: Array<{ chapterId: number; document: JsonObject }> = [];

  const gateFiles = await listFiles(paths.gateRoot, '.json');
  for (const gateFile of gateFiles) {
    const relative = path.relative(sourceRoot, gateFile).split(path.sep).join('/');
    const sourceGate = object(await readJsonFile(gateFile));
    const gateId = number(sourceGate.id, NaN);
    if (!Number.isInteger(gateId)) throw new Error(`Gate id is invalid: ${relative}`);
    if (gateId < GATE_MIN || gateId > GATE_MAX) throw new Error(`Gate id is outside the additive range: ${gateId}`);
    if (gates[String(gateId)]) throw new Error(`Runtime gate id already exists: ${gateId}`);
    const gateRecord: LooseObject = { ...sourceGate };
    delete gateRecord.id;
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
      if (object(chapters[String(gateId)])[String(chapterId)]) throw new Error(`Runtime chapter id already exists: ${chapterId}`);
      const chapterRecord: LooseObject = { ...sourceChapter };
      delete chapterRecord.id;
      delete chapterRecord.parent_id;
      delete chapterRecord.description;
      delete chapterRecord.type;
      delete chapterRecord.unlock;
      delete chapterRecord.reward;
      delete chapterRecord.mydeck_reward;
      delete chapterRecord.rental_reward;
      for (const field of unsupportedChapterPackFields) {
        if (sourceChapter[field] === undefined) continue;
        delete chapterRecord[field];
        warnings.push(problem(
          field === 'unlock_secret' ? 'UNLOCK_SECRET_UNSUPPORTED' : 'UNSUPPORTED_PACK_FIELD',
          `${field} is not generated by the public additive core`,
          `${relative}:chapters.${localId}`,
          'warning',
        ));
      }
      chapterRecord.parent_chapter = sourceChapter.parent_id ? safeComposite(sourceChapter.parent_id, gateId, 1) : 0;
      chapterRecord.mydeck_set_id = 0;
      chapterRecord.set_id = 0;
      chapterRecord.unlock_id = 0;
      chapterRecord.begin_sn = string(sourceChapter.begin_sn);
      const duel = sourceChapter.type === 'Duel' || typeof sourceChapter.cpu_deck === 'string';
      chapterRecord.npc_id = duel ? 1 : 0;
      if (sourceChapter.difficulty !== undefined) chapterRecord.difficulty = number(sourceChapter.difficulty);
      if (array(sourceChapter.unlock).length) {
        chapterRecord.unlock_id = unlockId;
        addChapterUnlock(unlocks, unlockItems, unlockId, array(sourceChapter.unlock), { value: unlockItemId });
        unlockItemId += array(sourceChapter.unlock).length;
        unlockId += 1;
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
    const gateCardLine = `${gateId},${number(sourceGate.illust_id, 4027)},${number(sourceGate.illust_x)},${number(sourceGate.illust_y)}`;
    const gateCardsPath = path.join(dataRoot, 'ClientData', 'SoloGateCards.txt');
    await assertRealPathInside(runtimeRoot, gateCardsPath);
    await ensureDirectory(path.dirname(gateCardsPath));
    await appendText(gateCardsPath, gateCardLine);
    changedFiles.push('Data/ClientData/SoloGateCards.txt');
    let ids = `[IDS_SOLO.GATE${String(gateId).padStart(3, '0')}]\n${string(sourceGate.name)}\n[IDS_SOLO.GATE${String(gateId).padStart(3, '0')}_EXPLANATION]\n${string(sourceGate.description)}\n`;
    for (const sourceChapterValue of sourceChapters) {
      const sourceChapter = object(sourceChapterValue);
      const chapterId = compositeChapterId(gateId, localChapterId(gateId, number(sourceChapter.id, 1)));
      ids += `[IDS_SOLO.CHAPTER${chapterId}_EXPLANATION]\n${string(sourceChapter.description)}\n`;
    }
    const soloIdsPath = path.join(dataRoot, 'ClientData', 'IDS', 'IDS_SOLO.txt');
    await assertRealPathInside(runtimeRoot, soloIdsPath);
    await ensureDirectory(path.dirname(soloIdsPath));
    await appendText(soloIdsPath, ids);
    changedFiles.push('Data/ClientData/IDS/IDS_SOLO.txt');
  }

  const duelRoot = path.join(dataRoot, 'SoloDuels');
  await ensureDirectory(duelRoot);
  for (const duel of duelOutputs) {
    const target = path.join(duelRoot, `${duel.chapterId}.json`);
    await assertRealPathInside(runtimeRoot, target);
    if (await exists(target)) throw new Error(`Runtime duel file already exists: ${duel.chapterId}.json`);
    await atomicWriteJson(target, duel.document);
    changedFiles.push(path.relative(runtimeRoot, target).split(path.sep).join('/'));
  }

  const structureRoot = path.join(dataRoot, 'StructureDecks');
  await ensureDirectory(structureRoot);
  const structureFiles = await listFiles(paths.structureRoot, '.json');
  for (const structureFile of structureFiles) {
    const source = object(await readJsonFile(structureFile));
    const id = number(source.id, NaN);
    if (!Number.isInteger(id)) throw new Error(`Structure id is invalid: ${path.basename(structureFile)}`);
    if (id < STRUCTURE_MIN || id > STRUCTURE_MAX) throw new Error(`Structure id is outside the additive range: ${id}`);
    const target = path.join(structureRoot, `${id}.json`);
    await assertRealPathInside(runtimeRoot, target);
    if (await exists(target)) throw new Error(`Runtime structure id already exists: ${id}`);
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

  const generatedSolo = serializePayload({ Master: { ...master, Solo: solo } } as unknown as JsonObject, soloSource);
  await atomicWriteJson(soloPath, generatedSolo);
  changedFiles.push('Data/Solo.json');

  const overlayFiles = await listFiles(paths.overlayRoot);
  for (const file of overlayFiles) {
    const relative = path.relative(paths.overlayRoot, file).split(path.sep).join('/');
    if (isForbiddenOverlay(relative)) {
      warnings.push(problem('OVERLAY_SCOPE_UNSUPPORTED', `Skipped unsupported overlay ${relative}`, relative, 'warning'));
      continue;
    }
    if (!relative.toLowerCase().startsWith('clientdata/')) {
      warnings.push(problem('OVERLAY_SCOPE_UNSUPPORTED', `Only additive ClientData overlays are supported: ${relative}`, relative, 'warning'));
      continue;
    }
    const targetRelative = relative.startsWith('ClientData/') ? `Data/${relative}` : `Data/${relative}`;
    const target = path.resolve(runtimeRoot, ...targetRelative.split('/'));
    await assertRealPathInside(runtimeRoot, target);
    if (!pathInside(runtimeRoot, target)) throw new Error(`Overlay path escapes runtime: ${relative}`);
    if (await exists(target)) {
      if (relative.toLowerCase().endsWith('.txt')) {
        await appendText(target, await fs.readFile(file, 'utf8'));
        changedFiles.push(targetRelative);
      } else {
        warnings.push(problem('OVERLAY_EXISTING_SKIPPED', `Skipped existing runtime overlay ${relative}`, relative, 'warning'));
      }
    } else {
      await ensureDirectory(path.dirname(target));
      await fs.copyFile(file, target);
      changedFiles.push(targetRelative);
    }
  }
  options.logger?.info?.('Applied additive campaign overlay', { changedFiles });
  return { warnings, changedFiles };
};
