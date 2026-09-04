import path from 'node:path';
import * as fs from 'node:fs/promises';

import { assertRealPathInside, exists, listFiles, readJsonFile } from './fs';
import { getWorkspacePaths, loadManifest, validateManifest } from './manifest';
import { GATE_BACKGROUND_CODES, validateGateBackgroundPng } from './gate-background-assets';
import { isUnsupportedTargetFile, unsupportedChapterPackFields } from './materialize';
import {
  DocumentType,
  JsonObject,
  OperationResult,
  Problem,
  ValidationReport,
  failure,
  problem,
  result,
} from './types';

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const GATE_MIN = 100;
const GATE_MAX = 2101;
const STRUCTURE_MIN = 1129000;
const STRUCTURE_MAX = 1129999;
const LOCAL_CHAPTER_MIN = 1;
const LOCAL_CHAPTER_MAX = 9999;

const asObject = (value: unknown): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;

const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;

const sourceRelative = (sourceRoot: string, file: string) => path.relative(sourceRoot, file).split(path.sep).join('/');
const normalizedReference = (value: string) => value.replaceAll('\\', '/');
const isUnsafeReference = (value: string) => {
  const normalized = normalizedReference(value);
  return path.isAbsolute(value) || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..') || normalized.includes('\0');
};

const fileBasenames = (files: string[]) => {
  const map = new Map<string, string[]>();
  for (const file of files) {
    const base = path.basename(file);
    map.set(base, [...(map.get(base) || []), file]);
  }
  return map;
};

interface GateInfo {
  id: number;
  file: string;
  gate: JsonObject;
  chapters: Map<number, { file: string; chapter: JsonObject }>;
}

interface ChapterReferenceCheck {
  file: string;
  code: string;
  gateId: unknown;
  chapterId: unknown;
  sourceNode: string;
  edge?: { from: string; to: string };
}

const chapterLocalId = (gateId: number, value: unknown): number | undefined => {
  if (!integer(value)) return undefined;
  if (value >= LOCAL_CHAPTER_MIN && value <= LOCAL_CHAPTER_MAX) return value;
  const prefix = gateId * 10000;
  if (value >= prefix + LOCAL_CHAPTER_MIN && value <= prefix + LOCAL_CHAPTER_MAX) return value - prefix;
  return undefined;
};

const checkDeckReference = (
  reference: unknown,
  file: string,
  deckMap: Map<string, string>,
  decksByBasename: Map<string, string[]>,
  problems: Problem[],
  warnings: Problem[],
) => {
  if (reference === undefined || reference === null || reference === '') return;
  if (typeof reference !== 'string') {
    problems.push(problem('DECK_REFERENCE_INVALID', 'Deck reference must be a string', file));
    return;
  }
  if (isUnsafeReference(reference)) {
    problems.push(problem('DECK_REFERENCE_PATH_INVALID', `Deck reference must stay inside source: ${reference}`, file));
    return;
  }
  const normalized = normalizedReference(reference);
  if (deckMap.has(normalized)) return;
  const basenameMatches = decksByBasename.get(path.posix.basename(normalized)) || [];
  if (basenameMatches.length === 1) {
    warnings.push(problem('LEGACY_DECK_BASENAME', `Legacy basename-only deck reference: ${reference}`, file, 'warning'));
  } else {
    problems.push(problem('DECK_REFERENCE_MISSING', `Deck reference does not resolve uniquely: ${reference}`, file));
  }
};

const pushChapterReference = (
  reference: unknown,
  check: Omit<ChapterReferenceCheck, 'gateId' | 'chapterId'>,
  references: ChapterReferenceCheck[],
) => {
  const value = asObject(reference);
  if (!value) return;
  if (value.gateId !== undefined || value.chapterId !== undefined) {
    references.push({ ...check, gateId: value.gateId, chapterId: value.chapterId });
  }
};

const detectCycles = (edges: Array<{ from: string; to: string }>, problems: Problem[], file: string, code: string) => {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) adjacency.set(edge.from, [...(adjacency.get(edge.from) || []), edge.to]);
  const state = new Map<string, number>();
  const visit = (node: string): boolean => {
    if (state.get(node) === 1) return true;
    if (state.get(node) === 2) return false;
    state.set(node, 1);
    for (const child of adjacency.get(node) || []) if (visit(child)) return true;
    state.set(node, 2);
    return false;
  };
  for (const node of adjacency.keys()) {
    if (visit(node)) {
      problems.push(problem(code, 'Reference graph contains a cycle', file));
      return;
    }
  }
};

export const validateCampaign = async (
  projectRoot: string,
  sourceRootInput?: string,
): Promise<OperationResult<ValidationReport>> => {
  const warnings: Problem[] = [];
  const problems: Problem[] = [];
  const sourceRoot = path.resolve(sourceRootInput || path.join(projectRoot, 'campaign', 'source'));
  const manifestPath = path.join(sourceRoot, 'manifest.json');
  try {
    if (!(await exists(manifestPath))) return failure([problem('MANIFEST_MISSING', `Required manifest is missing: ${manifestPath}`, 'manifest.json')], 'PATH_ERROR');
    await assertRealPathInside(sourceRoot, manifestPath);
    const manifest = await loadManifest(sourceRoot);
    problems.push(...validateManifest(manifest));
    const paths = getWorkspacePaths(projectRoot, sourceRoot, manifest);
    await Promise.all([paths.gateRoot, paths.deckRoot, paths.structureRoot, paths.targetRoot].map((root) => assertRealPathInside(sourceRoot, root)));
    const [gateFiles, deckFiles, structureFiles, targetFiles] = await Promise.all([
      listFiles(paths.gateRoot, '.json'),
      listFiles(paths.deckRoot, '.json'),
      listFiles(paths.structureRoot, '.json'),
      listFiles(paths.targetRoot),
    ]);
    const deckMap = new Map(deckFiles.map((file) => [sourceRelative(paths.deckRoot, file), file]));
    const decksByBasename = fileBasenames(deckFiles);
    for (const [basename, files] of decksByBasename) {
      if (files.length > 1) warnings.push(problem('LEGACY_DECK_BASENAME_AMBIGUOUS', `Multiple deck files share basename ${basename}`, 'deck', 'warning'));
    }

    const gateMap = new Map<number, GateInfo>();
    const chapterMap = new Map<string, { gateId: number; localId: number; file: string; chapter: JsonObject }>();
    const chapterReferences: ChapterReferenceCheck[] = [];
    const parentEdges: Array<{ from: string; to: string }> = [];
    const unlockEdges: Array<{ from: string; to: string }> = [];
    const compositeChapterIds = new Set<number>();

    for (const file of gateFiles) {
      const relative = sourceRelative(sourceRoot, file);
      let gate: JsonObject;
      try {
        gate = asObject(await readJsonFile(file)) || {};
      } catch (error) {
        problems.push(problem('JSON_PARSE_FAILED', String(error), relative));
        continue;
      }
      const id = gate.id;
      if (!integer(id)) {
        problems.push(problem('GATE_ID_INVALID', 'Gate id must be an Int32 integer', relative));
        continue;
      }
      if (id < GATE_MIN || id > GATE_MAX) {
        problems.push(problem('GATE_ID_OUT_OF_RANGE', `Gate id must be between ${GATE_MIN} and ${GATE_MAX}`, relative));
        continue;
      }
      if (gateMap.has(id)) {
        problems.push(problem('GATE_ID_DUPLICATE', `Duplicate gate id ${id}`, relative));
        continue;
      }
      const info: GateInfo = { id, file, gate, chapters: new Map() };
      gateMap.set(id, info);
      if (gate.parent_id !== undefined && gate.parent_id !== 0) {
        if (!integer(gate.parent_id)) problems.push(problem('GATE_PARENT_INVALID', 'Gate parent_id must be an Int32 integer or 0', relative));
        else parentEdges.push({ from: `g:${id}`, to: `g:${gate.parent_id}` });
      }
      const chapters = gate.chapters;
      if (chapters !== undefined && !Array.isArray(chapters)) {
        problems.push(problem('CHAPTERS_INVALID', 'Gate chapters must be an array', relative));
      }
      for (const chapterValue of Array.isArray(chapters) ? chapters : []) {
        const chapter = asObject(chapterValue);
        if (!chapter || !integer(chapter.id)) {
          problems.push(problem('CHAPTER_ID_INVALID', 'Chapter id must be an Int32 integer', relative));
          continue;
        }
        const localId = chapter.id;
        if (localId < LOCAL_CHAPTER_MIN || localId > LOCAL_CHAPTER_MAX) {
          problems.push(problem('CHAPTER_ID_OUT_OF_RANGE', `Local chapter id must be between ${LOCAL_CHAPTER_MIN} and ${LOCAL_CHAPTER_MAX}`, relative));
          continue;
        }
        const composite = id * 10000 + localId;
        if (composite < INT32_MIN || composite > INT32_MAX) problems.push(problem('CHAPTER_COMPOSITE_OUT_OF_RANGE', `Composite chapter id is outside Int32: ${composite}`, relative));
        if (info.chapters.has(localId) || compositeChapterIds.has(composite)) {
          problems.push(problem('CHAPTER_ID_DUPLICATE', `Duplicate chapter id ${composite}`, relative));
          continue;
        }
        info.chapters.set(localId, { file, chapter });
        chapterMap.set(`c:${id}:${localId}`, { gateId: id, localId, file, chapter });
        compositeChapterIds.add(composite);
        if (chapter.parent_id !== undefined && chapter.parent_id !== 0) {
          if (!integer(chapter.parent_id)) problems.push(problem('CHAPTER_PARENT_INVALID', 'Chapter parent_id must be an Int32 integer or 0', relative));
          else {
            const parentLocal = chapterLocalId(id, chapter.parent_id);
            parentEdges.push({ from: `c:${id}:${localId}`, to: `c:${id}:${parentLocal ?? chapter.parent_id}` });
          }
        }
        checkDeckReference(chapter.cpu_deck, relative, deckMap, decksByBasename, problems, warnings);
        checkDeckReference(chapter.rental_deck, relative, deckMap, decksByBasename, problems, warnings);
        if ((chapter.type === 'Duel' || chapter.cpu_deck !== undefined) && typeof chapter.cpu_deck !== 'string') {
          problems.push(problem('DUEL_CPU_DECK_MISSING', 'Duel chapter requires cpu_deck', relative));
        }
        for (const field of unsupportedChapterPackFields) {
          if (chapter[field] !== undefined) warnings.push(problem(
            'UNSUPPORTED_PACK_FIELD',
            `${field} is not generated by the campaign Data materializer`,
            relative,
            'warning',
          ));
        }
        for (const unlock of Array.isArray(chapter.unlock) ? chapter.unlock : []) {
          pushChapterReference(unlock, { file: relative, code: 'CHAPTER_UNLOCK', sourceNode: `c:${id}:${localId}`, edge: { from: `c:${id}:${localId}`, to: '' } }, chapterReferences);
        }
        const clear = asObject(chapter.clear_chapter);
        if (clear) pushChapterReference(clear, { file: relative, code: 'CHAPTER_CLEAR_REFERENCE', sourceNode: `c:${id}:${localId}` }, chapterReferences);
      }
      for (const unlock of Array.isArray(gate.unlock) ? gate.unlock : []) {
        pushChapterReference(unlock, { file: relative, code: 'GATE_UNLOCK', sourceNode: `g:${id}`, edge: { from: `g:${id}`, to: '' } }, chapterReferences);
      }
      const clear = asObject(gate.clear_chapter);
      if (clear) pushChapterReference(clear, { file: relative, code: 'GATE_CLEAR_REFERENCE', sourceNode: `g:${id}` }, chapterReferences);
      else if (integer(gate.clear_chapter)) chapterReferences.push({ file: relative, code: 'GATE_CLEAR_REFERENCE', gateId: id, chapterId: gate.clear_chapter, sourceNode: `g:${id}` });
    }

    for (const [id, info] of gateMap) {
      const parent = info.gate.parent_id;
      if (parent !== undefined && parent !== 0 && integer(parent) && !gateMap.has(parent)) problems.push(problem('GATE_PARENT_ORPHAN', `Gate parent does not exist: ${parent}`, sourceRelative(sourceRoot, info.file)));
      for (const [localId, chapterInfo] of info.chapters) {
        const parentId = chapterInfo.chapter.parent_id;
        if (parentId !== undefined && parentId !== 0 && integer(parentId)) {
          const parentLocal = chapterLocalId(id, parentId);
          if (parentLocal === undefined || !info.chapters.has(parentLocal)) problems.push(problem('CHAPTER_PARENT_ORPHAN', `Chapter parent does not exist in gate ${id}: ${parentId}`, sourceRelative(sourceRoot, chapterInfo.file)));
        }
        void localId;
      }
    }
    detectCycles(parentEdges, problems, 'gate/chapter', 'REFERENCE_GRAPH_CYCLE');

    for (const reference of chapterReferences) {
      const sourceGateId = reference.sourceNode.startsWith('g:') ? Number(reference.sourceNode.slice(2)) : Number(reference.sourceNode.split(':')[1]);
      const targetGateId = reference.gateId === undefined ? sourceGateId : reference.gateId;
      if (!integer(targetGateId) || !gateMap.has(targetGateId)) {
        problems.push(problem(`${reference.code}_ORPHAN`, `Referenced gate does not exist: ${String(targetGateId)}`, reference.file));
        continue;
      }
      const targetLocalId = chapterLocalId(targetGateId, reference.chapterId);
      if (targetLocalId === undefined || !chapterMap.has(`c:${targetGateId}:${targetLocalId}`)) {
        problems.push(problem(`${reference.code}_ORPHAN`, `Referenced chapter does not exist: ${String(reference.chapterId)}`, reference.file));
        continue;
      }
      if (reference.edge) {
        reference.edge.to = `c:${targetGateId}:${targetLocalId}`;
        unlockEdges.push(reference.edge);
      }
    }
    detectCycles(unlockEdges, problems, 'gate/chapter unlock references', 'UNLOCK_GRAPH_CYCLE');

    const structureIds = new Set<number>();
    for (const file of structureFiles) {
      const relative = sourceRelative(sourceRoot, file);
      try {
        const structure = asObject(await readJsonFile(file));
        const id = structure?.id;
        if (!structure || !integer(id)) problems.push(problem('STRUCTURE_ID_INVALID', 'Structure id must be an Int32 integer', relative));
        else if (id < STRUCTURE_MIN || id > STRUCTURE_MAX) problems.push(problem('STRUCTURE_ID_OUT_OF_RANGE', `Structure id must be between ${STRUCTURE_MIN} and ${STRUCTURE_MAX}`, relative));
        else if (structureIds.has(id)) problems.push(problem('STRUCTURE_ID_DUPLICATE', `Duplicate structure id ${id}`, relative));
        else structureIds.add(id);
        if (structure && (typeof structure.deck !== 'string' || !structure.deck)) {
          problems.push(problem('STRUCTURE_DECK_MISSING', 'Structure deck requires a deck reference', relative));
        } else if (structure) {
          checkDeckReference(structure.deck, relative, deckMap, decksByBasename, problems, warnings);
        }
      } catch (error) {
        problems.push(problem('JSON_PARSE_FAILED', String(error), relative));
      }
    }

    for (const file of targetFiles) {
      const relative = path.relative(paths.targetRoot, file).split(path.sep).join('/');
      const lower = relative.toLowerCase();
      if (lower === 'data/settings.json' || lower === 'data/shop.policy.json' || lower === 'data/clientdata/clientsettings.json') {
        try {
          const managed = asObject(await readJsonFile(file));
          if (!managed || !asObject(managed.patch) || Object.keys(managed).some((key) => key !== 'patch')) {
            problems.push(problem('RUNTIME_POLICY_TARGET_INVALID', 'Runtime policy IR must contain only a patch object', relative));
          }
        } catch (error) {
          problems.push(problem('RUNTIME_POLICY_TARGET_INVALID', String(error), relative));
        }
        continue;
      }
      if (lower === 'data/shop.json' || lower === 'data/shoppackodds.json') {
        try {
          const managed = asObject(await readJsonFile(file));
          if (!managed) problems.push(problem('SHOP_TARGET_INVALID', 'Managed Shop target must be a JSON object', relative));
          else if (lower === 'data/shop.json' && (!asObject(managed.PackShop) || Object.keys(managed).some((key) => key !== 'PackShop'))) {
            problems.push(problem('SHOP_TARGET_INVALID', 'Shop.json IR must contain only PackShop', relative));
          } else if (lower === 'data/shoppackodds.json' && (!Array.isArray(managed.entries) || Object.keys(managed).some((key) => key !== 'entries'))) {
            problems.push(problem('SHOP_ODDS_TARGET_INVALID', 'ShopPackOdds.json IR must contain only entries', relative));
          }
        } catch (error) {
          problems.push(problem('SHOP_TARGET_INVALID', String(error), relative));
        }
        continue;
      }
      if (isUnsupportedTargetFile(relative) || !lower.startsWith('data/clientdata/sologatebackgrounds/')) {
        problems.push(problem('TARGET_FILE_UNSUPPORTED', 'File is outside the supported campaign-owned Data families', relative));
      }
    }

    for (const required of ['data/shop.json', 'data/shoppackodds.json']) {
      if (!targetFiles.some((file) => path.relative(paths.targetRoot, file).split(path.sep).join('/').toLowerCase() === required)) {
        problems.push(problem('OWNED_FAMILY_MISSING', `Required campaign target is missing: ${required}`, required));
      }
    }

    const targetByRelative = new Map(targetFiles.map((file) => [
      path.relative(paths.targetRoot, file).split(path.sep).join('/').toLowerCase(),
      file,
    ]));
    for (const gateId of [...gateMap.keys()].sort((left, right) => left - right)) {
      const relative = `Data/ClientData/SoloGateBackgrounds/${gateId}.png`;
      const file = targetByRelative.get(relative.toLowerCase());
      if (!file) {
        problems.push(problem(GATE_BACKGROUND_CODES.MISSING, `Custom Solo Gate ${gateId} requires ${relative}`, relative));
        continue;
      }
      problems.push(...validateGateBackgroundPng({ sourcePath: relative, bytes: new Uint8Array(await fs.readFile(file)) }));
    }

    const files = [...gateFiles, ...deckFiles, ...structureFiles, ...targetFiles].map((file) => sourceRelative(sourceRoot, file)).sort();
    const report: ValidationReport = {
      sourceRoot,
      files,
      errorCount: problems.filter((entry) => entry.severity !== 'warning').length,
      warningCount: warnings.length + problems.filter((entry) => entry.severity === 'warning').length,
    };
    const errors = problems.filter((entry) => entry.severity !== 'warning');
    if (errors.length) return failure(errors, 'COMMAND_FAILED', warnings);
    return result(report, [...warnings, ...problems.filter((entry) => entry.severity === 'warning')]);
  } catch (error) {
    return failure([problem('CAMPAIGN_VALIDATE_FAILED', String(error), sourceRoot)], 'PATH_ERROR', warnings);
  }
};

export const isDocumentType = (value: string): value is DocumentType =>
  value === 'gate' || value === 'deck' || value === 'structure';
