import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

import {
  buildFakeRuntime,
  checkCompileDeterminism,
  checkFailurePreservesOutput,
  compareExpectedProblems,
  compareSemantic,
  inspectAllowedFiles,
  loadPipelineFixture,
  measurePipelineSteps,
  runPipelineFixture,
  writeHarnessText,
} from '../src/core/pipeline-harness';

const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/pipeline-harness');
const editorRoot = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);
const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'ygomaster-pipeline-harness-test-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('pipeline fixture convention and semantic comparison', () => {
  it('loads success/failure layouts and ignores key order and generated timestamps', async () => {
    const success = await loadPipelineFixture(path.join(fixtureRoot, 'success'));
    const failure = await loadPipelineFixture(path.join(fixtureRoot, 'failure'));
    assert.equal(success.manifest.outcome, 'success');
    assert.equal(failure.manifest.outcome, 'failure');
    assert.equal(failure.expectedProblems[0]?.code, 'HAR_INVALID_STEPS');
    const compared = compareSemantic(
      { b: 2, generatedAt: 'now', nested: { z: true, a: 1 } },
      { nested: { a: 1, z: true }, b: 2, generatedAt: 'golden' },
    );
    assert.equal(compared.equal, true);
    assert.equal(compareSemantic({ generatedAt: 'a' }, { generatedAt: 'b' }, { ignoreGeneratedTimestamps: false }).equal, false);
    assert.equal(compareSemantic({ payload: { value: 1 } }, { payload: { value: 2 } }, { ignoredPaths: ['/payload/value'] }).equal, true);
  });

  it('inspects fake runtime files without touching an external runtime', async () => {
    const root = await makeRoot();
    const runtime = await buildFakeRuntime({
      root: path.join(root, 'runtime'),
      files: { 'Data/Solo/demo.json': { id: 'demo' } },
    });
    assert.deepEqual(runtime.files, ['Data/Solo/demo.json']);
    assert.equal((await runtime.inspectAllowedFiles()).ok, true);
    await writeFile(path.join(runtime.root, 'unexpected.txt'), 'forbidden');
    const inspection = await inspectAllowedFiles(runtime.root, ['Data/Solo/demo.json']);
    assert.deepEqual(inspection.unexpected, ['unexpected.txt']);
    assert.equal(inspection.ok, false);
  });
});

describe('success/failure fixture execution', () => {
  it('runs both minimal fixtures with one harness API', async () => {
    const success = await runPipelineFixture({
      fixtureRoot: path.join(fixtureRoot, 'success'),
      compile: async ({ irRoot, deployRoot, contentRoot }) => {
        const source = JSON.parse(await readFile(path.join(contentRoot, 'demo.json'), 'utf8')) as Record<string, unknown>;
        await writeHarnessText(path.join(irRoot, 'demo.json'), `${JSON.stringify(source, null, 2)}\n`);
        await writeHarnessText(path.join(deployRoot, 'Data', 'Solo', 'demo.json'), `${JSON.stringify({ ...source, generatedAt: new Date().toISOString() })}\n`);
      },
    });
    assert.equal(success.ok, true);
    assert.equal(success.allowedDeploy.ok, true);

    const failure = await runPipelineFixture({
      fixtureRoot: path.join(fixtureRoot, 'failure'),
      compile: async () => ({
        ok: false,
        problems: [{
          code: 'HAR_INVALID_STEPS',
          message: 'different wording is intentionally not golden data',
          sourcePath: 'broken.json',
          line: 3,
          column: 12,
          endLine: 3,
          endColumn: 26,
          jsonPointer: '/steps',
        }],
      }),
    });
    assert.equal(failure.ok, true);
    assert.equal(failure.problems.equal, true);
  });

  it('cleans every owned default workspace while retaining a caller workspace', async () => {
    await runPipelineFixture({
      fixtureRoot: path.join(fixtureRoot, 'success'),
      compile: async () => undefined,
    });
    await runPipelineFixture({
      fixtureRoot: path.join(fixtureRoot, 'failure'),
      compile: async () => ({ ok: false, problems: [] }),
    });
    const leftovers = (await fs.readdir(editorRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('.ygomaster-pipeline-harness-'))
      .map((entry) => entry.name);
    assert.deepEqual(leftovers, []);

    const callerWorkspace = await fs.mkdtemp(path.join(editorRoot, '.pipeline-harness-caller-'));
    roots.push(callerWorkspace);
    await runPipelineFixture({
      fixtureRoot: path.join(fixtureRoot, 'failure'),
      workspaceRoot: callerWorkspace,
      compile: async () => ({ ok: false, problems: [] }),
    });
    assert.equal((await fs.stat(callerWorkspace)).isDirectory(), true);
  });

  it('runs both fixtures through the standalone structured runner', async () => {
    const result = await execFileAsync(process.execPath, ['scripts/run-pipeline-fixtures.mjs'], { cwd: editorRoot });
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      fixtures: Array<{ name: string; ok: boolean }>;
    };
    assert.equal(report.ok, true);
    assert.deepEqual(report.fixtures.map((fixture) => [fixture.name, fixture.ok]), [
      ['minimal-success', true],
      ['minimal-failure', true],
    ]);
    const leftovers = (await fs.readdir(editorRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('.ygomaster-pipeline-harness-'));
    assert.deepEqual(leftovers, []);
  });

  it('matches problem code and source span and reports span drift', () => {
    const expected = [{ code: 'E', message: 'expected', sourcePath: 'a.json', line: 2, column: 3, endLine: 2, endColumn: 4 }];
    assert.equal(compareExpectedProblems([{ ...expected[0], message: 'localized' }], expected).equal, true);
    const mismatch = compareExpectedProblems([{ ...expected[0], line: 9 }], expected);
    assert.equal(mismatch.equal, false);
    assert.equal(mismatch.mismatched.length, 1);
  });
});

describe('determinism, atomic failure, and independent timings', () => {
  it('detects zero-diff no-rewrite output on a second compile', async () => {
    const root = await makeRoot();
    let calls = 0;
    const report = await checkCompileDeterminism({
      outputRoot: root,
      compile: async ({ outputRoot, pass }) => {
        calls += 1;
        if (pass === 1) await writeHarnessText(path.join(outputRoot, 'ir.json'), '{"b":2,"a":1}\n');
      },
    });
    assert.equal(calls, 2);
    assert.equal(report.byteStable, true);
    assert.equal(report.semanticStable, true);
    assert.deepEqual(report.rewrittenFiles, []);
    assert.equal(report.zeroDiff, true);
  });

  it('proves a compiler failure preserves existing IR bytes and semantics', async () => {
    const root = await makeRoot();
    await fs.mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'ir.json'), '{"value":1,"generatedAt":"old"}\n');
    const report = await checkFailurePreservesOutput({
      outputRoot: root,
      compileFailure: async () => {
        throw new Error('synthetic compiler failure');
      },
    });
    assert.deepEqual(report, {
      failureObserved: true,
      byteUnchanged: true,
      semanticUnchanged: true,
      preserved: true,
    });
  });

  it('produces timing/agent-step JSON independently of correctness', async () => {
    const report = await measurePipelineSteps([
      { name: 'parse', run: () => undefined },
      { name: 'compile', run: async () => undefined },
    ], { fixture: 'minimal-success', agentSteps: 2 });
    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(report.timings.map((entry) => entry.name), ['parse', 'compile']);
    assert.equal(report.agentSteps, 2);
    assert.equal('correctness' in report, false);
  });
});
