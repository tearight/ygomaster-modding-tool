import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { searchCatalog } = await import(pathToFileURL(path.resolve(here, '..', 'dist-cli', 'core', 'catalog.js')).href);

const option = (name, fallback) => {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
};

const size = Math.max(1, Number(option('size', '14000')));
const rounds = Math.max(3, Number(option('rounds', '20')));
const catalogPath = option('catalog', process.env.YGOMASTER_CATALOG_BENCHMARK_PATH || '');
const shouldAssert = process.argv.includes('--assert');

const syntheticCard = (index) => {
  const id = index + 1;
  const level = index % 13;
  const dragon = index % 7 === 0;
  const name = index % 997 === 0 ? `푸른 눈 fixture ${id}` : `Synthetic Card ${id}`;
  return {
    id,
    ydkId: 10000000 + id,
    names: { english: name, display: name },
    texts: { english: `Deterministic effect token-${index % 101} for benchmark card ${id}.`, display: `Deterministic effect token-${index % 101} for benchmark card ${id}.` },
    original: {},
    stats: { type: 0x21, race: dragon ? 8192 : 1, level, atk: (index % 41) * 100, def: (index % 31) * 100 },
    autoTags: ['type:monster', `level:${level}`, dragon ? 'race:dragon' : 'race:warrior'],
    availability: index % 5,
  };
};

const loadStarted = performance.now();
const cards = catalogPath
  ? JSON.parse(fs.readFileSync(path.resolve(catalogPath), 'utf8')).cards
  : Array.from({ length: size }, (_, index) => syntheticCard(index));
const loadMs = performance.now() - loadStarted;

const queries = [
  'id:1001',
  'race:dragon level>=8',
  '"deterministic effect" token-17',
  '"푸른 눈"',
  'atk>=3000 def<2000',
];

searchCatalog(cards, queries[0], 20);
const samples = [];
const totals = {};
for (let round = 0; round < rounds; round += 1) {
  for (const query of queries) {
    const started = performance.now();
    const found = searchCatalog(cards, query, 20);
    samples.push(performance.now() - started);
    totals[query] = found.total;
  }
}

const percentile = (values, ratio) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
};

const report = {
  schemaVersion: 1,
  dataset: catalogPath ? 'catalog' : 'synthetic',
  cardCount: cards.length,
  rounds,
  queryCount: samples.length,
  loadMs: Number(loadMs.toFixed(3)),
  warmQueryMs: {
    p50: Number(percentile(samples, 0.5).toFixed(3)),
    p95: Number(percentile(samples, 0.95).toFixed(3)),
    max: Number(Math.max(...samples).toFixed(3)),
  },
  totals,
  budgets: { warmP95Ms: 50 },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (shouldAssert && report.warmQueryMs.p95 > report.budgets.warmP95Ms) process.exitCode = 1;
