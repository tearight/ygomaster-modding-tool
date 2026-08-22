import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { migrateCustomCardRecord, validateCustomCardDatabase } from '../src/core';

const roots: string[] = [];

const makeRoot = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ygomaster-custom-card-'));
  roots.push(root);
  return root;
};

const writeJson = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2));
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('custom card database', () => {
  it('materializes ordered layers while preserving nested extension fields', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'campaign', 'source');
    const databaseRoot = path.join(sourceRoot, 'card-db');
    await writeJson(path.join(databaseRoot, 'manifest.json'), {
      schemaVersion: 1,
      revision: 3,
      layers: [
        { id: 'generated', priority: 100, kind: 'generated', directory: 'layers/generated' },
        { id: 'reviewed', priority: 200, kind: 'reviewed', directory: 'layers/reviewed' },
      ],
    });
    await writeJson(path.join(databaseRoot, 'layers', 'generated', '1001.json'), {
      schemaVersion: 1,
      cardId: 1001,
      revision: 1,
      searchTerms: ['engine'],
      facets: { role: ['engine'], score: 2 },
      extensions: {
        'org.ygomastersolo.analysis/v1': {
          roles: ['engine'],
          review: { state: 'generated', opaque: { keep: true } },
        },
      },
      claims: [{ path: '/extensions/analysis/roles', confidence: 0.8, source: { kind: 'rule-analysis', reference: 'fixture:rules-1' } }],
    });
    await writeJson(path.join(databaseRoot, 'layers', 'reviewed', '1001.json'), {
      schemaVersion: 1,
      cardId: 1001,
      revision: 2,
      searchTerms: ['reviewed'],
      facets: { role: ['boss'] },
      extensions: {
        'org.ygomastersolo.analysis/v1': {
          roles: ['boss'],
          review: { state: 'accepted' },
        },
      },
    });
    await writeJson(path.join(databaseRoot, 'layers', 'generated', '1002.json'), {
      schemaVersion: 1,
      cardId: 1002,
      revision: 1,
      searchTerms: ['discarded-analysis'],
    });
    await writeJson(path.join(databaseRoot, 'layers', 'reviewed', '1002.json'), {
      schemaVersion: 1,
      cardId: 1002,
      revision: 2,
      operation: 'tombstone',
    });

    const validated = await validateCustomCardDatabase(root, sourceRoot, new Set([1001, 1002]));
    assert.equal(validated.ok, true);
    assert.equal(validated.data?.sourceRecordCount, 4);
    assert.equal(validated.data?.materializedCards.length, 1);
    const card = validated.data?.materializedCards[0];
    assert.deepEqual(card?.searchTerms, ['engine', 'reviewed']);
    assert.deepEqual(card?.facets.role, ['boss']);
    assert.deepEqual(card?.appliedLayers, ['generated', 'reviewed']);
    assert.deepEqual(card?.extensions['org.ygomastersolo.analysis/v1'], {
      roles: ['boss'],
      review: { state: 'accepted', opaque: { keep: true } },
    });
  });

  it('rejects unknown runtime IDs and reserved base field overrides', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'campaign', 'source');
    const databaseRoot = path.join(sourceRoot, 'card-db');
    await writeJson(path.join(databaseRoot, 'manifest.json'), {
      schemaVersion: 1,
      revision: 1,
      layers: [{ id: 'reviewed', priority: 200, kind: 'reviewed', directory: 'layers/reviewed' }],
    });
    await writeJson(path.join(databaseRoot, 'layers', 'reviewed', '9999.json'), {
      schemaVersion: 1,
      cardId: 9999,
      revision: 1,
      stats: { atk: 9999 },
      extensions: { invalidNamespace: {} },
    });
    const validated = await validateCustomCardDatabase(root, sourceRoot, new Set([1001]));
    assert.equal(validated.ok, false);
    assert.deepEqual(new Set(validated.problems.map((entry) => entry.code)), new Set([
      'CUSTOM_CARD_ID_UNKNOWN',
      'CUSTOM_CARD_RESERVED_FIELD',
      'CUSTOM_CARD_NAMESPACE_INVALID',
    ]));
  });

  it('offers an explicit v0 to v1 migration without mutating the input', () => {
    const legacy = { schemaVersion: 0, id: 1001, revision: 2, tags: ['engine'], custom: { nested: { value: 1 } } };
    const migrated = migrateCustomCardRecord(legacy);
    assert.equal(migrated.migratedFrom, 0);
    assert.equal(migrated.record?.cardId, 1001);
    assert.deepEqual(migrated.record?.extensions, { 'org.ygomastersolo.legacy/v1': { nested: { value: 1 } } });
    assert.deepEqual(legacy.custom, { nested: { value: 1 } });
    const reloaded = migrateCustomCardRecord(JSON.parse(JSON.stringify(migrated.record)) as unknown);
    assert.deepEqual(reloaded.record, migrated.record);
    assert.equal(migrateCustomCardRecord({ schemaVersion: 2, cardId: 1001, revision: 1 }).problem?.code, 'CUSTOM_CARD_SCHEMA_UNSUPPORTED');
  });
});
