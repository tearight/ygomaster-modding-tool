import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  RELEASE_PRODUCT_CODES,
  validateReleaseProductGraph,
} from '../src/core/release-product-content';

const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/release-product-content');
const readFixture = async (relative: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(fixtureRoot, relative), 'utf8')) as unknown;

describe('release and product content graph', () => {
  it('keeps historical provenance separate from supported digital delivery', async () => {
    const result = validateReleaseProductGraph(await readFixture('positive/graph.json'), 'positive/graph.json', {
      knownShopRefs: ['shop:vol-1-pack'],
    });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.deepEqual(result.summary, {
      releases: 2,
      products: 2,
      identities: 2,
      printEdges: 2,
      deliveries: 2,
      activeDeliveries: 1,
      identitiesWithActiveDelivery: 1,
      identitiesWithoutActiveDelivery: 1,
    });
    assert.equal(result.document?.payload.products[0]?.officialProductId, '1');
    assert.equal(result.document?.payload.products[0]?.deliveries[0]?.ref, 'shop:vol-1-pack');
  });

  it('rejects duplicate keys/dates, invalid dates/deliveries, orphans, and cycles', async () => {
    const result = validateReleaseProductGraph(await readFixture('negative/invalid-graph.json'), 'negative/invalid-graph.json', {
      knownShopRefs: ['shop:vol-1-pack'],
    });
    const codes = new Set(result.problems.map((problem) => problem.code));
    assert.equal(result.ok, false);
    for (const code of [
      RELEASE_PRODUCT_CODES.KEY_DUPLICATE,
      RELEASE_PRODUCT_CODES.DATE_DUPLICATE,
      RELEASE_PRODUCT_CODES.DATE_INVALID,
      RELEASE_PRODUCT_CODES.RELEASE_PRODUCT_ORPHAN,
      RELEASE_PRODUCT_CODES.PRODUCT_IDENTITY_ORPHAN,
      RELEASE_PRODUCT_CODES.IDENTITY_PRODUCT_ORPHAN,
      RELEASE_PRODUCT_CODES.DELIVERY_INVALID,
      RELEASE_PRODUCT_CODES.DELIVERY_TARGET_MISSING,
      RELEASE_PRODUCT_CODES.DELIVERY_CYCLE,
    ]) assert.equal(codes.has(code), true, `${code}: ${JSON.stringify(result.problems)}`);
    assert.equal(result.problems.every((problem) => problem.sourcePath === 'negative/invalid-graph.json'), true);
  });
});
