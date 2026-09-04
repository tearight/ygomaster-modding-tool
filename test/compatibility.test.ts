import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { dataToFiles } from '../src/main/task/dataToFiles';
import { filesToData } from '../src/main/task/filesToData';
import {
  mergeJsonObjects,
  serializePayload,
  unwrapPayload,
} from '../src/main/task/ygoMasterJson';

const tempDirectories: string[] = [];

const writeJson = async (filePath: string, value: unknown) => {
  await writeFile(filePath, JSON.stringify(value));
};

const createFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ygomaster-tool-'));
  tempDirectories.push(root);

  const dataPath = path.join(root, 'data');
  const filesPath = path.join(root, 'files');
  const duelPath = path.join(dataPath, 'SoloDuels', 'nested');
  const structurePath = path.join(dataPath, 'StructureDecks');
  const idsPath = path.join(dataPath, 'ClientData', 'IDS');
  await Promise.all([
    mkdir(duelPath, { recursive: true }),
    mkdir(structurePath, { recursive: true }),
    mkdir(idsPath, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(
      path.join(dataPath, 'Solo.json'),
      JSON.stringify({
        code: 0,
        res: [
          [
            0,
            {
              Master: {
                Solo: {
                  gate: {
                    67: {
                      category: 2,
                      priority: 1,
                      parent_gate: 0,
                      view_gate: 0,
                      unlock_id: 0,
                      clear_chapter: 670001,
                    },
                  },
                  chapter: {
                    67: {
                      670001: {
                        p1_img: 'player',
                        parent_chapter: 0,
                        mydeck_set_id: 1,
                        set_id: 2,
                        unlock_id: 0,
                        begin_sn: '',
                        npc_id: 1,
                        unlock_secret: '9074 9071',
                      },
                    },
                  },
                  unlock: {},
                  unlock_item: {},
                  reward: {
                    1: { 1: { 1: 100 } },
                    2: { 1: { 1: 100 } },
                  },
                },
              },
            },
          ],
        ],
        remove: ['keep-me'],
      }),
    ),
    writeJson(path.join(duelPath, '670001.json'), {
      code: 0,
      res: [
        [
          106,
          {
            Duel: {
              chapter: 670001,
              p1_img: 'player',
              dialog_intro: ['hello'],
              name: ['', 'CPU'],
              mat: [1090005, 1090005],
              sleeve: [1070001, 1070001],
              icon: [1010014, 1010001],
              icon_frame: [1030001, 1030001],
              avatar: [1001004, 0],
              avatar_home: [0, 0],
              duel_object: [1100005, 1100005],
              Deck: [
                {
                  Main: { CardIds: [10029], Rare: [1] },
                  Extra: { CardIds: [], Rare: [] },
                  Side: { CardIds: [], Rare: [] },
                  deck_marker: 'keep',
                },
                {
                  Main: { CardIds: [10030], Rare: [1] },
                  Extra: { CardIds: [], Rare: [] },
                  Side: { CardIds: [], Rare: [] },
                },
              ],
            },
          },
        ],
      ],
      remove: ['keep-me'],
    }),
    writeFile(path.join(dataPath, 'ClientData', 'SoloGateCards.txt'), '67,4027,0,0'),
    writeFile(
      path.join(idsPath, 'IDS_SOLO.txt'),
      '[IDS_SOLO.GATE067]\nGate\n[IDS_SOLO.GATE067_EXPLANATION]\nDescription\n[IDS_SOLO.CHAPTER670001_EXPLANATION]\nChapter\n',
    ),
    writeFile(path.join(idsPath, 'IDS_ITEM.txt'), '[IDS_ITEM.ID1121001]\nStructure\n'),
    writeFile(
      path.join(idsPath, 'IDS_ITEMDESC.txt'),
      '[IDS_ITEMDESC.ID1121001]\nStructure description\n',
    ),
    writeJson(path.join(structurePath, '1121001.json'), {
      structure_id: 1121001,
      accessory: { box: 1080001, sleeve: 1070001 },
      focus: { ids: [10029], r: [1] },
      contents: {
        m: { ids: [10029], r: [1] },
        e: { ids: [], r: [] },
        s: { ids: [], r: [] },
      },
    }),
    writeJson(path.join(dataPath, 'Shop.json'), { sentinel: 'unchanged' }),
    writeJson(path.join(dataPath, 'Settings.json'), { sentinel: 'unchanged' }),
  ]);

  return { dataPath, filesPath };
};

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('YgoMaster JSON compatibility', () => {
  it('unwraps and rewraps response payloads without losing wrapper fields', () => {
    const source = {
      code: 0,
      res: [[106, { Duel: { chapter: 1, custom: true } }]],
      remove: ['keep'],
    };
    const unwrapped = unwrapPayload<{ Duel: { chapter: number } }>(
      source,
      'Duel',
    );
    const generated = mergeJsonObjects(unwrapped.payload, {
      Duel: { chapter: 1, custom: false },
    });
    const result = serializePayload(generated, unwrapped);

    assert.equal(result.code, 0);
    assert.deepEqual(result.remove, ['keep']);
    assert.deepEqual(
      (result.res as unknown[][])[0][1],
      { Duel: { chapter: 1, custom: false } },
    );
  });

  it('imports wrapped and nested duel files, then exports the new string unlock rule', async () => {
    const { dataPath, filesPath } = await createFixture();

    await dataToFiles({
      dataPath,
      gatePath: path.join(filesPath, 'gate'),
      deckPath: path.join(filesPath, 'deck'),
      structureDeckPath: path.join(filesPath, 'structure'),
    });

    const gatePath = path.join(filesPath, 'gate', '67.json');
    const gate = JSON.parse(await readFile(gatePath, 'utf8')) as {
      chapters: Array<{ unlock_pack?: number[] }>;
    };
    gate.chapters[0].unlock_pack = [1234, 5678];
    await writeJson(gatePath, gate);

    await filesToData({
      dataPath,
      gatePath: path.join(filesPath, 'gate'),
      deckPath: path.join(filesPath, 'deck'),
      structureDeckPath: path.join(filesPath, 'structure'),
    });

    const solo = JSON.parse(
      await readFile(path.join(dataPath, 'Solo.json'), 'utf8'),
    ) as Record<string, unknown>;
    const duel = JSON.parse(
      await readFile(
        path.join(dataPath, 'SoloDuels', '670001.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const soloPayload = unwrapPayload<{ Solo: Record<string, unknown> }>(
      solo,
      'Master',
    ).payload;
    const chapter = (
      (soloPayload.Solo.chapter as Record<string, Record<string, unknown>>)[
        '67'
      ]['670001']
    ) as Record<string, unknown>;

    assert.equal(chapter.unlock_secret, '1234 5678');
    assert.equal(chapter.p1_img, 'player');
    assert.deepEqual(solo.remove, ['keep-me']);
    assert.equal(
      (
        (soloPayload.Solo.gate as Record<string, Record<string, unknown>>)[
          '67'
        ]
      ).category,
      2,
    );
    const duelPayload = unwrapPayload<Record<string, unknown>>(
      duel,
      'Duel',
    ).payload;
    assert.equal((duelPayload.dialog_intro as string[])[0], 'hello');
    assert.equal(
      (duelPayload.Deck as Array<Record<string, unknown>>)[0].deck_marker,
      'keep',
    );
    assert.deepEqual(duel.remove, ['keep-me']);

    assert.deepEqual(
      JSON.parse(await readFile(path.join(dataPath, 'Shop.json'), 'utf8')),
      { sentinel: 'unchanged' },
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(dataPath, 'Settings.json'), 'utf8')),
      { sentinel: 'unchanged' },
    );

    const secondFilesPath = path.join(path.dirname(filesPath), 'files-second');
    await dataToFiles({
      dataPath,
      gatePath: path.join(secondFilesPath, 'gate'),
      deckPath: path.join(secondFilesPath, 'deck'),
      structureDeckPath: path.join(secondFilesPath, 'structure'),
    });
    const secondGate = JSON.parse(
      await readFile(path.join(secondFilesPath, 'gate', '67.json'), 'utf8'),
    ) as { chapters: Array<{ unlock_pack?: number[] }> };
    assert.deepEqual(secondGate.chapters[0].unlock_pack, [1234, 5678]);
  });

  it('handles upstream gates without chapter groups and replaces a custom gate', async () => {
    const { dataPath, filesPath } = await createFixture();
    const soloPath = path.join(dataPath, 'Solo.json');
    const sourceSolo = JSON.parse(await readFile(soloPath, 'utf8')) as {
      res: Array<Array<unknown>>;
    };
    const sourceMaster = (sourceSolo.res[0][1] as {
      Master: { Solo: { gate: Record<string, Record<string, unknown>> } };
    }).Master;
    sourceMaster.Solo.gate['21'] = {
      category: 1,
      open_date: 123456,
      priority: 99,
      parent_gate: 0,
      view_gate: 0,
      unlock_id: 0,
      clear_chapter: 670001,
    };
    await writeJson(soloPath, sourceSolo);

    const paths = {
      dataPath,
      gatePath: path.join(filesPath, 'gate'),
      deckPath: path.join(filesPath, 'deck'),
      structureDeckPath: path.join(filesPath, 'structure'),
    };
    await dataToFiles(paths);

    const placeholderGate = JSON.parse(
      await readFile(path.join(paths.gatePath, '21.json'), 'utf8'),
    ) as { chapters: unknown[] };
    assert.deepEqual(placeholderGate.chapters, []);

    const baseGate = JSON.parse(
      await readFile(path.join(paths.gatePath, '67.json'), 'utf8'),
    ) as Record<string, unknown>;
    const baseChapters = baseGate.chapters as Array<Record<string, unknown>>;
    const customGate = JSON.parse(JSON.stringify(baseGate)) as Record<
      string,
      unknown
    >;
    customGate.id = 99;
    customGate.name = 'Custom replacement';
    customGate.priority = 99;
    customGate.clear_chapter = { gateId: 99, chapterId: 1 };
    const customChapter = JSON.parse(
      JSON.stringify(baseChapters[0]),
    ) as Record<string, unknown>;
    customChapter.id = 1;
    customChapter.parent_id = 0;
    customGate.chapters = [customChapter];
    await writeJson(path.join(paths.gatePath, '99.json'), customGate);

    await filesToData(paths);

    const result = JSON.parse(await readFile(soloPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const solo = unwrapPayload<{ Solo: Record<string, unknown> }>(
      result,
      'Master',
    ).payload.Solo;
    const gates = solo.gate as Record<string, Record<string, unknown>>;
    const chapters = solo.chapter as Record<
      string,
      Record<string, Record<string, unknown>>
    >;

    assert.equal(Object.keys(gates).length, 3);
    assert.equal(gates['21'].category, 1);
    assert.equal(gates['21'].open_date, 123456);
    assert.equal(chapters['21'], undefined);
    assert.equal(gates['99'].priority, 99);
    assert.equal(chapters['67']['670001'].p1_img, 'player');
  });
});
