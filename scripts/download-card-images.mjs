import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROVIDER = 'ygoprodeck';
const PROVIDER_PAGE = 'https://ygoprodeck.com/api-guide/';
const MAX_REQUESTS_PER_SECOND = 20;
const DEFAULT_REQUESTS_PER_SECOND = 8;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const DEFAULT_RETRIES = 3;
const SIZE_PATHS = Object.freeze({ small: 'cards_small', full: 'cards', cropped: 'cards_cropped' });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const parsePositiveNumber = (value, label) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);
  return parsed;
};

export const createRequestLimiter = (requestsPerSecond = DEFAULT_REQUESTS_PER_SECOND) => {
  const rate = parsePositiveNumber(requestsPerSecond, 'requestsPerSecond');
  if (rate > MAX_REQUESTS_PER_SECOND) {
    throw new Error(`requestsPerSecond cannot exceed YGOPRODeck's documented limit of ${MAX_REQUESTS_PER_SECOND}`);
  }
  const interval = Math.ceil(1000 / rate);
  let nextStart = 0;
  return async () => {
    const now = Date.now();
    const startAt = Math.max(now, nextStart);
    nextStart = startAt + interval;
    const wait = Math.max(0, startAt - now);
    if (wait) await delay(wait);
  };
};

const isJpeg = (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

const atomicWrite = async (targetPath, bytes) => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const backupPath = `${targetPath}.${process.pid}.${Date.now()}.previous`;
  let backedUp = false;
  try {
    await fs.writeFile(temporaryPath, bytes, { flag: 'wx' });
    try {
      await fs.rename(targetPath, backupPath);
      backedUp = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await fs.rename(temporaryPath, targetPath);
    if (backedUp) await fs.rm(backupPath, { force: true });
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    if (backedUp) {
      await fs.rename(backupPath, targetPath).catch(() => undefined);
    }
    throw error;
  }
};

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8'));

export const series1ImageCards = async (graphPath) => {
  const graph = await readJson(graphPath);
  const identities = graph?.payload?.identities;
  if (!Array.isArray(identities)) throw new Error(`Series 1 graph has no payload.identities array: ${graphPath}`);
  const cards = identities
    .filter((identity) => identity?.acquisitionPlan?.supported === true)
    .map((identity) => ({
      runtimeId: Number(identity?.runtime?.runtimeCardId),
      ydkId: Number(identity?.runtime?.ydkId),
      name: String(identity?.runtime?.nameEn || identity?.officialNameJa || identity?.key || ''),
    }))
    .filter((card) => Number.isInteger(card.runtimeId) && card.runtimeId > 0 && Number.isInteger(card.ydkId) && card.ydkId > 0);
  const unique = new Map(cards.map((card) => [card.ydkId, card]));
  return [...unique.values()].sort((left, right) => left.runtimeId - right.runtimeId || left.ydkId - right.ydkId);
};

export const catalogImageCards = async (catalogPath) => {
  const catalog = await readJson(catalogPath);
  if (!Array.isArray(catalog?.cards)) throw new Error(`Catalog has no cards array: ${catalogPath}`);
  const unique = new Map();
  for (const entry of catalog.cards) {
    const runtimeId = Number(entry?.id);
    const ydkId = Number(entry?.ydkId);
    if (!Number.isInteger(runtimeId) || runtimeId <= 0 || !Number.isInteger(ydkId) || ydkId <= 0) continue;
    unique.set(ydkId, {
      runtimeId,
      ydkId,
      name: String(entry?.names?.english || entry?.names?.display || `runtime ${runtimeId}`),
    });
  }
  return [...unique.values()].sort((left, right) => left.runtimeId - right.runtimeId || left.ydkId - right.ydkId);
};

const retryDelay = (attempt, response) => {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * (2 ** attempt);
};

const fetchImage = async ({ fetchImpl, limiter, url, retries, timeoutMs }) => {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await limiter();
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt === retries) throw error;
      await delay(retryDelay(attempt));
      continue;
    }
    if (response.status === 404) return { missing: true };
    if (response.status === 429 || response.status >= 500) {
      if (attempt === retries) throw new Error(`Image request failed after ${retries + 1} attempts: HTTP ${response.status} ${url}`);
      await delay(retryDelay(attempt, response));
      continue;
    }
    if (!response.ok) throw new Error(`Image request failed: HTTP ${response.status} ${url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isJpeg(bytes)) throw new Error(`Image response is not a JPEG: ${url}`);
    return { bytes };
  }
  throw new Error(`Unreachable image retry state: ${url}`);
};

export const downloadCardImages = async ({
  cards,
  cacheRoot,
  sizes = ['small', 'full'],
  requestsPerSecond = DEFAULT_REQUESTS_PER_SECOND,
  concurrency = DEFAULT_CONCURRENCY,
  retries = DEFAULT_RETRIES,
  timeoutMs = 30_000,
  force = false,
  dryRun = false,
  sameNameFallback = false,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
}) => {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  const normalizedSizes = [...new Set(sizes.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  for (const size of normalizedSizes) {
    if (!SIZE_PATHS[size]) throw new Error(`Unsupported image size ${size}; use ${Object.keys(SIZE_PATHS).join(', ')}`);
  }
  const workerCount = Math.floor(parsePositiveNumber(concurrency, 'concurrency'));
  if (workerCount > MAX_CONCURRENCY) throw new Error(`concurrency cannot exceed ${MAX_CONCURRENCY}`);
  const limiter = createRequestLimiter(requestsPerSecond);
  const results = { requested: 0, downloaded: 0, cached: 0, providerMissing: 0, fallback: 0, missing: 0, failed: 0, bytes: 0, failures: [] };
  const metadataPath = path.join(cacheRoot, PROVIDER, 'metadata.json');
  const previousMetadata = await readJson(metadataPath).catch(() => undefined);
  const records = previousMetadata?.provider === PROVIDER && previousMetadata.records && typeof previousMetadata.records === 'object'
    ? structuredClone(previousMetadata.records)
    : {};
  const work = cards.flatMap((card) => normalizedSizes.map((size) => ({ card, size })));

  let nextIndex = 0;
  let completed = 0;
  const processWorkItem = async (index) => {
    const { card, size } = work[index];
    const relativePath = `${PROVIDER}/${size}/${card.ydkId}.jpg`;
    const targetPath = path.join(cacheRoot, ...relativePath.split('/'));
    records[card.ydkId] ||= { runtimeId: card.runtimeId, ydkId: card.ydkId, name: card.name, files: {} };
    try {
      if (!force) {
        const existing = await fs.readFile(targetPath).catch(() => undefined);
        if (existing && isJpeg(existing)) {
          results.cached += 1;
          records[card.ydkId].files[size] = { ...records[card.ydkId].files[size], path: relativePath, bytes: existing.length, cached: true };
          completed += 1;
          onProgress({ index: completed, total: work.length, results, card, size });
          return;
        }
      }
      results.requested += 1;
      if (dryRun) {
        completed += 1;
        onProgress({ index: completed, total: work.length, results, card, size });
        return;
      }
      const url = `https://images.ygoprodeck.com/images/${SIZE_PATHS[size]}/${card.ydkId}.jpg`;
      const response = await fetchImage({ fetchImpl, limiter, url, retries, timeoutMs });
      if (response.missing) {
        results.providerMissing += 1;
        results.missing += 1;
        records[card.ydkId].files[size] = { missing: true, url };
      } else {
        await atomicWrite(targetPath, response.bytes);
        results.downloaded += 1;
        results.bytes += response.bytes.length;
        records[card.ydkId].files[size] = {
          path: relativePath,
          bytes: response.bytes.length,
          sha256: createHash('sha256').update(response.bytes).digest('hex'),
          url,
        };
      }
    } catch (error) {
      results.failed += 1;
      results.failures.push({ runtimeId: card.runtimeId, ydkId: card.ydkId, size, message: String(error) });
    }
    completed += 1;
    onProgress({ index: completed, total: work.length, results, card, size });
  };
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= work.length) return;
      await processWorkItem(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workerCount, Math.max(1, work.length)) }, () => worker()));

  if (!dryRun && sameNameFallback && results.missing) {
    const cardsByName = new Map();
    for (const card of cards) {
      if (!card.name) continue;
      const candidates = cardsByName.get(card.name) || [];
      candidates.push(card);
      cardsByName.set(card.name, candidates);
    }
    for (const card of cards) {
      const record = records[card.ydkId];
      if (!record?.files) continue;
      for (const size of normalizedSizes) {
        const missingFile = record.files[size];
        if (!missingFile?.missing) continue;
        const candidates = (cardsByName.get(card.name) || []).filter((candidate) => candidate.ydkId !== card.ydkId);
        let donor;
        let donorBytes;
        for (const candidate of candidates) {
          const candidatePath = path.join(cacheRoot, PROVIDER, size, `${candidate.ydkId}.jpg`);
          const bytes = await fs.readFile(candidatePath).catch(() => undefined);
          if (bytes && isJpeg(bytes)) {
            donor = candidate;
            donorBytes = bytes;
            break;
          }
        }
        if (!donor || !donorBytes) continue;
        const relativePath = `${PROVIDER}/${size}/${card.ydkId}.jpg`;
        await atomicWrite(path.join(cacheRoot, ...relativePath.split('/')), donorBytes);
        record.files[size] = {
          path: relativePath,
          bytes: donorBytes.length,
          sha256: createHash('sha256').update(donorBytes).digest('hex'),
          fallbackFromYdkId: donor.ydkId,
          fallbackReason: 'provider-image-unavailable-same-name',
          unavailableUrl: missingFile.url,
        };
        results.fallback += 1;
        results.missing -= 1;
      }
    }
  }

  if (!dryRun) {
    const metadata = {
      schemaVersion: 1,
      provider: PROVIDER,
      providerDocumentation: PROVIDER_PAGE,
      generatedAt: new Date().toISOString(),
      requestsPerSecond,
      concurrency: workerCount,
      sizes: normalizedSizes,
      cardCount: cards.length,
      results: { requested: results.requested, downloaded: results.downloaded, cached: results.cached, providerMissing: results.providerMissing, fallback: results.fallback, missing: results.missing, failed: results.failed, bytes: results.bytes },
      records,
      failures: results.failures,
    };
    await atomicWrite(metadataPath, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`));
  }
  return results;
};

const parseArgs = (argv) => Object.fromEntries(argv.map((argument) => {
  const match = /^--([^=]+)(?:=(.*))?$/u.exec(argument);
  if (!match) throw new Error(`Unsupported positional argument: ${argument}`);
  return [match[1], match[2] ?? true];
}));

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const editorRoot = path.resolve(scriptDirectory, '..');
  const projectRoot = path.resolve(String(args['project-root'] || path.join(editorRoot, '..', '..')));
  const scope = String(args.scope || 'series1');
  const sizes = String(args.sizes || 'small,full').split(',');
  const requestsPerSecond = parsePositiveNumber(args['requests-per-second'] || DEFAULT_REQUESTS_PER_SECOND, 'requests-per-second');
  const retries = Number(args.retries ?? DEFAULT_RETRIES);
  const concurrency = Math.floor(parsePositiveNumber(args.concurrency || DEFAULT_CONCURRENCY, 'concurrency'));
  const limit = args.limit ? Math.floor(parsePositiveNumber(args.limit, 'limit')) : undefined;
  const cacheRoot = path.resolve(String(args['cache-root'] || path.join(projectRoot, '.db', 'card-images')));
  const cards = scope === 'series1'
    ? await series1ImageCards(path.resolve(String(args.graph || path.join(projectRoot, 'campaign', 'source', 'graph', 'series1.json'))))
    : scope === 'catalog'
      ? await catalogImageCards(path.resolve(String(args.catalog || path.join(projectRoot, '.db', 'catalog.json'))))
      : (() => { throw new Error('scope must be series1 or catalog'); })();
  const selected = limit ? cards.slice(0, limit) : cards;
  process.stdout.write(`Card image cache: ${selected.length} cards, ${sizes.join('+')}, ${requestsPerSecond} requests/sec, concurrency ${concurrency}, ${cacheRoot}\n`);
  let lastReported = 0;
  const results = await downloadCardImages({
    cards: selected,
    cacheRoot,
    sizes,
    requestsPerSecond,
    concurrency,
    retries,
    force: args.force === true,
    dryRun: args['dry-run'] === true,
    sameNameFallback: args['same-name-fallback'] === true,
    onProgress: ({ index, total, results: current }) => {
      if (index === total || index - lastReported >= 25) {
        lastReported = index;
        process.stdout.write(`[${index}/${total}] downloaded=${current.downloaded} cached=${current.cached} missing=${current.missing} failed=${current.failed}\n`);
      }
    },
  });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (results.failed) process.exitCode = 1;
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
