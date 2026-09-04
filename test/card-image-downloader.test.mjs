import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRequestLimiter, downloadCardImages, series1ImageCards } from '../scripts/download-card-images.mjs';

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]);

test('rejects a configured request rate above the documented provider limit', () => {
  assert.throws(() => createRequestLimiter(21), /cannot exceed/);
});

test('reserves distinct limiter slots for concurrent callers', async () => {
  const limiter = createRequestLimiter(20);
  const starts = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    await limiter();
    starts.push(Date.now());
  }));
  starts.sort((left, right) => left - right);
  assert.ok(starts[3] - starts[0] >= 130, `concurrent starts were insufficiently spaced: ${starts.join(', ')}`);
});

test('loads only supported runtime-backed Series 1 identities', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'card-image-graph-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const graphPath = path.join(root, 'series1.json');
  await fs.writeFile(graphPath, JSON.stringify({ payload: { identities: [
    { acquisitionPlan: { supported: true }, runtime: { runtimeCardId: 4007, ydkId: 89631140, nameEn: 'Blue-Eyes White Dragon' } },
    { acquisitionPlan: { supported: false }, runtime: { runtimeCardId: 4344, ydkId: 123, nameEn: 'Unavailable' } },
  ] } }));
  assert.deepEqual(await series1ImageCards(graphPath), [
    { runtimeId: 4007, ydkId: 89631140, name: 'Blue-Eyes White Dragon' },
  ]);
});

test('downloads JPEGs atomically and skips valid cached files on the next run', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'card-image-cache-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const cards = [{ runtimeId: 4007, ydkId: 89631140, name: 'Blue-Eyes White Dragon' }];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  const first = await downloadCardImages({ cards, cacheRoot: root, sizes: ['small', 'full'], requestsPerSecond: 20, fetchImpl });
  assert.equal(first.downloaded, 2);
  assert.equal(first.failed, 0);
  assert.equal(calls, 2);
  assert.deepEqual(new Uint8Array(await fs.readFile(path.join(root, 'ygoprodeck', 'small', '89631140.jpg'))), jpeg);

  const second = await downloadCardImages({ cards, cacheRoot: root, sizes: ['small', 'full'], requestsPerSecond: 20, fetchImpl });
  assert.equal(second.cached, 2);
  assert.equal(second.requested, 0);
  assert.equal(calls, 2);
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'ygoprodeck', 'metadata.json'), 'utf8'));
  assert.match(metadata.records['89631140'].files.small.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(metadata.records['89631140'].files.small.cached, true);
});

test('records a missing provider image without leaving a partial file', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'card-image-missing-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const results = await downloadCardImages({
    cards: [{ runtimeId: 1, ydkId: 2, name: 'Missing' }],
    cacheRoot: root,
    sizes: ['small'],
    requestsPerSecond: 20,
    fetchImpl: async () => new Response('', { status: 404 }),
  });
  assert.equal(results.missing, 1);
  assert.equal(results.providerMissing, 1);
  assert.equal(results.failed, 0);
  await assert.rejects(() => fs.access(path.join(root, 'ygoprodeck', 'small', '2.jpg')));
});

test('fills a provider-missing variant from an exact same-name cached image only when requested', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'card-image-fallback-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const cards = [
    { runtimeId: 10, ydkId: 100, name: 'Same Card' },
    { runtimeId: 11, ydkId: 101, name: 'Same Card' },
  ];
  const results = await downloadCardImages({
    cards,
    cacheRoot: root,
    sizes: ['small'],
    requestsPerSecond: 20,
    sameNameFallback: true,
    fetchImpl: async (url) => url.endsWith('/100.jpg')
      ? new Response(jpeg, { status: 200 })
      : new Response('', { status: 404 }),
  });
  assert.equal(results.providerMissing, 1);
  assert.equal(results.fallback, 1);
  assert.equal(results.missing, 0);
  assert.deepEqual(
    new Uint8Array(await fs.readFile(path.join(root, 'ygoprodeck', 'small', '101.jpg'))),
    jpeg,
  );
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'ygoprodeck', 'metadata.json'), 'utf8'));
  assert.equal(metadata.records['101'].files.small.fallbackFromYdkId, 100);
});
