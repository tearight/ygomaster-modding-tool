import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { validateTargetCapability } from '../src/core/target-contract';
import {
  ID_NAMESPACE_RANGES,
  ID_REGISTRY_VERSION,
  IdRegistryError,
  applyRegistryPlan,
  chapterParts,
  compositeChapterId,
  computeRegistryGeneration,
  diffRegistry,
  migrateRegistry,
  moveRegistryKey,
  parseRegistry,
  planRegistry,
  readRegistry,
  renameRegistryKey,
  retireRegistryKey,
  retireRegistryKeyWithDependents,
  type AllocationRequest,
  type IdRegistry,
  type RegistryPlan,
  validateRegistry,
} from '../src/core/id-registry';

const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/id-registry');
const temporaryRoots: string[] = [];

const loadFixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(path.join(fixtureRoot, name), 'utf8')) as T;

const loadBase = async (): Promise<IdRegistry> => parseRegistry(await loadFixture('base-registry.json'));

const expectSyncCode = (operation: () => unknown, code: string): void => {
  assert.throws(operation, (error: unknown) => error instanceof IdRegistryError && error.code === code);
};

const expectAsyncCode = async (operation: () => Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(operation, (error: unknown) => error instanceof IdRegistryError && error.code === code);
};

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'ygomaster-id-registry-'));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('deterministic YgoMaster target ID registry', () => {
  it('validates the fixture contract, namespace ranges, and chapter composite rule', async () => {
    const registry = await loadBase();
    assert.equal(validateRegistry(registry).length, 0);
    assert.equal(registry.registryVersion, ID_REGISTRY_VERSION);
    assert.deepEqual(ID_NAMESPACE_RANGES.gate, { min: 90000, max: 90999 });
    assert.deepEqual(ID_NAMESPACE_RANGES.structure, { min: 1129000, max: 1129999 });
    assert.equal(compositeChapterId(90001, 1), 900010001);
    assert.deepEqual(chapterParts(900010001), { gateId: 90001, localId: 1 });
    assert.equal(computeRegistryGeneration(registry), registry.generation);
  });

  it('allocates by sorted symbolic key, independent of request order', async () => {
    const registry = await loadBase();
    const requests = await loadFixture<AllocationRequest[]>('requests-unsorted.json');
    const forward = planRegistry(registry, requests);
    const reverse = planRegistry(registry, [...requests].reverse());
    assert.deepEqual(reverse.registry, forward.registry);
    assert.deepEqual(reverse.diff, forward.diff);
    assert.equal(forward.registry.namespaces.gate.assignments['gate.beta']?.id, 90000);
    assert.equal(forward.registry.namespaces.gate.assignments['gate.pinned']?.id, 90010);
    assert.equal(forward.registry.namespaces.chapter.assignments['chapter.alpha.second']?.id, 900010002);
    assert.equal(forward.registry.namespaces.shop.assignments['shop.beta']?.id, 1130001);
    assert.equal(forward.registry.fixtureUnknown && (forward.registry.fixtureUnknown as { preserve?: boolean }).preserve, true);
  });

  it('keeps existing assignments stable and never reuses tombstones', async () => {
    const registry = await loadBase();
    const plan = planRegistry(registry, [
      { namespace: 'gate', key: 'gate.alpha' },
      { namespace: 'gate', key: 'gate.new' },
    ]);
    assert.equal(plan.registry.namespaces.gate.assignments['gate.alpha']?.id, 90001);
    assert.equal(plan.registry.namespaces.gate.assignments['gate.new']?.id, 90000);
    expectSyncCode(() => planRegistry(registry, [{ namespace: 'gate', key: 'gate.retired' }]), 'ID_REGISTRY_TOMBSTONE_REUSE');
    expectSyncCode(() => planRegistry(registry, [{ namespace: 'gate', key: 'gate.new', pin: 90002 }]), 'ID_REGISTRY_TOMBSTONE_REUSE');
    expectSyncCode(() => retireRegistryKey(registry, 'gate', 'missing'), 'ID_REGISTRY_ASSIGNMENT_MISSING');
  });

  it('supports explicit pins and reports invalid pin, collision, runtime, and exhaustion errors', async () => {
    const registry = await loadBase();
    const pinned = planRegistry(registry, [{ namespace: 'gate', key: 'gate.explicit', pin: 90020 }]);
    assert.equal(pinned.registry.namespaces.gate.assignments['gate.explicit']?.id, 90020);
    const pinWins = planRegistry(registry, [
      { namespace: 'gate', key: 'gate.before-pin' },
      { namespace: 'gate', key: 'gate.after-pin', pin: 90000 },
    ]);
    assert.equal(pinWins.registry.namespaces.gate.assignments['gate.after-pin']?.id, 90000);
    assert.equal(pinWins.registry.namespaces.gate.assignments['gate.before-pin']?.id, 90003);
    expectSyncCode(() => planRegistry(registry, [{ namespace: 'gate', key: 'gate.bad', pin: 1 }]), 'ID_REGISTRY_PIN_INVALID');
    expectSyncCode(() => planRegistry(registry, [
      { namespace: 'gate', key: 'gate.one', pin: 90020 },
      { namespace: 'gate', key: 'gate.two', pin: 90020 },
    ]), 'ID_REGISTRY_COLLISION');
    expectSyncCode(() => planRegistry(registry, [{ namespace: 'gate', key: 'gate.runtime', pin: 90020 }], { runtimeOccupied: { gate: [90020] } }), 'ID_REGISTRY_RUNTIME_COLLISION');
    expectSyncCode(() => planRegistry(registry, [
      { namespace: 'reward', key: 'reward.one' },
      { namespace: 'reward', key: 'reward.two' },
    ], { rangeOverrides: { reward: { min: 910001, max: 910001 } } }), 'ID_REGISTRY_EXHAUSTED');
    expectSyncCode(() => planRegistry(registry, [{ namespace: 'chapter', key: 'chapter.bad-pin', gateKey: 'gate.alpha', localId: 1, pin: 900010002 }]), 'ID_REGISTRY_PIN_INVALID');
    const pinnedChapter = planRegistry(registry, [{ namespace: 'chapter', key: 'chapter.explicit-pin', pin: compositeChapterId(90001, 7) }]);
    assert.deepEqual(pinnedChapter.registry.namespaces.chapter.assignments['chapter.explicit-pin'], { id: 900010007, gateId: 90001, localId: 7 });
    const pinnedWithGate = planRegistry(registry, [{ namespace: 'chapter', key: 'chapter.explicit-pin-gate', gateKey: 'gate.alpha', pin: compositeChapterId(90001, 8) }]);
    assert.deepEqual(pinnedWithGate.registry.namespaces.chapter.assignments['chapter.explicit-pin-gate'], { id: 900010008, gateKey: 'gate.alpha', localId: 8 });
    const pinnedWithCompatibilityMetadata = planRegistry(registry, [{ namespace: 'chapter', key: 'chapter.explicit-localChapterId', gateKey: 'gate.alpha', localChapterId: 9, pin: compositeChapterId(90001, 9) }]);
    assert.deepEqual(pinnedWithCompatibilityMetadata.registry.namespaces.chapter.assignments['chapter.explicit-localChapterId'], { id: 900010009, gateKey: 'gate.alpha', localId: 9 });
    expectSyncCode(() => planRegistry(registry, [{ namespace: 'chapter', key: 'chapter.conflicting-local-metadata', gateKey: 'gate.alpha', localId: 9, localChapterId: 10 }]), 'ID_REGISTRY_CHAPTER_RULE_INVALID');
    expectSyncCode(() => compositeChapterId(214749, 9999), 'ID_REGISTRY_INT32_OVERFLOW');
  });

  it('rejects missing or dangling chapter metadata and keeps gate migration fail-closed', async () => {
    const registry = await loadBase();
    const missingMetadata = JSON.parse(JSON.stringify(registry)) as IdRegistry;
    delete missingMetadata.namespaces.chapter.assignments['chapter.alpha.first'].gateKey;
    delete missingMetadata.namespaces.chapter.assignments['chapter.alpha.first'].localId;
    missingMetadata.generation = computeRegistryGeneration(missingMetadata);
    assert.equal(validateRegistry(missingMetadata).some((entry) => entry.code === 'ID_REGISTRY_CHAPTER_RULE_INVALID'), true);
    expectSyncCode(() => parseRegistry(missingMetadata), 'ID_REGISTRY_CHAPTER_RULE_INVALID');

    const danglingGateKey = JSON.parse(JSON.stringify(registry)) as IdRegistry;
    danglingGateKey.namespaces.chapter.assignments['chapter.alpha.first'].gateKey = 'gate.dangling';
    danglingGateKey.generation = computeRegistryGeneration(danglingGateKey);
    expectSyncCode(() => parseRegistry(danglingGateKey), 'ID_REGISTRY_CHAPTER_GATE_MISSING');
    expectSyncCode(() => retireRegistryKey(registry, 'gate', 'gate.alpha'), 'ID_REGISTRY_DEPENDENCY_MIGRATION_REQUIRED');
    expectSyncCode(() => moveRegistryKey(registry, { namespace: 'gate', key: 'gate.alpha' }, { namespace: 'gate', key: 'gate.moved' }), 'ID_REGISTRY_DEPENDENCY_MIGRATION_REQUIRED');
  });

  it('requires and applies explicit dependent chapter migrations in one gate move plan', async () => {
    const registry = await loadBase();
    const gateMove = { kind: 'move' as const, from: { namespace: 'gate' as const, key: 'gate.alpha' }, to: { namespace: 'gate' as const, key: 'gate.moved' } };
    const chapterMove = {
      kind: 'move' as const,
      from: { namespace: 'chapter' as const, key: 'chapter.alpha.first' },
      to: { namespace: 'chapter' as const, key: 'chapter.moved', gateKey: 'gate.moved', localId: 1 },
    };
    expectSyncCode(() => migrateRegistry(registry, [gateMove]), 'ID_REGISTRY_DEPENDENCY_MIGRATION_REQUIRED');
    const plan = migrateRegistry(registry, [gateMove, chapterMove]);
    assert.equal(plan.registry.namespaces.gate.assignments['gate.moved']?.id, 90000);
    assert.equal(plan.registry.namespaces.gate.tombstones['gate.alpha']?.id, 90001);
    assert.deepEqual(plan.registry.namespaces.chapter.assignments['chapter.moved'], { id: 900000001, gateKey: 'gate.moved', localId: 1 });
    assert.equal(plan.registry.namespaces.chapter.tombstones['chapter.alpha.first']?.id, 900010001);
    assert.equal(validateRegistry(plan.registry).length, 0);
    const wrapped = migrateRegistry(registry, { migrations: [gateMove, chapterMove] });
    assert.deepEqual(wrapped.registry, plan.registry);
    const withDestination = planRegistry(registry, [{ namespace: 'gate', key: 'gate.moved' }]).registry;
    const retired = retireRegistryKeyWithDependents(withDestination, 'gate', 'gate.alpha', [chapterMove]);
    assert.equal(retired.registry.namespaces.gate.assignments['gate.alpha'], undefined);
    assert.equal(retired.registry.namespaces.gate.tombstones['gate.alpha']?.id, 90001);
    assert.equal(validateRegistry(retired.registry).length, 0);
  });

  it('does not allocate card IDs and keeps Shop allocation separate from project adapter approval', async () => {
    const registry = await loadBase();
    expectSyncCode(() => planRegistry(registry, [{ namespace: 'card' as never, key: 'card.never' }]), 'ID_REGISTRY_CARD_UNSUPPORTED');
    const shop = planRegistry(registry, [{ namespace: 'shop', key: 'shop.authored' }]);
    assert.equal(shop.registry.namespaces.shop.assignments['shop.authored']?.id, 1130001);
    const shopCapability = validateTargetCapability('shop');
    assert.equal(shopCapability[0]?.code, 'SHOP_TARGET_UNVERIFIED');
    assert.equal(shopCapability[0]?.severity, 'error');
  });

  it('uses rename and move migration primitives without silent renumbering', async () => {
    const registry = await loadBase();
    const renamed = renameRegistryKey(registry, 'gate', 'gate.alpha', 'gate.renamed');
    assert.equal(renamed.registry.namespaces.gate.assignments['gate.renamed']?.id, 90001);
    assert.equal(renamed.registry.namespaces.gate.assignments['gate.alpha'], undefined);
    assert.equal(renamed.registry.namespaces.chapter.assignments['chapter.alpha.first']?.gateKey, 'gate.renamed');
    assert.equal(renamed.diff.some((entry) => entry.namespace === 'gate' && entry.key === 'gate.alpha' && entry.action === 'remove' && entry.before === 90001), true);
    assert.equal(renamed.diff.some((entry) => entry.namespace === 'gate' && entry.key === 'gate.renamed' && entry.action === 'add' && entry.after === 90001), true);
    assert.equal(renamed.diff.some((entry) => entry.namespace === 'chapter' && entry.key === 'chapter.alpha.first' && entry.metadataChanged === true), true);

    const withGate = planRegistry(registry, [{ namespace: 'gate', key: 'gate.beta' }]).registry;
    const moved = moveRegistryKey(withGate, {
      namespace: 'chapter',
      key: 'chapter.alpha.first',
    }, {
      namespace: 'chapter',
      key: 'chapter.moved',
      gateKey: 'gate.beta',
      localId: 1,
    });
    assert.equal(moved.registry.namespaces.chapter.assignments['chapter.moved']?.id, 900000001);
    assert.equal(moved.registry.namespaces.chapter.tombstones['chapter.alpha.first']?.id, 900010001);
    expectSyncCode(() => planRegistry(moved.registry, [{ namespace: 'chapter', key: 'chapter.alpha.first', gateKey: 'gate.beta', localId: 2 }]), 'ID_REGISTRY_TOMBSTONE_REUSE');
  });

  it('keeps dry-run separate from explicit atomic apply and validates staging', async () => {
    const registry = await loadBase();
    const root = await makeRoot();
    const registryPath = path.join(root, 'registry.json');
    await writeFile(registryPath, JSON.stringify(registry));
    const plan = planRegistry(registry, [{ namespace: 'gate', key: 'gate.applied' }]);
    assert.equal(plan.dryRun, true);
    assert.equal(await fs.stat(path.join(root, 'registry.json')).then(() => true), true);
    await expectAsyncCode(() => applyRegistryPlan(registryPath, plan), 'ID_REGISTRY_APPLY_REQUIRED');
    const applied = await applyRegistryPlan(registryPath, plan, { accept: true });
    assert.equal(applied.registry.namespaces.gate.assignments['gate.applied']?.id, 90000);
    assert.equal((await readRegistry(registryPath)).generation, plan.generation);
    assert.equal((await readRegistry(registryPath)).fixtureUnknown && ((await readRegistry(registryPath)).fixtureUnknown as { preserve?: boolean }).preserve, true);
    assert.equal((await fs.readdir(root)).some((entry) => entry.includes('.staging-')), false);

    const tampered = {
      ...plan,
      baseGeneration: applied.generation,
      generation: 'tampered',
      registry: { ...plan.registry, generation: 'tampered' },
    } as RegistryPlan;
    await expectAsyncCode(() => applyRegistryPlan(registryPath, tampered, { accept: true }), 'ID_REGISTRY_STAGING_INVALID');
    assert.equal((await readRegistry(registryPath)).generation, plan.generation);
  });

  it('fails closed on stale plans and reports deterministic registry diffs', async () => {
    const registry = await loadBase();
    const plan = planRegistry(registry, [{ namespace: 'unlock', key: 'unlock.one' }]);
    const changed = planRegistry(registry, [{ namespace: 'unlock', key: 'unlock.other' }]).registry;
    assert.notEqual(changed.generation, plan.generation);
    assert.deepEqual(diffRegistry(registry, plan.registry), plan.diff);
    const root = await makeRoot();
    const registryPath = path.join(root, 'registry.json');
    await writeFile(registryPath, JSON.stringify(changed));
    await expectAsyncCode(() => applyRegistryPlan(registryPath, plan, { accept: true }), 'ID_REGISTRY_STALE_PLAN');
  });
});
