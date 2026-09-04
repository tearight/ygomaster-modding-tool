import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useState } from 'react';

export interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

export interface RecoveryRecord<T> {
  workspace: string;
  entity: string;
  generation: string;
  savedAt: string;
  draft: T;
}

const encode = (value: string) => encodeURIComponent(value);
export const recoveryPrefix = (workspace: string, entity: string) => `ygomaster:recovery:${encode(workspace)}:${encode(entity)}:`;
export const recoveryKey = (workspace: string, entity: string, generation: string) => `${recoveryPrefix(workspace, entity)}${encode(generation)}`;

export const browserRecoveryStorage = (): RecoveryStorage | undefined => {
  if (typeof window === 'undefined' || !window.localStorage) return undefined;
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
    keys: () => Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index)).filter((key): key is string => Boolean(key)),
  };
};

export const readRecoveryDraft = <T>(storage: RecoveryStorage | undefined, workspace: string, entity: string, generation: string): { record?: RecoveryRecord<T>; stale: boolean } => {
  if (!storage || !workspace || !entity || !generation) return { stale: false };
  const prefix = recoveryPrefix(workspace, entity);
  const stale = storage.keys().some((key) => key.startsWith(prefix) && key !== recoveryKey(workspace, entity, generation));
  const value = storage.getItem(recoveryKey(workspace, entity, generation));
  if (!value) return { stale };
  try {
    const record = JSON.parse(value) as RecoveryRecord<T>;
    if (record.workspace !== workspace || record.entity !== entity || record.generation !== generation) return { stale: true };
    return { record, stale };
  } catch {
    return { stale: true };
  }
};

export const writeRecoveryDraft = <T>(storage: RecoveryStorage | undefined, workspace: string, entity: string, generation: string, draft: T) => {
  if (!storage || !workspace || !entity || !generation) return;
  const record: RecoveryRecord<T> = { workspace, entity, generation, savedAt: new Date().toISOString(), draft };
  storage.setItem(recoveryKey(workspace, entity, generation), JSON.stringify(record));
};

export const clearRecoveryDraft = (storage: RecoveryStorage | undefined, workspace: string, entity: string, generation: string) => {
  if (storage) storage.removeItem(recoveryKey(workspace, entity, generation));
};

export const authoredCandidateSignature = (generation: string, draft: unknown) => JSON.stringify([generation, draft]);

export interface GateAuthoringDraftState<T> {
  draft: T;
  setDraft: Dispatch<SetStateAction<T>>;
  dirty: boolean;
  recovered: boolean;
  staleRecoveryExists: boolean;
  signature: string;
  previewSignature: string;
  markPreviewed: () => void;
  invalidatePreview: () => void;
  canApply: boolean;
  discard: () => void;
  applied: () => void;
}

export const useGateAuthoringDraft = <T,>(workspace: string, entity: string, generation: string, authored: T): GateAuthoringDraftState<T> => {
  const storage = useMemo(browserRecoveryStorage, []);
  const authoredSignature = useMemo(() => JSON.stringify(authored), [authored]);
  const recovery = useMemo(() => readRecoveryDraft<T>(storage, workspace, entity, generation), [entity, generation, storage, workspace]);
  const [draft, setDraftState] = useState<T>(() => recovery.record?.draft ?? authored);
  const [recovered, setRecovered] = useState(Boolean(recovery.record));
  const [previewSignature, setPreviewSignature] = useState('');

  useEffect(() => {
    const next = readRecoveryDraft<T>(storage, workspace, entity, generation);
    setDraftState(next.record?.draft ?? authored);
    setRecovered(Boolean(next.record));
    setPreviewSignature('');
  }, [authored, authoredSignature, entity, generation, storage, workspace]);

  const signature = useMemo(() => authoredCandidateSignature(generation, draft), [draft, generation]);
  const dirty = JSON.stringify(draft) !== authoredSignature;
  const setDraft: Dispatch<SetStateAction<T>> = useCallback((value) => {
    setDraftState((current) => typeof value === 'function' ? (value as (previous: T) => T)(current) : value);
    setPreviewSignature('');
  }, []);

  useEffect(() => {
    if (dirty) writeRecoveryDraft(storage, workspace, entity, generation, draft);
    else clearRecoveryDraft(storage, workspace, entity, generation);
  }, [dirty, draft, entity, generation, storage, workspace]);

  const discard = useCallback(() => {
    clearRecoveryDraft(storage, workspace, entity, generation);
    setDraftState(authored);
    setRecovered(false);
    setPreviewSignature('');
  }, [authored, entity, generation, storage, workspace]);
  const applied = useCallback(() => {
    clearRecoveryDraft(storage, workspace, entity, generation);
    setRecovered(false);
    setPreviewSignature('');
  }, [entity, generation, storage, workspace]);

  return {
    draft,
    setDraft,
    dirty,
    recovered,
    staleRecoveryExists: recovery.stale,
    signature,
    previewSignature,
    markPreviewed: () => setPreviewSignature(signature),
    invalidatePreview: () => setPreviewSignature(''),
    canApply: dirty && previewSignature === signature,
    discard,
    applied,
  };
};
