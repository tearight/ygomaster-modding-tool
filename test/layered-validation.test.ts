import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  validateLayeredCampaign,
  type LayeredSourceLocation,
} from '../src/core/layered-validation';
import type { Problem } from '../src/core/types';

const editorRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/layered-validation');
const temporaryRoots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(editorRoot, '.tmp-layered-validation-'));
  temporaryRoots.push(root);
  return root;
};

const readFixtureProblems = async (name: string): Promise<Problem[]> =>
  JSON.parse(await fs.readFile(path.join(fixtureRoot, name), 'utf8')) as Problem[];

const noOpCompiler = async () => ({ ok: true, checkOnly: true, problems: [], warnings: [] });

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('layered validation policy', () => {
  it('keeps warning-only validation successful and separates quality diagnostics', async () => {
    const warning = (await readFixtureProblems('warning-only.json'))[0];
    const result = await validateLayeredCampaign({
      checkOnly: true,
      contentCheck: () => [warning],
      compileCheck: noOpCompiler,
      validateIr: async () => ({ ok: true, exitCode: 0, exitName: 'SUCCESS', problems: [], warnings: [] }),
      qualityHook: () => [{
        code: 'QUALITY_REVIEW_PENDING',
        message: 'Optional review is pending',
        severity: 'warning',
        sourcePath: 'quality.json',
      }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.exitName, 'SUCCESS');
    assert.equal(result.data?.warningOnly, true);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.warnings.map((problem) => problem.code), ['LOCALIZATION_FALLBACK_USED']);
    assert.deepEqual(result.qualityProblems.map((problem) => problem.code), ['QUALITY_REVIEW_PENDING']);
  });

  it('promotes unsupported target capability to a stable blocking failure', async () => {
    const unsupported = (await readFixtureProblems('unsupported.json'))[0];
    const result = await validateLayeredCampaign({
      compileCheck: () => ({ ok: true, problems: [], warnings: [unsupported] }),
      validateIr: async () => ({ ok: true, exitCode: 0, exitName: 'SUCCESS', problems: [], warnings: [] }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.exitName, 'COMMAND_FAILED');
    assert.deepEqual(result.problems.map((problem) => problem.code), ['SHOP_TARGET_UNSUPPORTED']);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.data?.blockingCodes, ['SHOP_TARGET_UNSUPPORTED']);
  });

  it('remaps generated diagnostics to authored provenance and still calls IR validation', async () => {
    let irCalled = false;
    const generated = {
      code: 'IR_GATE_INVALID',
      message: 'Generated wording is intentionally unstable',
      severity: 'warning' as const,
      path: 'gate/100.json',
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 5,
      jsonPointer: '/title',
    };
    const location: LayeredSourceLocation = {
      sourcePath: 'content/gates/intro.json',
      line: 17,
      column: 4,
      endLine: 17,
      endColumn: 16,
      jsonPointer: '/chapters/0/titleKey',
    };
    const result = await validateLayeredCampaign({
      projectRoot: 'fixture-project',
      irRoot: 'fixture-ir',
      checkOnly: true,
      compileCheck: () => ({ ok: true, checkOnly: true, problems: [], warnings: [generated], stagingRoot: 'fixture-staging' }),
      sourceMap: { 'gate/100.json': location },
      validateIr: async (_projectRoot, irRoot, context) => {
        irCalled = irRoot === 'fixture-staging' && context.checkOnly;
        return { ok: true, exitCode: 0, exitName: 'SUCCESS', problems: [], warnings: [] };
      },
    });

    assert.equal(irCalled, true);
    assert.equal(result.ok, true);
    assert.equal(result.data?.remappedDiagnosticCount, 1);
    assert.equal(result.warnings[0]?.code, 'IR_GATE_INVALID');
    assert.equal(result.warnings[0]?.sourcePath, 'content/gates/intro.json');
    assert.equal(result.warnings[0]?.line, 17);
    assert.equal(result.warnings[0]?.jsonPointer, '/chapters/0/titleKey');
    assert.equal(result.warnings[0]?.path, 'content/gates/intro.json');
  });

  it('does not allow a check-only callback to publish', async () => {
    const result = await validateLayeredCampaign({
      checkOnly: true,
      compileCheck: () => ({ ok: true, checkOnly: true, published: true }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.problems[0]?.code, 'LAYERED_CHECK_ONLY_PUBLISH_FORBIDDEN');
  });
});

describe('family negative fixture envelopes', () => {
  it('covers deck, shop, Gate graph, registry, localization, and accessory failures', async () => {
    const names = [
      'problems/deck-count.json',
      'problems/deck-unresolved-card.json',
      'problems/pack-probability.json',
      'problems/pack-collation.json',
      'problems/gate-graph-cycle.json',
      'problems/id-collision.json',
      'problems/missing-localization.json',
      'problems/missing-accessory.json',
    ];
    const expectedCodes: string[] = [];
    for (const name of names) {
      const problems = await readFixtureProblems(name);
      expectedCodes.push(...problems.map((problem) => problem.code));
      const result = await validateLayeredCampaign({ contentCheck: () => problems });
      assert.equal(result.ok, false, name);
      assert.equal(result.exitCode, 1, name);
      assert.deepEqual(result.problems.map((problem) => problem.code), [problems[0]?.code], name);
      assert.equal(result.problems[0]?.sourcePath, problems[0]?.sourcePath, name);
      assert.equal(result.problems[0]?.jsonPointer, problems[0]?.jsonPointer, name);
    }
    assert.deepEqual(expectedCodes, [
      'DECK_MAIN_SIZE_INVALID',
      'CARD_NAME_UNRESOLVED',
      'SHOP_PROBABILITY_SUM_INVALID',
      'SHOP_COLLATION_SLOT_UNKNOWN',
      'GATE_GRAPH_CYCLE',
      'ID_REGISTRY_COLLISION',
      'LOCALIZATION_REFERENCE_MISSING',
      'STRUCTURE_ACCESSORY_MISSING',
    ]);
  });
});

describe('existing validator reuse and performance report', () => {
  it('uses validateCampaign by default for a check-only IR root', async () => {
    const root = await makeRoot();
    const irRoot = path.join(root, 'ir');
    await fs.mkdir(irRoot, { recursive: true });
    await fs.writeFile(
      path.join(irRoot, 'manifest.json'),
      `${JSON.stringify({
        formatVersion: 1,
        campaign: { name: 'Fixture', slug: 'fixture', version: '0.0.1' },
        directories: { gate: 'gate', deck: 'deck', structure: 'structure', target: 'target/ygomaster' },
        authoring: { language: 'English' },
        idPolicy: { gatePrefix: 100, structurePrefix: 1129000 },
        runtime: { repository: 'pixeltris/YgoMaster', channel: 'latest', autoDownload: true },
      }, null, 2)}\n`,
      'utf8',
    );
    await fs.mkdir(path.join(irRoot, 'target', 'ygomaster', 'Data'), { recursive: true });
    await fs.writeFile(path.join(irRoot, 'target', 'ygomaster', 'Data', 'Shop.json'), '{"PackShop":{}}\n', 'utf8');
    await fs.writeFile(path.join(irRoot, 'target', 'ygomaster', 'Data', 'ShopPackOdds.json'), '{"entries":[]}\n', 'utf8');

    let checkOnlySeen = false;
    const result = await validateLayeredCampaign({
      projectRoot: root,
      irRoot,
      checkOnly: true,
      compileCheck: (context) => {
        checkOnlySeen = context.checkOnly;
        return { ok: true, checkOnly: true };
      },
    });

    assert.equal(checkOnlySeen, true);
    assert.equal(result.ok, true);
    assert.equal(result.phaseResults.find((phase) => phase.phase === 'ir')?.skipped, undefined);
    assert.equal(result.performance.coldTargetMet, result.performance.totalMs <= 2000);
    assert.equal(typeof result.performance.totalMs, 'number');
    assert.equal(result.performance.targetMs, 2000);
    assert.equal(result.data?.performance.totalMs, result.performance.totalMs);
  });

  it('reports a slow cold run without changing correctness', async () => {
    const result = await validateLayeredCampaign({
      performanceTargetMs: 0,
      contentCheck: () => [{
        code: 'LOCALIZATION_FALLBACK_USED',
        message: 'warning',
        severity: 'warning',
      }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.data?.performance.coldTargetMet, false);
    assert.equal(result.qualityProblems.some((problem) => problem.code === 'VALIDATION_PERFORMANCE_TARGET_MISSED'), true);
  });
});
