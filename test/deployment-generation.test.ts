import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { deployCampaign, inspectDeployment, validateDeploymentGeneration } from '../src/core/deployment';
import { createIrGenerationMetadata } from '../src/core/layers';
import { initWorkspace } from '../src/core/manifest';

const expected = {
  contentGeneration: 'content-sha256-a',
  compilerVersion: 'ir-compiler/v1',
  catalogGeneration: 'catalog-a',
  idRegistryGeneration: 'registry-a',
  targetContractVersion: 'ygomaster-campaign-target/v3',
};

describe('managed IR deployment generation guard', () => {
  it('accepts an exact generation and validates optional metadata when no expectation is supplied', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'deploy-generation-'));
    try {
      await writeFile(path.join(root, 'generation.json'), `${JSON.stringify(createIrGenerationMetadata({
        contentGeneration: expected.contentGeneration,
        compilerVersion: 'ir-compiler/v1',
        catalogGeneration: expected.catalogGeneration,
        idRegistryGeneration: expected.idRegistryGeneration,
      }), null, 2)}\n`, 'utf8');
      assert.equal((await validateDeploymentGeneration(root, expected)).ok, true);
      assert.equal((await validateDeploymentGeneration(root)).ok, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for a missing required generation without mutating the source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'deploy-generation-missing-'));
    try {
      const guarded = await validateDeploymentGeneration(root, expected);
      assert.equal(guarded.ok, false);
      assert.equal(guarded.problems[0]?.code, 'IR_GENERATION_METADATA_MISSING');
      assert.equal((await validateDeploymentGeneration(root)).ok, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports every stale generation dimension before runtime work begins', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'deploy-generation-stale-'));
    try {
      await writeFile(path.join(root, 'generation.json'), `${JSON.stringify(createIrGenerationMetadata({
        contentGeneration: 'content-old',
        compilerVersion: 'ir-compiler/old',
        catalogGeneration: 'catalog-old',
        idRegistryGeneration: 'registry-old',
      }), null, 2)}\n`, 'utf8');
      const guarded = await validateDeploymentGeneration(root, expected);
      assert.equal(guarded.ok, false);
      assert.deepEqual(
        guarded.problems.map((entry) => entry.path),
        [
          'generation.json:contentGeneration',
          'generation.json:compilerVersion',
          'generation.json:catalogGeneration',
          'generation.json:idRegistryGeneration',
        ],
      );
      assert.equal(guarded.problems.every((entry) => entry.code === 'IR_GENERATION_STALE'), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed generation metadata even when no expected values are supplied', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'deploy-generation-invalid-'));
    try {
      await writeFile(path.join(root, 'generation.json'), '{"schemaVersion":99}\n', 'utf8');
      const guarded = await validateDeploymentGeneration(root);
      assert.equal(guarded.ok, false);
      assert.equal(guarded.problems[0]?.code, 'IR_GENERATION_METADATA_INVALID');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a stale managed deploy before runtime transport or source mutation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'deploy-generation-integration-'));
    const sourceRoot = path.join(root, 'source');
    try {
      await initWorkspace(root, sourceRoot);
      const stale = createIrGenerationMetadata({
        contentGeneration: 'content-old',
        compilerVersion: 'ir-compiler/old',
        catalogGeneration: 'catalog-old',
        idRegistryGeneration: 'registry-old',
      });
      const generationPath = path.join(sourceRoot, 'generation.json');
      await writeFile(generationPath, `${JSON.stringify(stale, null, 2)}\n`, 'utf8');
      const before = await readFile(generationPath, 'utf8');
      let transportCalls = 0;
      const deployed = await deployCampaign({
        projectRoot: root,
        sourceRoot,
        gameRoot: path.join(root, 'game'),
        expectedGeneration: expected,
        transport: {
          getJson: async () => { transportCalls += 1; throw new Error('must not run'); },
          getBytes: async () => { transportCalls += 1; return new Uint8Array(); },
        },
      });
      assert.equal(deployed.ok, false);
      assert.equal(deployed.problems.every((entry) => entry.code === 'IR_GENERATION_STALE'), true);
      assert.equal(transportCalls, 0);
      assert.equal(await readFile(generationPath, 'utf8'), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed nested generation data when inspecting a deployment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'deploy-generation-inspect-'));
    try {
      await writeFile(path.join(root, '.campaign-deployment.json'), `${JSON.stringify({
        campaign: { name: 'Fixture', slug: 'fixture', version: '1' },
        deployedAt: new Date().toISOString(),
        resolvedRuntimeTag: 'v1',
        runtimeAsset: { name: 'fixture.zip', url: 'fixture://runtime' },
        moddingToolVersion: '0.13.0',
        contractVersion: 1,
        irGeneration: {
          contentGeneration: 'content',
          compilerVersion: 'compiler',
          catalogGeneration: 'catalog',
          idRegistryGeneration: 'registry',
          targetContractVersion: 'wrong-target',
        },
      }, null, 2)}\n`, 'utf8');
      const inspected = await inspectDeployment(root);
      assert.equal(inspected.ok, false);
      assert.equal(inspected.problems[0]?.code, 'DEPLOYMENT_INSPECT_FAILED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
