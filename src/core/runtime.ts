import * as fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { atomicWriteJson, ensureDirectory, exists, pathInside, readJsonFile, removeExact } from './fs';
import { CoreLogger, OperationResult, RuntimeCacheEntry, RuntimeEnsureResult, RuntimeRelease, RuntimeStatus, failure, problem, result } from './types';

export const RUNTIME_REPOSITORY = 'pixeltris/YgoMaster';
export const RELEASE_API_URL = `https://api.github.com/repos/${RUNTIME_REPOSITORY}/releases/latest`;
export const REQUIRED_RUNTIME_FILES = [
  'YgoMaster.exe',
  'YgoMasterClient.exe',
  'YgoMasterLoader.dll',
  'Data/Solo.json',
];

const cacheDirectory = (projectRoot: string) => path.resolve(projectRoot, '.cache', 'ygomaster', 'releases');
const cacheMetadataPath = (directory: string) => path.join(directory, 'metadata.json');
const cacheRuntimePath = (directory: string) => path.join(directory, 'runtime');
const cacheArchivePath = (directory: string) => path.join(directory, 'archive.zip');

export const defaultRuntimeTransport = (): import('./types').RuntimeTransport => ({
  async getJson(url: string) {
    const response = await fetch(url, { headers: { 'User-Agent': 'ygomaster-modding-tool/0.13.0', Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`Runtime lookup failed: HTTP ${response.status}`);
    return response.json();
  },
  async getBytes(url: string) {
    const response = await fetch(url, { headers: { 'User-Agent': 'ygomaster-modding-tool/0.13.0', Accept: 'application/octet-stream' } });
    if (!response.ok) throw new Error(`Runtime download failed: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
});

export const resolveLatestRelease = async (transport = defaultRuntimeTransport()): Promise<RuntimeRelease> => {
  const value = (await transport.getJson(RELEASE_API_URL)) as { tag_name?: string; published_at?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
  const tag = typeof value.tag_name === 'string' ? value.tag_name.trim() : '';
  if (!tag) throw new Error('Latest release is missing tag_name');
  const expectedAssetName = `YgoMaster-${tag}.zip`;
  const assets = value.assets || [];
  const asset = assets.find((item) => item.name === expectedAssetName);
  if (!asset?.name || !asset.browser_download_url) throw new Error(`Latest release has no ${expectedAssetName} asset`);
  return {
    tag,
    assetName: asset.name,
    assetUrl: asset.browser_download_url,
    ...(value.published_at ? { publishedAt: value.published_at } : {}),
  };
};

const readUInt16 = (data: Uint8Array, offset: number) => data[offset] | (data[offset + 1] << 8);
const readUInt32 = (data: Uint8Array, offset: number) => (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;

/** Minimal ZIP reader for the official runtime archive (stored/deflate entries only). */
export const extractZip = async (data: Uint8Array, targetRoot: string): Promise<void> => {
  const minimum = Math.max(0, data.length - 65557);
  let eocd = -1;
  for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
    if (readUInt32(data, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record not found');
  const entries = readUInt16(data, eocd + 10);
  const centralOffset = readUInt32(data, eocd + 16);
  let cursor = centralOffset;
  await ensureDirectory(targetRoot);

  for (let index = 0; index < entries; index += 1) {
    if (readUInt32(data, cursor) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const method = readUInt16(data, cursor + 10);
    const compressedSize = readUInt32(data, cursor + 20);
    const uncompressedSize = readUInt32(data, cursor + 24);
    const nameLength = readUInt16(data, cursor + 28);
    const extraLength = readUInt16(data, cursor + 30);
    const commentLength = readUInt16(data, cursor + 32);
    const localOffset = readUInt32(data, cursor + 42);
    const name = Buffer.from(data.subarray(cursor + 46, cursor + 46 + nameLength)).toString('utf8').replaceAll('\\', '/');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!name || name.endsWith('/')) continue;
    const normalized = path.posix.normalize(name);
    if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) throw new Error(`ZIP path escapes extraction root: ${name}`);
    const outputPath = path.resolve(targetRoot, ...normalized.split('/'));
    if (!pathInside(targetRoot, outputPath)) throw new Error(`ZIP path escapes extraction root: ${name}`);
    if (readUInt32(data, localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local entry: ${name}`);
    const localNameLength = readUInt16(data, localOffset + 26);
    const localExtraLength = readUInt16(data, localOffset + 28);
    const compressed = data.subarray(localOffset + 30 + localNameLength + localExtraLength, localOffset + 30 + localNameLength + localExtraLength + compressedSize);
    let content: Uint8Array;
    if (method === 0) content = compressed;
    else if (method === 8) content = new Uint8Array(inflateRawSync(compressed));
    else throw new Error(`Unsupported ZIP compression method ${method}`);
    if (uncompressedSize !== 0xffffffff && content.byteLength !== uncompressedSize) throw new Error(`ZIP size mismatch: ${name}`);
    await ensureDirectory(path.dirname(outputPath));
    await fs.writeFile(outputPath, content);
  }
};

const hasRequiredFiles = async (runtimePath: string): Promise<boolean> => {
  for (const relative of REQUIRED_RUNTIME_FILES) if (!(await exists(path.resolve(runtimePath, ...relative.split('/'))))) return false;
  return true;
};

const readEntry = async (directory: string): Promise<RuntimeCacheEntry | undefined> => {
  try {
    const metadata = await readJsonFile<{ tag: string; assetName: string; assetUrl: string; downloadedAt?: string }>(cacheMetadataPath(directory));
    const runtimePath = cacheRuntimePath(directory);
    return {
      tag: metadata.tag,
      assetName: metadata.assetName,
      assetUrl: metadata.assetUrl,
      archivePath: cacheArchivePath(directory),
      runtimePath,
      valid: await hasRequiredFiles(runtimePath),
      ...(metadata.downloadedAt ? { downloadedAt: metadata.downloadedAt } : {}),
    };
  } catch {
    return undefined;
  }
};

export const runtimeStatus = async (projectRoot: string): Promise<OperationResult<RuntimeStatus>> => {
  try {
    const root = cacheDirectory(projectRoot);
    const names = (await exists(root)) ? await fs.readdir(root, { withFileTypes: true }) : [];
    const entries: RuntimeCacheEntry[] = [];
    for (const item of names.filter((entry) => entry.isDirectory())) {
      const entry = await readEntry(path.join(root, item.name));
      if (entry) entries.push(entry);
    }
    entries.sort((left, right) => left.tag.localeCompare(right.tag));
    return result({ cacheRoot: root, entries });
  } catch (error) {
    return failure([problem('RUNTIME_STATUS_FAILED', String(error))], 'PATH_ERROR');
  }
};

export const ensureRuntime = async (
  projectRoot: string,
  options: { transport?: import('./types').RuntimeTransport; logger?: CoreLogger } = {},
): Promise<{ value: RuntimeEnsureResult; warnings: import('./types').Problem[] }> => {
  const transport = options.transport || defaultRuntimeTransport();
  const root = cacheDirectory(projectRoot);
  await ensureDirectory(root);
  try {
    const release = await resolveLatestRelease(transport);
    const directory = path.join(root, release.tag.replace(/[^A-Za-z0-9._-]/g, '_'));
    const existing = await readEntry(directory);
    if (existing?.valid) return { value: { entry: existing, cacheHit: true }, warnings: [] };
    const temp = await fs.mkdtemp(path.join(root, '.download-'));
    try {
      const archive = await transport.getBytes(release.assetUrl);
      await fs.writeFile(path.join(temp, 'archive.zip'), archive);
      const extracted = path.join(temp, 'extract');
      await extractZip(archive, extracted);
      const topLevel = path.join(extracted, 'YgoMaster');
      const runtimePath = (await hasRequiredFiles(topLevel)) ? topLevel : extracted;
      if (!(await hasRequiredFiles(runtimePath))) throw new Error('Downloaded runtime is missing required YgoMaster files');
      await removeExact(directory);
      await ensureDirectory(directory);
      await fs.rename(path.join(temp, 'archive.zip'), cacheArchivePath(directory));
      await fs.rename(runtimePath, cacheRuntimePath(directory));
      const metadata = { tag: release.tag, assetName: release.assetName, assetUrl: release.assetUrl, downloadedAt: new Date().toISOString() };
      await atomicWriteJson(cacheMetadataPath(directory), metadata);
      const entry = await readEntry(directory);
      if (!entry?.valid) throw new Error('Cached runtime failed validation');
      return { value: { entry, cacheHit: false }, warnings: [] };
    } finally {
      await removeExact(temp);
    }
  } catch (error) {
    options.logger?.warn?.('Latest runtime lookup/download failed; trying cache fallback', error);
    const status = await runtimeStatus(projectRoot);
    const fallback = status.data?.entries.filter((entry) => entry.valid).sort((left, right) => (right.downloadedAt || '').localeCompare(left.downloadedAt || ''))[0];
    if (fallback) {
      return {
        value: { entry: fallback, cacheHit: true },
        warnings: [problem('LATEST_RELEASE_LOOKUP_FAILED', String(error), undefined, 'warning')],
      };
    }
    throw error;
  }
};

export const runtimeFetch = async (
  projectRoot: string,
  options: { transport?: import('./types').RuntimeTransport; logger?: CoreLogger } = {},
): Promise<OperationResult<RuntimeEnsureResult>> => {
  try {
    const ensured = await ensureRuntime(projectRoot, options);
    return result(ensured.value, ensured.warnings);
  } catch (error) {
    return failure([problem('RUNTIME_FETCH_FAILED', String(error))], 'COMMAND_FAILED');
  }
};
