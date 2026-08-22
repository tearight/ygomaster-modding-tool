import * as fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteJson, ensureDirectory, exists } from './fs';
import { readStrictJson } from './json';
import {
  MaterializedCustomCard,
  customCardDatabaseExists,
  validateCustomCardDatabase,
} from './card-custom';
import {
  CatalogCacheMetadata,
  CatalogCard,
  CatalogRefreshResult,
  CatalogSearchResult,
  CatalogSourceDefinition,
  CatalogSourceRecord,
  CatalogStatus,
  CatalogTransport,
  CoreLogger,
  OperationResult,
  RuntimeTransport,
  failure,
  problem,
  result,
} from './types';
import { ensureRuntime, runtimeStatus } from './runtime';
import { resolveWorkspaceDataRoot } from './project-root';

/**
 * Card catalog cache is deliberately separate from campaign source and from
 * the YgoMaster runtime cache. It contains display data only.
 */
export const CATALOG_DATABASE_DIRECTORY = ['.db'] as const;
/** Backwards-compatible name for callers that only need the catalog root. */
export const CATALOG_CACHE_DIRECTORY = CATALOG_DATABASE_DIRECTORY;
export const CATALOG_SOURCE_DIRECTORY = ['.db', 'sources'] as const;
export const CATALOG_FILE_NAME = 'catalog.json';
export const CATALOG_METADATA_FILE_NAME = 'metadata.json';

export const DEFAULT_CATALOG_SOURCES: CatalogSourceDefinition[] = [
  {
    id: 'korean',
    language: 'korean',
    url: 'https://raw.githubusercontent.com/Team-AllYGOPro/edopro-korean/main/cards.cdb',
    format: 'sqlite',
  },
  {
    id: 'english',
    language: 'english',
    url: 'https://raw.githubusercontent.com/ProjectIgnis/BabelCDB/master/cards.cdb',
    format: 'sqlite',
  },
];

const dataRoot = (projectRoot: string) => resolveWorkspaceDataRoot(projectRoot);
const cacheRoot = (projectRoot: string) => path.resolve(dataRoot(projectRoot), ...CATALOG_DATABASE_DIRECTORY);
const catalogPath = (projectRoot: string) => path.join(cacheRoot(projectRoot), CATALOG_FILE_NAME);
const metadataPath = (projectRoot: string) => path.join(cacheRoot(projectRoot), CATALOG_METADATA_FILE_NAME);
const sourceRoot = (projectRoot: string) => path.resolve(dataRoot(projectRoot), ...CATALOG_SOURCE_DIRECTORY);
const sourcePath = (projectRoot: string, language: 'korean' | 'english') => path.join(sourceRoot(projectRoot), language, 'cards.cdb');
const sourcePathMap = (projectRoot: string): Partial<Record<'korean' | 'english', string>> => ({
  korean: sourcePath(projectRoot, 'korean'),
  english: sourcePath(projectRoot, 'english'),
});

interface CatalogMemoryEntry {
  catalogMtimeMs: number;
  catalogSize: number;
  metadataMtimeMs: number;
  metadataSize: number;
  cards: CatalogCard[];
  metadata: CatalogCacheMetadata;
}

const catalogMemoryCache = new Map<string, CatalogMemoryEntry>();

const invalidateCatalogMemoryCache = (projectRoot: string) => {
  catalogMemoryCache.delete(cacheRoot(projectRoot));
};

const rememberCatalog = (key: string, entry: CatalogMemoryEntry) => {
  catalogMemoryCache.delete(key);
  catalogMemoryCache.set(key, entry);
  while (catalogMemoryCache.size > 4) {
    const oldest = catalogMemoryCache.keys().next().value as string | undefined;
    if (!oldest) break;
    catalogMemoryCache.delete(oldest);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

const toStringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const cloneRecord = (value: Record<string, unknown>, id: number): CatalogSourceRecord => {
  const resultRecord: CatalogSourceRecord = { id };
  Object.entries(value).forEach(([key, entry]) => {
    if (key === 'id') return;
    if (
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean' ||
      (Array.isArray(entry) && entry.every((item) => item === null || typeof item !== 'object'))
    ) {
      resultRecord[key] = entry as CatalogSourceRecord[typeof key];
    }
  });
  return resultRecord;
};

const normalizeSourceRecord = (value: unknown, fallbackId?: number): CatalogSourceRecord | undefined => {
  if (!isRecord(value)) return;
  const id = toNumber(value.id ?? value.ID ?? value.code ?? fallbackId);
  if (id === undefined || !Number.isInteger(id)) return;
  return cloneRecord(value, id);
};

const mergeSourceRecord = (left: CatalogSourceRecord | undefined, right: CatalogSourceRecord): CatalogSourceRecord => ({
  ...(left || { id: right.id }),
  ...right,
  id: right.id,
});

const recordList = (value: unknown): CatalogSourceRecord[] => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeSourceRecord(entry))
      .filter((entry): entry is CatalogSourceRecord => Boolean(entry));
  }
  if (!isRecord(value)) return [];

  const nested = ['cards', 'data', 'records', 'texts', 'datas']
    .map((key) => value[key])
    .find((entry) => Array.isArray(entry));
  if (nested) return recordList(nested);

  return Object.entries(value)
    .map(([key, entry]) => normalizeSourceRecord(entry, toNumber(key)))
    .filter((entry): entry is CatalogSourceRecord => Boolean(entry));
};

const parseJsonDatabase = (value: unknown): CatalogSourceRecord[] => {
  if (isRecord(value) && (Array.isArray(value.datas) || Array.isArray(value.texts))) {
    const datas = recordList(value.datas);
    const texts = recordList(value.texts);
    const byId = new Map<number, CatalogSourceRecord>();
    datas.forEach((entry) => byId.set(entry.id, entry));
    texts.forEach((entry) => byId.set(entry.id, mergeSourceRecord(byId.get(entry.id), entry)));
    return [...byId.values()];
  }
  return recordList(value);
};

const readVarint = (data: Uint8Array, offset: number): { value: number; next: number } => {
  let value = 0;
  let cursor = offset;
  for (let index = 0; index < 9; index += 1) {
    const byte = data[cursor];
    if (byte === undefined) throw new Error('SQLite varint exceeds input');
    if (index === 8) return { value: value * 256 + byte, next: cursor + 1 };
    value = value * 128 + (byte & 0x7f);
    cursor += 1;
    if (!(byte & 0x80)) return { value, next: cursor };
  }
  throw new Error('SQLite varint is invalid');
};

const readSignedInteger = (data: Uint8Array, offset: number, length: number): number => {
  if (length === 0) return 0;
  let value = 0;
  for (let index = 0; index < length; index += 1) value = value * 256 + data[offset + index];
  const sign = 2 ** (length * 8 - 1);
  return value >= sign ? value - 2 ** (length * 8) : value;
};

const readSerialValue = (data: Uint8Array, offset: number, serial: number): { value: unknown; next: number } => {
  if (serial === 0) return { value: null, next: offset };
  if (serial === 1) return { value: readSignedInteger(data, offset, 1), next: offset + 1 };
  if (serial === 2) return { value: readSignedInteger(data, offset, 2), next: offset + 2 };
  if (serial === 3) return { value: readSignedInteger(data, offset, 3), next: offset + 3 };
  if (serial === 4) return { value: readSignedInteger(data, offset, 4), next: offset + 4 };
  if (serial === 5) return { value: readSignedInteger(data, offset, 6), next: offset + 6 };
  if (serial === 6) {
    let value = 0n;
    for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(data[offset + index]);
    if (value & (1n << 63n)) value -= 1n << 64n;
    // Preserve 64-bit values such as setcode without lossy JS Number coercion.
    return { value: value.toString(), next: offset + 8 };
  }
  if (serial === 7) {
    const view = new DataView(data.buffer, data.byteOffset + offset, 8);
    return { value: view.getFloat64(0, false), next: offset + 8 };
  }
  if (serial === 8) return { value: 0, next: offset };
  if (serial === 9) return { value: 1, next: offset };
  if (serial < 12) throw new Error(`SQLite reserved serial type ${serial}`);
  const length = serial % 2 === 0 ? (serial - 12) / 2 : (serial - 13) / 2;
  const end = offset + length;
  if (end > data.length) throw new Error('SQLite record exceeds input');
  if (serial % 2 === 0) return { value: data.slice(offset, end), next: end };
  return { value: new TextDecoder().decode(data.slice(offset, end)), next: end };
};

const readRecord = (payload: Uint8Array): unknown[] => {
  const header = readVarint(payload, 0);
  const serials: number[] = [];
  let cursor = header.next;
  while (cursor < header.value) {
    const serial = readVarint(payload, cursor);
    serials.push(serial.value);
    cursor = serial.next;
  }
  let content = header.value;
  return serials.map((serial) => {
    const entry = readSerialValue(payload, content, serial);
    content = entry.next;
    return entry.value;
  });
};

const uint16 = (data: Uint8Array, offset: number) => (data[offset] << 8) | data[offset + 1];
const uint32 = (data: Uint8Array, offset: number) =>
  ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;

const readSqliteRows = (data: Uint8Array, rootPage: number, pageSize: number, reserved: number): unknown[][] => {
  const usable = pageSize - reserved;
  const visited = new Set<number>();
  const rows: unknown[][] = [];
  const readPage = (pageNumber: number) => {
    const offset = (pageNumber - 1) * pageSize;
    if (offset < 0 || offset + pageSize > data.length) throw new Error(`SQLite page ${pageNumber} is outside input`);
    return offset;
  };
  const readPayload = (cellOffset: number, pageOffset: number): { payload: Uint8Array; rowid: number } => {
    const payloadSizeValue = readVarint(data, cellOffset);
    const payloadSize = payloadSizeValue.value;
    const rowid = readVarint(data, payloadSizeValue.next);
    const payloadOffset = rowid.next;
    const maxLocal = usable - 35;
    const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
    const local = payloadSize <= maxLocal
      ? payloadSize
      : minLocal + ((payloadSize - minLocal) % (usable - 4));
    const chunks: Uint8Array[] = [data.slice(payloadOffset, payloadOffset + local)];
    let remaining = payloadSize - local;
    const overflowOffset = payloadOffset + local;
    if (remaining > 0) {
      let nextPage = uint32(data, overflowOffset);
      while (remaining > 0 && nextPage !== 0) {
        const overflowPageOffset = readPage(nextPage);
        const bytes = Math.min(remaining, usable - 4);
        chunks.push(data.slice(overflowPageOffset + 4, overflowPageOffset + 4 + bytes));
        remaining -= bytes;
        nextPage = uint32(data, overflowPageOffset);
      }
      if (remaining > 0) throw new Error(`SQLite overflow chain is truncated at page ${nextPage}`);
    }
    void pageOffset;
    return { payload: concatBytes(chunks), rowid: rowid.value };
  };
  const visit = (pageNumber: number) => {
    if (visited.has(pageNumber)) return;
    visited.add(pageNumber);
    const pageStart = readPage(pageNumber);
    const headerStart = pageNumber === 1 ? pageStart + 100 : pageStart;
    const pageType = data[headerStart];
    const count = uint16(data, headerStart + 3);
    const pointersStart = headerStart + (pageType === 0x05 ? 12 : 8);
    if (pageType === 0x0d) {
      for (let index = 0; index < count; index += 1) {
        const cell = uint16(data, pointersStart + index * 2);
        const cellData = readPayload(pageStart + cell, pageStart);
        const record = readRecord(cellData.payload);
        // SQLite omits an INTEGER PRIMARY KEY from the record payload; in
        // YGOPro's datas/texts tables that omitted value is the rowid.
        rows.push(record[0] === null ? [cellData.rowid, ...record.slice(1)] : record);
      }
      return;
    }
    if (pageType !== 0x05) throw new Error(`Unsupported SQLite table page type 0x${pageType.toString(16)}`);
    for (let index = 0; index < count; index += 1) {
      const cell = uint16(data, pointersStart + index * 2);
      visit(uint32(data, pageStart + cell));
    }
    visit(uint32(data, headerStart + 8));
  };
  visit(rootPage);
  return rows;
};

const concatBytes = (chunks: Uint8Array[]): Uint8Array => {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.length;
  });
  return output;
};

/** Read the small subset of SQLite used by EDOPro cards.cdb without a DB dependency. */
export const parseSqliteCardDatabase = (data: Uint8Array): CatalogSourceRecord[] => {
  const header = new TextDecoder().decode(data.slice(0, 16));
  if (header !== 'SQLite format 3\u0000') throw new Error('Card database is not a SQLite 3 file');
  const rawPageSize = uint16(data, 16);
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
  if (!pageSize || pageSize % 2 !== 0) throw new Error(`Unsupported SQLite page size ${pageSize}`);
  const reserved = data[20];
  const masterRows = readSqliteRows(data, 1, pageSize, reserved);
  const roots = new Map<string, number>();
  masterRows.forEach((row) => {
    const name = typeof row[1] === 'string' ? row[1].toLowerCase() : '';
    const root = toNumber(row[3]);
    if (root && (name === 'datas' || name === 'texts')) roots.set(name, root);
  });
  if (!roots.size) throw new Error('Card database does not contain datas/texts tables');
  const byId = new Map<number, CatalogSourceRecord>();
  const dataRows = roots.has('datas') ? readSqliteRows(data, roots.get('datas') as number, pageSize, reserved) : [];
  dataRows.forEach((row) => {
    const id = toNumber(row[0]);
    if (id === undefined || !Number.isInteger(id)) return;
    const record: CatalogSourceRecord = {
      id,
      ot: toNumber(row[1]),
      alias: toNumber(row[2]),
      setcode: typeof row[3] === 'string' ? row[3] : toNumber(row[3]),
      type: toNumber(row[4]),
      atk: toNumber(row[5]),
      def: toNumber(row[6]),
      level: toNumber(row[7]),
      race: toNumber(row[8]),
      attribute: toNumber(row[9]),
      category: toNumber(row[10]),
    };
    byId.set(id, record);
  });
  const textRows = roots.has('texts') ? readSqliteRows(data, roots.get('texts') as number, pageSize, reserved) : [];
  textRows.forEach((row) => {
    const id = toNumber(row[0]);
    if (id === undefined || !Number.isInteger(id)) return;
    const record: CatalogSourceRecord = {
      id,
      name: toStringValue(row[1]),
      desc: toStringValue(row[2]),
    };
    byId.set(id, mergeSourceRecord(byId.get(id), record));
  });
  return [...byId.values()].sort((left, right) => left.id - right.id);
};

export const parseCardDatabase = (data: Uint8Array | string, format?: CatalogSourceDefinition['format']): CatalogSourceRecord[] => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const isSqlite = new TextDecoder().decode(bytes.slice(0, 16)) === 'SQLite format 3\u0000';
  if (format === 'sqlite' || isSqlite) return parseSqliteCardDatabase(bytes);
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
  return parseJsonDatabase(JSON.parse(text) as unknown).sort((left, right) => left.id - right.id);
};

const attributeTags: Record<number, string> = {
  1: 'earth',
  2: 'water',
  4: 'fire',
  8: 'wind',
  16: 'light',
  32: 'dark',
  64: 'divine',
};

const raceTags: Record<number, string> = {
  1: 'warrior',
  2: 'spellcaster',
  4: 'fairy',
  8: 'fiend',
  16: 'zombie',
  32: 'machine',
  64: 'aqua',
  128: 'pyro',
  256: 'rock',
  512: 'winged-beast',
  1024: 'plant',
  2048: 'insect',
  4096: 'thunder',
  8192: 'dragon',
  16384: 'beast',
  32768: 'beast-warrior',
  65536: 'dinosaur',
  131072: 'fish',
  262144: 'sea-serpent',
  524288: 'reptile',
  1048576: 'psychic',
  2097152: 'divine-beast',
  4194304: 'creator-god',
  8388608: 'wyrm',
  16777216: 'cyberse',
  33554432: 'illusion',
};

const typeTags: Array<[number, string]> = [
  [0x1, 'monster'],
  [0x2, 'spell'],
  [0x4, 'trap'],
  [0x10, 'normal'],
  [0x20, 'effect'],
  [0x40, 'fusion'],
  [0x80, 'ritual'],
  [0x100, 'spirit'],
  [0x200, 'union'],
  [0x400, 'gemini'],
  [0x1000, 'tuner'],
  [0x2000, 'synchro'],
  [0x4000, 'token'],
  [0x10000, 'quick-play'],
  [0x20000, 'continuous'],
  [0x40000, 'equip'],
  [0x80000, 'field'],
  [0x100000, 'counter'],
  [0x200000, 'flip'],
  [0x400000, 'toon'],
  [0x800000, 'xyz'],
  [0x1000000, 'pendulum'],
  [0x2000000, 'special-summon'],
  [0x4000000, 'link'],
];

const stopWords = new Set([
  'the', 'this', 'that', 'with', 'from', 'when', 'you', 'your', 'and', 'for', 'can', 'into',
  'then', 'have', 'has', 'are', 'not', '다음', '경우', '카드', '자신', '이후', '발동',
]);

const addTag = (tags: Set<string>, value: string | undefined) => {
  const normalized = value?.trim().toLocaleLowerCase();
  if (normalized) tags.add(normalized);
};

const addTextTags = (tags: Set<string>, text: string | undefined) => {
  if (!text) return;
  const words = text.normalize('NFKC').toLocaleLowerCase().match(/[\p{Script=Hangul}]+|[a-z0-9]+/giu) || [];
  words.forEach((word) => {
    if (word.length < 2 || stopWords.has(word)) return;
    addTag(tags, `effect:${word}`);
  });
};

export const generateAutoTags = (record: CatalogSourceRecord, text?: string): string[] => {
  const tags = new Set<string>();
  const type = toNumber(record.type);
  if (type !== undefined) {
    typeTags.forEach(([bit, name]) => {
      if ((type & bit) === bit) addTag(tags, `type:${name}`);
    });
  }
  const attribute = toNumber(record.attribute);
  if (attribute !== undefined) {
    const name = attributeTags[attribute];
    if (name) addTag(tags, `attribute:${name}`);
  }
  const race = toNumber(record.race);
  if (race !== undefined) {
    Object.entries(raceTags).forEach(([bit, name]) => {
      if ((race & Number(bit)) === Number(bit)) addTag(tags, `race:${name}`);
    });
  }
  const rawLevel = toNumber(record.level);
  const isXyz = type !== undefined && (type & 0x800000) === 0x800000;
  const isLink = type !== undefined && (type & 0x4000000) === 0x4000000;
  const level = !isXyz && !isLink ? rawLevel : undefined;
  if (level !== undefined && level >= 0) addTag(tags, `level:${level}`);
  const rank = toNumber(record.rank) ?? (isXyz ? rawLevel : undefined);
  if (rank !== undefined && rank >= 0) addTag(tags, `rank:${rank}`);
  const link = toNumber(record.link ?? record.linkval) ?? (isLink ? rawLevel : undefined);
  if (link !== undefined && link >= 0) addTag(tags, `link:${link}`);
  const scale = toNumber(record.scale ?? record.lscale ?? record.rscale);
  if (scale !== undefined && scale >= 0) addTag(tags, `scale:${scale}`);
  const atk = toNumber(record.atk);
  if (atk !== undefined && atk >= 0) addTag(tags, `atk:${atk}`);
  const def = toNumber(record.def);
  if (def !== undefined && def >= 0) addTag(tags, `def:${def}`);
  const category = toNumber(record.category);
  if (category !== undefined && category >= 0) addTag(tags, `category:${category}`);
  addTextTags(tags, text || record.desc);
  return [...tags].sort();
};

const normalizedName = (value: unknown) => toStringValue(value);

const recordToCard = (
  id: number,
  ydkId: number,
  availability: number | undefined,
  korean: CatalogSourceRecord | undefined,
  english: CatalogSourceRecord | undefined,
): CatalogCard => {
  const koreanName = normalizedName(korean?.name);
  const englishName = normalizedName(english?.name);
  const koreanText = normalizedName(korean?.desc);
  const englishText = normalizedName(english?.desc);
  const merged = { ...(english || {}), ...(korean || {}) };
  const type = toNumber(merged.type);
  const rawLevel = toNumber(merged.level);
  const isXyz = type !== undefined && (type & 0x800000) === 0x800000;
  const isLink = type !== undefined && (type & 0x4000000) === 0x4000000;
  const stats = {
    type,
    attribute: toNumber(merged.attribute),
    race: toNumber(merged.race),
    level: !isXyz && !isLink ? rawLevel : undefined,
    rank: toNumber(merged.rank) ?? (isXyz ? rawLevel : undefined),
    link: toNumber(merged.link ?? merged.linkval) ?? (isLink ? rawLevel : undefined),
    scale: toNumber(merged.scale ?? merged.lscale ?? merged.rscale),
    atk: toNumber(merged.atk),
    def: toNumber(merged.def),
  };
  const generatedRecord: CatalogSourceRecord = { id, ...merged, ...stats };
  return {
    id,
    ydkId,
    names: { ...(koreanName ? { korean: koreanName } : {}), ...(englishName ? { english: englishName } : {}), display: koreanName || englishName || `#${id}` },
    texts: { ...(koreanText ? { korean: koreanText } : {}), ...(englishText ? { english: englishText } : {}), ...(koreanText || englishText ? { display: koreanText || englishText } : {}) },
    original: { ...(korean ? { korean } : {}), ...(english ? { english } : {}) },
    stats,
    autoTags: generateAutoTags(generatedRecord, koreanText || englishText),
    ...(availability === undefined ? {} : { availability }),
  };
};

const parseCardList = (value: unknown): Map<number, number> => {
  const map = new Map<number, number>();
  const visit = (entry: unknown) => {
    if (!isRecord(entry)) return;
    Object.entries(entry).forEach(([key, child]) => {
      const id = toNumber(key);
      const availability = toNumber(child);
      if (id !== undefined && Number.isInteger(id) && availability !== undefined) map.set(id, availability);
      else if (isRecord(child)) visit(child);
    });
  };
  visit(value);
  return map;
};

const parseYdkIds = (text: string): Map<number, number[]> => {
  const map = new Map<number, number[]>();
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line) => {
    const normalized = line.replace(/#.*/, '').trim();
    if (!normalized) return;
    const values = normalized.split(/[\s,;]+/).map(Number);
    if (values.length < 2 || !Number.isInteger(values[0]) || !Number.isInteger(values[1])) return;
    const candidates = map.get(values[1]) || [];
    if (!candidates.includes(values[0])) candidates.push(values[0]);
    map.set(values[1], candidates);
  });
  return map;
};

interface CatalogYgoMasterInput {
  cardList: unknown;
  ydkIds: string;
  runtimeTag?: string;
  cardListPath?: string;
  ydkIdsPath?: string;
}

export interface CatalogRefreshOptions {
  transport?: CatalogTransport;
  /** Runtime release transport is independent from card database downloads. */
  runtimeTransport?: RuntimeTransport;
  /** Re-fetch both approved card sources instead of using valid local files. */
  online?: boolean;
  sources?: CatalogSourceDefinition[];
  ygoMaster?: Partial<CatalogYgoMasterInput> & { runtimePath?: string };
  logger?: CoreLogger;
}

const defaultCatalogSourcesFromEnvironment = (): CatalogSourceDefinition[] => {
  const koreanUrl = process.env.YGOMASTER_CATALOG_KOREAN_URL?.trim();
  const englishUrl = process.env.YGOMASTER_CATALOG_ENGLISH_URL?.trim();
  return DEFAULT_CATALOG_SOURCES.map((source) => {
    const override = source.language === 'korean' ? koreanUrl : englishUrl;
    const revision = source.language === 'korean'
      ? process.env.YGOMASTER_CATALOG_KOREAN_REVISION
      : process.env.YGOMASTER_CATALOG_ENGLISH_REVISION;
    return { ...source, ...(override ? { url: override } : {}), ...(revision ? { revision } : {}) };
  });
};

export const defaultCatalogTransport = (): CatalogTransport => ({
  async getBytesWithMetadata(url: string) {
    const response = await fetch(url, { headers: { 'User-Agent': 'ygomaster-modding-tool/0.13.0', Accept: 'application/octet-stream' } });
    if (!response.ok) throw new Error(`Catalog download failed: HTTP ${response.status}`);
    const etag = response.headers.get('etag')?.trim();
    const lastModified = response.headers.get('last-modified')?.trim();
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      ...(etag ? { revision: etag } : lastModified ? { revision: lastModified } : {}),
    };
  },
  async getBytes(url: string) {
    const downloaded = await this.getBytesWithMetadata?.(url);
    if (!downloaded) throw new Error('Catalog transport cannot download bytes');
    return downloaded.bytes;
  },
  async getText(url: string) {
    const response = await fetch(url, { headers: { 'User-Agent': 'ygomaster-modding-tool/0.13.0', Accept: 'text/plain' } });
    if (!response.ok) throw new Error(`Catalog download failed: HTTP ${response.status}`);
    return response.text();
  },
});

const readRuntimeInputs = async (
  projectRoot: string,
  options: CatalogRefreshOptions,
  runtimeTransport?: RuntimeTransport,
): Promise<CatalogYgoMasterInput> => {
  const provided = options.ygoMaster;
  if (provided?.cardList !== undefined && typeof provided.ydkIds === 'string') {
    return { cardList: provided.cardList, ydkIds: provided.ydkIds, runtimeTag: provided.runtimeTag, cardListPath: provided.cardListPath, ydkIdsPath: provided.ydkIdsPath };
  }
  let runtimePath = provided?.runtimePath;
  let runtimeTag = provided?.runtimeTag;
  if (!runtimePath) {
    const cached = await runtimeStatus(projectRoot);
    const entry = cached.data?.entries
      .filter((candidate) => candidate.valid)
      .sort((left, right) => (right.downloadedAt || '').localeCompare(left.downloadedAt || ''))[0];
    if (entry) {
      runtimePath = entry.runtimePath;
      runtimeTag = runtimeTag || entry.tag;
    }
  }
  if (!runtimePath) {
    const ensured = await ensureRuntime(projectRoot, { transport: runtimeTransport, logger: options.logger });
    runtimePath = ensured.value.entry.runtimePath;
    runtimeTag = runtimeTag || ensured.value.entry.tag;
  }
  const cardListPath = path.resolve(runtimePath, 'Data', 'CardList.json');
  const ydkIdsPath = path.resolve(runtimePath, 'Data', 'YdkIds.txt');
  return {
    cardList: JSON.parse(await fs.readFile(cardListPath, 'utf8')) as unknown,
    ydkIds: await fs.readFile(ydkIdsPath, 'utf8'),
    runtimeTag,
    cardListPath,
    ydkIdsPath,
  };
};

interface LoadedCatalogSource {
  bytes: Uint8Array;
  records: CatalogSourceRecord[];
  revision?: string;
  previous?: CatalogCacheMetadata['sources'][number];
  usedFrom: 'local' | 'download';
}

const readLocalSource = async (
  projectRoot: string,
  source: CatalogSourceDefinition,
  cached: { metadata: CatalogCacheMetadata } | undefined,
): Promise<LoadedCatalogSource | undefined> => {
  try {
    const bytes = new Uint8Array(await fs.readFile(sourcePath(projectRoot, source.language)));
    const records = parseCardDatabase(bytes, source.format);
    if (!records.length) return;
    const previous = cached?.metadata.sources.find((entry) => entry.language === source.language);
    return { bytes, records, usedFrom: 'local', ...(previous ? { previous } : {}) };
  } catch {
    return;
  }
};

const readDownloadedSource = async (source: CatalogSourceDefinition, transport: CatalogTransport): Promise<LoadedCatalogSource> => {
  const downloaded = transport.getBytesWithMetadata
    ? await transport.getBytesWithMetadata(source.url)
    : { bytes: await transport.getBytes(source.url) };
  const records = parseCardDatabase(downloaded.bytes, source.format);
  if (!records.length) throw new Error(`Catalog source ${source.id} contains no card records`);
  return { bytes: downloaded.bytes, records, revision: downloaded.revision, usedFrom: 'download' };
};

const commitSourceBytes = async (
  projectRoot: string,
  updates: Map<'korean' | 'english', Uint8Array>,
): Promise<void> => {
  if (!updates.size) return;
  const root = cacheRoot(projectRoot);
  await ensureDirectory(root);
  const stageParent = await fs.mkdtemp(path.join(root, '.sources-stage-'));
  const stageRoot = path.join(stageParent, 'sources');
  const currentRoot = sourceRoot(projectRoot);
  const backupRoot = path.join(root, `.sources-backup-${process.pid}-${Date.now()}`);
  let movedCurrent = false;
  let movedStage = false;
  try {
    await ensureDirectory(stageRoot);
    if (await exists(currentRoot)) {
      const currentEntries = await fs.readdir(currentRoot, { withFileTypes: true });
      for (const entry of currentEntries) {
        await fs.cp(path.join(currentRoot, entry.name), path.join(stageRoot, entry.name), { recursive: true });
      }
    }
    for (const [language, bytes] of updates) {
      const destination = path.join(stageRoot, language, 'cards.cdb');
      await ensureDirectory(path.dirname(destination));
      await fs.writeFile(destination, bytes);
    }
    if (await exists(currentRoot)) {
      await fs.rename(currentRoot, backupRoot);
      movedCurrent = true;
    }
    await fs.rename(stageRoot, currentRoot);
    movedStage = true;
    if (movedCurrent) {
      await fs.rm(backupRoot, { recursive: true, force: true });
    }
  } catch (error) {
    try {
      const backupExists = await exists(backupRoot);
      if (movedCurrent && backupExists) {
        if (movedStage && await exists(currentRoot)) await fs.rm(currentRoot, { recursive: true, force: true });
        await fs.rename(backupRoot, currentRoot);
      }
    } catch (restoreError) {
      throw new Error(`${String(error)}; original source backup preserved at ${backupRoot}; restore failed: ${String(restoreError)}`);
    }
    throw error;
  } finally {
    await fs.rm(stageParent, { recursive: true, force: true });
    // A backup is intentionally retained if replacement or restoration did
    // not complete. Never delete the only recoverable source copy here.
  }
};

const readCache = async (projectRoot: string): Promise<{ cards: CatalogCard[]; metadata: CatalogCacheMetadata } | undefined> => {
  const key = cacheRoot(projectRoot);
  try {
    const [catalogFile, metadataFile] = await Promise.all([
      fs.stat(catalogPath(projectRoot)),
      fs.stat(metadataPath(projectRoot)),
    ]);
    const remembered = catalogMemoryCache.get(key);
    if (
      remembered
      && remembered.catalogMtimeMs === catalogFile.mtimeMs
      && remembered.catalogSize === catalogFile.size
      && remembered.metadataMtimeMs === metadataFile.mtimeMs
      && remembered.metadataSize === metadataFile.size
    ) {
      return { cards: remembered.cards, metadata: remembered.metadata };
    }
    const [catalog, metadata] = await Promise.all([
      readStrictJson<{ schemaVersion?: number; cards?: CatalogCard[] }>(catalogPath(projectRoot)),
      readStrictJson<CatalogCacheMetadata>(metadataPath(projectRoot)),
    ]);
    if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.cards) || metadata.schemaVersion !== 1) return;
    rememberCatalog(key, {
      catalogMtimeMs: catalogFile.mtimeMs,
      catalogSize: catalogFile.size,
      metadataMtimeMs: metadataFile.mtimeMs,
      metadataSize: metadataFile.size,
      cards: catalog.cards,
      metadata,
    });
    return { cards: catalog.cards, metadata };
  } catch {
    catalogMemoryCache.delete(key);
    return;
  }
};

export const catalogStatus = async (projectRoot: string): Promise<OperationResult<CatalogStatus>> => {
  const cached = await readCache(projectRoot);
  const metadata = cached?.metadata;
  return result({
    cacheRoot: cacheRoot(projectRoot),
    catalogPath: catalogPath(projectRoot),
    metadataPath: metadataPath(projectRoot),
    sourcePaths: sourcePathMap(projectRoot),
    valid: Boolean(cached),
    ...(metadata ? { metadata } : {}),
    cardCount: cached?.cards.length || 0,
    missingRuntimeIdCount: metadata?.missingRuntimeIds.length || 0,
    ...(metadata ? { lastUpdated: metadata.generatedAt } : {}),
  });
};

export const refreshCatalog = async (
  projectRoot: string,
  options: CatalogRefreshOptions = {},
): Promise<OperationResult<CatalogRefreshResult>> => {
  const sources = options.sources || defaultCatalogSourcesFromEnvironment();
  const transport = options.transport || defaultCatalogTransport();
  const cached = await readCache(projectRoot);
  try {
    if (!sources.length) throw new Error('No catalog sources configured; use the approved defaults or pass sources explicitly');
    const ygoMaster = await readRuntimeInputs(projectRoot, options, options.runtimeTransport);
    const cardList = parseCardList(ygoMaster.cardList);
    const bridge = parseYdkIds(ygoMaster.ydkIds);
    const recordsByLanguage = new Map<'korean' | 'english', Map<number, CatalogSourceRecord>>();
    const sourceMetadata: CatalogCacheMetadata['sources'] = [];
    const sourceUsage: Partial<Record<'korean' | 'english', 'local' | 'download'>> = {};
    const sourceUpdates = new Map<'korean' | 'english', Uint8Array>();
    for (const source of sources) {
      if (!source.url.trim()) throw new Error(`Catalog source ${source.id} has an empty URL`);
      const local = options.online ? undefined : await readLocalSource(projectRoot, source, cached);
      const loaded = local || await readDownloadedSource(source, transport);
      const records = loaded.records;
      if (loaded.usedFrom === 'download') sourceUpdates.set(source.language, loaded.bytes);
      const byId = new Map<number, CatalogSourceRecord>();
      records.forEach((record) => byId.set(record.id, record));
      recordsByLanguage.set(source.language, byId);
      sourceUsage[source.language] = loaded.usedFrom;
      const previous = loaded.usedFrom === 'local' ? loaded.previous : undefined;
      const revision = loaded.usedFrom === 'local'
        ? previous?.revision ?? source.revision
        : source.revision || loaded.revision;
      sourceMetadata.push({
        id: source.id,
        language: source.language,
        url: loaded.usedFrom === 'local' ? previous?.url ?? source.url : source.url,
        format: source.format || 'sqlite',
        path: sourcePath(projectRoot, source.language),
        usedFrom: loaded.usedFrom,
        ...(revision ? { revision } : {}),
        fetchedAt: loaded.usedFrom === 'local' ? previous?.fetchedAt ?? new Date().toISOString() : new Date().toISOString(),
        recordCount: records.length,
      });
    }
    const korean = recordsByLanguage.get('korean');
    const english = recordsByLanguage.get('english');
    const missingRuntimeIds: number[] = [];
    const cards: CatalogCard[] = [];
    [...cardList.keys()].sort((left, right) => left - right).forEach((id) => {
      const ydkCandidates = bridge.get(id) || [];
      const matched = ydkCandidates
        .map((ydkId) => ({ ydkId, koreanRecord: korean?.get(ydkId), englishRecord: english?.get(ydkId) }))
        .find((candidate) => candidate.koreanRecord || candidate.englishRecord);
      if (!matched) {
        missingRuntimeIds.push(id);
        return;
      }
      cards.push(recordToCard(id, matched.ydkId, cardList.get(id), matched.koreanRecord, matched.englishRecord));
    });
    const warnings = [];
    if (!korean) warnings.push(problem('CATALOG_KOREAN_SOURCE_MISSING', 'Korean catalog source was not configured', undefined, 'warning'));
    if (!english) warnings.push(problem('CATALOG_ENGLISH_SOURCE_MISSING', 'English catalog source was not configured', undefined, 'warning'));
    if (missingRuntimeIds.length) warnings.push(problem('CATALOG_RUNTIME_IDS_MISSING', `${missingRuntimeIds.length} YgoMaster card IDs had no bridge or display record`, undefined, 'warning'));
    const metadata: CatalogCacheMetadata = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      cardCount: cards.length,
      matchedRuntimeIdCount: cards.length,
      missingRuntimeIds,
      sources: sourceMetadata,
      ygoMaster: {
        ...(ygoMaster.runtimeTag ? { runtimeTag: ygoMaster.runtimeTag } : {}),
        ...(ygoMaster.cardListPath ? { cardListPath: ygoMaster.cardListPath } : {}),
        ...(ygoMaster.ydkIdsPath ? { ydkIdsPath: ygoMaster.ydkIdsPath } : {}),
        runtimeIdCount: cardList.size,
        bridgeCount: [...bridge.values()].reduce((count, candidates) => count + candidates.length, 0),
      },
    };
    // Network bytes are fully parsed before this point. Stage all raw sources
    // together so a failed language never removes another language's valid DB.
    await commitSourceBytes(projectRoot, sourceUpdates);
    await ensureDirectory(cacheRoot(projectRoot));
    await atomicWriteJson(catalogPath(projectRoot), { schemaVersion: 1, cards });
    await atomicWriteJson(metadataPath(projectRoot), metadata);
    invalidateCatalogMemoryCache(projectRoot);
    const status = await catalogStatus(projectRoot);
    if (!status.data) throw new Error('Catalog cache status could not be read after refresh');
    const usages = Object.values(sourceUsage);
    const localHit = usages.length > 0 && usages.every((value) => value === 'local');
    return result({ status: status.data, cacheHit: localHit, sourceUsage, cards }, warnings);
  } catch (error) {
    options.logger?.warn?.('Catalog refresh failed; preserving existing cache', error);
    if (cached) {
      const status = await catalogStatus(projectRoot);
      if (status.data) {
        const sourceUsage = Object.fromEntries(cached.metadata.sources.map((source) => [source.language, source.usedFrom])) as Partial<Record<'korean' | 'english', 'local' | 'download'>>;
        return result({ status: status.data, cacheHit: true, sourceUsage, cards: cached.cards }, [problem('CATALOG_REFRESH_FAILED', String(error), undefined, 'warning')]);
      }
    }
    return failure([problem('CATALOG_REFRESH_FAILED', String(error))], 'COMMAND_FAILED');
  }
};

const searchPlainText = (card: CatalogCard): string => [
  card.id,
  card.ydkId,
  card.names.display,
  card.names.korean,
  card.names.english,
  card.texts.display,
  card.texts.korean,
  card.texts.english,
].filter((value) => value !== undefined).join(' ').toLocaleLowerCase();

interface CatalogSearchDocument {
  card: CatalogCard;
  text: string;
  tags: Set<string>;
}

const searchDocumentCache = new WeakMap<CatalogCard[], CatalogSearchDocument[]>();

const searchDocuments = (cards: CatalogCard[]): CatalogSearchDocument[] => {
  const remembered = searchDocumentCache.get(cards);
  if (remembered) return remembered;
  const documents = cards.map((card) => ({
    card,
    text: searchPlainText(card),
    tags: new Set(card.autoTags.map((tag) => tag.toLocaleLowerCase())),
  }));
  searchDocumentCache.set(cards, documents);
  return documents;
};

const customSearchProjection = (cards: MaterializedCustomCard[]) => new Map(cards.map((card) => {
  const tags = new Set<string>();
  Object.entries(card.facets).forEach(([field, value]) => {
    const values = Array.isArray(value) ? value : [value];
    values.forEach((entry) => {
      if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
        tags.add(`custom.${field}:${String(entry)}`.toLocaleLowerCase());
      }
    });
  });
  return [card.cardId, {
    text: card.searchTerms.join(' ').normalize('NFKC').toLocaleLowerCase(),
    tags,
  }] as const;
}));

export const searchCatalog = (
  cards: CatalogCard[],
  query: string,
  limit = 100,
  customCards: MaterializedCustomCard[] = [],
): CatalogSearchResult => {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const custom = customSearchProjection(customCards);
  const matches = searchDocuments(cards).filter(({ card, text, tags }) => {
    const customCard = custom.get(card.id);
    return terms.every((term) => {
      const colon = term.indexOf(':');
      if (colon >= 0) {
        const key = term.slice(0, colon);
        const value = term.slice(colon + 1);
        if (!value) return false;
        if (key === 'id') return String(card.id) === value;
        if (key === 'ydk') return String(card.ydkId) === value;
        return tags.has(term) || customCard?.tags.has(term) === true;
      }
      return text.includes(term) || customCard?.text.includes(term) === true;
    });
  });
  return { query, total: matches.length, cards: matches.slice(0, Math.max(1, limit)).map(({ card }) => card) };
};

export const catalogSearch = async (
  projectRoot: string,
  query: string,
  limit = 100,
  sourceRoot?: string,
): Promise<OperationResult<CatalogSearchResult>> => {
  const cached = await readCache(projectRoot);
  if (!cached) return failure([problem('CATALOG_CACHE_MISSING', 'Refresh the card catalog before searching')], 'COMMAND_FAILED');
  if (!(await customCardDatabaseExists(projectRoot, sourceRoot))) return result(searchCatalog(cached.cards, query, limit));
  const custom = await validateCustomCardDatabase(projectRoot, sourceRoot, new Set(cached.cards.map((card) => card.id)));
  if (!custom.ok || !custom.data) {
    const warnings = custom.problems.map((entry) => problem('CUSTOM_CARD_DATABASE_INVALID', `${entry.code}: ${entry.message}`, entry.path, 'warning'));
    return result(searchCatalog(cached.cards, query, limit), [...custom.warnings, ...warnings]);
  }
  return result(searchCatalog(cached.cards, query, limit, custom.data.materializedCards), custom.warnings);
};

export const catalogCardIds = async (projectRoot: string): Promise<OperationResult<number[]>> => {
  const cached = await readCache(projectRoot);
  if (!cached) return failure([problem('CATALOG_CACHE_MISSING', 'Refresh the card catalog before validating custom cards')], 'COMMAND_FAILED');
  return result(cached.cards.map((card) => card.id));
};

export const catalogCachePaths = (projectRoot: string) => ({
  cacheRoot: cacheRoot(projectRoot),
  catalogPath: catalogPath(projectRoot),
  metadataPath: metadataPath(projectRoot),
  sourcePaths: sourcePathMap(projectRoot),
});

export const catalogEnvironmentSources = defaultCatalogSourcesFromEnvironment;

export const catalogUsesRuntimeIdAuthority = (card: CatalogCard, runtimeIds: Set<number>): boolean => runtimeIds.has(card.id);

export const catalogCacheExists = async (projectRoot: string): Promise<boolean> => exists(catalogPath(projectRoot));
