import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  catalogSearch,
  catalogStatus,
  refreshCatalog,
} from '../src/core';
import { runCli } from '../src/cli';

const roots: string[] = [];

const makeRoot = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ygomaster-catalog-'));
  roots.push(root);
  return root;
};

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const writeRuntimeFixture = async (root: string) => {
  const runtime = path.join(root, '.cache', 'ygomaster', 'releases', 'fixture', 'runtime');
  await mkdir(path.join(runtime, 'Data'), { recursive: true });
  await writeFile(path.join(root, '.cache', 'ygomaster', 'releases', 'fixture', 'metadata.json'), JSON.stringify({
    tag: 'fixture',
    assetName: 'YgoMaster-fixture.zip',
    assetUrl: 'fixture://runtime',
    downloadedAt: new Date().toISOString(),
  }));
  await Promise.all([
    writeFile(path.join(runtime, 'YgoMaster.exe'), ''),
    writeFile(path.join(runtime, 'YgoMasterClient.exe'), ''),
    writeFile(path.join(runtime, 'YgoMasterLoader.dll'), ''),
    writeFile(path.join(runtime, 'Data', 'Solo.json'), '{}'),
    writeFile(path.join(runtime, 'Data', 'CardList.json'), JSON.stringify({ '1001': 4 })),
    writeFile(path.join(runtime, 'Data', 'YdkIds.txt'), '9001 1001\n'),
  ]);
};

const fixtureRuntimeArchive = () => {
  const entries = [
    ['YgoMaster.exe', ''],
    ['YgoMasterClient.exe', ''],
    ['YgoMasterLoader.dll', ''],
    ['Data/Solo.json', '{}'],
    ['Data/CardList.json', JSON.stringify({ '1001': 4 })],
    ['Data/YdkIds.txt', '9001 1001\n'],
  ] as const;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  entries.forEach(([name, value]) => {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(value);
    const local = Buffer.alloc(30 + nameBytes.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    data.copy(local, 30 + nameBytes.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  });
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralDirectory, end]));
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('card catalog', () => {
  it('joins YgoMaster runtime IDs with Korean-first display records and generated tags', async () => {
    const root = await makeRoot();
    const sources = [
      { id: 'korean', language: 'korean' as const, url: 'fixture://ko', format: 'json' as const, revision: 'fixture-ko-1' },
      { id: 'english', language: 'english' as const, url: 'fixture://en', format: 'json' as const, revision: 'fixture-en-1' },
    ];
    const transport = {
      getBytes: async (url: string) => url === 'fixture://ko'
        ? jsonBytes([{ id: 9001, name: '푸른 눈의 백룡', desc: '이 카드는 드래곤족 몬스터다.', type: 0x21, attribute: 16, race: 8192, level: 8, atk: 3000, def: 2500 }])
        : jsonBytes([
          { id: 9002, name: 'Dark Magician', desc: 'Draw one card.', type: 0x21, attribute: 32, race: 2, level: 7 },
          { id: 9004, name: 'Dragon decoy', desc: 'This level 9 dragon card mentions level 8 and 3000 in its text.', type: 0x21, attribute: 16, race: 8192, level: 9, atk: 2800 },
        ]),
    };
    const refreshed = await refreshCatalog(root, {
      sources,
      transport,
      ygoMaster: {
        cardList: { '1001': 4, '1002': 3, '1003': 2, '1004': 1 },
        ydkIds: '9000 1001\n9001 1001\n9002 1002\n9004 1004\n',
        runtimeTag: 'fixture-runtime',
      },
    });
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.data?.cards.length, 3);
    assert.equal(refreshed.data?.cards[0]?.id, 1001);
    assert.equal(refreshed.data?.cards[0]?.names.display, '푸른 눈의 백룡');
    assert.equal(refreshed.data?.cards[1]?.names.display, 'Dark Magician');
    assert.equal(refreshed.data?.cards[0]?.autoTags.includes('type:monster'), true);
    assert.equal(refreshed.data?.cards[0]?.autoTags.includes('race:dragon'), true);
    assert.equal(refreshed.data?.cards[0]?.autoTags.includes('level:8'), true);
    assert.equal(refreshed.data?.cards[0]?.autoTags.includes('effect:드래곤족'), true);
    assert.equal(refreshed.data?.status.metadata?.missingRuntimeIds.includes(1003), true);
    assert.equal(refreshed.data?.status.metadata?.sources[0]?.revision, 'fixture-ko-1');
    assert.match(refreshed.data?.status.sourcePaths.korean || '', /[\\/]\.db[\\/]sources[\\/]korean[\\/]cards\.cdb$/);
    assert.deepEqual(JSON.parse(await readFile(refreshed.data?.status.sourcePaths.korean as string, 'utf8'))[0].name, '푸른 눈의 백룡');

    const search = await catalogSearch(root, 'race:dragon level:8');
    assert.equal(search.ok, true);
    assert.deepEqual(search.data?.cards.map((card) => card.id), [1001]);

    const exactTags = await catalogSearch(root, 'race:dragon level:8 atk:3000');
    assert.equal(exactTags.ok, true);
    assert.deepEqual(exactTags.data?.cards.map((card) => card.id), [1001]);
    assert.deepEqual((await catalogSearch(root, 'id:1001')).data?.cards.map((card) => card.id), [1001]);
    assert.deepEqual((await catalogSearch(root, 'ydk:9001')).data?.cards.map((card) => card.id), [1001]);
  });

  it('preserves a valid cache when a refresh transport fails', async () => {
    const root = await makeRoot();
    const source = { id: 'english', language: 'english' as const, url: 'fixture://en', format: 'json' as const };
    const first = await refreshCatalog(root, {
      sources: [source],
      transport: { getBytes: async () => jsonBytes([{ id: 9001, name: 'Cache Card', desc: 'Draw a card.' }]) },
      ygoMaster: { cardList: { '1001': 4 }, ydkIds: '9001 1001' },
    });
    assert.equal(first.ok, true);
    const failed = await refreshCatalog(root, {
      online: true,
      sources: [source],
      transport: { getBytes: async () => { throw new Error('fixture offline'); } },
      ygoMaster: { cardList: { '1001': 4 }, ydkIds: '9001 1001' },
    });
    assert.equal(failed.ok, true);
    assert.equal(failed.data?.cacheHit, true);
    assert.equal(failed.warnings[0]?.code, 'CATALOG_REFRESH_FAILED');
    assert.equal(failed.data?.cards[0]?.names.display, 'Cache Card');
    assert.equal((await catalogStatus(root)).data?.valid, true);
  });

  it('stores raw sources, stays local-first, and atomically replaces them online', async () => {
    const root = await makeRoot();
    const sources = [
      { id: 'korean', language: 'korean' as const, url: 'fixture://ko', format: 'json' as const, revision: 'fixture-ko-1' },
      { id: 'english', language: 'english' as const, url: 'fixture://en', format: 'json' as const, revision: 'fixture-en-1' },
    ];
    let revision = 1;
    let calls = 0;
    let failEnglish = false;
    const transport = {
      getBytes: async (url: string) => {
        calls += 1;
        if (failEnglish && url === 'fixture://en') throw new Error('fixture online failure');
        const name = url === 'fixture://ko' ? `한국 카드 ${revision}` : `English Card ${revision}`;
        return jsonBytes([{ id: url === 'fixture://ko' ? 9001 : 9002, name, desc: `revision ${revision}` }]);
      },
    };
    const input = { cardList: { '1001': 4, '1002': 3 }, ydkIds: '9001 1001\n9002 1002\n' };

    const first = await refreshCatalog(root, { sources, transport, ygoMaster: input });
    assert.equal(first.ok, true);
    assert.equal(first.data?.cacheHit, false);
    assert.deepEqual(first.data?.sourceUsage, { korean: 'download', english: 'download' });
    assert.equal(calls, 2);
    const firstKoreanPath = first.data?.status.sourcePaths.korean as string;
    const firstEnglishPath = first.data?.status.sourcePaths.english as string;
    const firstKorean = await readFile(firstKoreanPath, 'utf8');
    const firstEnglish = await readFile(firstEnglishPath, 'utf8');
    const firstMetadata = first.data?.status.metadata?.sources || [];
    const firstKoreanMetadata = firstMetadata.find((source) => source.language === 'korean');
    const firstEnglishMetadata = firstMetadata.find((source) => source.language === 'english');

    const invalidConfiguredSources = [
      { ...sources[0], url: 'invalid://korean', revision: 'invalid-ko' },
      { ...sources[1], url: 'invalid://english', revision: 'invalid-en' },
    ];

    const local = await refreshCatalog(root, {
      sources: invalidConfiguredSources,
      transport: { getBytes: async () => { throw new Error('network must not be called for local refresh'); } },
      ygoMaster: input,
    });
    assert.equal(local.ok, true);
    assert.equal(local.data?.cacheHit, true);
    assert.deepEqual(local.data?.sourceUsage, { korean: 'local', english: 'local' });
    assert.equal(local.data?.status.metadata?.sources.every((source) => source.usedFrom === 'local'), true);
    const localKoreanMetadata = local.data?.status.metadata?.sources.find((source) => source.language === 'korean');
    const localEnglishMetadata = local.data?.status.metadata?.sources.find((source) => source.language === 'english');
    assert.equal(localKoreanMetadata?.url, firstKoreanMetadata?.url);
    assert.equal(localKoreanMetadata?.revision, firstKoreanMetadata?.revision);
    assert.equal(localKoreanMetadata?.fetchedAt, firstKoreanMetadata?.fetchedAt);
    assert.equal(localEnglishMetadata?.url, firstEnglishMetadata?.url);
    assert.equal(localEnglishMetadata?.revision, firstEnglishMetadata?.revision);
    assert.equal(localEnglishMetadata?.fetchedAt, firstEnglishMetadata?.fetchedAt);
    assert.equal(calls, 2);

    revision = 2;
    const online = await refreshCatalog(root, { online: true, sources, transport, ygoMaster: input });
    assert.equal(online.ok, true);
    assert.deepEqual(online.data?.sourceUsage, { korean: 'download', english: 'download' });
    assert.notEqual(await readFile(firstKoreanPath, 'utf8'), firstKorean);
    assert.notEqual(await readFile(firstEnglishPath, 'utf8'), firstEnglish);
    assert.equal(calls, 4);

    const updatedKorean = await readFile(firstKoreanPath, 'utf8');
    const updatedEnglish = await readFile(firstEnglishPath, 'utf8');
    failEnglish = true;
    const failed = await refreshCatalog(root, { online: true, sources, transport, ygoMaster: input });
    assert.equal(failed.ok, true);
    assert.equal(failed.data?.cacheHit, true);
    assert.equal(failed.warnings[0]?.code, 'CATALOG_REFRESH_FAILED');
    assert.equal(await readFile(firstKoreanPath, 'utf8'), updatedKorean);
    assert.equal(await readFile(firstEnglishPath, 'utf8'), updatedEnglish);
  });

  it('uses a separate runtime transport when no runtime cache exists', async () => {
    const root = await makeRoot();
    const sources = [{ id: 'english', language: 'english' as const, url: 'fixture://cards', format: 'json' as const }];
    const calls: string[] = [];
    const refreshed = await refreshCatalog(root, {
      sources,
      transport: {
        getBytes: async (url) => {
          calls.push(`catalog:${url}`);
          return jsonBytes([{ id: 9001, name: 'Runtime fixture card', desc: 'Dragon card.', type: 0x21, race: 8192, level: 8, atk: 3000 }]);
        },
      },
      runtimeTransport: {
        getJson: async (url) => {
          calls.push(`runtime-json:${url}`);
          return { tag_name: 'fixture', assets: [{ name: 'YgoMaster-fixture.zip', browser_download_url: 'fixture://runtime' }] };
        },
        getBytes: async (url) => {
          calls.push(`runtime-bytes:${url}`);
          return fixtureRuntimeArchive();
        },
      },
    });
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.data?.cards[0]?.id, 1001);
    assert.equal(calls.some((entry) => entry === 'runtime-json:https://api.github.com/repos/pixeltris/YgoMaster/releases/latest'), true);
    assert.equal(calls.includes('runtime-bytes:fixture://runtime'), true);
    assert.equal(calls.includes('catalog:fixture://cards'), true);
    assert.equal(calls.includes('runtime-json:fixture://cards'), false);
  });

  it('reproduces catalog refresh through source and compiled CLI paths', async () => {
    const root = await makeRoot();
    await writeRuntimeFixture(root);
    const encodedCards = encodeURIComponent(JSON.stringify([{ id: 9001, name: '푸른 눈의 백룡', desc: 'Dragon card.', type: 0x21, race: 8192, level: 8, atk: 3000 }]));
    const args = ['catalog', 'refresh', '--format=json', '--korean-url', `data:application/json,${encodedCards}`];
    const previousRoot = process.env.YGOMASTER_TOOL_PROJECT_ROOT;
    process.env.YGOMASTER_TOOL_PROJECT_ROOT = root;
    try {
      const sourceOutput: string[] = [];
      const sourceCode = await runCli([...args, '--pretty'], { stdout: (value) => sourceOutput.push(value) });
      assert.equal(sourceCode, 0);
      assert.equal(JSON.parse(sourceOutput[0]).ok, true);

      const compiledCli = path.resolve(__dirname, '..', 'dist-cli', 'cli', 'index.js');
      if (existsSync(compiledCli)) {
        const compiledOutput = execFileSync(process.execPath, [compiledCli, ...args], {
          cwd: path.resolve(__dirname, '..'),
          env: { ...process.env, YGOMASTER_TOOL_PROJECT_ROOT: root },
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(JSON.parse(compiledOutput).ok, true);
      }
    } finally {
      if (previousRoot === undefined) delete process.env.YGOMASTER_TOOL_PROJECT_ROOT;
      else process.env.YGOMASTER_TOOL_PROJECT_ROOT = previousRoot;
    }
    const search = await catalogSearch(root, '푸른 눈');
    assert.equal(search.ok, true);
    assert.equal(search.data?.cards[0]?.names.display, '푸른 눈의 백룡');
  });
});
