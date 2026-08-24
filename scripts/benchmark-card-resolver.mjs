import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const workspaceRoot = path.resolve(projectRoot, '..', '..');
const defaultFixture = path.join(workspaceRoot, 'campaign', 'fixtures', 'card-resolver', 'benchmark.json');

const args = process.argv.slice(2);
const assertBudget = args.includes('--assert');
const numericOption = (name, fallback, minimum) => {
  const value = args.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.trunc(parsed)) : fallback;
};
const option = (name) => args.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
const rounds = numericOption('--rounds', 20, 3);
const requestedSize = numericOption('--size', 200, 1);
const fixturePath = path.resolve(option('--fixture') || defaultFixture);
const catalogPath = option('--catalog');

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

const loadResolverModule = async () => {
  const compiledPath = path.join(projectRoot, 'dist-cli', 'core', 'card-resolver.js');
  if (fs.existsSync(compiledPath)) return import(pathToFileURL(compiledPath).href);

  const require = createRequire(import.meta.url);
  require('ts-node/register');
  return require(path.join(projectRoot, 'src', 'core', 'card-resolver.ts'));
};

const makeCard = (id, name) => ({
  id,
  ydkId: id + 10000000,
  names: { english: name, display: name },
  texts: {},
  original: {},
  stats: {},
  autoTags: [],
});

const source = catalogPath ? await readJson(path.resolve(catalogPath)) : await readJson(fixturePath);
const entries = catalogPath
  ? (source.cards || [])
    .filter((card) => Number.isSafeInteger(card.id) && typeof card.names?.english === 'string' && card.names.english.trim())
    .map((card) => ({ id: card.id, name: card.names.english }))
  : source.entries;
if (!Array.isArray(entries) || entries.length < requestedSize) {
  throw new Error(`Benchmark dataset has ${entries?.length || 0} entries; need at least ${requestedSize}`);
}
const selectedEntries = entries.slice(0, requestedSize);
const cards = catalogPath
  ? selectedEntries.map((entry) => makeCard(entry.id, entry.name))
  : selectedEntries.map((entry) => makeCard(entry.id, entry.name));
const requests = selectedEntries.map((entry, index) => ({
  sourceName: entry.name,
  sourcePath: 'benchmark.decklist',
  sourceSpan: { line: index + 1, column: 1, endLine: index + 1, endColumn: entry.name.length + 1 },
}));

const resolverModule = await loadResolverModule();
const resolver = resolverModule.createCardResolver(cards);
const warm = resolver.resolveBatch(requests);
if (!warm.ok) throw new Error(`Warm-up resolution failed: ${warm.problems.map((problem) => problem.code).join(', ')}`);

const samples = [];
for (let round = 0; round < rounds; round += 1) {
  const start = performance.now();
  const result = resolver.resolveBatch(requests);
  const elapsed = performance.now() - start;
  if (!result.ok) throw new Error(`Resolution failed on round ${round + 1}: ${result.problems.map((problem) => problem.code).join(', ')}`);
  samples.push(elapsed);
}
const sorted = [...samples].sort((left, right) => left - right);
const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] || 0;
const report = {
  schemaVersion: 1,
  resolverVersion: resolverModule.CARD_RESOLVER_VERSION,
  dataset: catalogPath ? 'catalog' : 'fixture',
  cardCount: cards.length,
  entryCount: requests.length,
  rounds,
  warmBatchMs: {
    p50: Number(percentile(0.5).toFixed(3)),
    p95: Number(percentile(0.95).toFixed(3)),
    max: Number(Math.max(...samples).toFixed(3)),
  },
  allOk: true,
  catalogGeneration: resolver.catalogGeneration,
  budgets: { warmP95Ms: 100 },
};
console.log(JSON.stringify(report, null, 2));
if (assertBudget && report.warmBatchMs.p95 > report.budgets.warmP95Ms) {
  process.exitCode = 1;
}
