import log from 'electron-log/main';
import { glob } from 'glob';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  ChapterUnlock,
  DuelChapter,
  Gate,
  ItemUnlock,
  Reward,
  StructureDeck,
  isDuelChapter,
  isRewardChapter,
  isUnlockChapter,
} from '../../common/type';
import {
  DeckData,
  DuelData,
  GateData,
  StructureDeckData,
  UnlockSecret,
} from '../type';
import {
  backup,
  batchPromiseAll,
  fileChapterIdToDataChapterId,
  getBackupDirectoryWithTime,
  getChildJsonPaths,
  getJsonPathsRecursively,
  readJson,
  saveJson,
  saveText,
  toPosix,
} from '../utils';
import {
  loadStructureDeckDescriptions,
  loadStructureDeckNames,
} from './dataToFiles';
import {
  isCustomStructureDeckId,
  isCustomStructureDeckPath,
} from './structure-deck';
import {
  JsonObject,
  SOURCE_METADATA_FILE,
  YgoMasterSourceMetadata,
  isJsonObject,
  mergeJsonObjects,
  serializePayload,
  unwrapPayload,
} from './ygoMasterJson';

interface Ids {
  unlockId: number;
  unlockItemId: number;
  rewardId: number;
}

export const filesToData = async (paths: {
  dataPath: string;
  gatePath: string;
  deckPath: string;
  structureDeckPath: string;
}) => {
  const { dataPath, gatePath, deckPath, structureDeckPath } = paths;
  const gates = await loadGates(gatePath);
  const deckPathMap = await loadDeckPathMap(deckPath);
  const structureDecks = await loadStructureDecks(structureDeckPath);
  const sourceMetadata = await loadSourceMetadata(path.dirname(gatePath));

  const gateData = createGateData(
    gates,
    sourceMetadata?.solo?.document,
  );
  const duelDataList = await batchPromiseAll(
    gates.flatMap((gate) => gate.chapters).filter(isDuelChapter),
    (chapter) =>
      createDuelData(
        chapter,
        deckPathMap,
        sourceMetadata?.duels?.[chapter.id.toString()]?.document,
      ),
  );
  const structureDeckDataList = await batchPromiseAll(
    structureDecks,
    (structure) => createStructureDeckData(structure, deckPathMap),
  );

  const backupPath = getBackupDirectoryWithTime(dataPath);
  await saveData({
    backupPath,
    dataPath,
    gates,
    gateData,
    duelDataList,
    structureDecks,
    structureDeckDataList,
    sourceMetadata,
  });
};

const loadSourceMetadata = async (
  filesPath: string,
): Promise<YgoMasterSourceMetadata | undefined> => {
  try {
    return await readJson<YgoMasterSourceMetadata>(
      path.resolve(filesPath, SOURCE_METADATA_FILE),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
};

const loadGates = async (gatePath: string): Promise<Gate[]> => {
  const gatePaths = await getChildJsonPaths(gatePath);
  const gates = await batchPromiseAll(gatePaths, readJson<Gate>);

  return gates
    .map((gate) => ({
      ...gate,
      chapters: gate.chapters.map((chapter) => ({
        ...chapter,
        id: fileChapterIdToDataChapterId(gate.id, chapter.id),
        parent_id:
          chapter.parent_id &&
          fileChapterIdToDataChapterId(gate.id, chapter.parent_id),
      })),
    }))
    .sort((a, b) => a.id - b.id);
};

const loadDeckPathMap = async (
  deckPath: string,
): Promise<Record<string, string>> => {
  const deckPaths = await glob(toPosix(path.resolve(deckPath, '**/*.json')));

  return Object.fromEntries(
    deckPaths.map((deckPath) => [path.basename(deckPath), deckPath]),
  );
};

const loadStructureDecks = async (
  structureDeckPath: string,
): Promise<StructureDeck[]> => {
  let structureDeckPaths: string[];
  try {
    structureDeckPaths = await getChildJsonPaths(structureDeckPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const structureDecks = await batchPromiseAll(
    structureDeckPaths,
    readJson<StructureDeck>,
  );

  return structureDecks.sort((a, b) => a.id - b.id);
};

const createDuelData = async (
  chapter: DuelChapter,
  pathMap: Record<string, string>,
  sourceDocument?: JsonObject,
): Promise<DuelData> => {
  const cpuDeck = await readJson<DeckData>(pathMap[chapter.cpu_deck]);
  const rentalDeck = chapter.rental_deck
    ? await readJson<DeckData>(pathMap[chapter.rental_deck])
    : cpuDeck;
  const sourceDuel = sourceDocument
    ? unwrapPayload<DuelData>(sourceDocument, 'Duel').payload
    : undefined;

  return {
    chapter: chapter.id,
    // The player-side display name is not represented in the authoring
    // chapter model. Keep it from the imported runtime payload instead of
    // replacing it with the editor's empty default.
    name: [sourceDuel?.name?.[0] ?? '', chapter.cpu_name],
    mat: [chapter.player_mat, chapter.cpu_mat],
    sleeve: [chapter.player_sleeve, chapter.cpu_sleeve],
    icon: [chapter.player_icon, chapter.cpu_icon],
    icon_frame: [chapter.player_icon_frame, chapter.cpu_icon_frame],
    avatar: [chapter.player_avatar, chapter.cpu_avatar],
    avatar_home: [chapter.player_avatar_home, chapter.cpu_avatar_home],
    duel_object: [chapter.player_duel_object, chapter.cpu_duel_object],
    hnum: [chapter.player_hand, chapter.cpu_hand],
    life: [chapter.player_life, chapter.cpu_life],
    cpu: chapter.cpu_value,
    cpuflag: chapter.cpu_flag,
    Deck: [
      {
        Main: { CardIds: rentalDeck.m.ids, Rare: rentalDeck.m.r },
        Extra: { CardIds: rentalDeck.e.ids, Rare: rentalDeck.e.r },
        Side: { CardIds: [], Rare: [] },
      },
      {
        Main: { CardIds: cpuDeck.m.ids, Rare: cpuDeck.m.r },
        Extra: { CardIds: cpuDeck.e.ids, Rare: cpuDeck.e.r },
        Side: { CardIds: [], Rare: [] },
      },
    ],
  };
};

const createGateData = (
  gates: Gate[],
  sourceDocument?: JsonObject,
): GateData => {
  const gateData: GateData = {
    gate: {},
    chapter: {},
    unlock: {},
    unlock_item: {},
    reward: {},
  };

  let initialIds: Ids = {
    unlockId: 1,
    unlockItemId: 1,
    rewardId: 1,
  };

  const sourceGateData = sourceDocument
    ? getSoloDataFromDocument(sourceDocument)
    : undefined;

  gates.forEach((gate) => {
    const { data, ids } = createSingleGateData(
      gate,
      initialIds,
      sourceGateData,
    );

    gateData.gate = { ...gateData.gate, ...data.gate };
    gateData.chapter = { ...gateData.chapter, ...data.chapter };
    gateData.unlock = { ...gateData.unlock, ...data.unlock };
    gateData.unlock_item = { ...gateData.unlock_item, ...data.unlock_item };
    gateData.reward = { ...gateData.reward, ...data.reward };
    initialIds = { ...ids };
  });

  return mergeGateData(sourceGateData, gateData);
};

const mergeGeneratedEntries = (
  original: unknown,
  generated: JsonObject,
): JsonObject => {
  const originalEntries = isJsonObject(original) ? original : {};
  const generatedEntries = isJsonObject(generated) ? generated : {};
  const merged = { ...originalEntries };

  Object.entries(generatedEntries).forEach(([key, value]) => {
    // An explicitly empty generated object means that an author deleted all
    // entries in that group.  Keep that distinction from an omitted group,
    // which is how an upstream placeholder gate is represented.
    merged[key] =
      isJsonObject(value) && Object.keys(value).length === 0
        ? {}
        : mergeJsonObjects(originalEntries[key], value as object);
  });

  return merged;
};

const mergeGateData = (
  original: GateData | undefined,
  generated: GateData,
): GateData => {
  if (!original) return generated;

  return {
    ...original,
    ...generated,
    gate: mergeGeneratedEntries(original.gate, generated.gate),
    chapter: mergeGeneratedEntries(original.chapter, generated.chapter),
    unlock: mergeGeneratedEntries(original.unlock, generated.unlock),
    unlock_item: mergeGeneratedEntries(
      original.unlock_item,
      generated.unlock_item,
    ),
    reward: mergeGeneratedEntries(original.reward, generated.reward),
  } as unknown as GateData;
};

const getSoloDataFromDocument = (document: JsonObject): GateData => {
  const source = unwrapPayload<{ Solo: GateData }>(document, 'Master');
  if (!isJsonObject(source.payload.Solo)) {
    throw new Error('Solo.json does not contain Master.Solo');
  }
  return source.payload.Solo as unknown as GateData;
};

const parseUnlockSecret = (value: unknown): number[] => {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is number => typeof item === 'number');
  }
  if (typeof value !== 'string' || !value.trim()) return [];

  return value
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter(Number.isFinite);
};

const sameNumbers = (left: number[], right: number[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const serializeUnlockSecret = (
  unlockPacks?: number[],
  original?: UnlockSecret,
): UnlockSecret | undefined => {
  if (unlockPacks === undefined) return;

  // Keep an imported string byte-for-byte stable until the user changes its
  // semantic pack list. The target format is still always a string for newly
  // authored values.
  if (
    typeof original === 'string' &&
    sameNumbers(parseUnlockSecret(original), unlockPacks)
  ) {
    return original;
  }

  return unlockPacks.join(' ');
};

const createSingleGateData = (
  gate: Gate,
  initialIds: Ids,
  sourceGateData?: GateData,
): { data: GateData; ids: Ids } => {
  const sourceGate = sourceGateData?.gate?.[gate.id] as
    | Record<string, unknown>
    | undefined;
  const gateField: GateData['gate'][string] = {
    priority: gate.priority,
    parent_gate: gate.parent_id,
    // `view_gate` is not part of the editor model, but it is meaningful in
    // the runtime graph. Preserve it for imported gates and use the protocol
    // default for newly authored gates.
    view_gate:
      typeof sourceGate?.view_gate === 'number' ? sourceGate.view_gate : 0,
    unlock_id: 0,
    clear_chapter: fileChapterIdToDataChapterId(
      gate.clear_chapter.gateId,
      gate.clear_chapter.chapterId,
    ),
    ...(typeof sourceGate?.category === 'number' ? { category: sourceGate.category } : {}),
    ...(typeof sourceGate?.open_date === 'number' ? { open_date: sourceGate.open_date } : {}),
  };

  const chapterField: GateData['chapter'][string] = {};
  const unlockField: GateData['unlock'] = {};
  const unlockItemField: GateData['unlock_item'] = {};
  const rewardField: GateData['reward'] = {};
  const ids = { ...initialIds };

  if (gate.unlock.length) {
    const unlock = createChapterUnlock(gate.unlock);

    gateField.unlock_id = ids.unlockId;
    unlockField[ids.unlockId] = unlock;
    ids.unlockId += 1;
  }

  gate.chapters.forEach((chapter) => {
    const sourceChapter = sourceGateData?.chapter?.[gate.id]?.[
      fileChapterIdToDataChapterId(gate.id, chapter.id)
    ];
    const chapterData: GateData['chapter'][string][string] = {
      parent_chapter: chapter.parent_id,
      mydeck_set_id: 0,
      set_id: 0,
      unlock_id: 0,
      begin_sn:
        typeof sourceChapter?.begin_sn === 'string'
          ? sourceChapter.begin_sn
          : '',
      npc_id: 1,
      difficulty: 0,
      unlock_secret: serializeUnlockSecret(
        chapter.unlock_pack,
        sourceChapter?.unlock_secret,
      ),
    };

    if (isUnlockChapter(chapter) && chapter.unlock.length) {
      const { unlock, unlockItem } = createItemUnlock(
        chapter.unlock,
        ids.unlockItemId,
      );

      chapterData.unlock_id = ids.unlockId;
      unlockField[ids.unlockId] = unlock;
      unlockItemField[ids.unlockItemId] = unlockItem;
      ids.unlockId += 1;
      ids.unlockItemId += 1;
      chapterData.npc_id = 0;
    }

    if (isRewardChapter(chapter) && chapter.reward.length) {
      const reward = createReward(chapter.reward);
      chapterData.set_id = ids.rewardId;
      rewardField[ids.rewardId] = reward;
      ids.rewardId += 1;
      chapterData.npc_id = 0;
    }

    if (isDuelChapter(chapter)) {
      chapterData.npc_id =
        typeof sourceChapter?.npc_id === 'number' ? sourceChapter.npc_id : 1;
      chapterData.difficulty = chapter.difficulty;

      if (chapter.mydeck_reward?.length) {
        const reward = createReward(chapter.mydeck_reward);
        chapterData.mydeck_set_id = ids.rewardId;
        rewardField[ids.rewardId] = reward;
        ids.rewardId += 1;
      }

      if (chapter.rental_deck && chapter.rental_reward?.length) {
        const reward = createReward(chapter.rental_reward);
        chapterData.set_id = ids.rewardId;
        rewardField[ids.rewardId] = reward;
        ids.rewardId += 1;
      }
    }

    chapterField[chapter.id] = chapterData;
  });

  return {
    data: {
      gate: { [gate.id]: gateField },
      // Keep a missing upstream chapter group missing.  The current runtime
      // has gate records which intentionally have no chapter payload yet;
      // manufacturing an empty group would make a round trip alter that
      // shape and can make generated-data deletion semantics ambiguous.
      chapter: gate.chapters.length ? { [gate.id]: chapterField } : {},
      unlock: unlockField,
      unlock_item: unlockItemField,
      reward: rewardField,
    },
    ids,
  };
};

const createReward = (chapterRewards: Reward[]) => {
  const reward: GateData['reward'][string] = {};
  chapterRewards.forEach(({ category, id, counts }) => {
    reward[category] = { ...reward[category], [id]: counts };
  });

  return reward;
};

const createChapterUnlock = (gateUnlocks: ChapterUnlock[]) => {
  const unlock: GateData['unlock'][string] = {};
  gateUnlocks.forEach(({ type, gateId, chapterId }) => {
    unlock[type] = [
      ...(unlock[type] ?? []),
      fileChapterIdToDataChapterId(gateId, chapterId),
    ];
  });

  return unlock;
};

const createItemUnlock = (
  chapterUnlocks: ItemUnlock[],
  unlockItemId: number,
) => {
  const firstUnlockType = chapterUnlocks[0].type;
  const unlock: GateData['unlock'][string] = {
    [firstUnlockType]: [unlockItemId],
  };

  const unlockItem: GateData['unlock_item'][string] = {};
  chapterUnlocks
    // Only consider single type
    .filter(({ type }) => type === firstUnlockType)
    .forEach(({ category, id, counts }) => {
      unlockItem[category] = { ...unlockItem[category], [id]: counts };
    });

  return { unlock, unlockItem };
};

const createStructureDeckData = async (
  structure: StructureDeck,
  pathMap: Record<string, string>,
): Promise<StructureDeckData> => {
  const deck = await readJson<DeckData>(pathMap[structure.deck]);

  return {
    structure_id: structure.id,
    accessory: { box: structure.box, sleeve: structure.sleeve },
    focus: {
      ids: structure.focus.length === 3 ? structure.focus : [0, 0, 0],
      r: [1, 1, 1],
    },
    contents: { m: deck.m, e: deck.e, s: deck.s },
  };
};

const backupStructureDecks = async (dataPath: string, backupPath: string) => {
  const structureDeckPath = path.resolve(dataPath, 'StructureDecks');

  const allStructureDeckPaths = await getChildJsonPaths(structureDeckPath);
  const customStructureDeckPaths: string[] = [];
  const systemStructureDeckPaths: string[] = [];

  allStructureDeckPaths.forEach((name) => {
    if (isCustomStructureDeckPath(name)) {
      customStructureDeckPaths.push(name);
    } else {
      systemStructureDeckPaths.push(name);
    }
  });

  await backup(dataPath, {
    backupPath,
    filePaths: customStructureDeckPaths.map((p) => path.relative(dataPath, p)),
    removeExistingBackup: false,
    removeOriginal: false,
  });

  await backup(dataPath, {
    backupPath,
    filePaths: systemStructureDeckPaths.map((p) => path.relative(dataPath, p)),
    removeExistingBackup: false,
    removeOriginal: false,
  });
};

const saveData = async (data: {
  backupPath: string;
  dataPath: string;
  gates: Gate[];
  gateData: GateData;
  duelDataList: DuelData[];
  structureDecks: StructureDeck[];
  structureDeckDataList: StructureDeckData[];
  sourceMetadata?: YgoMasterSourceMetadata;
}) => {
  const {
    backupPath,
    dataPath: targetDataPath,
    gates,
    gateData,
    duelDataList,
    structureDecks,
    structureDeckDataList,
    sourceMetadata,
  } = data;
  log.info('Start save data');

  const stagingDataPath = await fs.mkdtemp(
    path.join(path.dirname(targetDataPath), `.${path.basename(targetDataPath)}-export-`),
  );

  try {
    await fs.mkdir(path.resolve(stagingDataPath, 'SoloDuels'), {
      recursive: true,
    });
    await fs.mkdir(path.resolve(stagingDataPath, 'StructureDecks'), {
      recursive: true,
    });
    await fs.mkdir(path.resolve(stagingDataPath, 'ClientData', 'IDS'), {
      recursive: true,
    });
    await copySystemStructureDecks(targetDataPath, stagingDataPath);

    // Create duel files
    await batchPromiseAll(duelDataList, (duelData) =>
      saveJson(
        path.resolve(stagingDataPath, 'SoloDuels', `${duelData.chapter}.json`),
        createDuelDocument(
          duelData,
          sourceMetadata?.duels?.[duelData.chapter.toString()]?.document,
        ),
      ),
    );
    log.info('Created duel files in staging');

    // Create Solo.json
    await saveJson(
      path.resolve(stagingDataPath, 'Solo.json'),
      createSoloDocument(gateData, sourceMetadata?.solo?.document),
    );
    log.info('Created Solo.json in staging');

    // Create SoloGateCards.txt
    const soloGateCards = gates
      .map(
        ({ id, illust_id, illust_x, illust_y }) =>
          `${id},${illust_id},${illust_x},${illust_y}`,
      )
      .join('\n');
    await saveText(
      path.resolve(stagingDataPath, 'ClientData/SoloGateCards.txt'),
      soloGateCards,
    );
    log.info('Created SoloGateCards.txt in staging');

    // Create IDS_SOLO.txt
    let soloDescriptions = '';
    gates.forEach(({ id, name, description = '', chapters }) => {
      const paddedId = id.toString().padStart(3, '0');
      soloDescriptions += `[IDS_SOLO.GATE${paddedId}]\n${name}\n`;
      soloDescriptions += `[IDS_SOLO.GATE${paddedId}_EXPLANATION]\n${description}\n`;
      chapters.forEach((chapter) => {
        soloDescriptions += `[IDS_SOLO.CHAPTER${chapter.id}_EXPLANATION]\n${chapter.description}\n`;
      });
    });

    await saveText(
      path.resolve(stagingDataPath, 'ClientData/IDS/IDS_SOLO.txt'),
      soloDescriptions,
    );
    log.info('Created IDS_SOLO.txt in staging');

    // Create structure deck files
    await batchPromiseAll(structureDeckDataList, (structureData) =>
      saveJson(
        path.resolve(
          stagingDataPath,
          'StructureDecks',
          `${structureData.structure_id}.json`,
        ),
        structureData,
      ),
    );
    log.info('Created structure deck files in staging');

    const [structureDeckNames, structureDeckDescriptions] = await Promise.all([
      loadStructureDeckNames(targetDataPath),
      loadStructureDeckDescriptions(targetDataPath),
    ]);
    const existingStructureDecksInfo = Array.from(
      structureDeckNames.entries(),
    )
      .filter(([id]) => !isCustomStructureDeckId(id))
      .map(([id, name]) => {
        return { id, name, description: structureDeckDescriptions.get(id) };
      });

    let structureDeckName = '';
    let structureDeckDescription = '';
    [...existingStructureDecksInfo, ...structureDecks].forEach(
      ({ id, name, description = '' }) => {
        structureDeckName += `[IDS_ITEM.ID${id}]\n${name}\n`;
        structureDeckDescription += `[IDS_ITEMDESC.ID${id}]\n${description}\n`;
      },
    );

    await saveText(
      path.resolve(stagingDataPath, 'ClientData/IDS/IDS_ITEM.txt'),
      structureDeckName,
    );
    await saveText(
      path.resolve(stagingDataPath, 'ClientData/IDS/IDS_ITEMDESC.txt'),
      structureDeckDescription,
    );
    log.info('Created IDS_ITEM.txt & IDS_ITEMDESC.txt in staging');

    await validateStagedData(stagingDataPath);

    // Only after every generated file has been written and parsed do we touch
    // the target. The original files remain in place and are backed up first.
    await backup(targetDataPath, {
      backupPath,
      filePaths: [
        'SoloDuels',
        'Solo.json',
        'ClientData/SoloGateCards.txt',
        'ClientData/IDS/IDS_SOLO.txt',
        'ClientData/IDS/IDS_ITEM.txt',
        'ClientData/IDS/IDS_ITEMDESC.txt',
      ],
      removeOriginal: false,
    });
    await backupStructureDecks(targetDataPath, backupPath);
    log.info('Copied original files to backup folder');

    await commitStagedData(targetDataPath, stagingDataPath);
    log.info('Committed staged data');
  } finally {
    await fs.rm(stagingDataPath, { recursive: true, force: true });
  }
};

const copySystemStructureDecks = async (
  sourceDataPath: string,
  stagingDataPath: string,
) => {
  const structureDeckPaths = await getChildJsonPaths(
    path.resolve(sourceDataPath, 'StructureDecks'),
  );
  await batchPromiseAll(
    structureDeckPaths.filter((structureDeckPath) =>
      !isCustomStructureDeckPath(structureDeckPath),
    ),
    async (structureDeckPath) =>
      fs.cp(
        structureDeckPath,
        path.resolve(
          stagingDataPath,
          'StructureDecks',
          path.basename(structureDeckPath),
        ),
        { recursive: true },
      ),
  );
};

const validateStagedData = async (stagingDataPath: string) => {
  await readJson<JsonObject>(path.resolve(stagingDataPath, 'Solo.json'));
  const duelPaths = await getJsonPathsRecursively(
    path.resolve(stagingDataPath, 'SoloDuels'),
  );
  await batchPromiseAll(duelPaths, (duelPath) => readJson<JsonObject>(duelPath));
};

const commitStagedData = async (
  targetDataPath: string,
  stagingDataPath: string,
) => {
  const relativePaths = [
    'SoloDuels',
    'Solo.json',
    'ClientData/SoloGateCards.txt',
    'ClientData/IDS/IDS_SOLO.txt',
    'ClientData/IDS/IDS_ITEM.txt',
    'ClientData/IDS/IDS_ITEMDESC.txt',
  ];

  await batchPromiseAll(relativePaths, async (relativePath) => {
    const sourcePath = path.resolve(stagingDataPath, relativePath);
    const targetPath = path.resolve(targetDataPath, relativePath);
    await fs.rm(targetPath, { recursive: true, force: true });
    await fs.cp(sourcePath, targetPath, { recursive: true });
  });

  const targetStructureDeckPaths = await getChildJsonPaths(
    path.resolve(targetDataPath, 'StructureDecks'),
  );
  await batchPromiseAll(
    targetStructureDeckPaths.filter((structureDeckPath) =>
      isCustomStructureDeckPath(structureDeckPath),
    ),
    (structureDeckPath) => fs.rm(structureDeckPath, { force: true }),
  );

  const stagedStructureDeckPaths = await getChildJsonPaths(
    path.resolve(stagingDataPath, 'StructureDecks'),
  );
  await batchPromiseAll(stagedStructureDeckPaths, async (structureDeckPath) =>
    fs.cp(
      structureDeckPath,
      path.resolve(
        targetDataPath,
        'StructureDecks',
        path.basename(structureDeckPath),
      ),
      { recursive: true },
    ),
  );
};

const createDuelDocument = (
  duelData: DuelData,
  sourceDocument?: JsonObject,
): JsonObject => {
  if (!sourceDocument) return { Duel: duelData };

  const source = unwrapPayload<DuelData>(sourceDocument, 'Duel');
  const mergedDuel = mergeJsonObjects(source.payload, duelData);
  return serializePayload({ Duel: mergedDuel }, source);
};

const createSoloDocument = (
  gateData: GateData,
  sourceDocument?: JsonObject,
): JsonObject => {
  if (!sourceDocument) return { Master: { Solo: gateData } };

  const source = unwrapPayload<{ Solo: GateData }>(sourceDocument, 'Master');
  const master = mergeJsonObjects(source.payload, { Solo: gateData });
  return serializePayload({ Master: master }, source);
};
