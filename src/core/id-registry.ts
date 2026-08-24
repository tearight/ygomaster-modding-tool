import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteJson, assertRealPathInside, ensureDirectory, exists, readJsonFile } from './fs';
import { YGOMASTER_TARGET_CONTRACT_VERSION } from './layers';
import { JsonObject, Problem, problem } from './types';

/**
 * Numeric IDs owned by the card catalog are intentionally absent from this
 * union.  This registry allocates campaign target IDs only.
 */
export type RegistryNamespace = 'gate' | 'chapter' | 'reward' | 'unlock' | 'structure' | 'shop';

export const ID_REGISTRY_SCHEMA_VERSION = 1 as const;
export const ID_REGISTRY_VERSION = 'ygomaster-id-registry/v1' as const;
export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;

export interface IdRange {
  min: number;
  max: number;
}

/**
 * Gate and structure ranges are the campaign ranges documented by the target
 * contract.  The other ranges are campaign-owned, disjoint reservations.
 * Shop IDs may be allocated here for authored intent, but Shop deployment is
 * still unsupported by the YgoMaster target contract.
 */
export const ID_NAMESPACE_RANGES: Readonly<Record<RegistryNamespace, IdRange>> = Object.freeze({
  gate: Object.freeze({ min: 90000, max: 90999 }),
  chapter: Object.freeze({ min: 900000001, max: 909999999 }),
  reward: Object.freeze({ min: 910000, max: 910999 }),
  unlock: Object.freeze({ min: 911000, max: 911999 }),
  structure: Object.freeze({ min: 1129000, max: 1129999 }),
  shop: Object.freeze({ min: 1130000, max: 1130999 }),
});

export const ID_REGISTRY_NAMESPACE_ORDER: readonly RegistryNamespace[] = Object.freeze([
  'gate',
  'chapter',
  'reward',
  'unlock',
  'structure',
  'shop',
]);

export const CHAPTER_LOCAL_RANGE: IdRange = Object.freeze({ min: 1, max: 9999 });

export interface RegistryAssignment {
  id: number;
  /** Chapter metadata is required for every persisted chapter assignment. */
  gateKey?: string;
  gateId?: number;
  localId?: number;
  /** Compatibility spelling accepted on input; localId is the canonical output. */
  localChapterId?: number;
  [key: string]: unknown;
}

export interface RegistryTombstone {
  id: number;
  retiredGeneration: string;
  retiredAt?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface RegistryNamespaceState {
  range: IdRange;
  assignments: Record<string, RegistryAssignment>;
  tombstones: Record<string, RegistryTombstone>;
  [key: string]: unknown;
}

export interface IdRegistry {
  schemaVersion: typeof ID_REGISTRY_SCHEMA_VERSION;
  registryVersion: typeof ID_REGISTRY_VERSION;
  targetContractVersion: typeof YGOMASTER_TARGET_CONTRACT_VERSION;
  generation: string;
  namespaces: Record<RegistryNamespace, RegistryNamespaceState>;
  [key: string]: unknown;
}

export interface AllocationRequest {
  namespace: RegistryNamespace;
  key: string;
  /** A full target ID. For chapters this is the composite ID. */
  pin?: number;
  /** Required for a new chapter unless `pin` supplies the composite. */
  gateKey?: string;
  /** Optional direct parent gate ID, useful for imported locks. */
  gateId?: number;
  /** Local chapter number, 1..9999. */
  localId?: number;
  /** Compatibility spelling for localId used by content authors. */
  localChapterId?: number;
}

export interface RegistryAllocationOptions {
  /** IDs already present in the user-managed runtime, by namespace. */
  runtimeOccupied?: Partial<Record<RegistryNamespace, Iterable<number>>>;
  /** Narrow test ranges only; never persisted into the registry. */
  rangeOverrides?: Partial<Record<RegistryNamespace, IdRange>>;
}

export type RegistryDiffAction = 'add' | 'remove' | 'update' | 'retire';

export interface RegistryDiff {
  namespace: RegistryNamespace;
  key: string;
  action: RegistryDiffAction;
  before?: number;
  after?: number;
  metadataChanged?: boolean;
}

export interface RegistryPlan {
  dryRun: true;
  baseGeneration: string;
  generation: string;
  registry: IdRegistry;
  diff: RegistryDiff[];
}

export interface RegistryApplyResult {
  path: string;
  generation: string;
  registry: IdRegistry;
  diff: RegistryDiff[];
}

export interface RegistryMigrationEndpoint {
  namespace: RegistryNamespace;
  key: string;
  gateKey?: string;
  gateId?: number;
  localId?: number;
  localChapterId?: number;
  pin?: number;
}

export interface RegistryMigration {
  kind: 'rename' | 'move';
  from: RegistryMigrationEndpoint;
  to: RegistryMigrationEndpoint;
  reason?: string;
  /** A gate move may carry the explicit chapter migrations required to keep its graph closed. */
  dependentMigrations?: readonly RegistryMigration[];
}

export interface RegistryMigrationBatch {
  migrations: readonly RegistryMigration[];
}

export class IdRegistryError extends Error {
  readonly code: string;
  readonly problems: Problem[];

  constructor(code: string, message: string, sourcePath?: string, problems?: Problem[]) {
    super(message);
    this.name = 'IdRegistryError';
    this.code = code;
    this.problems = problems || [problem(code, message, sourcePath)];
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
};

const stableStringify = (value: unknown): string => JSON.stringify(stableValue(value));

const asInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

const namespaceOf = (value: unknown): RegistryNamespace => {
  if (value === 'card') throw new IdRegistryError('ID_REGISTRY_CARD_UNSUPPORTED', 'Card runtime IDs belong to the card catalog, not this registry');
  if (typeof value !== 'string' || !(ID_REGISTRY_NAMESPACE_ORDER as readonly string[]).includes(value)) {
    throw new IdRegistryError('ID_REGISTRY_NAMESPACE_INVALID', `Unsupported registry namespace: ${String(value)}`);
  }
  return value as RegistryNamespace;
};

const validKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value === value.trim() && !value.includes('\0') && value.length <= 256;

const chapterLocalValue = (value: { localId?: unknown; localChapterId?: unknown }): number | undefined => {
  if (value.localId !== undefined && value.localChapterId !== undefined && value.localId !== value.localChapterId) {
    throw new IdRegistryError('ID_REGISTRY_CHAPTER_RULE_INVALID', 'localId and localChapterId disagree');
  }
  const localId = value.localId ?? value.localChapterId;
  return localId === undefined ? undefined : (asInteger(localId) ? localId : Number.NaN);
};

const rangeValid = (range: unknown): range is IdRange =>
  isObject(range) && asInteger(range.min) && asInteger(range.max) && range.min >= INT32_MIN && range.max <= INT32_MAX && range.min <= range.max;

const rangeFor = (
  registry: IdRegistry,
  namespace: RegistryNamespace,
  options: RegistryAllocationOptions,
): IdRange => options.rangeOverrides?.[namespace] || registry.namespaces[namespace].range;

const idInRange = (id: number, range: IdRange): boolean => asInteger(id) && id >= range.min && id <= range.max;

const tombstoneId = (state: RegistryNamespaceState, id: number): string | undefined =>
  Object.entries(state.tombstones).find(([, tombstone]) => tombstone.id === id)?.[0];

const assignmentId = (state: RegistryNamespaceState, id: number): string | undefined =>
  Object.entries(state.assignments).find(([, assignment]) => assignment.id === id)?.[0];

const dependentChapterKeys = (registry: IdRegistry, gateKey: string, gateId: number): string[] =>
  Object.entries(registry.namespaces.chapter.assignments)
    .filter(([, assignment]) => {
      if (assignment.gateKey === gateKey || assignment.gateId === gateId) return true;
      try {
        return chapterParts(assignment.id).gateId === gateId;
      } catch {
        return false;
      }
    })
    .map(([key]) => key)
    .sort();

const runtimeSet = (options: RegistryAllocationOptions, namespace: RegistryNamespace): Set<number> =>
  new Set(options.runtimeOccupied?.[namespace] ? [...options.runtimeOccupied[namespace]!] : []);

const errorFromProblems = (problems: Problem[], fallbackCode: string): IdRegistryError => {
  const first = problems[0];
  return new IdRegistryError(first?.code || fallbackCode, first?.message || fallbackCode, first?.path, problems);
};

const namespaceState = (namespace: RegistryNamespace, range = ID_NAMESPACE_RANGES[namespace]): RegistryNamespaceState => ({
  range: { ...range },
  assignments: {},
  tombstones: {},
});

const canonicalRegistryWithoutGeneration = (registry: IdRegistry | Record<string, unknown>): Record<string, unknown> => {
  const copy = clone(registry) as Record<string, unknown>;
  copy.generation = '';
  return copy;
};

export const computeRegistryGeneration = (registry: IdRegistry | Record<string, unknown>): string => {
  const digest = createHash('sha256').update(stableStringify(canonicalRegistryWithoutGeneration(registry))).digest('hex');
  return `${ID_REGISTRY_VERSION}-${digest.slice(0, 24)}`;
};

export const createEmptyRegistry = (): IdRegistry => {
  const namespaces = {} as Record<RegistryNamespace, RegistryNamespaceState>;
  for (const namespace of ID_REGISTRY_NAMESPACE_ORDER) namespaces[namespace] = namespaceState(namespace);
  const registry = {
    schemaVersion: ID_REGISTRY_SCHEMA_VERSION,
    registryVersion: ID_REGISTRY_VERSION,
    targetContractVersion: YGOMASTER_TARGET_CONTRACT_VERSION,
    generation: '',
    namespaces,
  } as IdRegistry;
  registry.generation = computeRegistryGeneration(registry);
  return registry;
};

export const validateRegistry = (value: unknown): Problem[] => {
  const problems: Problem[] = [];
  if (!isObject(value)) return [problem('ID_REGISTRY_INVALID', 'ID registry must be an object')];
  if (value.schemaVersion !== ID_REGISTRY_SCHEMA_VERSION) problems.push(problem('ID_REGISTRY_SCHEMA_INVALID', `schemaVersion must be ${ID_REGISTRY_SCHEMA_VERSION}`, 'schemaVersion'));
  if (value.registryVersion !== ID_REGISTRY_VERSION) problems.push(problem('ID_REGISTRY_VERSION_INVALID', `registryVersion must be ${ID_REGISTRY_VERSION}`, 'registryVersion'));
  if (value.targetContractVersion !== YGOMASTER_TARGET_CONTRACT_VERSION) problems.push(problem('ID_REGISTRY_TARGET_VERSION_INVALID', `targetContractVersion must be ${YGOMASTER_TARGET_CONTRACT_VERSION}`, 'targetContractVersion'));
  if (!validKey(value.generation)) problems.push(problem('ID_REGISTRY_GENERATION_INVALID', 'generation must be a non-empty string', 'generation'));
  if (!isObject(value.namespaces)) return [...problems, problem('ID_REGISTRY_NAMESPACES_INVALID', 'namespaces must be an object', 'namespaces')];
  if (value.namespaces.card !== undefined) problems.push(problem('ID_REGISTRY_CARD_UNSUPPORTED', 'Card runtime IDs must be owned by the card catalog, not this registry', 'namespaces.card'));

  for (const namespace of ID_REGISTRY_NAMESPACE_ORDER) {
    const state = value.namespaces[namespace];
    if (!isObject(state)) {
      problems.push(problem('ID_REGISTRY_NAMESPACE_STATE_INVALID', `Missing namespace state: ${namespace}`, `namespaces.${namespace}`));
      continue;
    }
    if (!rangeValid(state.range)) problems.push(problem('ID_REGISTRY_RANGE_INVALID', `Invalid range for namespace ${namespace}`, `namespaces.${namespace}.range`));
    else if (state.range.min !== ID_NAMESPACE_RANGES[namespace].min || state.range.max !== ID_NAMESPACE_RANGES[namespace].max) problems.push(problem('ID_REGISTRY_RANGE_INVALID', `Persisted range for ${namespace} must match the campaign namespace contract`, `namespaces.${namespace}.range`));
    if (!isObject(state.assignments)) problems.push(problem('ID_REGISTRY_ASSIGNMENTS_INVALID', `assignments must be an object for ${namespace}`, `namespaces.${namespace}.assignments`));
    if (!isObject(state.tombstones)) problems.push(problem('ID_REGISTRY_TOMBSTONES_INVALID', `tombstones must be an object for ${namespace}`, `namespaces.${namespace}.tombstones`));
    if (isObject(state.assignments) && isObject(state.tombstones)) {
      for (const key of Object.keys(state.assignments)) {
        if (Object.prototype.hasOwnProperty.call(state.tombstones, key)) problems.push(problem('ID_REGISTRY_TOMBSTONE_REUSE', `${namespace}:${key} cannot be both assigned and tombstoned`, `namespaces.${namespace}.${key}`));
      }
    }
    const seen = new Map<number, string>();
    if (isObject(state.assignments)) {
      for (const [key, entry] of Object.entries(state.assignments)) {
        if (!validKey(key)) problems.push(problem('ID_REGISTRY_KEY_INVALID', `Invalid assignment key: ${key}`, `namespaces.${namespace}.assignments.${key}`));
        if (!isObject(entry) || !asInteger(entry.id)) {
          problems.push(problem('ID_REGISTRY_ASSIGNMENT_INVALID', `Assignment ${key} must contain an integer id`, `namespaces.${namespace}.assignments.${key}`));
          continue;
        }
        if (!idInRange(entry.id, ID_NAMESPACE_RANGES[namespace])) problems.push(problem('ID_REGISTRY_PIN_INVALID', `Assignment ${key} is outside the ${namespace} range`, `namespaces.${namespace}.assignments.${key}.id`));
        const previous = seen.get(entry.id);
        if (previous) problems.push(problem('ID_REGISTRY_COLLISION', `${namespace} id ${entry.id} is assigned to both ${previous} and ${key}`, `namespaces.${namespace}`));
        else seen.set(entry.id, key);
        if (namespace === 'chapter') {
          const metadataPath = `namespaces.chapter.assignments.${key}`;
          let localId: number | undefined;
          try {
            localId = chapterLocalValue(entry);
          } catch (error) {
            problems.push(problem('ID_REGISTRY_CHAPTER_RULE_INVALID', error instanceof IdRegistryError ? error.message : String(error), metadataPath));
          }
          const gateKey = entry.gateKey;
          const gateId = entry.gateId;
          if (localId === undefined || !asInteger(localId) || localId < CHAPTER_LOCAL_RANGE.min || localId > CHAPTER_LOCAL_RANGE.max) {
            problems.push(problem('ID_REGISTRY_CHAPTER_RULE_INVALID', `Chapter ${key} requires localId/localChapterId metadata in ${CHAPTER_LOCAL_RANGE.min}..${CHAPTER_LOCAL_RANGE.max}`, metadataPath));
          }
          if (gateKey === undefined && gateId === undefined) {
            problems.push(problem('ID_REGISTRY_CHAPTER_GATE_MISSING', `Chapter ${key} requires gateKey or gateId metadata`, metadataPath));
          } else if (gateKey !== undefined && !validKey(gateKey)) {
            problems.push(problem('ID_REGISTRY_KEY_INVALID', `Invalid gate key for chapter ${key}`, metadataPath));
          }
          if (gateId !== undefined && (!asInteger(gateId) || !idInRange(gateId, ID_NAMESPACE_RANGES.gate))) {
            problems.push(problem('ID_REGISTRY_CHAPTER_RULE_INVALID', `Invalid gateId metadata for chapter ${key}`, metadataPath));
          }
          try {
            const parts = chapterParts(entry.id);
            if (asInteger(localId) && parts.localId !== localId) {
              problems.push(problem('ID_REGISTRY_CHAPTER_RULE_INVALID', `Chapter ${key} local metadata does not match its composite id`, metadataPath));
            }
            if (asInteger(gateId) && parts.gateId !== gateId) {
              problems.push(problem('ID_REGISTRY_CHAPTER_RULE_INVALID', `Chapter ${key} gateId metadata does not match its composite id`, metadataPath));
            }
            if (validKey(gateKey)) {
              const gateState = value.namespaces.gate;
              const gateAssignment = isObject(gateState) && isObject(gateState.assignments)
                ? gateState.assignments[gateKey]
                : undefined;
              if (!isObject(gateAssignment) || !asInteger(gateAssignment.id)) {
                problems.push(problem('ID_REGISTRY_CHAPTER_GATE_MISSING', `Chapter ${key} gateKey does not resolve: ${gateKey}`, metadataPath));
              } else if (gateAssignment.id !== parts.gateId) {
                problems.push(problem('ID_REGISTRY_CHAPTER_RULE_INVALID', `Chapter ${key} gateKey does not match its composite id`, metadataPath));
              }
            }
          } catch (error) {
            problems.push(problem('ID_REGISTRY_CHAPTER_RULE_INVALID', error instanceof IdRegistryError ? error.message : String(error), metadataPath));
          }
        }
      }
    }
    if (isObject(state.tombstones)) {
      for (const [key, tombstone] of Object.entries(state.tombstones)) {
        if (!validKey(key)) problems.push(problem('ID_REGISTRY_KEY_INVALID', `Invalid tombstone key: ${key}`, `namespaces.${namespace}.tombstones.${key}`));
        if (!isObject(tombstone) || !asInteger(tombstone.id) || !validKey(tombstone.retiredGeneration)) {
          problems.push(problem('ID_REGISTRY_TOMBSTONE_INVALID', `Tombstone ${key} is malformed`, `namespaces.${namespace}.tombstones.${key}`));
          continue;
        }
        if (!idInRange(tombstone.id, ID_NAMESPACE_RANGES[namespace])) problems.push(problem('ID_REGISTRY_PIN_INVALID', `Tombstone ${key} is outside the ${namespace} range`, `namespaces.${namespace}.tombstones.${key}.id`));
        const previous = seen.get(tombstone.id);
        if (previous) problems.push(problem('ID_REGISTRY_COLLISION', `${namespace} id ${tombstone.id} is assigned/tombstoned more than once`, `namespaces.${namespace}`));
        else seen.set(tombstone.id, `tombstone:${key}`);
      }
    }
  }
  if (validKey(value.generation) && problems.every((entry) => entry.code !== 'ID_REGISTRY_NAMESPACES_INVALID')) {
    const expected = computeRegistryGeneration(value as unknown as IdRegistry);
    if (value.generation !== expected) problems.push(problem('ID_REGISTRY_GENERATION_INVALID', 'generation does not match registry content', 'generation'));
  }
  return problems;
};

export const parseRegistry = (value: unknown): IdRegistry => {
  const problems = validateRegistry(value);
  if (problems.length) throw errorFromProblems(problems, 'ID_REGISTRY_INVALID');
  return clone(value as IdRegistry);
};

const ensureRangeOverride = (range: IdRange | undefined, namespace: RegistryNamespace): void => {
  if (range === undefined) return;
  if (!rangeValid(range) || !idInRange(range.min, ID_NAMESPACE_RANGES[namespace]) || !idInRange(range.max, ID_NAMESPACE_RANGES[namespace])) {
    throw new IdRegistryError('ID_REGISTRY_RANGE_INVALID', `Invalid range override for ${namespace}`);
  }
};

const validateRequest = (request: AllocationRequest): void => {
  namespaceOf(request.namespace);
  if (!validKey(request.key)) throw new IdRegistryError('ID_REGISTRY_KEY_INVALID', `Invalid symbolic ID key: ${request.key}`);
  if (request.pin !== undefined && !asInteger(request.pin)) throw new IdRegistryError('ID_REGISTRY_PIN_INVALID', `Pin for ${request.namespace}:${request.key} must be an integer`);
  if (request.gateKey !== undefined && !validKey(request.gateKey)) throw new IdRegistryError('ID_REGISTRY_KEY_INVALID', `Invalid gate key for ${request.namespace}:${request.key}`);
  if (request.gateId !== undefined && !asInteger(request.gateId)) throw new IdRegistryError('ID_REGISTRY_PIN_INVALID', `gateId for ${request.namespace}:${request.key} must be an integer`);
  let localId: number | undefined;
  try {
    localId = chapterLocalValue(request);
  } catch (error) {
    throw new IdRegistryError('ID_REGISTRY_CHAPTER_RULE_INVALID', error instanceof IdRegistryError ? error.message : String(error));
  }
  if (localId !== undefined && (!asInteger(localId) || localId < CHAPTER_LOCAL_RANGE.min || localId > CHAPTER_LOCAL_RANGE.max)) throw new IdRegistryError('ID_REGISTRY_PIN_INVALID', `localId/localChapterId for ${request.namespace}:${request.key} must be between ${CHAPTER_LOCAL_RANGE.min} and ${CHAPTER_LOCAL_RANGE.max}`);
  if (request.namespace !== 'chapter' && (request.gateKey !== undefined || request.gateId !== undefined || request.localId !== undefined || request.localChapterId !== undefined)) throw new IdRegistryError('ID_REGISTRY_CHAPTER_RULE_INVALID', `Chapter metadata is only valid in the chapter namespace: ${request.namespace}:${request.key}`);
};

const requestSignature = (request: AllocationRequest): string => stableStringify(request);

const normalizeRequests = (requests: readonly AllocationRequest[]): AllocationRequest[] => {
  const seen = new Map<string, string>();
  for (const request of requests) {
    validateRequest(request);
    const identity = `${request.namespace}\u0000${request.key}`;
    const signature = requestSignature(request);
    const previous = seen.get(identity);
    if (previous !== undefined && previous !== signature) throw new IdRegistryError('ID_REGISTRY_COLLISION', `Conflicting requests for ${request.namespace}:${request.key}`);
    seen.set(identity, signature);
  }
  return [...requests]
    .filter((request, index, source) => source.findIndex((entry) => entry.namespace === request.namespace && entry.key === request.key) === index)
    .sort((left, right) => {
      const namespaceOrder = ID_REGISTRY_NAMESPACE_ORDER.indexOf(left.namespace) - ID_REGISTRY_NAMESPACE_ORDER.indexOf(right.namespace);
      return namespaceOrder || left.key.localeCompare(right.key);
    });
};

const assertAvailable = (
  state: RegistryNamespaceState,
  namespace: RegistryNamespace,
  id: number,
  range: IdRange,
  runtime: Set<number>,
): void => {
  if (!idInRange(id, range)) throw new IdRegistryError('ID_REGISTRY_PIN_INVALID', `${namespace} id ${id} is outside the allowed range`);
  const existing = assignmentId(state, id);
  if (existing) throw new IdRegistryError('ID_REGISTRY_COLLISION', `${namespace} id ${id} is already assigned to ${existing}`);
  const retired = tombstoneId(state, id);
  if (retired) throw new IdRegistryError('ID_REGISTRY_TOMBSTONE_REUSE', `${namespace} id ${id} is tombstoned by ${retired}`);
  if (runtime.has(id)) throw new IdRegistryError('ID_REGISTRY_RUNTIME_COLLISION', `${namespace} id ${id} already exists in the target runtime`);
};

const nextAvailable = (
  state: RegistryNamespaceState,
  namespace: RegistryNamespace,
  range: IdRange,
  runtime: Set<number>,
): number => {
  for (let candidate = range.min; candidate <= range.max; candidate += 1) {
    if (!assignmentId(state, candidate) && !tombstoneId(state, candidate) && !runtime.has(candidate)) return candidate;
  }
  throw new IdRegistryError('ID_REGISTRY_EXHAUSTED', `No free IDs remain in the ${namespace} namespace`);
};

export const compositeChapterId = (gateId: number, localId: number): number => {
  if (!asInteger(gateId) || !asInteger(localId) || localId < CHAPTER_LOCAL_RANGE.min || localId > CHAPTER_LOCAL_RANGE.max) throw new IdRegistryError('ID_REGISTRY_PIN_INVALID', `Invalid chapter composite inputs: ${gateId}, ${localId}`);
  const result = gateId * 10000 + localId;
  if (!Number.isSafeInteger(result) || result < INT32_MIN || result > INT32_MAX) throw new IdRegistryError('ID_REGISTRY_INT32_OVERFLOW', `Chapter composite ID exceeds Int32: ${result}`);
  if (!idInRange(gateId, ID_NAMESPACE_RANGES.gate)) throw new IdRegistryError('ID_REGISTRY_PIN_INVALID', `Gate ${gateId} is outside the allowed gate range`);
  return result;
};

export const chapterParts = (chapterId: number): { gateId: number; localId: number } => {
  if (!asInteger(chapterId) || chapterId < 0) throw new IdRegistryError('ID_REGISTRY_PIN_INVALID', `Invalid chapter ID: ${chapterId}`);
  const gateId = Math.floor(chapterId / 10000);
  const localId = chapterId - gateId * 10000;
  if (localId < CHAPTER_LOCAL_RANGE.min || localId > CHAPTER_LOCAL_RANGE.max) throw new IdRegistryError('ID_REGISTRY_CHAPTER_RULE_INVALID', `Chapter ID does not follow gate composite rules: ${chapterId}`);
  if (!idInRange(gateId, ID_NAMESPACE_RANGES.gate)) throw new IdRegistryError('ID_REGISTRY_CHAPTER_RULE_INVALID', `Chapter gate is outside the allowed range: ${chapterId}`);
  return { gateId, localId };
};

const resolveGateId = (
  registry: IdRegistry,
  request: AllocationRequest,
  existing: RegistryAssignment | undefined,
  options: RegistryAllocationOptions,
): number => {
  const gateState = registry.namespaces.gate;
  const range = rangeFor(registry, 'gate', options);
  const pinnedParts = request.pin === undefined ? undefined : chapterParts(request.pin);
  const fromKey = request.gateKey || existing?.gateKey;
  const fromKeyId = fromKey ? gateState.assignments[fromKey]?.id : undefined;
  const existingGateId = existing?.gateId ?? (existing ? chapterParts(existing.id).gateId : undefined);
  const gateId = request.gateId ?? fromKeyId ?? existingGateId ?? pinnedParts?.gateId;
  if (gateId === undefined) throw new IdRegistryError('ID_REGISTRY_CHAPTER_GATE_MISSING', `Chapter ${request.key} requires a gateKey or gateId`);
  if (!idInRange(gateId, range)) throw new IdRegistryError('ID_REGISTRY_PIN_INVALID', `Gate ${gateId} is outside the allowed gate range`);
  if (fromKey && fromKeyId === undefined) throw new IdRegistryError('ID_REGISTRY_CHAPTER_GATE_MISSING', `Gate key does not resolve: ${fromKey}`);
  if (fromKeyId !== undefined && request.gateId !== undefined && fromKeyId !== request.gateId) throw new IdRegistryError('ID_REGISTRY_COLLISION', `gateKey and gateId disagree for chapter ${request.key}`);
  if (pinnedParts && pinnedParts.gateId !== gateId) throw new IdRegistryError('ID_REGISTRY_PIN_INVALID', `Chapter pin does not match gate metadata: ${request.key}`);
  return gateId;
};

const addAssignment = (state: RegistryNamespaceState, key: string, entry: RegistryAssignment): void => {
  state.assignments[key] = entry;
};

const allocateOne = (
  registry: IdRegistry,
  request: AllocationRequest,
  options: RegistryAllocationOptions,
): void => {
  const namespace = namespaceOf(request.namespace);
  const state = registry.namespaces[namespace];
  const range = rangeFor(registry, namespace, options);
  const runtime = runtimeSet(options, namespace);
  const existing = state.assignments[request.key];
  if (existing) {
    if (request.pin !== undefined && request.pin !== existing.id) throw new IdRegistryError('ID_REGISTRY_PIN_INVALID', `Pinned ID for existing assignment ${namespace}:${request.key} would renumber ${existing.id}`);
    if (runtime.has(existing.id)) throw new IdRegistryError('ID_REGISTRY_RUNTIME_COLLISION', `${namespace} id ${existing.id} already exists in the target runtime`);
    if (namespace === 'chapter') {
      const gateId = resolveGateId(registry, request, existing, options);
      const localId = request.localId ?? existing.localId ?? chapterParts(existing.id).localId;
      if (request.localId !== undefined && existing.id !== compositeChapterId(gateId, localId)) throw new IdRegistryError('ID_REGISTRY_ASSIGNMENT_METADATA_CONFLICT', `Chapter metadata would change the existing ID for ${request.key}`);
      if (request.gateKey !== undefined && existing.gateKey !== undefined && request.gateKey !== existing.gateKey) throw new IdRegistryError('ID_REGISTRY_ASSIGNMENT_METADATA_CONFLICT', `Chapter gate move requires the migration primitive: ${request.key}`);
    }
    return;
  }
  if (state.tombstones[request.key]) throw new IdRegistryError('ID_REGISTRY_TOMBSTONE_REUSE', `${namespace}:${request.key} is a retired symbolic key`);

  let id: number;
  if (request.pin !== undefined) {
    id = request.pin;
    assertAvailable(state, namespace, id, range, runtime);
  } else {
    id = nextAvailable(state, namespace, range, runtime);
  }
  const entry: RegistryAssignment = { id };
  addAssignment(state, request.key, entry);
};

const allocateChapter = (
  registry: IdRegistry,
  request: AllocationRequest,
  options: RegistryAllocationOptions,
): void => {
  const state = registry.namespaces.chapter;
  const range = rangeFor(registry, 'chapter', options);
  const runtime = runtimeSet(options, 'chapter');
  const existing = state.assignments[request.key];
  const pinnedParts = request.pin === undefined ? undefined : chapterParts(request.pin);
  const gateId = resolveGateId(registry, request, existing, options);
  const gateKey = request.gateKey || existing?.gateKey;
  const requestedLocalId = chapterLocalValue(request);
  const existingLocalId = existing ? chapterLocalValue(existing) : undefined;
  let localId = requestedLocalId ?? existingLocalId ?? pinnedParts?.localId;
  if (request.pin !== undefined) {
    if (!asInteger(request.pin)) throw new IdRegistryError('ID_REGISTRY_PIN_INVALID', `Chapter pin must be an integer: ${request.key}`);
    if (!pinnedParts || pinnedParts.gateId !== gateId || (localId !== undefined && pinnedParts.localId !== localId)) throw new IdRegistryError('ID_REGISTRY_PIN_INVALID', `Chapter pin does not match gate/local metadata: ${request.key}`);
    localId = pinnedParts.localId;
  }
  if (existing) {
    if (request.pin !== undefined && request.pin !== existing.id) throw new IdRegistryError('ID_REGISTRY_PIN_INVALID', `Pinned ID for existing chapter ${request.key} would renumber ${existing.id}`);
    if (existing.id !== compositeChapterId(gateId, localId ?? chapterParts(existing.id).localId)) throw new IdRegistryError('ID_REGISTRY_ASSIGNMENT_METADATA_CONFLICT', `Chapter metadata would change the existing ID for ${request.key}`);
    if (gateKey !== undefined && existing.gateKey !== undefined && gateKey !== existing.gateKey) throw new IdRegistryError('ID_REGISTRY_ASSIGNMENT_METADATA_CONFLICT', `Chapter gate move requires the migration primitive: ${request.key}`);
    if (runtime.has(existing.id)) throw new IdRegistryError('ID_REGISTRY_RUNTIME_COLLISION', `${request.key} chapter ID already exists in the target runtime`);
    return;
  }
  if (state.tombstones[request.key]) throw new IdRegistryError('ID_REGISTRY_TOMBSTONE_REUSE', `chapter:${request.key} is a retired symbolic key`);
  if (localId === undefined) {
    for (let candidate = CHAPTER_LOCAL_RANGE.min; candidate <= CHAPTER_LOCAL_RANGE.max; candidate += 1) {
      const candidateId = compositeChapterId(gateId, candidate);
      if (idInRange(candidateId, range) && !assignmentId(state, candidateId) && !tombstoneId(state, candidateId) && !runtime.has(candidateId)) {
        localId = candidate;
        break;
      }
    }
    if (localId === undefined) throw new IdRegistryError('ID_REGISTRY_EXHAUSTED', `No free chapter IDs remain for gate ${gateId}`);
  }
  const id = compositeChapterId(gateId, localId);
  assertAvailable(state, 'chapter', id, range, runtime);
  addAssignment(state, request.key, {
    id,
    ...(gateKey ? { gateKey } : { gateId }),
    localId,
  });
};

const sortedNamespaceState = (state: RegistryNamespaceState): RegistryNamespaceState => ({
  ...state,
  range: { ...state.range },
  assignments: Object.fromEntries(Object.keys(state.assignments).sort().map((key) => [key, state.assignments[key]])),
  tombstones: Object.fromEntries(Object.keys(state.tombstones).sort().map((key) => [key, state.tombstones[key]])),
});

const normalizeRegistry = (registry: IdRegistry): IdRegistry => {
  const next = clone(registry);
  next.namespaces = Object.fromEntries(ID_REGISTRY_NAMESPACE_ORDER.map((namespace) => [namespace, sortedNamespaceState(next.namespaces[namespace])])) as Record<RegistryNamespace, RegistryNamespaceState>;
  next.generation = computeRegistryGeneration(next);
  return next;
};

export const diffRegistry = (before: IdRegistry, after: IdRegistry): RegistryDiff[] => {
  const diff: RegistryDiff[] = [];
  for (const namespace of ID_REGISTRY_NAMESPACE_ORDER) {
    const left = before.namespaces[namespace];
    const right = after.namespaces[namespace];
    const assignmentKeys = new Set([...Object.keys(left.assignments), ...Object.keys(right.assignments)]);
    for (const key of [...assignmentKeys].sort()) {
      const previous = left.assignments[key]?.id;
      const next = right.assignments[key]?.id;
      if (previous === undefined && next !== undefined) diff.push({ namespace, key, action: 'add', after: next });
      else if (previous !== undefined && next === undefined) diff.push({ namespace, key, action: 'remove', before: previous });
      else if (previous !== next) diff.push({ namespace, key, action: 'update', before: previous, after: next });
      else if (previous !== undefined && stableStringify(left.assignments[key]) !== stableStringify(right.assignments[key])) diff.push({ namespace, key, action: 'update', before: previous, after: next, metadataChanged: true });
    }
    const tombstoneKeys = new Set([...Object.keys(left.tombstones), ...Object.keys(right.tombstones)]);
    for (const key of [...tombstoneKeys].sort()) {
      const previous = left.tombstones[key]?.id;
      const next = right.tombstones[key]?.id;
      if (previous === undefined && next !== undefined) diff.push({ namespace, key, action: 'retire', after: next });
    }
  }
  return diff;
};

export const planRegistry = (
  registry: IdRegistry,
  requests: readonly AllocationRequest[],
  options: RegistryAllocationOptions = {},
): RegistryPlan => {
  const current = parseRegistry(registry);
  for (const namespace of ID_REGISTRY_NAMESPACE_ORDER) ensureRangeOverride(options.rangeOverrides?.[namespace], namespace);
  const normalized = normalizeRequests(requests);
  const next = clone(current);
  for (const namespace of ID_REGISTRY_NAMESPACE_ORDER) {
    const runtime = runtimeSet(options, namespace);
    for (const assignment of Object.values(next.namespaces[namespace].assignments)) {
      if (runtime.has(assignment.id)) throw new IdRegistryError('ID_REGISTRY_RUNTIME_COLLISION', `${namespace} id ${assignment.id} already exists in the target runtime`);
    }
  }
  const allocationOrder = [...normalized].sort((left, right) => {
    const namespaceOrder = ID_REGISTRY_NAMESPACE_ORDER.indexOf(left.namespace) - ID_REGISTRY_NAMESPACE_ORDER.indexOf(right.namespace);
    if (namespaceOrder) return namespaceOrder;
    if (left.pin !== undefined && right.pin === undefined) return -1;
    if (left.pin === undefined && right.pin !== undefined) return 1;
    return left.key.localeCompare(right.key);
  });
  for (const request of allocationOrder) {
    if (request.namespace === 'chapter') allocateChapter(next, request, options);
    else allocateOne(next, request, options);
  }
  const planned = normalizeRegistry(next);
  const problems = validateRegistry(planned);
  if (problems.length) throw errorFromProblems(problems, 'ID_REGISTRY_INVALID');
  return {
    dryRun: true,
    baseGeneration: current.generation,
    generation: planned.generation,
    registry: planned,
    diff: diffRegistry(current, planned),
  };
};

export const allocateRegistry = planRegistry;
export const dryRunRegistry = planRegistry;

export const retireRegistryKey = (
  registry: IdRegistry,
  namespaceInput: RegistryNamespace,
  key: string,
  reason = 'retired',
): IdRegistry => {
  const current = parseRegistry(registry);
  const namespace = namespaceOf(namespaceInput);
  const state = current.namespaces[namespace];
  const entry = state.assignments[key];
  if (!entry) throw new IdRegistryError('ID_REGISTRY_ASSIGNMENT_MISSING', `Cannot retire missing assignment ${namespace}:${key}`);
  if (state.tombstones[key]) throw new IdRegistryError('ID_REGISTRY_TOMBSTONE_REUSE', `Assignment is already tombstoned: ${namespace}:${key}`);
  if (namespace === 'gate') {
    const dependents = dependentChapterKeys(current, key, entry.id);
    if (dependents.length) throw new IdRegistryError('ID_REGISTRY_DEPENDENCY_MIGRATION_REQUIRED', `Gate ${key} has dependent chapters that must be explicitly migrated: ${dependents.join(', ')}`);
  }
  delete state.assignments[key];
  state.tombstones[key] = {
    id: entry.id,
    retiredGeneration: current.generation,
    reason,
  };
  return normalizeRegistry(current);
};

/** Retire a gate only after every dependent chapter has an explicit move. */
export const retireRegistryKeyWithDependents = (
  registry: IdRegistry,
  namespaceInput: RegistryNamespace,
  key: string,
  dependentMigrations: readonly RegistryMigration[],
  reason = 'retired',
  options: RegistryAllocationOptions = {},
): RegistryPlan => {
  const original = parseRegistry(registry);
  const namespace = namespaceOf(namespaceInput);
  const source = original.namespaces[namespace].assignments[key];
  if (!source) throw new IdRegistryError('ID_REGISTRY_ASSIGNMENT_MISSING', `Cannot retire missing assignment ${namespace}:${key}`);
  if (namespace !== 'gate') throw new IdRegistryError('ID_REGISTRY_MIGRATION_INVALID', 'Dependent chapter migrations are only valid when retiring a gate');
  const dependents = dependentChapterKeys(original, key, source.id);
  const declared = [...dependentMigrations];
  const declaredKeys = new Set(declared.map((migration) => migrationIdentity(migration)));
  if (declaredKeys.size !== declared.length) throw new IdRegistryError('ID_REGISTRY_COLLISION', `Duplicate dependent migration while retiring gate ${key}`);
  const missing = dependents.filter((chapterKey) => !declaredKeys.has(`chapter\u0000${chapterKey}`));
  if (missing.length) throw new IdRegistryError('ID_REGISTRY_DEPENDENCY_MIGRATION_REQUIRED', `Gate ${key} requires explicit migrations for: ${missing.join(', ')}`);
  if (declared.some((migration) => migration.kind !== 'move' || migration.from.namespace !== 'chapter')) throw new IdRegistryError('ID_REGISTRY_DEPENDENCY_MIGRATION_REQUIRED', `Gate ${key} dependents must be explicit chapter moves`);
  let working = original;
  for (const migration of declared.sort((left, right) => migrationIdentity(left).localeCompare(migrationIdentity(right)))) {
    working = migrationPlan(working, migration, options).registry;
  }
  working = retireRegistryKey(working, 'gate', key, reason);
  return makePlan(original, working);
};

const migrationPlan = (
  registry: IdRegistry,
  migration: RegistryMigration,
  options: RegistryAllocationOptions,
): RegistryPlan => {
  const current = parseRegistry(registry);
  const fromNamespace = namespaceOf(migration.from.namespace);
  const toNamespace = namespaceOf(migration.to.namespace);
  if (!validKey(migration.from.key) || !validKey(migration.to.key)) throw new IdRegistryError('ID_REGISTRY_KEY_INVALID', 'Migration keys must be non-empty stable strings');
  const sourceState = current.namespaces[fromNamespace];
  const source = sourceState.assignments[migration.from.key];
  if (!source) throw new IdRegistryError('ID_REGISTRY_ASSIGNMENT_MISSING', `Migration source does not exist: ${fromNamespace}:${migration.from.key}`);
  if (current.namespaces[toNamespace].assignments[migration.to.key]) throw new IdRegistryError('ID_REGISTRY_COLLISION', `Migration destination already exists: ${toNamespace}:${migration.to.key}`);
  if (current.namespaces[toNamespace].tombstones[migration.to.key]) throw new IdRegistryError('ID_REGISTRY_TOMBSTONE_REUSE', `Migration destination is tombstoned: ${toNamespace}:${migration.to.key}`);
  if (migration.kind === 'rename') {
    const before = clone(current);
    if (fromNamespace !== toNamespace) throw new IdRegistryError('ID_REGISTRY_MIGRATION_INVALID', 'Rename cannot change namespace; use move');
    if (migration.to.pin !== undefined && migration.to.pin !== source.id) throw new IdRegistryError('ID_REGISTRY_PIN_INVALID', `Rename pin would change ${source.id}`);
    if (fromNamespace === 'chapter' && (migration.to.gateKey !== undefined || migration.to.gateId !== undefined || migration.to.localId !== undefined || migration.to.localChapterId !== undefined)) {
      const request: AllocationRequest = { ...migration.to, namespace: 'chapter', key: migration.to.key };
      const expectedGate = resolveGateId(current, request, source, options);
      const expectedLocal = chapterLocalValue(request) ?? chapterLocalValue(source) ?? chapterParts(source.id).localId;
      if (source.id !== compositeChapterId(expectedGate, expectedLocal)) throw new IdRegistryError('ID_REGISTRY_MIGRATION_INVALID', 'Rename metadata would move a chapter; use move');
    }
    delete sourceState.assignments[migration.from.key];
    sourceState.assignments[migration.to.key] = clone(source);
    if (fromNamespace === 'gate') {
      for (const assignment of Object.values(current.namespaces.chapter.assignments)) {
        if (assignment.gateKey === migration.from.key) assignment.gateKey = migration.to.key;
      }
    }
    return makePlan(before, normalizeRegistry(current));
  }
  if (migration.from.namespace === migration.to.namespace && migration.from.key === migration.to.key) throw new IdRegistryError('ID_REGISTRY_MIGRATION_INVALID', 'Move requires a distinct destination key');
  if (fromNamespace === 'gate') {
    const dependents = dependentChapterKeys(current, migration.from.key, source.id);
    if (dependents.length) throw new IdRegistryError('ID_REGISTRY_DEPENDENCY_MIGRATION_REQUIRED', `Gate ${migration.from.key} has dependent chapters that must be explicitly migrated in the same plan: ${dependents.join(', ')}`);
  }
  delete sourceState.assignments[migration.from.key];
  sourceState.tombstones[migration.from.key] = {
    id: source.id,
    retiredGeneration: current.generation,
    reason: migration.reason || 'moved',
  };
  const working = normalizeRegistry(current);
  const targetRequest: AllocationRequest = {
    ...migration.to,
    namespace: toNamespace,
    key: migration.to.key,
  };
  const allocated = planRegistry(working, [targetRequest], options);
  return makePlan(registry, allocated.registry);
};

const makePlan = (beforeInput: IdRegistry, afterInput: IdRegistry): RegistryPlan => {
  const before = parseRegistry(beforeInput);
  const after = normalizeRegistry(parseRegistry(afterInput));
  return {
    dryRun: true,
    baseGeneration: before.generation,
    generation: after.generation,
    registry: after,
    diff: diffRegistry(before, after),
  };
};

const migrationIdentity = (migration: RegistryMigration): string =>
  `${migration.from.namespace}\u0000${migration.from.key}`;

/**
 * Apply a set of explicit migrations as one dry-run plan. Gate moves with
 * dependent chapters are staged in three phases: reserve the destination
 * gate, migrate every declared dependent chapter, then retire the old gate.
 * This keeps the intermediate dangling reference out of any persisted state.
 */
export const migrateRegistryBatch = (
  registry: IdRegistry,
  migrations: readonly RegistryMigration[],
  options: RegistryAllocationOptions = {},
): RegistryPlan => {
  const original = parseRegistry(registry);
  const suppliedMigrations = [...migrations];
  const suppliedSources = new Set<string>();
  for (const migration of suppliedMigrations) {
    const identity = migrationIdentity(migration);
    if (suppliedSources.has(identity)) throw new IdRegistryError('ID_REGISTRY_COLLISION', `Duplicate migration source: ${identity}`);
    suppliedSources.add(identity);
  }
  const workingMigrations = suppliedMigrations.map((migration) => {
    if (migration.kind !== 'move' || migration.from.namespace !== 'gate' || migration.dependentMigrations?.length) return migration;
    const source = original.namespaces.gate.assignments[migration.from.key];
    if (!source) return migration;
    const dependentKeys = new Set(dependentChapterKeys(original, migration.from.key, source.id));
    const explicit = suppliedMigrations.filter((candidate) => candidate.from.namespace === 'chapter' && dependentKeys.has(candidate.from.key));
    return explicit.length ? { ...migration, dependentMigrations: explicit } : migration;
  });
  const gateGroups = workingMigrations
    .filter((migration) => migration.kind === 'move' && migration.from.namespace === 'gate' && (migration.dependentMigrations?.length || 0) > 0)
    .sort((left, right) => migrationIdentity(left).localeCompare(migrationIdentity(right)));
  const consumed = new Set<string>();
  let working = original;

  // Reserve every destination gate before chapter migrations resolve gateKey.
  const gateSources = new Map<string, { migration: RegistryMigration; sourceId: number; dependents: string[] }>();
  for (const migration of gateGroups) {
    if (migration.to.namespace !== 'gate') throw new IdRegistryError('ID_REGISTRY_MIGRATION_INVALID', `A gate move with dependent chapters must target the gate namespace: ${migrationIdentity(migration)}`);
    const source = working.namespaces.gate.assignments[migration.from.key];
    if (!source) throw new IdRegistryError('ID_REGISTRY_ASSIGNMENT_MISSING', `Migration source does not exist: gate:${migration.from.key}`);
    const dependents = dependentChapterKeys(original, migration.from.key, source.id);
    const declared = [...(migration.dependentMigrations || [])];
    const declaredKeys = new Set<string>();
    for (const dependent of declared) {
      if (dependent.from.namespace !== 'chapter' || dependent.kind !== 'move') throw new IdRegistryError('ID_REGISTRY_DEPENDENCY_MIGRATION_REQUIRED', `Gate ${migration.from.key} dependents must be explicit chapter moves`);
      const identity = migrationIdentity(dependent);
      if (declaredKeys.has(identity) || consumed.has(identity)) throw new IdRegistryError('ID_REGISTRY_COLLISION', `Duplicate dependent migration: ${identity}`);
      declaredKeys.add(identity);
      consumed.add(identity);
    }
    const missing = dependents.filter((key) => !declaredKeys.has(`chapter\u0000${key}`));
    if (missing.length) throw new IdRegistryError('ID_REGISTRY_DEPENDENCY_MIGRATION_REQUIRED', `Gate ${migration.from.key} requires explicit migrations for: ${missing.join(', ')}`);
    const targetRequest: AllocationRequest = {
      ...migration.to,
      namespace: 'gate',
      key: migration.to.key,
    };
    const allocated = planRegistry(working, [targetRequest], options);
    working = allocated.registry;
    gateSources.set(migrationIdentity(migration), { migration, sourceId: source.id, dependents });
  }

  // Migrate each dependent against the now-reserved destination gate.
  for (const group of gateGroups) {
    const declared = [...(group.dependentMigrations || [])].sort((left, right) => migrationIdentity(left).localeCompare(migrationIdentity(right)));
    for (const dependent of declared) {
      const plan = migrationPlan(working, dependent, options);
      working = plan.registry;
    }
  }
  for (const group of gateGroups) {
    const source = gateSources.get(migrationIdentity(group));
    if (!source) continue;
    working = retireRegistryKey(working, 'gate', group.from.key, group.reason || 'moved');
  }

  const remaining = workingMigrations
    .filter((migration) => !gateSources.has(migrationIdentity(migration)) && !consumed.has(migrationIdentity(migration)))
    .sort((left, right) => migrationIdentity(left).localeCompare(migrationIdentity(right)) || left.kind.localeCompare(right.kind));
  for (const migration of remaining) {
    if (migration.dependentMigrations?.length) {
      // A gate dependency group is the only supported nested form. A nested
      // list on another namespace would otherwise be silently ignored.
      throw new IdRegistryError('ID_REGISTRY_MIGRATION_INVALID', `dependentMigrations is only valid on a gate move: ${migrationIdentity(migration)}`);
    }
    const plan = migrationPlan(working, migration, options);
    working = plan.registry;
  }
  return makePlan(original, working);
};

export const migrateRegistry = (
  registry: IdRegistry,
  migration: RegistryMigration | RegistryMigrationBatch | readonly RegistryMigration[],
  options: RegistryAllocationOptions = {},
): RegistryPlan => {
  if (Array.isArray(migration)) return migrateRegistryBatch(registry, migration, options);
  if (isObject(migration) && Array.isArray(migration.migrations)) return migrateRegistryBatch(registry, migration.migrations as readonly RegistryMigration[], options);
  if ((migration as RegistryMigration).dependentMigrations?.length) return migrateRegistryBatch(registry, [migration as RegistryMigration], options);
  return migrationPlan(registry, migration as RegistryMigration, options);
};

export const renameRegistryKey = (
  registry: IdRegistry,
  namespace: RegistryNamespace,
  fromKey: string,
  toKey: string,
  options: RegistryAllocationOptions = {},
): RegistryPlan => migrateRegistry(registry, { kind: 'rename', from: { namespace, key: fromKey }, to: { namespace, key: toKey } }, options);

export const moveRegistryKey = (
  registry: IdRegistry,
  from: RegistryMigrationEndpoint,
  to: RegistryMigrationEndpoint,
  options: RegistryAllocationOptions = {},
): RegistryPlan => migrateRegistry(registry, { kind: 'move', from, to }, options);

export const readRegistry = async (registryPath: string): Promise<IdRegistry> => {
  if (!(await exists(registryPath))) throw new IdRegistryError('ID_REGISTRY_FILE_MISSING', `ID registry does not exist: ${registryPath}`);
  return parseRegistry(await readJsonFile<unknown>(registryPath));
};

export const applyRegistryPlan = async (
  registryPath: string,
  plan: RegistryPlan,
  options: { accept?: boolean } = {},
): Promise<RegistryApplyResult> => {
  if (options.accept !== true) throw new IdRegistryError('ID_REGISTRY_APPLY_REQUIRED', 'Dry-run plan requires explicit accept:true before writing');
  const directory = path.dirname(path.resolve(registryPath));
  await ensureDirectory(directory);
  await assertRealPathInside(directory, registryPath);
  if (await exists(registryPath)) {
    const current = await readRegistry(registryPath);
    if (current.generation !== plan.baseGeneration) throw new IdRegistryError('ID_REGISTRY_STALE_PLAN', 'Registry changed after this plan was created');
  } else if (plan.baseGeneration !== createEmptyRegistry().generation) {
    throw new IdRegistryError('ID_REGISTRY_STALE_PLAN', 'A new registry file can only accept a plan based on an empty registry');
  }
  const stagingPath = `${registryPath}.staging-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
  try {
    await atomicWriteJson(stagingPath, plan.registry, false);
    let staged: IdRegistry;
    try {
      staged = parseRegistry(await readJsonFile<unknown>(stagingPath));
    } catch (error) {
      const details = error instanceof IdRegistryError ? error.message : String(error);
      throw new IdRegistryError('ID_REGISTRY_STAGING_INVALID', `Staged registry failed validation: ${details}`);
    }
    await atomicWriteJson(registryPath, staged, true);
    let committed: IdRegistry;
    try {
      committed = parseRegistry(await readJsonFile<unknown>(registryPath));
    } catch (error) {
      const details = error instanceof IdRegistryError ? error.message : String(error);
      throw new IdRegistryError('ID_REGISTRY_ATOMIC_WRITE_INVALID', `Committed registry failed validation: ${details}`);
    }
    if (committed.generation !== plan.generation) throw new IdRegistryError('ID_REGISTRY_ATOMIC_WRITE_INVALID', 'Committed registry generation differs from the accepted plan');
    return { path: registryPath, generation: committed.generation, registry: committed, diff: plan.diff };
  } finally {
    await fs.rm(stagingPath, { force: true });
  }
};

export const applyRegistry = applyRegistryPlan;
export const acceptRegistryPlan = applyRegistryPlan;

export const registryToJson = (registry: IdRegistry): JsonObject => clone(parseRegistry(registry)) as unknown as JsonObject;
