import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { buildFakeRuntime } from '../src/core/pipeline-harness';

const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/solo-runtime-contract');
const requiredGateIds = [100, 101, 102, 103, 104, 105, 106] as const;
/** Gate 107 is deliberately outside the Vol.1–7 view/unlock chain. */
const requiredIndependentGateIds = [107] as const;
const expectedPlayableChapterIds = [
  1000001,
  1010001,
  1020001,
  1020002,
  1030001,
  1040001,
  1040002,
  1050001,
  1060001,
  1060002,
] as const;
const expectedIndependentChapterIds = [1070001] as const;
const requiredGateCardMappings = [
  [100, 4044],
  [101, 4008],
  [102, 4507],
  [103, 4069],
  [104, 4027],
  [105, 4861],
  [106, 4749],
  [107, 4044],
] as const;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asPositiveInteger = (value: unknown): number | undefined => {
  const number = asNumber(value);
  return number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined;
};

/** Find a named raw payload in either an unwrapped or code/res-wrapped document. */
const findNamedObject = (value: unknown, name: string): JsonRecord | undefined => {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findNamedObject(child, name);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const direct = value[name];
  if (isRecord(direct)) return direct;
  for (const child of Object.values(value)) {
    const found = findNamedObject(child, name);
    if (found) return found;
  }
  return undefined;
};

const containsNumber = (value: unknown, wanted: number): boolean => {
  if (Array.isArray(value)) return value.some((child) => containsNumber(child, wanted));
  if (isRecord(value)) return Object.values(value).some((child) => containsNumber(child, wanted));
  return value === wanted;
};

const relativePath = (runtimeRoot: string, absolutePath: string): string =>
  path.relative(runtimeRoot, absolutePath).split(path.sep).join('/');

const sectionBody = (text: string, header: string): string => {
  const lines = text.split(/\r?\n/gu);
  const index = lines.findIndex((line) => line.trim() === header);
  if (index < 0) return '';
  const body: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (/^\[[^\]]+\]$/u.test(line.trim())) break;
    body.push(line);
  }
  return body.join('\n').trim();
};

export interface SoloRuntimeContractProblem {
  code: string;
  message: string;
  filePath?: string;
  gateId?: number;
  chapterId?: number;
}

export interface SoloRuntimeContractReport {
  ok: boolean;
  problems: SoloRuntimeContractProblem[];
  gateIds: number[];
  independentGateIds: number[];
  duelChapterIds: number[];
}

export interface SoloRuntimeContractOptions {
  requiredGateIds?: readonly number[];
  independentGateIds?: readonly number[];
  expectedPlayableChapterIds?: readonly number[];
  expectedIndependentChapterIds?: readonly number[];
  requiredGateCardMappings?: readonly (readonly [gateId: number, cardId: number])[];
  /** Runtime IDs copied from the authoritative card catalog for fixture checks. */
  catalogCardIds?: readonly number[];
}

const modeFromChapter = (
  setId: number,
  mydeckSetId: number,
): 'rental' | 'mydeck' | 'both' | undefined => {
  if (setId > 0 && mydeckSetId > 0) return 'both';
  if (setId > 0) return 'rental';
  if (mydeckSetId > 0) return 'mydeck';
  return undefined;
};

/**
 * Validate the final Data tree of a disposable YgoMaster staging/deployment.
 * This intentionally has no dependency on a game install or YgoMaster binary.
 */
export const validateSoloRuntimeContract = async (
  runtimeRoot: string,
  options: SoloRuntimeContractOptions = {},
): Promise<SoloRuntimeContractReport> => {
  const problems: SoloRuntimeContractProblem[] = [];
  const gateIds = [...(options.requiredGateIds ?? requiredGateIds)];
  const independentGateIds = [...(options.independentGateIds ?? requiredIndependentGateIds)];
  const expectedChapterIds = [...(options.expectedPlayableChapterIds ?? expectedPlayableChapterIds)];
  const expectedIndependentChapters = [...(options.expectedIndependentChapterIds ?? expectedIndependentChapterIds)];
  const expectedChapterIdSet = new Set([...expectedChapterIds, ...expectedIndependentChapters]);
  const allGateIds = [...new Set([...gateIds, ...independentGateIds])];
  const duelChapterIds: number[] = [];
  const add = (
    code: string,
    message: string,
    filePath?: string,
    gateId?: number,
    chapterId?: number,
  ): void => {
    problems.push({
      code,
      message,
      ...(filePath ? { filePath } : {}),
      ...(gateId === undefined ? {} : { gateId }),
      ...(chapterId === undefined ? {} : { chapterId }),
    });
  };

  const dataRoot = path.join(runtimeRoot, 'Data');
  const soloFile = path.join(dataRoot, 'Solo.json');
  const idsFile = path.join(dataRoot, 'ClientData', 'IDS', 'IDS_SOLO.txt');
  let soloDocument: unknown;
  try {
    soloDocument = JSON.parse(await readFile(soloFile, 'utf8')) as unknown;
  } catch (error) {
    add('SOLO_DATA_FILE_MISSING', `Cannot read ${relativePath(runtimeRoot, soloFile)}: ${error instanceof Error ? error.message : String(error)}`, relativePath(runtimeRoot, soloFile));
  }

  let idsText: string | undefined;
  try {
    idsText = await readFile(idsFile, 'utf8');
  } catch (error) {
    add('SOLO_IDS_FILE_MISSING', `Cannot read ${relativePath(runtimeRoot, idsFile)}: ${error instanceof Error ? error.message : String(error)}`, relativePath(runtimeRoot, idsFile));
  }

  const solo = findNamedObject(soloDocument, 'Solo');
  if (!solo) {
    add('SOLO_PAYLOAD_MISSING', 'Data/Solo.json does not contain a Solo payload', relativePath(runtimeRoot, soloFile));
    return { ok: false, problems, gateIds, independentGateIds, duelChapterIds };
  }

  const gates = asRecord(solo.gate);
  const chapters = asRecord(solo.chapter);
  const unlocks = asRecord(solo.unlock);
  const clearByGate = new Map<number, number>();
  const chapterMaps = new Map<number, JsonRecord>();

  for (let index = 0; index < gateIds.length; index += 1) {
    const gateId = gateIds[index] as number;
    const gate = gates[String(gateId)];
    const gateRecord = asRecord(gate);
    const gateFile = 'Data/Solo.json';
    if (!isRecord(gate)) {
      add('SOLO_GATE_MISSING', `Required Gate ${gateId} is missing from ${gateFile}`, gateFile, gateId);
      continue;
    }

    const clearChapter = asPositiveInteger(gateRecord.clear_chapter)
      ?? asPositiveInteger(asRecord(gateRecord.clear_chapter).chapterId);
    if (clearChapter === undefined) {
      add('SOLO_GATE_CLEAR_CHAPTER_INVALID', `Gate ${gateId} has no positive clear_chapter`, gateFile, gateId);
    } else {
      clearByGate.set(gateId, clearChapter);
    }

    const chapterMap = asRecord(chapters[String(gateId)]);
    chapterMaps.set(gateId, chapterMap);
    if (!Object.keys(chapterMap).length) {
      add('SOLO_GATE_CHAPTERS_MISSING', `Gate ${gateId} has no chapter map`, gateFile, gateId);
    } else if (clearChapter !== undefined && !Object.prototype.hasOwnProperty.call(chapterMap, String(clearChapter))) {
      add('SOLO_GATE_CLEAR_CHAPTER_UNRESOLVED', `Gate ${gateId} clear_chapter ${clearChapter} is not present in its chapter map`, gateFile, gateId, clearChapter);
    }

    const expectedViewGate = index === 0 ? 0 : gateIds[index - 1] as number;
    if (asNumber(gateRecord.view_gate) !== expectedViewGate) {
      add('SOLO_GATE_VIEW_CHAIN_INVALID', `Gate ${gateId} must view Gate ${expectedViewGate}`, gateFile, gateId);
    }

    if (index > 0) {
      const unlockId = asPositiveInteger(gateRecord.unlock_id);
      const previousGateId = gateIds[index - 1] as number;
      const previousClearChapter = clearByGate.get(previousGateId);
      const unlock = unlockId === undefined ? undefined : unlocks[String(unlockId)];
      if (unlockId === undefined || !isRecord(unlock)) {
        add('SOLO_GATE_UNLOCK_MISSING', `Gate ${gateId} must unlock from Gate ${previousGateId}'s clear chapter`, gateFile, gateId);
      } else if (previousClearChapter === undefined || !containsNumber(unlock, previousClearChapter)) {
        add('SOLO_GATE_UNLOCK_EDGE_INVALID', `Gate ${gateId} unlock ${unlockId} does not reference clear chapter ${previousClearChapter ?? 'unknown'} from Gate ${previousGateId}`, gateFile, gateId);
      }
    }
  }

  const reachable = new Set<number>();
  if (gateIds.length > 0 && isRecord(gates[String(gateIds[0])]) && asNumber(asRecord(gates[String(gateIds[0])]).view_gate) === 0) {
    reachable.add(gateIds[0] as number);
  }
  for (let index = 1; index < gateIds.length; index += 1) {
    const gateId = gateIds[index] as number;
    const previousGateId = gateIds[index - 1] as number;
    const gate = asRecord(gates[String(gateId)]);
    const unlockId = asPositiveInteger(gate.unlock_id);
    const previousClear = clearByGate.get(previousGateId);
    const edgeExists = unlockId !== undefined
      && previousClear !== undefined
      && containsNumber(unlocks[String(unlockId)], previousClear);
    if (reachable.has(previousGateId) && asNumber(gate.view_gate) === previousGateId && edgeExists) reachable.add(gateId);
  }
  for (const gateId of gateIds) {
    if (!reachable.has(gateId)) {
      add('SOLO_GATE_UNREACHABLE', `Gate ${gateId} is not reachable through the Vol.1–7 view/unlock chain`, 'Data/Solo.json', gateId);
    }
  }

  // Independent canaries prove that a single Gate is visible without being
  // accidentally appended to the Vol.1–7 chain or overwritten by its tail.
  for (const gateId of independentGateIds) {
    const gate = gates[String(gateId)];
    const gateRecord = asRecord(gate);
    const gateFile = 'Data/Solo.json';
    if (!isRecord(gate)) {
      add('SOLO_INDEPENDENT_GATE_MISSING', `Required independent Gate ${gateId} is missing from ${gateFile}`, gateFile, gateId);
      continue;
    }
    if (asNumber(gateRecord.view_gate) !== 0 || asNumber(gateRecord.parent_gate) !== 0 || asNumber(gateRecord.unlock_id) !== 0) {
      add('SOLO_INDEPENDENT_GATE_LINK_INVALID', `Independent Gate ${gateId} must have view_gate, parent_gate, and unlock_id set to 0`, gateFile, gateId);
    }
    if (asNumber(gateRecord.category) !== 2) {
      add('SOLO_INDEPENDENT_GATE_CATEGORY_INVALID', `Independent Gate ${gateId} must use category 2 (Training/Challenges)`, gateFile, gateId);
    }
    const clearChapter = asPositiveInteger(gateRecord.clear_chapter)
      ?? asPositiveInteger(asRecord(gateRecord.clear_chapter).chapterId);
    if (clearChapter === undefined) {
      add('SOLO_INDEPENDENT_GATE_CLEAR_CHAPTER_INVALID', `Independent Gate ${gateId} has no positive clear_chapter`, gateFile, gateId);
    } else {
      clearByGate.set(gateId, clearChapter);
    }
    const chapterMap = asRecord(chapters[String(gateId)]);
    chapterMaps.set(gateId, chapterMap);
    if (!Object.keys(chapterMap).length) {
      add('SOLO_INDEPENDENT_GATE_CHAPTERS_MISSING', `Independent Gate ${gateId} has no chapter map`, gateFile, gateId);
    } else if (clearChapter !== undefined && !Object.prototype.hasOwnProperty.call(chapterMap, String(clearChapter))) {
      add('SOLO_INDEPENDENT_GATE_CLEAR_CHAPTER_UNRESOLVED', `Independent Gate ${gateId} clear_chapter ${clearChapter} is not present in its chapter map`, gateFile, gateId, clearChapter);
    }
  }

  const gateCardsFile = path.join(dataRoot, 'ClientData', 'SoloGateCards.txt');
  let gateCardsText: string | undefined;
  try {
    gateCardsText = await readFile(gateCardsFile, 'utf8');
  } catch (error) {
    add('SOLO_GATE_CARDS_FILE_MISSING', `Cannot read ${relativePath(runtimeRoot, gateCardsFile)}: ${error instanceof Error ? error.message : String(error)}`, relativePath(runtimeRoot, gateCardsFile));
  }
  const gateCardById = new Map<number, number>();
  if (gateCardsText !== undefined) {
    for (const [index, rawLine] of gateCardsText.split(/\r?\n/gu).entries()) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const values = line.split(',').map((value) => Number(value.trim()));
      if (values.length !== 4 || values.some((value) => !Number.isInteger(value))) {
        add('SOLO_GATE_CARD_MAPPING_INVALID', `Invalid SoloGateCards row at line ${index + 1}: ${rawLine}`, relativePath(runtimeRoot, gateCardsFile));
        continue;
      }
      gateCardById.set(values[0] as number, values[1] as number);
    }
  }
  for (const [gateId, expectedCardId] of options.requiredGateCardMappings ?? requiredGateCardMappings) {
    const actualCardId = gateCardById.get(gateId);
    if (actualCardId === undefined) {
      add('SOLO_GATE_CARD_MAPPING_MISSING', `SoloGateCards is missing Gate ${gateId} card mapping`, relativePath(runtimeRoot, gateCardsFile), gateId);
      continue;
    }
    if (actualCardId !== expectedCardId) {
      add('SOLO_GATE_CARD_MAPPING_MISMATCH', `Gate ${gateId} maps to card ${actualCardId}, expected catalog card ${expectedCardId}`, relativePath(runtimeRoot, gateCardsFile), gateId);
    }
    if (options.catalogCardIds && !options.catalogCardIds.includes(actualCardId)) {
      add('SOLO_GATE_CARD_CATALOG_ID_MISSING', `Gate ${gateId} card ${actualCardId} is not present in the supplied catalog runtime IDs`, relativePath(runtimeRoot, gateCardsFile), gateId);
    }
  }

  for (const gateId of allGateIds) {
    const chapterMap = chapterMaps.get(gateId) ?? {};
    for (const [chapterKey, value] of Object.entries(chapterMap)) {
      const chapterId = Number(chapterKey);
      if (!Number.isInteger(chapterId) || !isRecord(value)) continue;
      const chapter = value;
      const setId = asNumber(chapter.set_id) ?? 0;
      const mydeckSetId = asNumber(chapter.mydeck_set_id) ?? 0;
      const npcId = asNumber(chapter.npc_id);
      const isPlayableDuelOrPractice = expectedChapterIdSet.has(chapterId)
        || (npcId !== undefined
        && npcId > 0
        && (setId > 0 || mydeckSetId > 0));
      if (!isPlayableDuelOrPractice) continue;
      duelChapterIds.push(chapterId);
      const duelFile = `Data/SoloDuels/${chapterId}.json`;
      const duelPath = path.join(runtimeRoot, ...duelFile.split('/'));
      let duelDocument: unknown;
      try {
        duelDocument = JSON.parse(await readFile(duelPath, 'utf8')) as unknown;
      } catch (error) {
        add('SOLO_DUEL_FILE_MISSING', `Duel chapter ${chapterId} is missing ${duelFile}: ${error instanceof Error ? error.message : String(error)}`, duelFile, gateId, chapterId);
      }
      const duel = findNamedObject(duelDocument, 'Duel');
      if (!duel) {
        add('SOLO_DUEL_PAYLOAD_MISSING', `Duel chapter ${chapterId} has no Duel payload at ${duelFile}`, duelFile, gateId, chapterId);
      } else if (asNumber(duel.chapter) !== chapterId) {
        add('SOLO_DUEL_CHAPTER_MISMATCH', `Duel file ${duelFile} declares chapter ${String(duel.chapter)} instead of ${chapterId}`, duelFile, gateId, chapterId);
      }

      if (chapter.begin_sn !== '') {
        add('SOLO_DUEL_BEGIN_SN_NON_EMPTY', `Duel chapter ${chapterId} has non-empty begin_sn; expected empty (runtime duel path ${duelFile})`, 'Data/Solo.json', gateId, chapterId);
      }
      if (npcId === undefined || npcId <= 0) {
        add('SOLO_DUEL_NPC_ID_INVALID', `Duel chapter ${chapterId} must have npc_id > 0`, 'Data/Solo.json', gateId, chapterId);
      }

      const mode = modeFromChapter(setId, mydeckSetId);
      if (!mode) {
        add('SOLO_DUEL_MODE_UNKNOWN', `Duel chapter ${chapterId} has no rental/mydeck mode`, 'Data/Solo.json', gateId, chapterId);
      } else if (mode === 'rental' && !(setId > 0 && !(mydeckSetId > 0))) {
        add('SOLO_DUEL_RENTAL_REWARD_INVALID', `Rental-only Duel chapter ${chapterId} requires set_id > 0 and no mydeck_set_id`, 'Data/Solo.json', gateId, chapterId);
      } else if (mode === 'mydeck' && !(mydeckSetId > 0 && !(setId > 0))) {
        add('SOLO_DUEL_MYDECK_REWARD_INVALID', `Mydeck-only Duel chapter ${chapterId} requires mydeck_set_id > 0 and no set_id`, 'Data/Solo.json', gateId, chapterId);
      } else if (mode === 'both' && !(setId > 0 && mydeckSetId > 0)) {
        add('SOLO_DUEL_BOTH_REWARDS_INVALID', `Both-mode Duel chapter ${chapterId} requires set_id > 0 and mydeck_set_id > 0`, 'Data/Solo.json', gateId, chapterId);
      }

      const chapterHeader = `[IDS_SOLO.CHAPTER${chapterId}_EXPLANATION]`;
      if (idsText !== undefined && !new RegExp(`^\\[IDS_SOLO\\.CHAPTER${chapterId}_EXPLANATION\\]$`, 'mu').test(idsText)) {
        add('SOLO_DUEL_IDS_EXPLANATION_MISSING', `IDS_SOLO is missing ${chapterHeader}`, relativePath(runtimeRoot, idsFile), gateId, chapterId);
      }
      const description = typeof chapter.description === 'string'
        ? chapter.description
        : sectionBody(idsText ?? '', chapterHeader);
      if (description && typeof chapter.begin_sn === 'string' && chapter.begin_sn.includes(description)) {
        add('SOLO_DUEL_DESCRIPTION_IN_BEGIN_SN', `Duel chapter ${chapterId} description must remain in IDS explanation, not begin_sn (runtime path ${duelFile})`, duelFile, gateId, chapterId);
      }
    }
  }

  for (const chapterId of [...expectedChapterIds, ...expectedIndependentChapters]) {
    const gateId = Math.floor(chapterId / 10000);
    const chapterMap = chapterMaps.get(gateId);
    if (!chapterMap || !isRecord(chapterMap[String(chapterId)])) {
      const scope = expectedIndependentChapters.includes(chapterId) ? 'independent canary' : 'Vol.1–7';
      add('SOLO_EXPECTED_CHAPTER_MISSING', `Expected ${scope} playable chapter ${chapterId} is missing from Data/Solo.json`, 'Data/Solo.json', gateId, chapterId);
    }
  }

  duelChapterIds.sort((left, right) => left - right);
  return { ok: problems.length === 0, problems, gateIds, independentGateIds, duelChapterIds };
};

interface StagingFixture {
  workspaceRoot: string;
  runtimeRoot: string;
}

const stagePositiveFixture = async (): Promise<StagingFixture> => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'solo-runtime-contract-'));
  const fakeRuntime = await buildFakeRuntime({ root: path.join(workspaceRoot, 'fake-runtime') });
  await cp(path.join(fixtureRoot, 'positive', 'Data'), path.join(fakeRuntime.root, 'Data'), { recursive: true, force: false });
  return { workspaceRoot, runtimeRoot: fakeRuntime.root };
};

const readFixtureCatalogCardIds = async (): Promise<number[]> => {
  const document = JSON.parse(await readFile(path.join(fixtureRoot, 'catalog-card-ids.json'), 'utf8')) as { schemaVersion?: number; catalogGeneration?: string; source?: string; cardIds?: unknown };
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.source, '.db/catalog.json');
  assert.equal(document.catalogGeneration, 'ygomaster-catalog-0bead34330e6d552112671c5');
  assert.ok(Array.isArray(document.cardIds));
  return document.cardIds.filter((value): value is number => typeof value === 'number');
};

const validateStagedFixture = async (runtimeRoot: string): Promise<SoloRuntimeContractReport> =>
  validateSoloRuntimeContract(runtimeRoot, { catalogCardIds: await readFixtureCatalogCardIds() });

describe('HAR-003 Solo runtime classification contract', () => {
  it('passes the positive disposable final Data staging for Vol.1–7 and all Duel modes', async () => {
    const fixture = await stagePositiveFixture();
    try {
      const report = await validateStagedFixture(fixture.runtimeRoot);
      assert.deepEqual(report.problems, [], JSON.stringify(report.problems, null, 2));
      assert.deepEqual(report.gateIds, [...requiredGateIds]);
      assert.deepEqual(report.independentGateIds, [...requiredIndependentGateIds]);
      assert.deepEqual(report.duelChapterIds, [...expectedPlayableChapterIds, ...expectedIndependentChapterIds].sort((left, right) => left - right));
    } finally {
      await rm(fixture.workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects a non-empty begin_sn with the chapter ID and SoloDuels file diagnostic', async () => {
    const fixture = await stagePositiveFixture();
    try {
      const mutation = JSON.parse(await readFile(path.join(fixtureRoot, 'negative', 'begin-sn.json'), 'utf8')) as {
        relativePath: string;
        gateId: number;
        chapterId: number;
        begin_sn: string;
      };
      const soloPath = path.join(fixture.runtimeRoot, ...mutation.relativePath.split('/'));
      const soloDocument = JSON.parse(await readFile(soloPath, 'utf8')) as JsonRecord;
      const solo = findNamedObject(soloDocument, 'Solo');
      assert.ok(solo);
      const chapter = asRecord(asRecord(solo.chapter)[String(mutation.gateId)])[String(mutation.chapterId)];
      assert.ok(isRecord(chapter));
      chapter.begin_sn = mutation.begin_sn;
      await writeFile(soloPath, `${JSON.stringify(soloDocument, null, 2)}\n`, 'utf8');

      const report = await validateStagedFixture(fixture.runtimeRoot);
      assert.equal(report.ok, false);
      const diagnostic = report.problems.find((problem) => problem.code === 'SOLO_DUEL_BEGIN_SN_NON_EMPTY');
      assert.ok(diagnostic);
      assert.equal(diagnostic.chapterId, mutation.chapterId);
      assert.equal(diagnostic.filePath, 'Data/Solo.json');
      assert.match(diagnostic.message, new RegExp(String(mutation.chapterId), 'u'));
      assert.match(diagnostic.message, new RegExp(`Data/SoloDuels/${mutation.chapterId}\\.json`, 'u'));
    } finally {
      await rm(fixture.workspaceRoot, { recursive: true, force: true });
    }
  });

  it('does not let an expected chapter with npc_id 0 evade Duel validation', async () => {
    const fixture = await stagePositiveFixture();
    try {
      const soloPath = path.join(fixture.runtimeRoot, 'Data', 'Solo.json');
      const soloDocument = JSON.parse(await readFile(soloPath, 'utf8')) as JsonRecord;
      const solo = findNamedObject(soloDocument, 'Solo');
      assert.ok(solo);
      const chapter = asRecord(asRecord(solo.chapter)['102'])['1020001'];
      assert.ok(isRecord(chapter));
      chapter.npc_id = 0;
      await writeFile(soloPath, `${JSON.stringify(soloDocument, null, 2)}\n`, 'utf8');

      const report = await validateStagedFixture(fixture.runtimeRoot);
      assert.equal(report.ok, false);
      const diagnostic = report.problems.find((problem) => problem.code === 'SOLO_DUEL_NPC_ID_INVALID');
      assert.ok(diagnostic);
      assert.equal(diagnostic.chapterId, 1020001);
      assert.equal(diagnostic.filePath, 'Data/Solo.json');
    } finally {
      await rm(fixture.workspaceRoot, { recursive: true, force: true });
    }
  });

  it('keeps the independent canary gate card mapped to an authoritative catalog ID', async () => {
    const fixture = await stagePositiveFixture();
    try {
      const gateCardsPath = path.join(fixture.runtimeRoot, 'Data', 'ClientData', 'SoloGateCards.txt');
      const gateCards = await readFile(gateCardsPath, 'utf8');
      await writeFile(gateCardsPath, gateCards.replace('107,4044,0,0', '107,999999,0,0'), 'utf8');

      const report = await validateStagedFixture(fixture.runtimeRoot);
      assert.equal(report.ok, false);
      const diagnostic = report.problems.find((problem) => problem.code === 'SOLO_GATE_CARD_CATALOG_ID_MISSING');
      assert.ok(diagnostic);
      assert.equal(diagnostic.gateId, 107);
      assert.match(diagnostic.message, /999999/u);
    } finally {
      await rm(fixture.workspaceRoot, { recursive: true, force: true });
    }
  });
});
