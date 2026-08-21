export type JsonObject = Record<string, unknown>;

export type YgoMasterPayloadShape = 'raw' | 'wrapped';

export interface YgoMasterPayloadSource {
  document: JsonObject;
  payloadKey: string;
  payload: object;
  shape: YgoMasterPayloadShape;
}

export const SOURCE_METADATA_FILE = '.ygomaster-source.json';

export interface YgoMasterSourceMetadata {
  version: 1;
  solo?: { document: JsonObject };
  duels: Record<string, { document: JsonObject }>;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cloneJson = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

const findPayload = (
  value: unknown,
  payloadKey: string,
): JsonObject | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findPayload(item, payloadKey);
      if (result) return result;
    }
    return;
  }

  if (!isObject(value)) return;
  if (isObject(value[payloadKey])) return value[payloadKey];

  for (const child of Object.values(value)) {
    const result = findPayload(child, payloadKey);
    if (result) return result;
  }
};

const replacePayload = (
  value: unknown,
  payloadKey: string,
  payload: JsonObject,
): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => replacePayload(item, payloadKey, payload));
  }

  if (!isObject(value)) return false;
  if (isObject(value[payloadKey])) {
    value[payloadKey] = payload;
    return true;
  }

  return Object.values(value).some((child) =>
    replacePayload(child, payloadKey, payload),
  );
};

/**
 * Read either an authoring payload ({ Master: ... } / { Duel: ... }) or a
 * YgoMaster response wrapper ({ code, res: [...] }).
 */
export const unwrapPayload = <T extends object>(
  document: unknown,
  payloadKey: string,
): Omit<YgoMasterPayloadSource, 'payload'> & { payload: T } => {
  if (!isObject(document)) {
    throw new Error(`Expected a JSON object containing ${payloadKey}`);
  }

  const rawPayload = document[payloadKey];
  if (isObject(rawPayload)) {
    return {
      document: cloneJson(document),
      payloadKey,
      payload: rawPayload as T,
      shape: 'raw',
    };
  }

  const wrappedPayload = findPayload(document, payloadKey);
  if (!wrappedPayload) {
    throw new Error(`Could not find ${payloadKey} in the JSON document`);
  }

  return {
    document: cloneJson(document),
    payloadKey,
    payload: wrappedPayload as T,
    shape: 'wrapped',
  };
};

/**
 * Replace only the payload inside the original document. This keeps wrapper
 * fields such as code, remove, and persistence data intact when an imported
 * response is exported again.
 */
export const serializePayload = (
  rootPayload: JsonObject,
  source?: YgoMasterPayloadSource,
): JsonObject => {
  if (!source || source.shape === 'raw') return cloneJson(rootPayload);

  const document = cloneJson(source.document);
  const payload = rootPayload[source.payloadKey];
  if (!isObject(payload)) {
    throw new Error(`Missing ${source.payloadKey} in generated JSON`);
  }

  if (!replacePayload(document, source.payloadKey, payload)) {
    throw new Error(`Could not replace ${source.payloadKey} in the source JSON`);
  }

  return document;
};

const mergeJsonValue = (original: unknown, generated: unknown): unknown => {
  if (Array.isArray(generated)) {
    if (!Array.isArray(original)) return generated;
    return generated.map((value, index) =>
      mergeJsonValue(original[index], value),
    );
  }
  if (!isObject(generated)) return generated;

  const result: JsonObject = isObject(original) ? { ...original } : {};
  Object.entries(generated).forEach(([key, value]) => {
    result[key] = mergeJsonValue(result[key], value);
  });
  return result;
};

export const mergeJsonObjects = <T extends object>(
  original: unknown,
  generated: T,
): T => mergeJsonValue(original, generated) as T;

export const isJsonObject = isObject;
