import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  SOURCE_MIGRATION_CODES,
  applySourceMigration,
  previewSourceMigration,
} from '../src/core/source-migration';
import { compileCampaignContentOperation } from '../src/core/content-operations';
import { createCardResolver } from '../src/core/card-resolver';
import { createEmptyRegistry } from '../src/core/id-registry';

const makeProject = (): Promise<string> => fs.mkdtemp(path.join(process.cwd(), '.source-migration-test-'));

const writeText = async (filePath: string, value: string): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, 'utf8');
};

const sourceRoot = (projectRoot: string): string => path.join(projectRoot, 'campaign', 'source');
const contentRoot = (projectRoot: string): string => path.join(projectRoot, 'campaign', 'content');

const writeSkeleton = async (projectRoot: string): Promise<void> => {
  const source = sourceRoot(projectRoot);
  await writeText(path.join(source, 'manifest.json'), '{"formatVersion":1,"layer":"source"}\n');
  await writeText(path.join(source, 'README.md'), 'generated source reference\n');
  await writeText(path.join(source, 'card-db', 'manifest.json'), '{"formatVersion":1}\n');
  await writeText(path.join(source, 'card-db', 'README.md'), 'catalog\n');
  await writeText(path.join(source, 'gate', '.gitkeep'), '');
  await writeText(path.join(source, 'deck', '.gitkeep'), '');
  await writeText(path.join(source, 'structure', '.gitkeep'), '');
  await writeText(path.join(source, 'overlay', '.gitkeep'), '');
  await writeText(path.join(source, 'assets', '.gitkeep'), '');
  await writeText(path.join(source, 'gates', '.gitkeep'), '');
  await writeText(path.join(source, 'decks', '.gitkeep'), '');
  await writeText(path.join(source, 'localization', '.gitkeep'), '');
  await writeText(path.join(source, '.ygomaster-source.json'), '{"opaque":true}\n');
};

const candidate = [
  { path: 'README.md', content: 'reviewed candidate\n' },
  {
    path: 'manifest.json',
    content: `${JSON.stringify({
      formatVersion: 1,
      layer: 'content',
      campaign: { name: 'Migration fixture', slug: 'migration-fixture', version: '1.0.0' },
      directories: {
        gates: 'gates', chapters: 'chapters', decks: 'decks', shop: 'shop', structures: 'structures',
        regulations: 'regulations', localization: 'localization', assets: 'assets', target: 'target/ygomaster',
      },
      sourceOfTruth: true,
    }, null, 2)}\n`,
  },
] as const;

describe('source migration preview/apply', () => {
  it('reports every active skeleton path deterministically and never mutates preview inputs', async () => {
    const project = await makeProject();
    try {
      await writeSkeleton(project);
      const source = sourceRoot(project);
      const before = await fs.readFile(path.join(source, 'manifest.json'), 'utf8');
      const first = await previewSourceMigration({ projectRoot: project });
      const second = await previewSourceMigration({ projectRoot: project });

      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(first.data?.noPromotableAuthoredData, true);
      assert.equal(first.data?.sourceGeneration, second.data?.sourceGeneration);
      assert.deepEqual(first.data?.sourcePaths, [...(first.data?.sourcePaths ?? [])].sort());
      const dispositions = new Map(first.data?.dispositions.map((entry) => [entry.path, entry]) ?? []);
      assert.equal(dispositions.get('manifest.json')?.disposition, 'retain-reference');
      assert.equal(dispositions.get('README.md')?.disposition, 'retain-reference');
      assert.equal(dispositions.get('card-db/manifest.json')?.disposition, 'retain-reference');
      assert.equal(dispositions.get('gate/.gitkeep')?.disposition, 'retain-reference');
      assert.equal(dispositions.get('gates/.gitkeep')?.disposition, 'remove-stale');
      assert.equal(dispositions.get('gates')?.disposition, 'remove-stale');
      assert.equal(dispositions.get('decks/.gitkeep')?.disposition, 'remove-stale');
      assert.equal(dispositions.get('decks')?.disposition, 'remove-stale');
      assert.equal(dispositions.get('.ygomaster-source.json')?.reviewRequired, true);
      assert.ok(first.data?.excludedInputs.some((entry) => entry.path.endsWith('campaign/source-legacy')));
      assert.equal(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'), before);
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });

  it('blocks an empty skeleton and rejects a source-legacy directory as an input', async () => {
    const project = await makeProject();
    try {
      await writeSkeleton(project);
      const preview = await previewSourceMigration({ projectRoot: project });
      assert.equal(preview.ok, true);
      const blocked = await applySourceMigration({
        projectRoot: project,
        preview: preview.data!,
        accept: true,
        expectedSourceGeneration: preview.data!.sourceGeneration,
      });
      assert.equal(blocked.ok, false);
      assert.ok(blocked.problems.some((entry) => entry.code === SOURCE_MIGRATION_CODES.NO_AUTHORED_DATA));

      const rejected = await previewSourceMigration({
        projectRoot: project,
        sourceRoot: path.join(project, 'campaign', 'source-legacy'),
      });
      assert.equal(rejected.ok, false);
      assert.ok(rejected.problems.some((entry) => entry.code === SOURCE_MIGRATION_CODES.REFERENCE_INPUT_FORBIDDEN));
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });

  it('publishes only an explicit reviewed candidate and preserves an exact source backup', async () => {
    const project = await makeProject();
    try {
      await writeSkeleton(project);
      await writeText(path.join(sourceRoot(project), 'gate', 'legacy.json'), '{"numeric":1000}\r\n');
      await writeText(path.join(contentRoot(project), 'manifest.json'), '{"formatVersion":0}\r\n');
      const preview = await previewSourceMigration({ projectRoot: project, candidateFiles: candidate });
      assert.equal(preview.ok, true);
      assert.equal(preview.data?.reviewedCandidate, true);
      assert.equal(preview.data?.noPromotableAuthoredData, false);
      const applied = await applySourceMigration({
        projectRoot: project,
        preview: preview.data!,
        candidateFiles: candidate,
        accept: true,
        expectedSourceGeneration: preview.data!.sourceGeneration,
      });
      assert.equal(applied.ok, true);
      assert.equal(await fs.readFile(path.join(contentRoot(project), 'README.md'), 'utf8'), 'reviewed candidate\n');
      assert.equal(await fs.readFile(path.join(sourceRoot(project), 'gate', 'legacy.json'), 'utf8'), '{"numeric":1000}\r\n');
      const backup = applied.data!.backupPath;
      assert.equal(await fs.readFile(path.join(backup, 'gate', 'legacy.json'), 'utf8'), '{"numeric":1000}\r\n');
      const compiled = await compileCampaignContentOperation({
        projectRoot: project,
        contentRoot: contentRoot(project),
        irRoot: path.join(project, 'campaign', 'compiled-source'),
        registryPath: path.join(project, 'campaign', 'id-registry.json'),
        resolver: createCardResolver([], { catalogGeneration: 'migration-fixture-catalog' }),
        registry: createEmptyRegistry(),
      });
      assert.equal(compiled.ok, true, JSON.stringify(compiled.problems));
      assert.equal((compiled.data as { mode: string }).mode, 'check');
      await assert.rejects(() => fs.lstat(path.join(project, 'campaign', `.content.migration-staging-${preview.data!.candidateGeneration.slice(0, 24)}`)), { code: 'ENOENT' });
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });

  it('restores the old content tree when the injected staging rename fails after moving', async () => {
    const project = await makeProject();
    try {
      await writeSkeleton(project);
      await writeText(path.join(contentRoot(project), 'old.txt'), 'old\r\nbytes');
      const preview = await previewSourceMigration({ projectRoot: project, candidateFiles: candidate });
      assert.equal(preview.ok, true);
      const staging = path.join(path.dirname(contentRoot(project)), `.content.migration-staging-${preview.data!.candidateGeneration.slice(0, 24)}`);
      const final = contentRoot(project);
      let injected = false;
      const failed = await applySourceMigration({
        projectRoot: project,
        preview: preview.data!,
        candidateFiles: candidate,
        accept: true,
        expectedSourceGeneration: preview.data!.sourceGeneration,
        rename: async (from, to) => {
          if (from === staging && to === final && !injected) {
            injected = true;
            await fs.rename(from, to);
            throw new Error('injected post-move failure');
          }
          await fs.rename(from, to);
        },
      });
      assert.equal(failed.ok, false);
      assert.equal(await fs.readFile(path.join(final, 'old.txt'), 'utf8'), 'old\r\nbytes');
      assert.equal(injected, true);
      await assert.rejects(() => fs.lstat(staging), { code: 'ENOENT' });
      const leftovers = (await fs.readdir(path.dirname(final))).filter((name) => name.startsWith('.content.migration-'));
      assert.deepEqual(leftovers, []);
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });

  it('never deletes the atomic recovery backup when rollback itself fails', async () => {
    const project = await makeProject();
    try {
      await writeSkeleton(project);
      await writeText(path.join(contentRoot(project), 'old.txt'), 'recover me');
      const preview = await previewSourceMigration({ projectRoot: project, candidateFiles: candidate });
      assert.equal(preview.ok, true);
      const staging = path.join(path.dirname(contentRoot(project)), `.content.migration-staging-${preview.data!.candidateGeneration.slice(0, 24)}`);
      const final = contentRoot(project);
      const recovery = path.join(path.dirname(final), `.content.migration-backup-${preview.data!.candidateGeneration.slice(0, 24)}`);
      const failed = await applySourceMigration({
        projectRoot: project,
        preview: preview.data!,
        candidateFiles: candidate,
        accept: true,
        expectedSourceGeneration: preview.data!.sourceGeneration,
        rename: async (from, to) => {
          if (from === staging && to === final) throw new Error('injected publish failure');
          if (from === recovery && to === final) throw new Error('injected rollback failure');
          await fs.rename(from, to);
        },
      });
      assert.equal(failed.ok, false);
      assert.equal(await fs.readFile(path.join(recovery, 'old.txt'), 'utf8'), 'recover me');
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });
});
