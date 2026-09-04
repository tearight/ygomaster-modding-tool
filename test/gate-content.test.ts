import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  GATE_CONTENT_CODES,
  assertGateCompilation,
  compileGateContent,
  gateIrSemanticEqual,
  parseGateContent,
  validateGateContent,
} from '../src/core/gate-content';
import { materializeCampaignData } from '../src/core/materialize';
import { buildFakeRuntime } from '../src/core/pipeline-harness';
import { defaultManifest } from '../src/core/manifest';
import { createLocalizationCatalog } from '../src/core/localization-content';

const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/gate-content');

const readJson = async <T>(relativePath: string): Promise<T> =>
  JSON.parse(await readFile(path.join(fixtureRoot, relativePath), 'utf8')) as T;

const readSource = async (relativePath: string): Promise<string> =>
  readFile(path.join(fixtureRoot, relativePath), 'utf8');

const successInput = () => readJson<Record<string, unknown>>('success/gate.json');

const fixtureOptions = async () => ({
  localization: createLocalizationCatalog(await readJson<Record<string, Record<string, string>>>('localization.json'), { fallbackLanguage: 'en' }),
  language: 'en',
  fallbackLanguage: 'en',
  deckReferences: ['decks/cpu.json', 'decks/rental.json', 'decks/boss.json'],
  cardIds: { 'card:blue-eyes': 10029 },
  deckProjections: {
    'decks/cpu.json': { m: { ids: [1001, 1002], r: [1, 1] }, e: { ids: [], r: [] }, s: { ids: [], r: [] } },
    'decks/rental.json': { m: { ids: [1003, 1004], r: [1, 1] }, e: { ids: [], r: [] }, s: { ids: [], r: [] } },
    'decks/boss.json': { m: { ids: [1005, 1006], r: [1, 1] }, e: { ids: [], r: [] }, s: { ids: [], r: [] } },
  },
});

const codes = (problems: readonly { code: string }[]): Set<string> => new Set(problems.map((entry) => entry.code));

describe('GAT-001 versioned symbolic Gate content', () => {
  it('parses symbolic Gate, chapter kinds, target extension, and localization references', async () => {
    const parsed = parseGateContent(await successInput(), 'success/gate.json');
    assert.deepEqual(parsed.problems, []);
    assert.ok(parsed.document);
    assert.equal(parsed.document.gate.id, 'gate:chronicle');
    assert.equal(parsed.document.gate.regulation, 'regulation:chronicle-standard');
    assert.deepEqual(parsed.document.gate.chapters.map((chapter) => chapter.kind), ['duel', 'reward', 'unlock', 'duel']);
    assert.equal(parsed.document.gate.chapters[0]?.duel?.playerMode, 'rental');
    assert.equal(parsed.document.gate.chapters[0]?.duel?.cpuDeck, 'decks/cpu.json');
    assert.deepEqual(parsed.document.gate.target, { ygomaster: { illust_id: 4027 } });
    assert.deepEqual(parsed.document.original.envelope.payload, (await successInput()).payload);
  });

  it('parses authoring-only deckFolder without projecting it to Gate IR or YgoMaster target data', async () => {
    const input = await successInput();
    (input.payload as Record<string, unknown>).deckFolder = 'deck-folder:Chronicle';
    const parsed = parseGateContent(input, 'deck-folder.json');
    assert.ok(parsed.document);
    assert.equal(parsed.document.gate.deckFolder, 'deck-folder:chronicle');
    const compiled = compileGateContent(parsed.document, await fixtureOptions());
    assert.equal(compiled.ok, true, JSON.stringify(compiled.problems));
    const ir = assertGateCompilation(compiled);
    assert.equal(Object.prototype.hasOwnProperty.call(ir.sourceFiles['gate/chronicle.json'] || {}, 'deckFolder'), false);
    assert.equal(JSON.stringify(ir.solo).includes('deckFolder'), false);
    assert.equal(JSON.stringify(ir.duels).includes('deckFolder'), false);
  });

  it('allocates Gate/chapter/reward/structure IDs deterministically and builds target-compatible IR', async () => {
    const parsed = parseGateContent(await successInput(), 'success/gate.json');
    assert.ok(parsed.document);
    const options = await fixtureOptions();
    const first = compileGateContent(parsed.document, options);
    const second = compileGateContent(parsed.document, options);
    assert.equal(first.ok, true, JSON.stringify(first.problems));
    assert.equal(second.ok, true, JSON.stringify(second.problems));
    const ir = assertGateCompilation(first);
    const secondIr = assertGateCompilation(second);
    assert.equal(gateIrSemanticEqual(ir, secondIr), true);
    assert.equal(first.registry?.namespaces.gate.assignments.chronicle?.id, 100);
    assert.equal(Object.keys(ir.solo.gate).length, 1);
    assert.equal(Object.keys(ir.duels).length, 2);
    assert.equal(Object.values(ir.solo.gate)[0]?.illust_id, 4027);
    assert.equal(Object.values(ir.solo.gate)[0]?.category, 1);
    assert.equal(Object.values(ir.solo.gate)[0]?.open_date, -2208988800);
    const rewardId = Object.keys(ir.solo.reward)[0];
    assert.deepEqual(ir.rewardItems[rewardId]?.map((item) => item.category), [1, 2, 12]);
    assert.equal(first.registry?.namespaces.structure.assignments.starter?.id, 1129000);
    assert.equal(Object.values(ir.duels).some((duel) => (duel.Duel as Record<string, unknown>).difficulty === 2), true);
    const sourceGate = ir.sourceFiles['gate/chronicle.json'];
    assert.equal(sourceGate?.illust_id, 4027);
    assert.equal(sourceGate?.category, 1);
    assert.equal(sourceGate?.open_date, -2208988800);
    const sourceChapters = sourceGate?.chapters as Array<Record<string, unknown>>;
    assert.deepEqual(sourceChapters.map((chapter) => chapter.begin_sn), ['', '', '', '']);
    assert.equal(sourceChapters.some((chapter) => chapter.description === 'Start the duel.'), true);
    const targetChapters = Object.values(ir.solo.chapter).flatMap((chapters) => Object.values(chapters));
    assert.equal(targetChapters.every((chapter) => chapter.begin_sn === ''), true);
    const bossId = first.registry?.namespaces.chapter.assignments.boss?.id as number;
    assert.equal(sourceChapters.find((chapter) => chapter.id === bossId % 10000)?.difficulty, 2);
    for (const chapterId of Object.keys(ir.duels).map(Number)) {
      assert.equal(Math.floor(chapterId / 10000), 100);
      assert.ok(chapterId % 10000 >= 1);
    }
    assert.equal(Object.values(ir.sourceFiles).every((file) => typeof file.id === 'number'), true);
    assert.equal(Object.values(ir.sourceFiles).some((file) => Array.isArray(file.chapters)), true);
  });

  it('preserves My Deck reward routing in generated deploy IR', async () => {
    const input = await successInput();
    const payload = input.payload as Record<string, unknown>;
    const chapters = payload.chapters as Array<Record<string, unknown>>;
    const boss = chapters.find((chapter) => chapter.id === 'chapter:boss') as Record<string, unknown>;
    const duel = boss.duel as Record<string, unknown>;
    duel.playerMode = 'mydeck';
    delete duel.rentalDeck;
    boss.rewards = [{ kind: 'gem', amount: 25 }];
    const parsed = parseGateContent(input, 'mydeck-reward.json');
    assert.ok(parsed.document);
    const compiled = compileGateContent(parsed.document, await fixtureOptions());
    assert.equal(compiled.ok, true, JSON.stringify(compiled.problems));
    const sourceGate = assertGateCompilation(compiled).sourceFiles['gate/chronicle.json'];
    const sourceChapters = sourceGate?.chapters as Array<Record<string, unknown>>;
    const sourceBoss = sourceChapters.find((chapter) => chapter.id === 1) as Record<string, unknown>;
    assert.ok(Array.isArray(sourceBoss.mydeck_reward));
    assert.equal(sourceBoss.reward, undefined);
    assert.equal(sourceBoss.rental_reward, undefined);
  });

  it('projects symbolic TCG unlockSecrets to the runtime chapter field', async () => {
    const input = await successInput();
    const firstChapter = ((input.payload as Record<string, unknown>).chapters as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    firstChapter.unlockSecrets = ['shop:next-pack'];
    const parsed = parseGateContent(input, 'unlock-secrets.json');
    assert.ok(parsed.document);
    const compiled = compileGateContent(parsed.document, { ...(await fixtureOptions()), shopIds: { 'shop:next-pack': 1130001 } });
    assert.equal(compiled.ok, true, JSON.stringify(compiled.problems));
    const ir = assertGateCompilation(compiled);
    const openingId = compiled.registry?.namespaces.chapter.assignments.opening?.id as number;
    assert.equal(ir.solo.chapter['100']?.[String(openingId)]?.unlock_secret, '1130001');
    const source = ir.sourceFiles['gate/chronicle.json']?.chapters as Array<Record<string, unknown>>;
    assert.equal(source.find((chapter) => chapter.id === openingId % 10000)?.unlock_secret, '1130001');
  });

  it('detects unknown/numeric fields, graph defects, unreachable required chapters, and path escapes', async () => {
    const unknown = parseGateContent(await readJson('invalid/unknown-field.json'), 'invalid/unknown-field.json');
    assert.equal(codes(unknown.problems).has(GATE_CONTENT_CODES.FIELD_UNKNOWN), true);

    const numeric = parseGateContent({
      formatVersion: 1,
      kind: 'gate',
      payload: { id: 100, nameKey: 'gate.chronicle.name', descriptionKey: 'gate.chronicle.description', goal: 'chapter:one', chapters: [] },
    }, 'numeric.json');
    assert.equal(codes(numeric.problems).has(GATE_CONTENT_CODES.NUMERIC_ID_FORBIDDEN), true);

    const cycle = parseGateContent(await readJson('invalid/cycle.json'), 'invalid/cycle.json');
    assert.ok(cycle.document);
    const cycleResult = validateGateContent(cycle.document);
    const cycleCodes = codes(cycleResult.problems);
    assert.equal(cycleCodes.has(GATE_CONTENT_CODES.PARENT_CYCLE), true);
    assert.equal(cycleCodes.has(GATE_CONTENT_CODES.UNLOCK_GRAPH_CYCLE), true);
    assert.equal(cycleCodes.has(GATE_CONTENT_CODES.PARENT_UNLOCK_CYCLE), true);

    const valid = await successInput();
    const unreachable = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    const payload = unreachable.payload as Record<string, unknown>;
    const chapters = payload.chapters as Array<Record<string, unknown>>;
    chapters.push({ id: 'chapter:unreachable', kind: 'reward', required: true, descriptionKey: 'chapter.reward.description', rewards: [{ kind: 'gem', amount: 1 }] });
    const unreachableResult = validateGateContent(parseGateContent(unreachable, 'unreachable.json').document);
    assert.equal(codes(unreachableResult.problems).has(GATE_CONTENT_CODES.REQUIRED_UNREACHABLE), true);

    const escaped = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    const escapedPayload = escaped.payload as Record<string, unknown>;
    const escapedChapters = escapedPayload.chapters as Array<Record<string, unknown>>;
    (escapedChapters[0].duel as Record<string, unknown>).cpuDeck = '../outside.json';
    const escapedResult = parseGateContent(escaped, 'escaped.json');
    assert.equal(codes(escapedResult.problems).has(GATE_CONTENT_CODES.DECK_REFERENCE_INVALID), true);
  });

  it('validates malformed and wrong-namespace Gate regulation references with a source pointer', async () => {
    const malformed = await successInput();
    (malformed.payload as Record<string, unknown>).regulation = 'regulation:';
    const malformedResult = parseGateContent(malformed, 'malformed-regulation.json');
    const malformedProblem = malformedResult.problems.find((problem) => problem.code === GATE_CONTENT_CODES.REGULATION_REF_INVALID);
    assert.ok(malformedProblem);
    assert.equal(malformedProblem.sourcePath, 'malformed-regulation.json');
    assert.equal(malformedProblem.jsonPointer, '/payload/regulation');

    const wrongNamespace = await successInput();
    (wrongNamespace.payload as Record<string, unknown>).regulation = 'banlist:chronicle-standard';
    const wrongNamespaceResult = parseGateContent(wrongNamespace, 'wrong-regulation-namespace.json');
    const namespaceProblem = wrongNamespaceResult.problems.find((problem) => problem.code === GATE_CONTENT_CODES.REGULATION_REF_NAMESPACE_INVALID);
    assert.ok(namespaceProblem);
    assert.equal(namespaceProblem.sourcePath, 'wrong-regulation-namespace.json');
    assert.equal(namespaceProblem.jsonPointer, '/payload/regulation');
  });

  it('rejects begin_sn target overrides so Duel scripts cannot re-enter the runtime contract', async () => {
    const chapterTarget = await successInput();
    const chapter = ((chapterTarget.payload as Record<string, unknown>).chapters as Array<Record<string, unknown>>)[0];
    chapter.target = { ygomaster: { begin_sn: 'scenario' } };
    const chapterResult = parseGateContent(chapterTarget, 'begin-sn-target.json');
    const chapterProblem = chapterResult.problems.find((problem) => problem.code === GATE_CONTENT_CODES.TARGET_OVERRIDE_FORBIDDEN && problem.jsonPointer?.endsWith('/begin_sn'));
    assert.ok(chapterProblem);

    const duelTarget = await successInput();
    const duel = ((duelTarget.payload as Record<string, unknown>).chapters as Array<Record<string, unknown>>)[0]?.duel as Record<string, unknown>;
    duel.target = { ygomaster: { begin_sn: 'scenario' } };
    const duelResult = parseGateContent(duelTarget, 'begin-sn-duel-target.json');
    const duelProblem = duelResult.problems.find((problem) => problem.code === GATE_CONTENT_CODES.TARGET_OVERRIDE_FORBIDDEN && problem.jsonPointer?.endsWith('/begin_sn'));
    assert.ok(duelProblem);
  });

  it('blocks Duel compilation without resolved CPU/rental projections and preserves parsed diagnostics', async () => {
    const parsed = parseGateContent(await successInput(), 'success/gate.json');
    assert.ok(parsed.document);
    const noProjection = compileGateContent(parsed.document, {
      ...(await fixtureOptions()),
      deckProjections: undefined,
    });
    const noProjectionCodes = codes(noProjection.problems);
    assert.equal(noProjection.ok, false);
    assert.equal(noProjectionCodes.has(GATE_CONTENT_CODES.DUEL_CPU_DECK_PROJECTION_MISSING), true);
    assert.equal(noProjectionCodes.has(GATE_CONTENT_CODES.DUEL_RENTAL_DECK_PROJECTION_MISSING), true);
    assert.equal(noProjection.ir, undefined);

    const emptyProjection = compileGateContent(parsed.document, {
      ...(await fixtureOptions()),
      deckProjections: { 'decks/cpu.json': { m: { ids: [], r: [] }, e: { ids: [], r: [] }, s: { ids: [], r: [] } }, 'decks/rental.json': { m: { ids: [1], r: [1] }, e: { ids: [], r: [] }, s: { ids: [], r: [] } }, 'decks/boss.json': { m: { ids: [2], r: [1] }, e: { ids: [], r: [] }, s: { ids: [], r: [] } } },
    });
    assert.equal(codes(emptyProjection.problems).has(GATE_CONTENT_CODES.DUEL_DECK_PROJECTION_EMPTY), true);

    const mismatchedOptions = await fixtureOptions();
    mismatchedOptions.deckProjections['decks/cpu.json'] = { m: { ids: [1001, 1002], r: [1] }, e: { ids: [], r: [] }, s: { ids: [], r: [] } };
    const mismatchedProjection = compileGateContent(parsed.document, mismatchedOptions);
    assert.equal(mismatchedProjection.ok, false);
    assert.equal(codes(mismatchedProjection.problems).has(GATE_CONTENT_CODES.DUEL_DECK_PROJECTION_LENGTH_MISMATCH), true);

    const tainted = {
      ...parsed.document,
      original: { ...parsed.document.original, raw: { ...parsed.document.original.raw, unknownRoot: true } },
      diagnostics: [],
      ok: false,
    };
    const preserved = validateGateContent({ document: tainted, problems: [] }, await fixtureOptions());
    assert.equal(codes(preserved.problems).has(GATE_CONTENT_CODES.TOP_LEVEL_UNKNOWN), true);
  });

  it('requires a goal and never returns an IR with clear_chapter zero', async () => {
    const source = await successInput();
    const payload = source.payload as Record<string, unknown>;
    delete payload.goal;
    const parsed = parseGateContent(source, 'missing-goal.json');
    assert.equal(codes(parsed.problems).has(GATE_CONTENT_CODES.GOAL_MISSING), true);
    const result = compileGateContent(source, await fixtureOptions());
    assert.equal(result.ok, false);
    assert.equal(result.ir, undefined);
    assert.equal(codes(result.problems).has(GATE_CONTENT_CODES.GOAL_MISSING), true);
    assert.equal(codes(result.problems).has(GATE_CONTENT_CODES.CLEAR_CHAPTER_ZERO_FORBIDDEN), false);
  });

  it('rejects unsupported pack unlock as an explicit target capability failure', async () => {
    const parsed = parseGateContent(await readJson('invalid/pack-unlock.json'), 'invalid/pack-unlock.json');
    assert.equal(codes(parsed.problems).has(GATE_CONTENT_CODES.UNLOCK_SECRET_UNSUPPORTED), true);
    const result = compileGateContent(parsed.document || await readJson('invalid/pack-unlock.json'));
    assert.equal(result.ok, false);
    assert.equal(result.targetCapability.status, 'blocked');
    assert.equal(result.targetCapability.blockingCode, GATE_CONTENT_CODES.UNLOCK_SECRET_UNSUPPORTED);
  });
});

describe('GAT-001 authoritative fake-runtime projection', () => {
  it('materializes the compiled Gate/Duel source through the Data adapter', async () => {
    const parsed = parseGateContent(await successInput(), 'success/gate.json');
    assert.ok(parsed.document);
    const options = await fixtureOptions();
    const compiled = compileGateContent(parsed.document, options);
    const ir = assertGateCompilation(compiled);
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'gat-001-'));
    try {
      const sourceRoot = path.join(workspaceRoot, 'source');
      const deckRoot = path.join(sourceRoot, 'deck', 'decks');
      await Promise.all([
        mkdir(path.join(sourceRoot, 'gate'), { recursive: true }),
        mkdir(deckRoot, { recursive: true }),
        mkdir(path.join(sourceRoot, 'structure'), { recursive: true }),
        mkdir(path.join(sourceRoot, 'target', 'ygomaster', 'Data', 'ClientData', 'SoloGateBackgrounds'), { recursive: true }),
      ]);
      await writeFile(path.join(sourceRoot, 'manifest.json'), `${JSON.stringify(defaultManifest(), null, 2)}\n`, 'utf8');
      for (const [relative, value] of Object.entries(ir.sourceFiles)) {
        const source = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
        if (Array.isArray(source.chapters)) {
          // Exercise the Data boundary against stale source data from the
          // pre-fix compiler; runtime output must still be non-Scenario.
          source.chapters.forEach((chapter) => {
            if (chapter && typeof chapter === 'object') (chapter as Record<string, unknown>).begin_sn = 'stale scenario';
          });
        }
        await writeFile(path.join(sourceRoot, ...relative.split('/')), `${JSON.stringify(source, null, 2)}\n`, 'utf8');
      }
      for (const deck of ['cpu.json', 'rental.json', 'boss.json']) {
        await writeFile(path.join(deckRoot, deck), await readSource(`decks/${deck}`), 'utf8');
      }
      const gateId = compiled.registry?.namespaces.gate.assignments.chronicle?.id as number;
      await writeFile(path.join(sourceRoot, 'target', 'ygomaster', 'Data', 'Shop.json'), JSON.stringify({ PackShop: {} }), 'utf8');
      await writeFile(path.join(sourceRoot, 'target', 'ygomaster', 'Data', 'ShopPackOdds.json'), JSON.stringify({ entries: [] }), 'utf8');
      await writeFile(path.join(sourceRoot, 'target', 'ygomaster', 'Data', 'ClientData', 'SoloGateBackgrounds', `${gateId}.png`), new Uint8Array());
      const runtime = await buildFakeRuntime({
        root: path.join(workspaceRoot, 'runtime'),
        files: {
          'Data/Solo.json': { Master: { Solo: { gate: { '1': {} }, chapter: {}, unlock: {}, unlock_item: {}, reward: {} } } },
          'Data/Shop.json': { keep: true, PackShop: { '1': {} }, StructureShop: { '2': {} } },
          'Data/ShopPackOdds.json': [{ name: 'baseline' }],
        },
      });
      const applied = await materializeCampaignData(sourceRoot, runtime.root, { projectRoot: workspaceRoot });
      assert.ok(applied.changedFiles.includes('Data/Solo.json'));
      const solo = JSON.parse(await readFile(path.join(runtime.root, 'Data/Solo.json'), 'utf8')) as {
        Master: { Solo: { gate: Record<string, unknown>; chapter: Record<string, Record<string, unknown>>; unlock: Record<string, unknown>; unlock_item: Record<string, unknown> } };
      };
      const soloPayload = solo.Master.Solo;
      const goalId = compiled.registry?.namespaces.chapter.assignments.boss?.id as number;
      assert.ok(soloPayload.gate[String(gateId)]);
      assert.ok(soloPayload.chapter[String(gateId)][String(goalId)]);
      const targetGate = soloPayload.gate[String(gateId)] as Record<string, unknown>;
      assert.equal(targetGate.parent_gate, 0);
      assert.equal(targetGate.parent_id, undefined);
      const targetChapter = soloPayload.chapter[String(gateId)][String(goalId)] as Record<string, unknown>;
      assert.equal(targetChapter.difficulty, 2);
      assert.equal(targetChapter.begin_sn, '');
      assert.equal(targetChapter.cpu_deck, undefined);
      assert.equal(targetChapter.rental_deck, undefined);
      const generatedSourceGate = ir.sourceFiles['gate/chronicle.json'] as Record<string, unknown>;
      const generatedSourceChapters = generatedSourceGate.chapters as Array<Record<string, unknown>>;
      const unlockSource = generatedSourceChapters.find((chapter) => chapter.type === 'Unlock') as Record<string, unknown>;
      const unlockChapterId = gateId * 10000 + Number(unlockSource.id);
      const unlockChapter = soloPayload.chapter[String(gateId)][String(unlockChapterId)] as Record<string, unknown>;
      assert.equal(typeof unlockChapter.unlock_id === 'number' && unlockChapter.unlock_id > 0, true);
      assert.deepEqual(soloPayload.unlock_item, {});
      assert.equal(JSON.stringify(soloPayload.unlock).includes(String(gateId * 10000 + 2)), true);
      const duel = JSON.parse(await readFile(path.join(runtime.root, 'Data', 'SoloDuels', `${goalId}.json`), 'utf8')) as {
        Duel: { chapter: number; Deck: Array<{ Main: { CardIds: number[] } }> };
      };
      assert.equal(duel.Duel.chapter, goalId);
      assert.deepEqual(duel.Duel.Deck[0].Main.CardIds, [1003, 1004]);
      assert.deepEqual(duel.Duel.Deck[1].Main.CardIds, [1005, 1006]);
      const ids = await readFile(path.join(runtime.root, 'Data', 'ClientData', 'IDS', 'IDS_SOLO.txt'), 'utf8');
      assert.equal(ids.includes(`IDS_SOLO.GATE${gateId}`), true);
      assert.equal(ids.includes('Face the final duel.'), true);
      assert.equal((await readFile(path.join(runtime.root, 'Data', 'ClientData', 'SoloGateCards.txt'), 'utf8')).includes(`${gateId},4027`), true);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
