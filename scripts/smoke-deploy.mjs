import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { deployCampaign, unwrapPayload } from '../dist-cli/core/index.js';

const projectRoot = process.cwd();
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ygomaster-deploy-smoke-'));
const sourceRoot = path.join(temp, 'source');
const gameRoot = path.join(temp, 'game');
try {
  await fs.mkdir(path.join(sourceRoot, 'gate'), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'deck'), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'structure'), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'target', 'ygomaster', 'Data', 'ClientData', 'SoloGateBackgrounds'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'manifest.json'), JSON.stringify({ formatVersion: 1, campaign: { name: 'Smoke', slug: 'smoke', version: '1' }, directories: { gate: 'gate', deck: 'deck', structure: 'structure', target: 'target/ygomaster' }, authoring: { language: 'Korean' }, idPolicy: { gatePrefix: 100, structurePrefix: 1129000 }, runtime: { repository: 'pixeltris/YgoMaster', channel: 'latest', autoDownload: true } }));
  await fs.writeFile(path.join(sourceRoot, 'deck', 'cpu.json'), JSON.stringify({ m: { ids: [10001], r: [1] }, e: { ids: [], r: [] }, s: { ids: [], r: [] } }));
  await fs.writeFile(path.join(sourceRoot, 'gate', '100.json'), JSON.stringify({ id: 100, name: 'Smoke', description: 'Smoke', priority: 1, clear_chapter: { gateId: 100, chapterId: 1 }, chapters: [{ id: 1, type: 'Duel', cpu_deck: 'cpu.json', cpu_name: 'CPU' }] }));
  await fs.writeFile(path.join(sourceRoot, 'target', 'ygomaster', 'Data', 'Shop.json'), JSON.stringify({ PackShop: {} }));
  await fs.writeFile(path.join(sourceRoot, 'target', 'ygomaster', 'Data', 'ShopPackOdds.json'), JSON.stringify({ entries: [] }));
  await fs.writeFile(path.join(sourceRoot, 'target', 'ygomaster', 'Data', 'ClientData', 'SoloGateBackgrounds', '100.png'), Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x08, 0x06, 0x00, 0x00, 0x00,
  ]));
  const result = await deployCampaign({
    projectRoot,
    sourceRoot,
    gameRoot,
    transport: {
      getJson: async () => ({ tag_name: 'v1.77', assets: [{ name: 'YgoMaster-v1.77.zip', browser_download_url: 'https://github.com/pixeltris/YgoMaster/releases/download/v1.77/YgoMaster-v1.77.zip' }] }),
      getBytes: async () => new Uint8Array(),
    },
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  const deploymentPath = result.data.path;
  const metadata = JSON.parse(await fs.readFile(path.join(deploymentPath, '.campaign-deployment.json'), 'utf8'));
  const soloDocument = JSON.parse(await fs.readFile(path.join(deploymentPath, 'Data', 'Solo.json'), 'utf8'));
  const solo = unwrapPayload(soloDocument, 'Master').payload;
  if (!solo.Solo?.gate?.['100']) throw new Error('Smoke gate missing from deployed Solo.json');
  console.log(JSON.stringify({ ok: true, cacheTag: metadata.resolvedRuntimeTag, deploymentPath, warnings: result.warnings }, null, 2));
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
