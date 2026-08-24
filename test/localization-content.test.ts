import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  LocalizationContentError,
  createLocalizationCatalog,
  generateSoloLocalizationProjection,
  loadAssetManifest,
  loadLocalizationDirectory,
  normalizeLocalizationKey,
  parseLocalizationText,
  resolveLocalization,
  validateAssetManifest,
  validateAssetManifestFiles,
  validateLocalizationReferences,
} from '../src/core/localization-content';

const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/localization-content');

describe('localization source parsing and fallback', () => {
  it('normalizes stable keys and preserves Markdown text with LF/CRLF/solitary CR', () => {
    assert.equal(normalizeLocalizationKey(' Gate.Demo Title '), 'gate.demo-title');
    assert.throws(() => normalizeLocalizationKey('../outside'), LocalizationContentError);
    const parsed = parseLocalizationText('[demo.title]\r\nHello **world**\r[demo.empty]\r[demo.title]\r\nAgain\r', 'en', 'story.md');
    assert.equal(parsed.lines[0]?.lineEnding, '\r\n');
    assert.equal(parsed.lines[1]?.lineEnding, '\r');
    assert.equal(parsed.entries[0]?.value, 'Hello **world**');
    assert.equal(parsed.diagnostics.some((entry) => entry.code === 'LOCALIZATION_TEXT_BLANK'), true);
    assert.equal(parsed.diagnostics.some((entry) => entry.code === 'LOCALIZATION_KEY_DUPLICATE'), true);
    assert.equal(parsed.diagnostics.every((entry) => entry.sourcePath === 'story.md'), true);
    assert.equal(parsed.diagnostics.every((entry) => typeof entry.line === 'number'), true);
  });

  it('loads language files, resolves fallback, and diagnoses missing references', async () => {
    const catalog = await loadLocalizationDirectory(path.join(fixtureRoot, 'localization'), { fallbackLanguage: 'en' });
    assert.equal(catalog.languages.ko['gate.demo.name'], '데모 게이트');
    const fallback = resolveLocalization(catalog, { key: 'gate.demo.description', language: 'ko', sourcePath: 'gate.json', line: 4 });
    assert.equal(fallback.value, 'The **demo** gate has a deterministic story.');
    assert.equal(fallback.usedFallback, true);
    assert.equal(fallback.problems[0]?.code, 'LOCALIZATION_FALLBACK_USED');
    const missing = resolveLocalization(catalog, { key: 'gate.missing.name', language: 'ko', sourcePath: 'gate.json', line: 7 });
    assert.equal(missing.value, undefined);
    assert.equal(missing.problems[0]?.code, 'LOCALIZATION_REFERENCE_MISSING');
    assert.equal(validateLocalizationReferences(catalog, [
      { key: 'gate.demo.name', language: 'ko' },
      { key: 'gate.missing.name', language: 'ko' },
    ]).some((entry) => entry.code === 'LOCALIZATION_REFERENCE_MISSING'), true);
  });
});

describe('asset manifest safety and target capability', () => {
  it('accepts a minimal relative fixture and rejects path/metadata/collision hazards', async () => {
    const loaded = await loadAssetManifest(path.join(fixtureRoot, 'assets', 'asset-manifest.json'), {
      root: path.join(fixtureRoot, 'assets'),
    });
    assert.equal(loaded.problems.length, 0);
    assert.equal(loaded.manifest?.assets[0]?.target && typeof loaded.manifest.assets[0].target, 'object');
    const filesProblems = await validateAssetManifestFiles(loaded.manifest, { root: path.join(fixtureRoot, 'assets') });
    assert.deepEqual(filesProblems, []);

    const unsafe = {
      formatVersion: 1,
      assets: [
        { key: 'one', source: '../secret.txt', role: 'gate-card', provenance: '', license: '' },
        { key: 'two', source: 'missing.txt', role: 'gate-card', provenance: 'fixture', license: 'CC0', target: 'Data/x' },
        { key: 'three', source: 'gate-card.txt', role: 'gate-card', provenance: 'fixture', license: 'CC0', target: 'Data/x' },
        { key: 'background', source: 'gate-card.txt', role: 'background', provenance: 'fixture', license: 'CC0' },
        { key: 'credential', source: 'https://user:secret@example.invalid/a.png', role: 'gate-card', provenance: 'fixture', license: 'CC0' },
      ],
    };
    const codes = new Set(validateAssetManifest(unsafe).map((entry) => entry.code));
    assert.equal(codes.has('ASSET_PATH_INVALID'), true);
    assert.equal(codes.has('ASSET_PROVENANCE_MISSING'), true);
    assert.equal(codes.has('ASSET_LICENSE_MISSING'), true);
    assert.equal(codes.has('ASSET_TARGET_COLLISION'), true);
    assert.equal(codes.has('CLIENT_ASSET_UNSUPPORTED'), true);
    assert.equal(codes.has('ASSET_CREDENTIAL_URL_FORBIDDEN'), true);
    const missingCodes = new Set(await validateAssetManifestFiles(unsafe, { root: path.join(fixtureRoot, 'assets') }));
    assert.equal([...missingCodes].some((entry) => entry.code === 'ASSET_SOURCE_FILE_MISSING'), true);
  });

  it('requires explicit confirmation for unsupported background/general roles', () => {
    const background = {
      formatVersion: 1,
      assets: [{ key: 'bg', source: 'gate-card.txt', role: 'background', provenance: 'fixture', license: 'CC0' }],
    };
    assert.equal(validateAssetManifest(background).some((entry) => entry.code === 'CLIENT_ASSET_UNSUPPORTED'), true);
    assert.equal(validateAssetManifest(background, { confirmedRoles: ['background'] }).some((entry) => entry.code === 'CLIENT_ASSET_UNSUPPORTED'), false);
    assert.equal(validateAssetManifest({
      formatVersion: 1,
      assets: [{ key: 'general', source: 'gate-card.txt', role: 'general', confirmed: true, provenance: 'fixture', license: 'CC0' }],
    }).some((entry) => entry.code === 'CLIENT_ASSET_UNSUPPORTED'), false);
  });
});

describe('deterministic supported Solo projection', () => {
  it('generates only IDS_SOLO and SoloGateCards with fallback text', async () => {
    const catalog = await loadLocalizationDirectory(path.join(fixtureRoot, 'localization'), { fallbackLanguage: 'en' });
    const projection = generateSoloLocalizationProjection({
      language: 'ko',
      fallbackLanguage: 'en',
      gates: [{
        id: 90001,
        nameKey: 'gate.demo.name',
        descriptionKey: 'gate.demo.description',
        cardId: 4027,
        cardY: 1.03,
        cardX: 0,
        chapters: [{ id: 1, descriptionKey: 'chapter.demo.opening.description' }],
      }],
    }, catalog);
    const expectedIds = await readFile(path.join(fixtureRoot, 'expected', 'IDS_SOLO.txt'), 'utf8');
    const expectedCards = await readFile(path.join(fixtureRoot, 'expected', 'SoloGateCards.txt'), 'utf8');
    assert.equal(projection.files['Data/ClientData/IDS/IDS_SOLO.txt'], expectedIds);
    assert.equal(projection.files['Data/ClientData/SoloGateCards.txt'], expectedCards);
    assert.equal(projection.problems.filter((entry) => entry.severity !== 'warning').length, 0);
    assert.equal(projection.problems.filter((entry) => entry.code === 'LOCALIZATION_FALLBACK_USED').length, 2);
    assert.equal(Object.keys(projection.files).every((file) => file === 'Data/ClientData/IDS/IDS_SOLO.txt' || file === 'Data/ClientData/SoloGateCards.txt'), true);
    assert.equal(Object.values(projection.files).join('\n').includes(fixtureRoot), false);
  });

  it('keeps output ordering deterministic regardless of gate input order', async () => {
    const catalog = createLocalizationCatalog([
      { language: 'en', key: 'gate.a.name', value: 'A' },
      { language: 'en', key: 'gate.a.description', value: 'A desc' },
      { language: 'en', key: 'gate.b.name', value: 'B' },
      { language: 'en', key: 'gate.b.description', value: 'B desc' },
    ], { fallbackLanguage: 'en' });
    const make = (gates: Array<{ id: number; nameKey: string; descriptionKey: string; cardId: number }>) =>
      generateSoloLocalizationProjection({ gates }, catalog).files;
    assert.deepEqual(make([
      { id: 90002, nameKey: 'gate.b.name', descriptionKey: 'gate.b.description', cardId: 2 },
      { id: 90001, nameKey: 'gate.a.name', descriptionKey: 'gate.a.description', cardId: 1 },
    ]), make([
      { id: 90001, nameKey: 'gate.a.name', descriptionKey: 'gate.a.description', cardId: 1 },
      { id: 90002, nameKey: 'gate.b.name', descriptionKey: 'gate.b.description', cardId: 2 },
    ]));
  });
});
