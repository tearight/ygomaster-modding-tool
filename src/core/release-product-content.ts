import { contentDiagnostic } from './content-format';
import type { JsonObject, Problem } from './types';

export const RELEASE_PRODUCT_GRAPH_VERSION = 1 as const;

export const RELEASE_PRODUCT_CODES = Object.freeze({
  DOCUMENT_INVALID: 'RELEASE_PRODUCT_DOCUMENT_INVALID',
  KEY_DUPLICATE: 'RELEASE_PRODUCT_KEY_DUPLICATE',
  DATE_INVALID: 'RELEASE_PRODUCT_DATE_INVALID',
  DATE_DUPLICATE: 'RELEASE_PRODUCT_DATE_DUPLICATE',
  ORDER_INVALID: 'RELEASE_PRODUCT_ORDER_INVALID',
  RELEASE_PRODUCT_ORPHAN: 'RELEASE_PRODUCT_ORPHAN',
  PRODUCT_RELEASE_ORPHAN: 'RELEASE_PRODUCT_RELEASE_ORPHAN',
  PRODUCT_IDENTITY_ORPHAN: 'RELEASE_PRODUCT_IDENTITY_ORPHAN',
  IDENTITY_PRODUCT_ORPHAN: 'RELEASE_IDENTITY_PRODUCT_ORPHAN',
  PRINT_EDGE_MISMATCH: 'RELEASE_PRODUCT_PRINT_EDGE_MISMATCH',
  DELIVERY_INVALID: 'RELEASE_PRODUCT_DELIVERY_INVALID',
  DELIVERY_TARGET_MISSING: 'RELEASE_PRODUCT_DELIVERY_TARGET_MISSING',
  DELIVERY_CYCLE: 'RELEASE_PRODUCT_DELIVERY_CYCLE',
} as const);

export type ProductDeliveryKind = 'shop-pack' | 'structure' | 'fixed-reward' | 'promo-archive';
export type ProductDeliveryStatus = 'active' | 'planned';

export interface ProductDelivery {
  key: string;
  kind: ProductDeliveryKind;
  status: ProductDeliveryStatus;
  ref: string;
  coverage: 'partial' | 'complete';
  predecessorRef?: string;
}

export interface ReleaseWave {
  key: string;
  date: string;
  products: string[];
}

export interface HistoricalProduct {
  key: string;
  officialProductId: string;
  officialNameJa: string;
  releaseDate: string;
  family: string;
  accessChannel: string;
  sourceUrl: string;
  confidence: string;
  identityRefs: string[];
  deliveries: ProductDelivery[];
}

export interface ProductPrintEdge {
  productRef: string;
  releaseDate: string;
  historicalRarity: string;
  artworkEvidence: string;
  firstRelease: boolean;
  reprint: boolean;
}

export interface HistoricalCardIdentity {
  key: string;
  officialCardId: number;
  officialNameJa: string;
  identityStatus: string;
  rulesStatus: string;
  runtime: JsonObject | null;
  runtimeCandidates: number[];
  acquisitionRoutes: string[];
  prints: ProductPrintEdge[];
}

export interface ReleaseProductGraph {
  graphId: string;
  boundary: {
    region: string;
    startDate: string;
    endDateInclusive: string;
  };
  releases: ReleaseWave[];
  products: HistoricalProduct[];
  identities: HistoricalCardIdentity[];
}

export interface ReleaseProductGraphDocument {
  formatVersion: typeof RELEASE_PRODUCT_GRAPH_VERSION;
  kind: 'release-product-graph';
  payload: ReleaseProductGraph;
}

export interface ReleaseProductGraphSummary {
  releases: number;
  products: number;
  identities: number;
  printEdges: number;
  deliveries: number;
  activeDeliveries: number;
  identitiesWithActiveDelivery: number;
  identitiesWithoutActiveDelivery: number;
}

export interface ReleaseProductGraphResult {
  ok: boolean;
  document?: ReleaseProductGraphDocument;
  summary?: ReleaseProductGraphSummary;
  problems: Problem[];
}

export interface ReleaseProductValidationOptions {
  knownShopRefs?: Iterable<string>;
  knownStructureRefs?: Iterable<string>;
  knownRewardRefs?: Iterable<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const compareOrdinal = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;

const diagnostic = (code: string, message: string, sourcePath: string | undefined, jsonPointer: string): Problem =>
  contentDiagnostic({ code, message, sourcePath, jsonPointer });

const dateValue = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : undefined;
};

const requiredString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(requiredString);

const deliveryKind = (value: unknown): value is ProductDeliveryKind =>
  value === 'shop-pack' || value === 'structure' || value === 'fixed-reward' || value === 'promo-archive';

const refPrefix = (kind: ProductDeliveryKind): string => kind === 'structure' ? 'structure:' : kind === 'fixed-reward' ? 'reward:' : 'shop:';

const activeTargetSet = (kind: ProductDeliveryKind, options: ReleaseProductValidationOptions): Set<string> => {
  if (kind === 'structure') return new Set(options.knownStructureRefs || []);
  if (kind === 'fixed-reward') return new Set(options.knownRewardRefs || []);
  return new Set(options.knownShopRefs || []);
};

/** Validate the campaign-scoped historical provenance and digital delivery graph. */
export const validateReleaseProductGraph = (
  value: unknown,
  sourcePath?: string,
  options: ReleaseProductValidationOptions = {},
): ReleaseProductGraphResult => {
  const problems: Problem[] = [];
  if (!isRecord(value) || value.formatVersion !== RELEASE_PRODUCT_GRAPH_VERSION || value.kind !== 'release-product-graph' || !isRecord(value.payload)) {
    return { ok: false, problems: [diagnostic(RELEASE_PRODUCT_CODES.DOCUMENT_INVALID, 'Release/product graph requires formatVersion 1, kind release-product-graph, and an object payload', sourcePath, '')] };
  }
  const graph = value.payload;
  if (!requiredString(graph.graphId) || !isRecord(graph.boundary) || !Array.isArray(graph.releases) || !Array.isArray(graph.products) || !Array.isArray(graph.identities)) {
    return { ok: false, problems: [diagnostic(RELEASE_PRODUCT_CODES.DOCUMENT_INVALID, 'Graph requires graphId, boundary, releases, products, and identities', sourcePath, '/payload')] };
  }
  for (const [field, item] of [['startDate', graph.boundary.startDate], ['endDateInclusive', graph.boundary.endDateInclusive]] as const) {
    if (dateValue(item) === undefined) problems.push(diagnostic(RELEASE_PRODUCT_CODES.DATE_INVALID, `Boundary ${field} must be an ISO calendar date`, sourcePath, `/payload/boundary/${field}`));
  }

  const releases = graph.releases as unknown[];
  const products = graph.products as unknown[];
  const identities = graph.identities as unknown[];
  const releaseByKey = new Map<string, ReleaseWave>();
  const releaseByDate = new Map<string, ReleaseWave>();
  const parsedReleases: ReleaseWave[] = [];
  let previousDate = -Infinity;
  releases.forEach((raw, index) => {
    const pointer = `/payload/releases/${index}`;
    if (!isRecord(raw) || !requiredString(raw.key) || dateValue(raw.date) === undefined || !stringArray(raw.products)) {
      problems.push(diagnostic(RELEASE_PRODUCT_CODES.DOCUMENT_INVALID, 'Release requires key, ISO date, and product reference array', sourcePath, pointer));
      return;
    }
    const release = raw as unknown as ReleaseWave;
    if (releaseByKey.has(release.key)) problems.push(diagnostic(RELEASE_PRODUCT_CODES.KEY_DUPLICATE, `Duplicate release key: ${release.key}`, sourcePath, `${pointer}/key`));
    if (releaseByDate.has(release.date)) problems.push(diagnostic(RELEASE_PRODUCT_CODES.DATE_DUPLICATE, `Duplicate release wave date: ${release.date}`, sourcePath, `${pointer}/date`));
    const currentDate = dateValue(release.date) as number;
    if (currentDate < previousDate) problems.push(diagnostic(RELEASE_PRODUCT_CODES.ORDER_INVALID, `Release waves must be chronological: ${release.date}`, sourcePath, `${pointer}/date`));
    previousDate = currentDate;
    releaseByKey.set(release.key, release);
    releaseByDate.set(release.date, release);
    parsedReleases.push(release);
  });

  const productByKey = new Map<string, HistoricalProduct>();
  const productByOfficialId = new Map<string, HistoricalProduct>();
  const deliveryByKey = new Map<string, ProductDelivery>();
  products.forEach((raw, index) => {
    const pointer = `/payload/products/${index}`;
    if (!isRecord(raw) || !requiredString(raw.key) || !requiredString(raw.officialProductId) || !requiredString(raw.officialNameJa)
      || dateValue(raw.releaseDate) === undefined || !requiredString(raw.family) || !requiredString(raw.accessChannel)
      || !requiredString(raw.sourceUrl) || !requiredString(raw.confidence)
      || !stringArray(raw.identityRefs) || !Array.isArray(raw.deliveries)) {
      problems.push(diagnostic(RELEASE_PRODUCT_CODES.DOCUMENT_INVALID, 'Product requires historical identity, date/family/channel, identityRefs, and deliveries', sourcePath, pointer));
      return;
    }
    const product = raw as unknown as HistoricalProduct;
    if (productByKey.has(product.key) || productByOfficialId.has(product.officialProductId)) problems.push(diagnostic(RELEASE_PRODUCT_CODES.KEY_DUPLICATE, `Duplicate product key or official ID: ${product.key}`, sourcePath, `${pointer}/key`));
    productByKey.set(product.key, product);
    productByOfficialId.set(product.officialProductId, product);
    const wave = releaseByDate.get(product.releaseDate);
    if (!wave || !wave.products.includes(product.key)) problems.push(diagnostic(RELEASE_PRODUCT_CODES.PRODUCT_RELEASE_ORPHAN, `Product is not owned by its dated release wave: ${product.key}`, sourcePath, `${pointer}/releaseDate`));
    product.deliveries.forEach((delivery, deliveryIndex) => {
      const deliveryPointer = `${pointer}/deliveries/${deliveryIndex}`;
      if (!isRecord(delivery) || !requiredString(delivery.key) || !deliveryKind(delivery.kind)
        || (delivery.status !== 'active' && delivery.status !== 'planned') || !requiredString(delivery.ref)
        || (delivery.coverage !== 'partial' && delivery.coverage !== 'complete')
        || (delivery.predecessorRef !== undefined && !requiredString(delivery.predecessorRef))) {
        problems.push(diagnostic(RELEASE_PRODUCT_CODES.DELIVERY_INVALID, 'Delivery requires supported kind/status, key, and ref', sourcePath, deliveryPointer));
        return;
      }
      if (!delivery.ref.startsWith(refPrefix(delivery.kind))) problems.push(diagnostic(RELEASE_PRODUCT_CODES.DELIVERY_INVALID, `Delivery ref namespace does not match ${delivery.kind}: ${delivery.ref}`, sourcePath, `${deliveryPointer}/ref`));
      if (deliveryByKey.has(delivery.key)) problems.push(diagnostic(RELEASE_PRODUCT_CODES.KEY_DUPLICATE, `Duplicate delivery key: ${delivery.key}`, sourcePath, `${deliveryPointer}/key`));
      deliveryByKey.set(delivery.key, delivery as ProductDelivery);
      if (delivery.status === 'active' && !activeTargetSet(delivery.kind, options).has(delivery.ref)) {
        problems.push(diagnostic(RELEASE_PRODUCT_CODES.DELIVERY_TARGET_MISSING, `Active delivery target does not resolve: ${delivery.ref}`, sourcePath, `${deliveryPointer}/ref`));
      }
    });
  });

  for (const [releaseIndex, release] of parsedReleases.entries()) {
    release.products.forEach((productRef, productIndex) => {
      const product = productByKey.get(productRef);
      if (!product || product.releaseDate !== release.date) problems.push(diagnostic(RELEASE_PRODUCT_CODES.RELEASE_PRODUCT_ORPHAN, `Release product reference does not resolve on the same date: ${productRef}`, sourcePath, `/payload/releases/${releaseIndex}/products/${productIndex}`));
    });
  }

  const identityByKey = new Map<string, HistoricalCardIdentity>();
  const identityByOfficialId = new Map<number, HistoricalCardIdentity>();
  identities.forEach((raw, index) => {
    const pointer = `/payload/identities/${index}`;
    if (!isRecord(raw) || !requiredString(raw.key) || !Number.isSafeInteger(raw.officialCardId) || !requiredString(raw.officialNameJa)
      || !requiredString(raw.identityStatus) || !requiredString(raw.rulesStatus) || (raw.runtime !== null && !isRecord(raw.runtime))
      || !Array.isArray(raw.runtimeCandidates) || !raw.runtimeCandidates.every(Number.isSafeInteger)
      || !stringArray(raw.acquisitionRoutes) || !Array.isArray(raw.prints)) {
      problems.push(diagnostic(RELEASE_PRODUCT_CODES.DOCUMENT_INVALID, 'Identity requires official identity/status/runtime and print edges', sourcePath, pointer));
      return;
    }
    const identity = raw as unknown as HistoricalCardIdentity;
    if (identityByKey.has(identity.key) || identityByOfficialId.has(identity.officialCardId)) problems.push(diagnostic(RELEASE_PRODUCT_CODES.KEY_DUPLICATE, `Duplicate identity key or official ID: ${identity.key}`, sourcePath, `${pointer}/key`));
    identityByKey.set(identity.key, identity);
    identityByOfficialId.set(identity.officialCardId, identity);
    if (!identity.prints.length) problems.push(diagnostic(RELEASE_PRODUCT_CODES.IDENTITY_PRODUCT_ORPHAN, `Identity has no historical product: ${identity.key}`, sourcePath, `${pointer}/prints`));
    identity.acquisitionRoutes.forEach((route, routeIndex) => {
      const known = new Set([...(options.knownShopRefs || []), ...(options.knownStructureRefs || []), ...(options.knownRewardRefs || [])]);
      if (!known.has(route)) problems.push(diagnostic(RELEASE_PRODUCT_CODES.DELIVERY_TARGET_MISSING, `Identity acquisition route does not resolve: ${route}`, sourcePath, `${pointer}/acquisitionRoutes/${routeIndex}`));
    });
    identity.prints.forEach((print, printIndex) => {
      const printPointer = `${pointer}/prints/${printIndex}`;
      if (!isRecord(print) || !requiredString(print.productRef) || dateValue(print.releaseDate) === undefined || !requiredString(print.historicalRarity)
        || !requiredString(print.artworkEvidence) || typeof print.firstRelease !== 'boolean' || typeof print.reprint !== 'boolean') {
        problems.push(diagnostic(RELEASE_PRODUCT_CODES.DOCUMENT_INVALID, 'Print edge requires product/date/rarity/artwork and first/reprint flags', sourcePath, printPointer));
        return;
      }
      const product = productByKey.get(print.productRef);
      if (!product) problems.push(diagnostic(RELEASE_PRODUCT_CODES.IDENTITY_PRODUCT_ORPHAN, `Print product does not resolve: ${print.productRef}`, sourcePath, `${printPointer}/productRef`));
      else if (product.releaseDate !== print.releaseDate || !product.identityRefs.includes(identity.key)) problems.push(diagnostic(RELEASE_PRODUCT_CODES.PRINT_EDGE_MISMATCH, `Print edge does not match product date/membership: ${identity.key} -> ${print.productRef}`, sourcePath, printPointer));
    });
  });

  for (const [productIndex, product] of [...productByKey.values()].entries()) {
    product.identityRefs.forEach((identityRef, identityIndex) => {
      const identity = identityByKey.get(identityRef);
      if (!identity) problems.push(diagnostic(RELEASE_PRODUCT_CODES.PRODUCT_IDENTITY_ORPHAN, `Product identity reference does not resolve: ${identityRef}`, sourcePath, `/payload/products/${productIndex}/identityRefs/${identityIndex}`));
      else if (!identity.prints.some((print) => print.productRef === product.key)) problems.push(diagnostic(RELEASE_PRODUCT_CODES.PRINT_EDGE_MISMATCH, `Product membership lacks reciprocal print edge: ${product.key} -> ${identityRef}`, sourcePath, `/payload/products/${productIndex}/identityRefs/${identityIndex}`));
    });
  }

  for (const delivery of deliveryByKey.values()) {
    if (delivery.predecessorRef && !deliveryByKey.has(delivery.predecessorRef)) problems.push(diagnostic(RELEASE_PRODUCT_CODES.DELIVERY_TARGET_MISSING, `Delivery predecessor does not resolve: ${delivery.predecessorRef}`, sourcePath, '/payload/products'));
    const seen = new Set<string>();
    let current: ProductDelivery | undefined = delivery;
    while (current?.predecessorRef) {
      if (seen.has(current.key)) {
        problems.push(diagnostic(RELEASE_PRODUCT_CODES.DELIVERY_CYCLE, `Delivery predecessor cycle contains ${current.key}`, sourcePath, '/payload/products'));
        break;
      }
      seen.add(current.key);
      current = deliveryByKey.get(current.predecessorRef);
    }
  }

  const identitiesWithActiveDelivery = [...identityByKey.values()].filter((identity) => identity.acquisitionRoutes.length > 0).length;
  const summary: ReleaseProductGraphSummary = {
    releases: releaseByKey.size,
    products: productByKey.size,
    identities: identityByKey.size,
    printEdges: [...identityByKey.values()].reduce((sum, identity) => sum + identity.prints.length, 0),
    deliveries: deliveryByKey.size,
    activeDeliveries: [...deliveryByKey.values()].filter((delivery) => delivery.status === 'active').length,
    identitiesWithActiveDelivery,
    identitiesWithoutActiveDelivery: identityByKey.size - identitiesWithActiveDelivery,
  };
  const sortedProblems = problems.sort((left, right) => compareOrdinal(left.sourcePath || '', right.sourcePath || '') || compareOrdinal(left.jsonPointer || '', right.jsonPointer || '') || compareOrdinal(left.code, right.code));
  return { ok: sortedProblems.length === 0, document: clone(value as unknown as ReleaseProductGraphDocument), summary, problems: sortedProblems };
};

export const parseReleaseProductGraph = validateReleaseProductGraph;
