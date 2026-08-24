import * as fs from 'node:fs/promises';
import path from 'node:path';

const smokePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export const createSmokeGateFixture = async (sourceRoot) => {
  await fs.mkdir(path.join(sourceRoot, 'deck'), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'gate'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'deck', 'cpu.json'), JSON.stringify({ m: { ids: [10001], r: [1] }, e: { ids: [], r: [] }, s: { ids: [], r: [] } }));
  await fs.writeFile(path.join(sourceRoot, 'gate', '90001.json'), JSON.stringify({ id: 90001, name: 'Release smoke', description: 'Release smoke', priority: 1, clear_chapter: { gateId: 90001, chapterId: 1 }, chapters: [{ id: 1, type: 'Duel', cpu_deck: 'cpu.json', cpu_name: 'CPU' }] }));
  const gateBackground = path.join(sourceRoot, 'overlay', 'ClientData', 'SoloGateBackgrounds', '90001.png');
  await fs.mkdir(path.dirname(gateBackground), { recursive: true });
  const smokePng = Buffer.from(smokePngBase64, 'base64');
  smokePng.writeUInt32BE(256, 16);
  smokePng.writeUInt32BE(256, 20);
  await fs.writeFile(gateBackground, smokePng);
  return { gateBackground };
};

export const preflightSmokeFixture = async (temporaryRoot) => {
  const sourceRoot = path.join(temporaryRoot, 'source');
  const { gateBackground } = await createSmokeGateFixture(sourceRoot);
  const png = await fs.readFile(gateBackground);
  if (png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256) throw new Error('Release smoke Gate background must be 256x256');
  const gate = JSON.parse(await fs.readFile(path.join(sourceRoot, 'gate', '90001.json'), 'utf8'));
  if (!gate.chapters?.length || !gate.clear_chapter) throw new Error('Release smoke Gate fixture is incomplete');
  return sourceRoot;
};
