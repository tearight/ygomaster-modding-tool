import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { formatDeckAuthoringSections, type DeckAuthoringSections } from '../common/deck-authoring';
import { publishAtomicDirectory } from './atomic-directory';
import { loadCardResolver, type CardNameResolver } from './card-resolver';
import { compileCampaignContent, type CompileCampaignContentOptions } from './campaign-pipeline';
import { discoverCampaignIrBundle } from './content-bundle-loader';
import { compileDecklist, parseDecklist } from './deck-content';
import { atomicWriteText, exists, moveToTrash, resolveSafeInside } from './fs';
import {
  applyRegistryPlan,
  createEmptyRegistry,
  diffRegistry,
  readRegistry,
  reviewRegistryPlan,
  type IdRegistry,
  type RegistryPlan,
} from './id-registry';
import { IR_COMPILER_VERSION } from './ir-compiler';
import { validateLayeredCampaign } from './layered-validation';
import {
  IR_GENERATION_METADATA_FILE,
  type ContentManifest,
  YGOMASTER_TARGET_CONTRACT_VERSION,
  readIrGenerationMetadata,
} from './layers';
import type { OperationResult, Problem } from './types';
import { failure, problem, result } from './types';
import { parseShopPackMetadata, validateShopContent } from './shop-content';
import { parseGateContent } from './gate-content';
import { parseStructureContent } from './structure-content';
import { parseRegulationMetadata, regulationCapabilityGolden, validateRegulationContent } from './regulation-content';
import { inspectGateBackgroundPng } from './gate-background-assets';
import { type AssetManifest } from './localization-content';
import {
  RUNTIME_POLICY_FIELD_DEFINITIONS,
  validateRuntimePolicyPatch,
  type RuntimePolicyFamily,
} from './runtime-policy';
import {
  deckFolderFromMetadata,
  descendantDeckFolderIds,
  normalizeDeckFolderReference,
  parseDeckFolderCatalog,
  validateDeckOrganization,
  type DeckOrganizationDeck,
  type GateDeckScopeGate,
} from './deck-organization';

export interface ContentDocumentMutation {
  sourcePath: string;
  operation: 'create' | 'update' | 'delete';
  content?: string;
  expectedContentGeneration: string;
  confirmApply: boolean;
}

export interface ContentDeckPreview {
  sourcePath: string;
  sections: DeckAuthoringSections;
  expectedContentGeneration: string;
}

export interface CampaignDeckWorkspaceViewModel {
  contentGeneration: string;
  catalogState: 'missing' | 'ready';
  catalog: { sourcePath: string; exists: boolean; document: Record<string, unknown> };
  folders: Array<{
    id: string;
    name: string;
    parent?: string;
    breadcrumb: string[];
    depth: number;
    directDeckCount: number;
    recursiveDeckCount: number;
    consumerGateIds: string[];
  }>;
  decks: Array<{
    key: string;
    reference: string;
    sourcePath: string;
    adapterPath: string;
    identityOrigin: 'explicit' | 'legacy-flat';
    sidecarPath?: string;
    sidecarSourcePath?: string;
    folderId?: string;
    folderStatus: 'assigned' | 'unassigned' | 'missing';
    role?: string;
    metadata: Record<string, unknown>;
    consumers: Array<{ gateId: string; chapterId: string; role: 'cpu' | 'rental' | 'player' }>;
    deepLink: string;
    deepLinkInfo: { route: '/decks'; sourcePath: string };
  }>;
  gates: Array<{
    id: string;
    gateId: string;
    sourcePath?: string;
    folderId?: string;
    deckFolder?: string;
    scopedDeckCount: number;
    chapters: GateDeckScopeGate['chapters'];
    candidates: { cpu: string[]; rental: string[] };
    outOfScopeReferences: Array<{ chapterId: string; role: 'cpu' | 'rental'; reference: string; code: string }>;
    scope: {
      descendantFolderIds: string[];
      deckCount: number;
      candidates: { cpu: string[]; rental: string[] };
      outOfScopeReferences: Array<{
        chapterId: string;
        role: 'cpu' | 'rental';
        reference: string;
        code: string;
      }>;
    };
    deepLink: { route: '/gates'; sourcePath?: string };
  }>;
  diagnostics: Problem[];
}

export interface ContentShopDocumentDraft {
  sourcePath: string;
  content: string;
}

export interface ContentShopMutation {
  metadata: ContentShopDocumentDraft;
  packList: ContentShopDocumentDraft;
  odds: ContentShopDocumentDraft;
  expectedContentGeneration: string;
  confirmApply: boolean;
}

export interface ContentStructureMutation extends ContentDocumentMutation {}

export interface ContentRegulationMutation {
  metadata: ContentShopDocumentDraft;
  rules: ContentShopDocumentDraft;
  operation: 'create' | 'update' | 'delete';
  expectedContentGeneration: string;
  confirmApply: boolean;
}

export interface ContentLocalizationAssetMutation extends ContentDocumentMutation {}

export interface ContentRuntimePolicyMutation {
  policy: Record<string, Record<string, unknown>>;
  expectedContentGeneration: string;
  confirmApply: boolean;
}

export interface ContentDeckFolderBootstrapAssignment {
  /** Existing authored Deck source (`*.decklist`) from the workspace VM. */
  sourcePath: string;
  /** Optional reviewed assertion for an existing or newly-created sidecar. */
  sidecarSourcePath?: string;
  folderId: string;
}

export interface ContentGateFolderBootstrapAssignment {
  /** Existing authored Gate JSON source from the workspace VM. */
  sourcePath: string;
  folderId: string;
}

/**
 * A reviewed, all-or-nothing migration from the legacy no-catalog shape.
 * Apply requests must resubmit the exact previewSignature returned by preview.
 */
export interface ContentDeckFoldersBootstrapRequest {
  catalog: Record<string, unknown>;
  deckAssignments: readonly ContentDeckFolderBootstrapAssignment[];
  gateAssignments: readonly ContentGateFolderBootstrapAssignment[];
  expectedContentGeneration: string;
  confirmApply: boolean;
  previewSignature?: string;
}

const DOCUMENT_EXTENSIONS = new Set(['.json', '.decklist', '.regulation', '.packlist']);

const documentPath = async (contentRoot: string, sourcePath: string): Promise<string> => {
  if (!sourcePath || !DOCUMENT_EXTENSIONS.has(path.posix.extname(sourcePath).toLowerCase())) throw new Error(`Unsupported authored document: ${sourcePath}`);
  return resolveSafeInside(contentRoot, sourcePath);
};

const isManifestDocumentPath = (manifest: ContentManifest, sourcePath: string): boolean => {
  if (sourcePath === 'manifest.json') return true;
  const directories = Object.values(manifest.directories || {}).map((entry) => entry.replace(/\\/gu, '/').replace(/\/$/u, ''));
  return directories.some((directory) => directory && sourcePath.startsWith(`${directory}/`));
};

const listDocuments = async (root: string, directory = ''): Promise<string[]> => {
  const current = directory ? await resolveSafeInside(root, directory) : root;
  const entries = await fs.readdir(current, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.trash' || entry.name.startsWith('.')) continue;
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...await listDocuments(root, relative));
    else if (DOCUMENT_EXTENSIONS.has(path.posix.extname(entry.name).toLowerCase())) output.push(relative);
  }
  return output.sort();
};

export const listCampaignContentDocuments = async (options: ContentOperationPaths): Promise<OperationResult<unknown>> => {
  try {
    const paths = operationPaths(options);
    const inspected = await discoverCampaignIrBundle(paths.contentRoot);
    if (!inspected.ok || !inspected.bundle) return failure(inspected.problems, 'COMMAND_FAILED');
    const documents = (await listDocuments(paths.contentRoot)).filter((sourcePath) => isManifestDocumentPath(inspected.bundle?.manifest as ContentManifest, sourcePath));
    return result({ contentGeneration: inspected.bundle.snapshot.contentGeneration, documents });
  } catch (error) {
    return failure([problem('CONTENT_DOCUMENT_LIST_FAILED', String(error))], 'PATH_ERROR');
  }
};

export const readCampaignContentDocument = async (options: ContentOperationPaths & { sourcePath: string }): Promise<OperationResult<unknown>> => {
  try {
    const paths = operationPaths(options);
    const source = await documentPath(paths.contentRoot, options.sourcePath);
    const inspected = await discoverCampaignIrBundle(paths.contentRoot);
    if (!inspected.ok || !inspected.bundle) return failure(inspected.problems, 'COMMAND_FAILED');
    if (!isManifestDocumentPath(inspected.bundle.manifest, options.sourcePath)) return failure([problem('CONTENT_DOCUMENT_PATH_UNAUTHORIZED', 'Document is not within a manifest-declared content family', options.sourcePath)], 'PATH_ERROR');
    return result({ sourcePath: options.sourcePath, content: await fs.readFile(source, 'utf8'), contentGeneration: inspected.bundle.snapshot.contentGeneration });
  } catch (error) {
    return failure([problem('CONTENT_DOCUMENT_READ_FAILED', String(error), options.sourcePath)], 'PATH_ERROR');
  }
};

/**
 * Filesystem-free authoring projection for Deck navigation and Gate-scoped
 * pickers. It exposes content-relative authored and generated adapter paths;
 * the renderer never receives an absolute filesystem path.
 */
export const inspectCampaignDeckWorkspace = async (
  options: ContentOperationPaths,
): Promise<OperationResult<CampaignDeckWorkspaceViewModel>> => {
  try {
    const paths = operationPaths(options);
    const loaded = await discoverCampaignIrBundle(paths.contentRoot);
    if (!loaded.ok || !loaded.bundle) return failure(loaded.problems, 'COMMAND_FAILED');
    const bundle = loaded.bundle;
    const parsedGates = bundle.gates.map((entry) => ({ entry, parsed: parseGateContent(entry.value, entry.sourcePath) }));
    const diagnostics = parsedGates.flatMap(({ parsed }) => parsed.problems);
    const gateInputs: GateDeckScopeGate[] = parsedGates.flatMap(({ entry, parsed }) => parsed.document ? [{
      id: parsed.document.gate.id,
      sourcePath: entry.sourcePath,
      deckFolder: parsed.document.gate.deckFolder,
      chapters: parsed.document.gate.chapters.map((chapter) => ({
        id: chapter.id,
        cpuDeck: chapter.duel?.cpuDeck,
        rentalDeck: chapter.duel?.rentalDeck,
      })),
    }] : []);
    const organizationDecks: DeckOrganizationDeck[] = Object.values(bundle.decks).map((entry) => ({
        key: entry.reference.slice('deck:'.length),
        reference: entry.reference,
        aliases: entry.aliases,
        sourcePath: entry.source.sourcePath,
        adapterPath: entry.adapterPath,
        identityOrigin: entry.identityOrigin,
        ...(entry.sidecar ? { sidecarPath: entry.sidecar.sourcePath } : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      }));
    const organization = validateDeckOrganization(bundle.deckFolderCatalog, organizationDecks, gateInputs);
    diagnostics.push(...organization.problems);
    const scopes = new Map(organization.scopes.map((scope) => [scope.gateId, scope]));
    const consumers = new Map<string, Array<{ gateId: string; chapterId: string; role: 'cpu' | 'rental' | 'player' }>>();
    const deckAliases = new Map<string, DeckOrganizationDeck>();
    for (const deck of organizationDecks) {
      for (const alias of [deck.reference, deck.key, deck.sourcePath, ...(deck.aliases || [])]) deckAliases.set(alias, deck);
    }
    for (const { parsed } of parsedGates) {
      if (!parsed.document) continue;
      for (const chapter of parsed.document.gate.chapters) {
        for (const [role, reference] of [
          ['cpu', chapter.duel?.cpuDeck],
          ['rental', chapter.duel?.rentalDeck],
          ['player', chapter.duel?.playerDeck],
        ] as const) {
          if (!reference) continue;
          const deck = deckAliases.get(reference);
          if (!deck) continue;
          consumers.set(deck.reference, [...(consumers.get(deck.reference) || []), { gateId: parsed.document.gate.id, chapterId: chapter.id, role }]);
        }
      }
    }
    const folderIds = new Set(bundle.deckFolderCatalog?.folders.map((folder) => folder.id) || []);
    const deckFolderIds = new Map(organizationDecks.map((deck) => [deck, deckFolderFromMetadata(deck.metadata, deck.sidecarPath || deck.sourcePath).folderId]));
    const decks = organizationDecks.map((deck) => {
      const folderId = deckFolderIds.get(deck);
      const folder = deckFolderFromMetadata(deck.metadata, deck.sidecarPath || deck.sourcePath);
      const role = typeof deck.metadata?.role === 'string' ? deck.metadata.role.trim().toLowerCase() : undefined;
      const folderStatus: 'assigned' | 'unassigned' | 'missing' = !folder.explicit
        ? 'unassigned'
        : folderId && folderIds.has(folderId) ? 'assigned' : 'missing';
      return {
        key: deck.key,
        reference: deck.reference,
        sourcePath: deck.sourcePath,
        adapterPath: deck.adapterPath as string,
        identityOrigin: deck.identityOrigin as 'explicit' | 'legacy-flat',
        ...(deck.sidecarPath ? { sidecarPath: deck.sidecarPath } : {}),
        ...(deck.sidecarPath ? { sidecarSourcePath: deck.sidecarPath } : {}),
        ...(folderId ? { folderId } : {}),
        folderStatus,
        ...(role ? { role } : {}),
        metadata: JSON.parse(JSON.stringify(deck.metadata || {})) as Record<string, unknown>,
        consumers: (consumers.get(deck.reference) || []).sort((left, right) => left.gateId.localeCompare(right.gateId) || left.chapterId.localeCompare(right.chapterId) || left.role.localeCompare(right.role)),
        deepLink: `/decks?deck=${encodeURIComponent(deck.reference)}`,
        deepLinkInfo: { route: '/decks' as const, sourcePath: deck.sourcePath },
      };
    }).sort((left, right) => left.reference.localeCompare(right.reference));
    const folderById = new Map((bundle.deckFolderCatalog?.folders || []).map((folder) => [folder.id, folder]));
    const breadcrumbFor = (folderId: string): string[] => {
      const names: string[] = [];
      const seen = new Set<string>();
      let current = folderById.get(folderId);
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        names.unshift(current.name);
        current = current.parent ? folderById.get(current.parent) : undefined;
      }
      return names;
    };
    const folders = (bundle.deckFolderCatalog?.folders || []).map((folder) => {
      const descendants = new Set(descendantDeckFolderIds(bundle.deckFolderCatalog as NonNullable<typeof bundle.deckFolderCatalog>, folder.id));
      const breadcrumb = breadcrumbFor(folder.id);
      return {
        id: folder.id,
        name: folder.name,
        ...(folder.parent ? { parent: folder.parent } : {}),
        breadcrumb,
        depth: Math.max(0, breadcrumb.length - 1),
        directDeckCount: [...deckFolderIds.values()].filter((folderId) => folderId === folder.id).length,
        recursiveDeckCount: [...deckFolderIds.values()].filter((folderId) => Boolean(folderId && descendants.has(folderId))).length,
        consumerGateIds: organization.scopes.filter((scope) => scope.descendantFolderIds.includes(folder.id)).map((scope) => scope.gateId).sort(),
      };
    });
    const gates = gateInputs.map((gate) => {
      const scope = scopes.get(gate.id);
      const descendants = new Set(scope?.descendantFolderIds || []);
      const outOfScopeReferences = (scope?.references || []).flatMap((reference) => reference.problem ? [{
        chapterId: reference.chapterId,
        role: reference.role,
        reference: reference.reference,
        code: reference.problem.code,
      }] : []);
      const scopedDeckCount = decks.filter((deck) => Boolean(deck.folderId && descendants.has(deck.folderId))).length;
      return {
        id: gate.id,
        gateId: gate.id,
        ...(gate.sourcePath ? { sourcePath: gate.sourcePath } : {}),
        ...(gate.deckFolder ? { folderId: gate.deckFolder } : {}),
        ...(gate.deckFolder ? { deckFolder: gate.deckFolder } : {}),
        scopedDeckCount,
        chapters: gate.chapters,
        candidates: scope?.candidateReferences || { cpu: [], rental: [] },
        outOfScopeReferences,
        scope: {
          descendantFolderIds: scope?.descendantFolderIds || [],
          deckCount: scopedDeckCount,
          candidates: scope?.candidateReferences || { cpu: [], rental: [] },
          outOfScopeReferences,
        },
        deepLink: { route: '/gates' as const, ...(gate.sourcePath ? { sourcePath: gate.sourcePath } : {}) },
      };
    }).sort((left, right) => left.gateId.localeCompare(right.gateId));
    const data: CampaignDeckWorkspaceViewModel = {
      contentGeneration: bundle.snapshot.contentGeneration,
      catalogState: bundle.deckFolderCatalog ? 'ready' : 'missing',
      catalog: {
        sourcePath: bundle.deckFolderSource?.sourcePath || `${(bundle.manifest.directories?.decks || 'decks').replace(/\\/gu, '/').replace(/\/$/u, '')}/_folders.json`,
        exists: Boolean(bundle.deckFolderSource),
        document: bundle.deckFolderCatalog ? JSON.parse(JSON.stringify(bundle.deckFolderCatalog.original)) as Record<string, unknown> : {},
      },
      folders,
      decks,
      gates,
      diagnostics,
    };
    return diagnostics.some((entry) => entry.severity !== 'warning')
      ? { ...failure(diagnostics, 'COMMAND_FAILED'), data }
      : result(data, diagnostics.filter((entry) => entry.severity === 'warning'));
  } catch (error) {
    return failure([problem('CONTENT_DECK_WORKSPACE_FAILED', String(error))], 'COMMAND_FAILED');
  }
};

const shopDocumentRoots = (manifest: ContentManifest) => {
  const root = (manifest.directories?.shop || 'shop').replace(/\\/gu, '/').replace(/\/$/u, '');
  return { root, packs: `${root}/packs/`, pools: `${root}/pools/`, odds: `${root}/odds/` };
};

class ContentShopPathError extends Error {
  readonly sourcePath: string;
  constructor(message: string, sourcePath: string) {
    super(message);
    this.name = 'ContentShopPathError';
    this.sourcePath = sourcePath;
  }
}

const assertShopDocumentPaths = async (
  contentRoot: string,
  manifest: ContentManifest,
  mutation: Pick<ContentShopMutation, 'metadata' | 'packList' | 'odds'>,
): Promise<void> => {
  const roots = shopDocumentRoots(manifest);
  const checks: Array<[ContentShopDocumentDraft, string, string]> = [
    [mutation.metadata, roots.packs, '.json'],
    [mutation.packList, roots.pools, '.packlist'],
    [mutation.odds, roots.odds, '.json'],
  ];
  for (const [draft, prefix, extension] of checks) {
    const segments = draft.sourcePath.replace(/\\/gu, '/').split('/');
    if (!draft.sourcePath.startsWith(prefix) || segments.some((entry) => entry === '.' || entry === '..') || path.posix.extname(draft.sourcePath).toLowerCase() !== extension) {
      throw new ContentShopPathError(`Shop authored document must stay inside ${prefix} and end in ${extension}`, draft.sourcePath);
    }
    const familyRoot = await resolveSafeInside(contentRoot, prefix.replace(/\/$/u, ''));
    const target = await documentPath(contentRoot, draft.sourcePath);
    const relative = path.relative(familyRoot, target);
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new ContentShopPathError(`Shop authored document resolved outside ${prefix}`, draft.sourcePath);
    }
  }
};

export const readCampaignShopDocuments = async (
  options: ContentOperationPaths & { sourcePath: string },
): Promise<OperationResult<unknown>> => {
  try {
    const paths = operationPaths(options);
    const loaded = await discoverCampaignIrBundle(paths.contentRoot);
    if (!loaded.ok || !loaded.bundle) return failure(loaded.problems, 'COMMAND_FAILED');
    const roots = shopDocumentRoots(loaded.bundle.manifest);
    if (!options.sourcePath.startsWith(roots.packs) || !options.sourcePath.endsWith('.json')) {
      return failure([problem('CONTENT_SHOP_PATH_UNAUTHORIZED', 'Shop metadata must be inside the manifest Shop packs directory', options.sourcePath)], 'PATH_ERROR');
    }
    const shop = loaded.bundle.shops.find((entry) => entry.metadata.sourcePath === options.sourcePath);
    if (!shop) return failure([problem('CONTENT_SHOP_DOCUMENT_MISSING', 'Shop metadata or its linked pool/odds document is missing', options.sourcePath)], 'COMMAND_FAILED');
    return result({
      contentGeneration: loaded.bundle.snapshot.contentGeneration,
      metadata: { sourcePath: shop.metadata.sourcePath, content: await fs.readFile(await documentPath(paths.contentRoot, shop.metadata.sourcePath), 'utf8') },
      packList: { sourcePath: shop.packList.sourcePath, content: await fs.readFile(await documentPath(paths.contentRoot, shop.packList.sourcePath), 'utf8') },
      odds: { sourcePath: shop.odds.sourcePath, content: await fs.readFile(await documentPath(paths.contentRoot, shop.odds.sourcePath), 'utf8') },
    });
  } catch (error) {
    return failure([problem('CONTENT_SHOP_READ_FAILED', String(error), options.sourcePath)], 'PATH_ERROR');
  }
};

/** Preview or atomically publish the three linked authored Shop documents.
 * This is the EDITOR-009 document boundary extended to one indivisible Shop unit. */
export const mutateCampaignShopDocuments = async (
  options: ContentExecutionOptions,
  mutation: ContentShopMutation,
): Promise<OperationResult<unknown>> => {
  const paths = operationPaths(options);
  let stagingPath = '';
  try {
    if (!mutation.expectedContentGeneration) return failure([problem('CONTENT_EXPECTED_GENERATION_REQUIRED', 'Shop mutation requires expectedContentGeneration')], 'USAGE_ERROR');
    const before = await discoverCampaignIrBundle(paths.contentRoot);
    if (!before.ok || !before.bundle) return failure(before.problems, 'COMMAND_FAILED');
    if (before.bundle.snapshot.contentGeneration !== mutation.expectedContentGeneration) return failure([problem('CONTENT_GENERATION_STALE', 'Authored content changed before this Shop mutation', mutation.metadata.sourcePath)], 'COMMAND_FAILED');
    await assertShopDocumentPaths(paths.contentRoot, before.bundle.manifest, mutation);

    let metadataValue: unknown;
    try { metadataValue = JSON.parse(mutation.metadata.content) as unknown; } catch (error) {
      return failure([problem('CONTENT_SHOP_METADATA_INVALID', String(error), mutation.metadata.sourcePath)], 'COMMAND_FAILED');
    }
    const parsedMetadata = parseShopPackMetadata(metadataValue, mutation.metadata.sourcePath);
    if (!parsedMetadata.document) return failure(parsedMetadata.problems, 'COMMAND_FAILED');
    const roots = shopDocumentRoots(before.bundle.manifest);
    const expectedPackListRef = path.posix.relative(roots.root, mutation.packList.sourcePath);
    const expectedOddsRef = path.posix.relative(roots.root, mutation.odds.sourcePath);
    if (parsedMetadata.document.metadata.packlist !== expectedPackListRef || parsedMetadata.document.metadata.odds !== expectedOddsRef) {
      return failure([problem('CONTENT_SHOP_REFERENCE_MISMATCH', `Metadata references must match the edited pool (${expectedPackListRef}) and odds (${expectedOddsRef}) documents`, mutation.metadata.sourcePath)], 'COMMAND_FAILED');
    }

    const parent = path.dirname(paths.contentRoot);
    const token = `${process.pid}-${Date.now()}`;
    stagingPath = path.join(parent, `.content-shop-stage-${token}`);
    const backupPath = path.join(parent, `.content-shop-backup-${token}`);
    await fs.cp(paths.contentRoot, stagingPath, { recursive: true, errorOnExist: true });
    for (const draft of [mutation.metadata, mutation.packList, mutation.odds]) {
      const stagedTarget = await documentPath(stagingPath, draft.sourcePath);
      await atomicWriteText(stagedTarget, draft.content, await exists(stagedTarget));
    }

    const compiled = await compileCore({ ...options, contentRoot: stagingPath }, true);
    const layered = await validateLayeredCampaign({ checkOnly: true, compileCheck: () => compiled });
    const projection = compiled.shopProjections?.find((entry) => entry.symbolicShopId === parsedMetadata.document?.metadata.normalizedShopId);
    const stagedBundle = await discoverCampaignIrBundle(stagingPath);
    const stagedShop = stagedBundle.bundle?.shops.find((entry) => entry.metadata.sourcePath === mutation.metadata.sourcePath);
    const inputs = await executionInputs(options);
    const validation = stagedShop ? validateShopContent({
      metadata: stagedShop.metadata.value,
      packList: stagedShop.packList.value,
      odds: stagedShop.odds.value,
      metadataSourcePath: stagedShop.metadata.sourcePath,
      packListSourcePath: stagedShop.packList.sourcePath,
      oddsSourcePath: stagedShop.odds.sourcePath,
    }, { resolver: inputs.resolver, registry: compiled.registry || inputs.registry }) : undefined;
    const preview = {
      sourcePaths: { metadata: mutation.metadata.sourcePath, packList: mutation.packList.sourcePath, odds: mutation.odds.sourcePath },
      symbolicShopId: parsedMetadata.document.metadata.normalizedShopId,
      references: { packList: expectedPackListRef, odds: expectedOddsRef, predecessor: parsedMetadata.document.metadata.unlockRef || null },
      rarities: validation?.packList?.rarities || [],
      resolutions: (validation?.resolutions || []).map((entry) => ({
        ...entry,
        ...(entry.lockEntry?.sourcePath ? { sourcePath: entry.lockEntry.sourcePath } : {}),
        ...(entry.lockEntry?.sourceSpan ? { sourceSpan: entry.lockEntry.sourceSpan } : {}),
      })),
      slots: validation?.odds?.slots || [],
      projection: projection || null,
      capability: { status: 'assumed', contractVersion: 'ygomaster-campaign-target/v3', supportedSubset: 'official-example-pack' },
    };
    if (!layered.ok) return { ...failure(layered.problems, 'COMMAND_FAILED', layered.warnings), data: preview };
    if (!mutation.confirmApply) return result({ ...preview, requiresConfirmation: true }, layered.warnings);

    const current = await discoverCampaignIrBundle(paths.contentRoot);
    if (!current.ok || !current.bundle) return failure(current.problems, 'COMMAND_FAILED');
    if (current.bundle.snapshot.contentGeneration !== mutation.expectedContentGeneration) return failure([problem('CONTENT_GENERATION_STALE', 'Authored content changed while validating this Shop mutation', mutation.metadata.sourcePath)], 'COMMAND_FAILED');
    await publishAtomicDirectory({ root: parent, stagingPath, finalPath: paths.contentRoot, backupPath });
    stagingPath = '';
    const after = await discoverCampaignIrBundle(paths.contentRoot);
    return result({ ...preview, contentGeneration: after.bundle?.snapshot.contentGeneration, applied: true }, layered.warnings);
  } catch (error) {
    if (error instanceof ContentShopPathError) return failure([problem('CONTENT_SHOP_PATH_UNAUTHORIZED', error.message, error.sourcePath)], 'PATH_ERROR');
    return failure([problem('CONTENT_SHOP_MUTATION_FAILED', String(error), mutation.metadata?.sourcePath)], 'COMMAND_FAILED');
  } finally {
    if (stagingPath) await fs.rm(stagingPath, { recursive: true, force: true });
  }
};

const deckResolutionState = (codes: readonly string[], matchKind?: string): string => {
  if (matchKind) return matchKind;
  if (codes.includes('CARD_NAME_AMBIGUOUS')) return 'ambiguous';
  if (codes.includes('CARD_NAME_UNRESOLVED') || codes.includes('CARD_ALIAS_UNREVIEWED')) return 'unresolved';
  if (codes.includes('CARD_RUNTIME_UNAVAILABLE')) return 'unavailable';
  return 'invalid';
};

/** Read-only line preview for the renderer. Parsing, resolution, legality and
 * runtime-ID projection remain owned by the shared content core.
 */
export const previewCampaignDeckDocument = async (
  options: ContentExecutionOptions,
  preview: ContentDeckPreview,
): Promise<OperationResult<unknown>> => {
  try {
    if (!preview.expectedContentGeneration) {
      return failure([problem('CONTENT_EXPECTED_GENERATION_REQUIRED', 'Deck preview requires expectedContentGeneration from document list or read', preview.sourcePath)], 'USAGE_ERROR');
    }
    if (!preview.sections || typeof preview.sections !== 'object') {
      return failure([problem('CONTENT_DOCUMENT_CONTENT_REQUIRED', 'Deck preview requires main, extra and side section text', preview.sourcePath)], 'USAGE_ERROR');
    }
    const contentRoot = operationPaths(options).contentRoot;
    const targetPath = await documentPath(contentRoot, preview.sourcePath);
    const loaded = await discoverCampaignIrBundle(contentRoot);
    if (!loaded.ok || !loaded.bundle) return failure(loaded.problems, 'COMMAND_FAILED');
    const deckRoot = (loaded.bundle.manifest.directories?.decks || 'decks').replace(/\\/gu, '/').replace(/\/$/u, '');
    const deckPath = await resolveSafeInside(contentRoot, deckRoot);
    const relativeDeckPath = path.relative(deckPath, targetPath);
    if (!relativeDeckPath || relativeDeckPath.startsWith('..') || path.isAbsolute(relativeDeckPath) || path.extname(relativeDeckPath).toLowerCase() !== '.decklist') {
      return failure([problem('CONTENT_DECK_PATH_UNAUTHORIZED', 'Deck preview path must be a .decklist inside the manifest deck directory', preview.sourcePath)], 'PATH_ERROR');
    }
    if (loaded.bundle.snapshot.contentGeneration !== preview.expectedContentGeneration) {
      return failure([problem('CONTENT_GENERATION_STALE', 'Authored content changed before this deck preview', preview.sourcePath)], 'COMMAND_FAILED');
    }

    const { resolver } = await executionInputs(options);
    const canonicalContent = formatDeckAuthoringSections(preview.sections);
    const document = parseDecklist(canonicalContent, { sourcePath: preview.sourcePath });
    const resolutions = document.entries.map((entry) => {
      const resolved = resolver.resolve({
        sourceName: entry.sourceName,
        ...(entry.selector ? { selector: entry.selector } : {}),
        sourcePath: preview.sourcePath,
        sourceSpan: entry.span,
      });
      return {
        line: entry.line,
        section: entry.section,
        count: entry.count,
        sourceName: entry.sourceName,
        state: deckResolutionState(resolved.problems.map((entry) => entry.code), resolved.lockEntry?.matchKind),
        ...(resolved.runtimeId === undefined ? {} : { runtimeId: resolved.runtimeId }),
        candidates: resolved.candidates,
        suggestions: resolved.suggestions,
        problems: resolved.problems,
      };
    });
    const compiled = compileDecklist(document, resolver, { isExtraDeckCard: (runtimeId) => resolver.isExtraDeckCard(runtimeId) });
    const data = {
      sourcePath: preview.sourcePath,
      canonicalContent,
      contentGeneration: loaded.bundle.snapshot.contentGeneration,
      resolutions,
      sections: compiled.sections,
      ...(compiled.ir ? { compiledRuntimeIds: compiled.ir } : {}),
    };
    if (!compiled.ok) return { ...failure(compiled.problems, 'COMMAND_FAILED'), data };
    return result(data);
  } catch (error) {
    return failure([problem('CONTENT_DECK_PREVIEW_FAILED', String(error), preview.sourcePath)], 'COMMAND_FAILED');
  }
};

export const mutateCampaignContentDocument = async (options: ContentExecutionOptions, mutation: ContentDocumentMutation): Promise<OperationResult<unknown>> => {
  const paths = operationPaths(options);
  try {
    if (!mutation.expectedContentGeneration) return failure([problem('CONTENT_EXPECTED_GENERATION_REQUIRED', 'Document mutation requires expectedContentGeneration from document list or read', mutation.sourcePath)], 'USAGE_ERROR');
    if ((mutation.operation === 'create' || mutation.operation === 'update') && typeof mutation.content !== 'string') return failure([problem('CONTENT_DOCUMENT_CONTENT_REQUIRED', `${mutation.operation} requires document content`, mutation.sourcePath)], 'USAGE_ERROR');
    const target = await documentPath(paths.contentRoot, mutation.sourcePath);
    const before = await discoverCampaignIrBundle(paths.contentRoot);
    if (!before.ok || !before.bundle) return failure(before.problems, 'COMMAND_FAILED');
    if (!isManifestDocumentPath(before.bundle.manifest, mutation.sourcePath)) return failure([problem('CONTENT_DOCUMENT_PATH_UNAUTHORIZED', 'Document is not within a manifest-declared content family', mutation.sourcePath)], 'PATH_ERROR');
    if (before.bundle.snapshot.contentGeneration !== mutation.expectedContentGeneration) return failure([problem('CONTENT_GENERATION_STALE', 'Authored content changed before this document mutation', mutation.sourcePath)], 'COMMAND_FAILED');
    const targetExists = await exists(target);
    if (mutation.operation === 'create' && targetExists) return failure([problem('CONTENT_DOCUMENT_EXISTS', 'Document already exists', mutation.sourcePath)], 'COMMAND_FAILED');
    if (mutation.operation !== 'create' && !targetExists) return failure([problem('CONTENT_DOCUMENT_MISSING', 'Document does not exist', mutation.sourcePath)], 'COMMAND_FAILED');
    const stageProjectRoot = path.join(path.resolve(options.projectRoot), `.document-stage-${process.pid}-${Date.now()}`);
    const stage = path.join(stageProjectRoot, 'campaign', 'content');
    try {
      await fs.mkdir(path.dirname(stage), { recursive: true });
      await fs.cp(paths.contentRoot, stage, { recursive: true, errorOnExist: true });
      const stagedTarget = await documentPath(stage, mutation.sourcePath);
      if (mutation.operation === 'delete') await fs.rm(stagedTarget);
      else await atomicWriteText(stagedTarget, mutation.content as string, mutation.operation !== 'create');
      const preview = await validateCampaignContentOperation({ ...options, projectRoot: stageProjectRoot, contentRoot: stage });
      if (!preview.ok) return failure(preview.problems, 'COMMAND_FAILED', preview.warnings);
      if (!mutation.confirmApply) return result({ sourcePath: mutation.sourcePath, operation: mutation.operation, preview: preview.data, requiresConfirmation: true }, preview.warnings);
      const current = await discoverCampaignIrBundle(paths.contentRoot);
      if (!current.ok || !current.bundle) return failure(current.problems, 'COMMAND_FAILED');
      if (current.bundle.snapshot.contentGeneration !== mutation.expectedContentGeneration) return failure([problem('CONTENT_GENERATION_STALE', 'Authored content changed while validating this document mutation', mutation.sourcePath)], 'COMMAND_FAILED');
      if (mutation.operation === 'delete') return result({ sourcePath: mutation.sourcePath, operation: mutation.operation, trashedPath: await moveToTrash(paths.contentRoot, mutation.sourcePath, 'document'), preview: preview.data });
      await atomicWriteText(target, mutation.content as string, mutation.operation !== 'create');
      return result({ sourcePath: mutation.sourcePath, operation: mutation.operation, preview: preview.data });
    } finally {
      await fs.rm(stageProjectRoot, { recursive: true, force: true });
    }
  } catch (error) {
    return failure([problem('CONTENT_DOCUMENT_MUTATION_FAILED', String(error), mutation.sourcePath)], 'COMMAND_FAILED');
  }
};

/**
 * Gate folder selection and any explicit Chapter remaps travel as one complete
 * Gate JSON candidate through the existing generation/staging/confirmation
 * boundary. No reference is synthesized or silently replaced here.
 */
export const mutateCampaignGateDeckScopeDocument = async (
  options: ContentExecutionOptions,
  mutation: ContentDocumentMutation,
): Promise<OperationResult<unknown>> => {
  if (mutation.operation !== 'update' || typeof mutation.content !== 'string') {
    return failure([problem('CONTENT_GATE_DECK_SCOPE_UPDATE_REQUIRED', 'Gate Deck scope mutation requires one complete Gate JSON update candidate', mutation.sourcePath)], 'USAGE_ERROR');
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(mutation.content) as unknown;
  } catch (error) {
    return failure([problem('CONTENT_GATE_DECK_SCOPE_JSON_INVALID', String(error), mutation.sourcePath)], 'COMMAND_FAILED');
  }
  const parsed = parseGateContent(candidate, mutation.sourcePath);
  if (!parsed.document || parsed.problems.some((entry) => entry.severity !== 'warning')) {
    return failure(parsed.problems.length ? parsed.problems : [problem('CONTENT_GATE_DECK_SCOPE_INVALID', 'Gate Deck scope candidate is invalid', mutation.sourcePath)], 'COMMAND_FAILED');
  }
  return mutateCampaignContentDocument(options, mutation);
};

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const canonicalBootstrapValue = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalBootstrapValue).join(',')}]`;
  if (isJsonRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalBootstrapValue(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

const bootstrapSignature = (
  request: ContentDeckFoldersBootstrapRequest,
  deckAssignments: readonly ContentDeckFolderBootstrapAssignment[],
  gateAssignments: readonly ContentGateFolderBootstrapAssignment[],
): string => createHash('sha256').update(canonicalBootstrapValue({
  expectedContentGeneration: request.expectedContentGeneration,
  catalog: request.catalog,
  deckAssignments: [...deckAssignments].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
  gateAssignments: [...gateAssignments].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
})).digest('hex');

const withDeckFolderMetadata = (
  existing: Record<string, unknown> | undefined,
  folderId: string,
): Record<string, unknown> => {
  const document = existing ? JSON.parse(JSON.stringify(existing)) as Record<string, unknown> : {};
  const metadata = isJsonRecord(document.metadata)
    ? document.metadata
    : { ...document };
  return { ...document, metadata: { ...metadata, folder: folderId } };
};

const withGateDeckFolder = (
  existing: Record<string, unknown>,
  folderId: string,
): Record<string, unknown> | undefined => isJsonRecord(existing.payload)
  ? { ...JSON.parse(JSON.stringify(existing)) as Record<string, unknown>, payload: { ...existing.payload, deckFolder: folderId } }
  : undefined;

/**
 * Atomically bootstrap the complete logical Deck-folder model into legacy
 * authored content. The reviewed candidate contains the catalog, every Deck
 * assignment and every Gate assignment; partial mappings never reach staging.
 * Generated IR is used only as a check-only validation result and is not
 * published by this operation.
 */
export const bootstrapCampaignDeckFolders = async (
  options: ContentExecutionOptions,
  request: ContentDeckFoldersBootstrapRequest,
): Promise<OperationResult<unknown>> => {
  const paths = operationPaths(options);
  let stagingPath = '';
  try {
    if (!request.expectedContentGeneration) {
      return failure([problem('CONTENT_EXPECTED_GENERATION_REQUIRED', 'Deck-folder bootstrap requires expectedContentGeneration')], 'USAGE_ERROR');
    }
    if (!Array.isArray(request.deckAssignments) || !Array.isArray(request.gateAssignments) || !isJsonRecord(request.catalog)) {
      return failure([problem('CONTENT_DECK_FOLDER_BOOTSTRAP_INVALID', 'Deck-folder bootstrap requires a catalog plus complete Deck and Gate assignment arrays')], 'USAGE_ERROR');
    }
    const before = await discoverCampaignIrBundle(paths.contentRoot);
    if (!before.ok || !before.bundle) return failure(before.problems, 'COMMAND_FAILED');
    if (before.bundle.snapshot.contentGeneration !== request.expectedContentGeneration) {
      return failure([problem('CONTENT_GENERATION_STALE', 'Authored content changed before this Deck-folder bootstrap')], 'COMMAND_FAILED');
    }
    const deckDirectory = (before.bundle.manifest.directories?.decks || 'decks').replace(/\\/gu, '/').replace(/\/$/u, '');
    const catalogSourcePath = `${deckDirectory}/_folders.json`;
    if (before.bundle.deckFolderSource) {
      return failure([problem('CONTENT_DECK_FOLDER_BOOTSTRAP_ALREADY_EXISTS', 'Deck-folder bootstrap is only available while the folder catalog is missing', before.bundle.deckFolderSource.sourcePath)], 'COMMAND_FAILED');
    }
    const parsedCatalog = parseDeckFolderCatalog(request.catalog, catalogSourcePath);
    if (!parsedCatalog.ok || !parsedCatalog.catalog) return failure(parsedCatalog.problems, 'COMMAND_FAILED');
    const folderIds = new Set(parsedCatalog.catalog.folders.map((folder) => folder.id));
    const mappingProblems: Problem[] = [];
    const normalizeAssignment = <T extends { sourcePath: string; folderId: string }>(assignment: T, family: 'Deck' | 'Gate'): T | undefined => {
      if (!assignment || typeof assignment.sourcePath !== 'string' || !assignment.sourcePath || typeof assignment.folderId !== 'string') {
        mappingProblems.push(problem('CONTENT_DECK_FOLDER_BOOTSTRAP_MAPPING_INVALID', `${family} assignments require sourcePath and folderId`));
        return undefined;
      }
      const normalized = normalizeDeckFolderReference(assignment.folderId, assignment.sourcePath, family === 'Deck' ? '/metadata/folder' : '/payload/deckFolder');
      mappingProblems.push(...normalized.problems);
      if (!normalized.value || !folderIds.has(normalized.value)) {
        if (normalized.value) mappingProblems.push(problem('CONTENT_DECK_FOLDER_BOOTSTRAP_FOLDER_MISSING', `${family} assignment references a missing folder: ${normalized.value}`, assignment.sourcePath));
        return undefined;
      }
      return { ...assignment, folderId: normalized.value };
    };
    const normalizedDecks = request.deckAssignments.flatMap((entry) => {
      const normalized = normalizeAssignment(entry, 'Deck');
      return normalized ? [normalized] : [];
    });
    const normalizedGates = request.gateAssignments.flatMap((entry) => {
      const normalized = normalizeAssignment(entry, 'Gate');
      return normalized ? [normalized] : [];
    });
    const duplicatePaths = (assignments: readonly { sourcePath: string }[], family: 'Deck' | 'Gate'): void => {
      const seen = new Set<string>();
      for (const assignment of assignments) {
        if (seen.has(assignment.sourcePath)) mappingProblems.push(problem('CONTENT_DECK_FOLDER_BOOTSTRAP_MAPPING_DUPLICATE', `Duplicate ${family} assignment: ${assignment.sourcePath}`, assignment.sourcePath));
        seen.add(assignment.sourcePath);
      }
    };
    duplicatePaths(normalizedDecks, 'Deck');
    duplicatePaths(normalizedGates, 'Gate');

    const discoveredDecks = Object.values(before.bundle.decks).sort((left, right) => left.source.sourcePath.localeCompare(right.source.sourcePath));
    const discoveredGates = [...before.bundle.gates].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
    const deckByPath = new Map(discoveredDecks.map((entry) => [entry.source.sourcePath, entry]));
    const gateByPath = new Map(discoveredGates.map((entry) => [entry.sourcePath, entry]));
    const deckAssignmentByPath = new Map(normalizedDecks.map((entry) => [entry.sourcePath, entry]));
    const gateAssignmentByPath = new Map(normalizedGates.map((entry) => [entry.sourcePath, entry]));
    for (const sourcePath of deckByPath.keys()) {
      if (!deckAssignmentByPath.has(sourcePath)) mappingProblems.push(problem('CONTENT_DECK_FOLDER_BOOTSTRAP_MAPPING_MISSING', `Deck assignment is required for ${sourcePath}`, sourcePath));
    }
    for (const sourcePath of gateByPath.keys()) {
      if (!gateAssignmentByPath.has(sourcePath)) mappingProblems.push(problem('CONTENT_DECK_FOLDER_BOOTSTRAP_MAPPING_MISSING', `Gate assignment is required for ${sourcePath}`, sourcePath));
    }
    for (const assignment of normalizedDecks) {
      const deck = deckByPath.get(assignment.sourcePath);
      if (!deck) mappingProblems.push(problem('CONTENT_DECK_FOLDER_BOOTSTRAP_MAPPING_UNKNOWN', `Deck source is not part of the active content snapshot: ${assignment.sourcePath}`, assignment.sourcePath));
      else {
        const expectedSidecarPath = deck.source.sourcePath.replace(/\.decklist$/iu, '.json');
        if (assignment.sidecarSourcePath !== undefined && assignment.sidecarSourcePath !== expectedSidecarPath) {
          mappingProblems.push(problem('CONTENT_DECK_FOLDER_BOOTSTRAP_SIDECAR_MISMATCH', `Deck sidecar must be ${expectedSidecarPath}`, assignment.sidecarSourcePath));
        }
      }
    }
    for (const assignment of normalizedGates) {
      if (!gateByPath.has(assignment.sourcePath)) mappingProblems.push(problem('CONTENT_DECK_FOLDER_BOOTSTRAP_MAPPING_UNKNOWN', `Gate source is not part of the active content snapshot: ${assignment.sourcePath}`, assignment.sourcePath));
    }
    if (mappingProblems.length) return failure(mappingProblems, 'COMMAND_FAILED');

    const orderedDeckAssignments = discoveredDecks.map((deck) => deckAssignmentByPath.get(deck.source.sourcePath) as ContentDeckFolderBootstrapAssignment);
    const orderedGateAssignments = discoveredGates.map((gate) => gateAssignmentByPath.get(gate.sourcePath) as ContentGateFolderBootstrapAssignment);
    const previewSignature = bootstrapSignature(request, orderedDeckAssignments, orderedGateAssignments);
    if (request.confirmApply && (!request.previewSignature || request.previewSignature !== previewSignature)) {
      return failure([problem('CONTENT_DECK_FOLDER_BOOTSTRAP_SIGNATURE_INVALID', 'Apply requires the matching previewSignature for this exact Deck-folder candidate')], 'COMMAND_FAILED');
    }

    const parent = path.dirname(paths.contentRoot);
    const token = `${process.pid}-${Date.now()}`;
    stagingPath = path.join(parent, `.content-deck-folder-stage-${token}`);
    const backupPath = path.join(parent, `.content-deck-folder-backup-${token}`);
    await fs.cp(paths.contentRoot, stagingPath, { recursive: true, errorOnExist: true });
    const stagedCatalog = await documentPath(stagingPath, catalogSourcePath);
    await atomicWriteText(stagedCatalog, `${JSON.stringify(request.catalog, null, 2)}\n`, false);

    const deckSidecars: Array<{ sourcePath: string; sidecarSourcePath: string; folderId: string; existed: boolean }> = [];
    for (const assignment of orderedDeckAssignments) {
      const deck = deckByPath.get(assignment.sourcePath) as (typeof discoveredDecks)[number];
      const sidecarSourcePath = deck.source.sourcePath.replace(/\.decklist$/iu, '.json');
      const candidate = withDeckFolderMetadata(deck.sidecar?.value, assignment.folderId);
      const stagedSidecar = await documentPath(stagingPath, sidecarSourcePath);
      await atomicWriteText(stagedSidecar, `${JSON.stringify(candidate, null, 2)}\n`, Boolean(deck.sidecar));
      deckSidecars.push({ sourcePath: assignment.sourcePath, sidecarSourcePath, folderId: assignment.folderId, existed: Boolean(deck.sidecar) });
    }
    const gates: Array<{ sourcePath: string; folderId: string }> = [];
    for (const assignment of orderedGateAssignments) {
      const gate = gateByPath.get(assignment.sourcePath) as (typeof discoveredGates)[number];
      const candidate = withGateDeckFolder(gate.value, assignment.folderId);
      if (!candidate) return failure([problem('CONTENT_DECK_FOLDER_BOOTSTRAP_GATE_INVALID', 'Gate candidate requires an object payload', assignment.sourcePath)], 'COMMAND_FAILED');
      const stagedGate = await documentPath(stagingPath, assignment.sourcePath);
      await atomicWriteText(stagedGate, `${JSON.stringify(candidate, null, 2)}\n`, true);
      gates.push({ sourcePath: assignment.sourcePath, folderId: assignment.folderId });
    }

    const validated = await validateCampaignContentOperation({ ...options, contentRoot: stagingPath });
    const preview = {
      expectedContentGeneration: request.expectedContentGeneration,
      contentGeneration: request.expectedContentGeneration,
      catalogSourcePath,
      catalog: JSON.parse(JSON.stringify(request.catalog)) as Record<string, unknown>,
      deckSidecars,
      gates,
      previewSignature,
    };
    if (!validated.ok) return { ...failure(validated.problems, 'COMMAND_FAILED', validated.warnings), data: preview };
    if (!request.confirmApply) return result({ ...preview, requiresConfirmation: true, applied: false }, validated.warnings);

    const current = await discoverCampaignIrBundle(paths.contentRoot);
    if (!current.ok || !current.bundle) return failure(current.problems, 'COMMAND_FAILED');
    if (current.bundle.snapshot.contentGeneration !== request.expectedContentGeneration || current.bundle.deckFolderSource) {
      return failure([problem('CONTENT_GENERATION_STALE', 'Authored content changed while validating this Deck-folder bootstrap')], 'COMMAND_FAILED');
    }
    await publishAtomicDirectory({ root: parent, stagingPath, finalPath: paths.contentRoot, backupPath });
    stagingPath = '';
    const after = await discoverCampaignIrBundle(paths.contentRoot);
    if (!after.ok || !after.bundle) return failure(after.problems, 'COMMAND_FAILED');
    return result({ ...preview, contentGeneration: after.bundle.snapshot.contentGeneration, applied: true }, validated.warnings);
  } catch (error) {
    return failure([problem('CONTENT_DECK_FOLDER_BOOTSTRAP_FAILED', String(error))], 'COMMAND_FAILED');
  } finally {
    if (stagingPath) await fs.rm(stagingPath, { recursive: true, force: true });
  }
};

const runtimePolicyFamilies: readonly RuntimePolicyFamily[] = ['settings', 'shop', 'client'];

const runtimePolicyRoot = (manifest: ContentManifest): string =>
  (manifest.directories?.runtimePolicy || 'runtime-policy').replace(/\\/gu, '/').replace(/\/$/u, '');

const policyPayload = (document: unknown): Record<string, unknown> => {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return {};
  const object = document as Record<string, unknown>;
  return object.payload && typeof object.payload === 'object' && !Array.isArray(object.payload)
    ? object.payload as Record<string, unknown>
    : object;
};

const policyDocument = (existing: unknown, payload: Record<string, unknown>): Record<string, unknown> => {
  if (existing && typeof existing === 'object' && !Array.isArray(existing)
    && Object.prototype.hasOwnProperty.call(existing, 'payload')) {
    return { ...(existing as Record<string, unknown>), payload };
  }
  return payload;
};

const runtimePolicySemanticDiff = (
  before: Record<string, Record<string, unknown>>,
  after: Record<string, Record<string, unknown>>,
) => runtimePolicyFamilies.flatMap((family) => {
  const keys = [...new Set([...Object.keys(before[family] || {}), ...Object.keys(after[family] || {})])].sort();
  return keys.flatMap((key) => {
    const previous = before[family]?.[key];
    const next = after[family]?.[key];
    if (JSON.stringify(previous) === JSON.stringify(next)) return [];
    return [{ family, key, before: previous ?? null, after: next ?? null }];
  });
});

/** Read the complete allowlisted runtime-policy authoring model without
 * exposing filesystem access to the renderer. */
export const readCampaignRuntimePolicy = async (
  options: ContentOperationPaths,
): Promise<OperationResult<unknown>> => {
  try {
    const paths = operationPaths(options);
    const loaded = await discoverCampaignIrBundle(paths.contentRoot);
    if (!loaded.ok || !loaded.bundle) return failure(loaded.problems, 'COMMAND_FAILED');
    const root = runtimePolicyRoot(loaded.bundle.manifest);
    const policy: Record<string, Record<string, unknown>> = {};
    const documents: Record<string, { sourcePath: string; shape: 'raw' | 'wrapped'; content: string | null }> = {};
    for (const family of runtimePolicyFamilies) {
      const sourcePath = `${root}/${family}.json`;
      const file = await documentPath(paths.contentRoot, sourcePath);
      if (!(await exists(file))) {
        policy[family] = {};
        documents[family] = { sourcePath, shape: 'wrapped', content: null };
        continue;
      }
      const content = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(content) as unknown;
      const wrapped = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.prototype.hasOwnProperty.call(parsed, 'payload'));
      policy[family] = policyPayload(parsed);
      documents[family] = { sourcePath, shape: wrapped ? 'wrapped' : 'raw', content };
    }
    return result({
      contentGeneration: loaded.bundle.snapshot.contentGeneration,
      policy,
      documents,
      fieldDefinitions: RUNTIME_POLICY_FIELD_DEFINITIONS,
      authority: {
        authoredRoot: 'campaign/content',
        generatedIrEditable: false,
        freshDeploymentPatchOnly: true,
        playerJsonEditable: false,
      },
    });
  } catch (error) {
    return failure([problem('CONTENT_RUNTIME_POLICY_READ_FAILED', String(error))], 'COMMAND_FAILED');
  }
};

/** Preview and atomically publish the three runtime-policy documents through
 * the EDITOR-009 content boundary. Existing wrapped-document sibling fields
 * survive because only payload is replaced. */
export const mutateCampaignRuntimePolicy = async (
  options: ContentExecutionOptions,
  mutation: ContentRuntimePolicyMutation,
): Promise<OperationResult<unknown>> => {
  const paths = operationPaths(options);
  let stagingPath = '';
  try {
    if (!mutation.expectedContentGeneration) return failure([problem('CONTENT_EXPECTED_GENERATION_REQUIRED', 'Runtime-policy mutation requires expectedContentGeneration')], 'USAGE_ERROR');
    if (!mutation.policy || typeof mutation.policy !== 'object' || Array.isArray(mutation.policy)) return failure([problem('RUNTIME_POLICY_INVALID', 'Runtime policy must be an object')], 'USAGE_ERROR');
    const before = await discoverCampaignIrBundle(paths.contentRoot);
    if (!before.ok || !before.bundle) return failure(before.problems, 'COMMAND_FAILED');
    if (before.bundle.snapshot.contentGeneration !== mutation.expectedContentGeneration) return failure([problem('CONTENT_GENERATION_STALE', 'Authored content changed before this runtime-policy mutation')], 'COMMAND_FAILED');
    const root = runtimePolicyRoot(before.bundle.manifest);
    const normalized: Record<string, Record<string, unknown>> = {};
    const validationProblems: Problem[] = [];
    for (const family of runtimePolicyFamilies) {
      const value = mutation.policy[family];
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        validationProblems.push(problem('RUNTIME_POLICY_INVALID', `Runtime policy ${family} must be an object`, `${root}/${family}.json`));
        continue;
      }
      normalized[family] = value;
      validationProblems.push(...validateRuntimePolicyPatch(family, value, `${root}/${family}.json`));
    }
    if (validationProblems.some((entry) => entry.severity !== 'warning')) return failure(validationProblems, 'COMMAND_FAILED');

    const previous: Record<string, Record<string, unknown>> = {};
    const parent = path.dirname(paths.contentRoot);
    const token = `${process.pid}-${Date.now()}`;
    stagingPath = path.join(parent, `.content-runtime-policy-stage-${token}`);
    const backupPath = path.join(parent, `.content-runtime-policy-backup-${token}`);
    await fs.cp(paths.contentRoot, stagingPath, { recursive: true, errorOnExist: true });
    for (const family of runtimePolicyFamilies) {
      const sourcePath = `${root}/${family}.json`;
      const originalPath = await documentPath(paths.contentRoot, sourcePath);
      const stagedTarget = await documentPath(stagingPath, sourcePath);
      const existing = await exists(originalPath) ? JSON.parse(await fs.readFile(originalPath, 'utf8')) as unknown : undefined;
      previous[family] = policyPayload(existing);
      await atomicWriteText(stagedTarget, `${JSON.stringify(policyDocument(existing, normalized[family]), null, 2)}\n`, await exists(stagedTarget));
    }
    const preview = await validateCampaignContentOperation({ ...options, contentRoot: stagingPath });
    const semanticDiff = runtimePolicySemanticDiff(previous, normalized);
    const warnings = [...validationProblems.filter((entry) => entry.severity === 'warning'), ...preview.warnings];
    const data = { policy: normalized, semanticDiff, freshDeploymentPatchOnly: true, playerJsonEditable: false };
    if (!preview.ok) return { ...failure(preview.problems, 'COMMAND_FAILED', warnings), data };
    if (!mutation.confirmApply) return result({ ...data, requiresConfirmation: true }, warnings);

    const current = await discoverCampaignIrBundle(paths.contentRoot);
    if (!current.ok || !current.bundle) return failure(current.problems, 'COMMAND_FAILED');
    if (current.bundle.snapshot.contentGeneration !== mutation.expectedContentGeneration) return failure([problem('CONTENT_GENERATION_STALE', 'Authored content changed while validating this runtime-policy mutation')], 'COMMAND_FAILED');
    await publishAtomicDirectory({ root: parent, stagingPath, finalPath: paths.contentRoot, backupPath });
    stagingPath = '';
    const after = await discoverCampaignIrBundle(paths.contentRoot);
    return result({ ...data, contentGeneration: after.bundle?.snapshot.contentGeneration, applied: true }, warnings);
  } catch (error) {
    return failure([problem('CONTENT_RUNTIME_POLICY_MUTATION_FAILED', String(error))], 'COMMAND_FAILED');
  } finally {
    if (stagingPath) await fs.rm(stagingPath, { recursive: true, force: true });
  }
};

const localizationAssetRoots = (manifest: ContentManifest) => ({
  localization: (manifest.directories?.localization || 'localization').replace(/\\/gu, '/').replace(/\/$/u, ''),
  assets: (manifest.directories?.assets || 'assets').replace(/\\/gu, '/').replace(/\/$/u, ''),
});

const localizationReferenceFields = new Set([
  'nameKey', 'nameRef', 'descriptionKey', 'descriptionRef', 'playerNameKey', 'cpuNameKey',
]);

const collectLocalizationReferences = (
  value: unknown,
  sourcePath: string,
  pointer = '',
  output: Array<{ key: string; sourcePath: string; jsonPointer: string }> = [],
): Array<{ key: string; sourcePath: string; jsonPointer: string }> => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectLocalizationReferences(entry, sourcePath, `${pointer}/${index}`, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  for (const [field, entry] of Object.entries(value as Record<string, unknown>)) {
    const childPointer = `${pointer}/${field}`;
    if (localizationReferenceFields.has(field)) {
      const key = typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && typeof (entry as { key?: unknown }).key === 'string'
          ? String((entry as { key: string }).key)
          : undefined;
      if (key) output.push({ key, sourcePath, jsonPointer: childPointer });
    }
    collectLocalizationReferences(entry, sourcePath, childPointer, output);
  }
  return output;
};

/** Read-only localization completeness and safe local asset preview. Binary
 * bytes are never changed and only bounded PNG data URLs cross preload. */
export const inspectCampaignLocalizationAssets = async (
  options: ContentExecutionOptions,
): Promise<OperationResult<unknown>> => {
  try {
    const paths = operationPaths(options);
    const loaded = await discoverCampaignIrBundle(paths.contentRoot);
    if (!loaded.ok || !loaded.bundle) return failure(loaded.problems, 'COMMAND_FAILED');
    const bundle = loaded.bundle;
    const roots = localizationAssetRoots(bundle.manifest);
    const references = [
      ...bundle.gates.flatMap((entry) => collectLocalizationReferences(entry.value, entry.sourcePath)),
      ...bundle.structures.flatMap((entry) => collectLocalizationReferences(entry.value, entry.sourcePath)),
      ...bundle.shops.flatMap((entry) => collectLocalizationReferences(entry.metadata.value, entry.metadata.sourcePath)),
    ];
    const languages = Object.keys(bundle.localization?.languages || {}).sort();
    const referenceSummary = [...new Set(references.map((entry) => entry.key))].sort().map((key) => ({
      key,
      missingLanguages: languages.filter((language) => bundle.localization?.languages[language]?.[key] === undefined),
      usages: references.filter((entry) => entry.key === key),
    }));

    const manifestPath = `${roots.assets}/manifest.json`;
    let manifest: AssetManifest = { formatVersion: 1, assets: [] };
    if (await exists(await documentPath(paths.contentRoot, manifestPath))) {
      manifest = JSON.parse(await fs.readFile(await documentPath(paths.contentRoot, manifestPath), 'utf8')) as AssetManifest;
    }
    const backgrounds = new Map(bundle.gateBackgrounds.map((entry) => [entry.key, entry]));
    const registry = options.registry || (await exists(paths.registryPath) ? await readRegistry(paths.registryPath) : createEmptyRegistry());
    const assets = (Array.isArray(manifest.assets) ? manifest.assets : []).map((entry) => {
      const background = backgrounds.get(entry.key);
      const dimensions = background ? inspectGateBackgroundPng(background.bytes) : undefined;
      const gateRefs = Array.isArray(entry.gateRefs) ? entry.gateRefs.filter((item): item is string => typeof item === 'string') : [];
      const targetPaths = gateRefs.flatMap((reference) => {
        const key = reference.startsWith('gate:') ? reference.slice(5) : '';
        const id = registry.namespaces.gate.assignments[key]?.id;
        return id === undefined ? [] : [`Data/ClientData/SoloGateBackgrounds/${id}.png`];
      });
      return {
        key: entry.key,
        source: entry.source,
        role: entry.role,
        provenance: entry.provenance || null,
        license: entry.license || null,
        gateRefs,
        targetPaths,
        dimensions: dimensions || null,
        previewDataUrl: background && background.bytes.byteLength <= 5 * 1024 * 1024
          ? `data:image/png;base64,${Buffer.from(background.bytes).toString('base64')}`
          : null,
        previewReadOnly: true,
      };
    });
    return result({
      contentGeneration: bundle.snapshot.contentGeneration,
      localization: {
        fallbackLanguage: bundle.localization?.fallbackLanguage || null,
        languages,
        referencedKeys: referenceSummary,
      },
      assets,
      authority: { authoredRoot: 'campaign/content', generatedIrEditable: false, previewMutatesSource: false },
    });
  } catch (error) {
    return failure([problem('CONTENT_LOCALIZATION_ASSET_INSPECT_FAILED', String(error))], 'COMMAND_FAILED');
  }
};

/** Restrict EDITOR-015 writes to localization JSON and the asset manifest,
 * then delegate every safety invariant to EDITOR-009. */
export const mutateCampaignLocalizationAssetDocument = async (
  options: ContentExecutionOptions,
  mutation: ContentLocalizationAssetMutation,
): Promise<OperationResult<unknown>> => {
  try {
    const paths = operationPaths(options);
    const loaded = await discoverCampaignIrBundle(paths.contentRoot);
    if (!loaded.ok || !loaded.bundle) return failure(loaded.problems, 'COMMAND_FAILED');
    const roots = localizationAssetRoots(loaded.bundle.manifest);
    const normalized = mutation.sourcePath.replace(/\\/gu, '/');
    const segments = normalized.split('/');
    const canonical = path.posix.normalize(normalized) === normalized
      && !segments.some((entry) => !entry || entry === '.' || entry === '..');
    const localizationPath = canonical
      && normalized.startsWith(`${roots.localization}/`)
      && path.posix.extname(normalized).toLowerCase() === '.json';
    const manifestPath = normalized === `${roots.assets}/manifest.json`;
    if (!localizationPath && !manifestPath) {
      return failure([problem(
        'CONTENT_LOCALIZATION_ASSET_PATH_UNAUTHORIZED',
        `Localization/asset authoring is limited to ${roots.localization}/*.json and ${roots.assets}/manifest.json`,
        mutation.sourcePath,
      )], 'PATH_ERROR');
    }
    const mutated = await mutateCampaignContentDocument(options, mutation);
    if (!mutated.ok || !mutation.confirmApply) return mutated;
    const inspected = await inspectCampaignLocalizationAssets(options);
    if (!inspected.ok) return inspected;
    return result({ mutation: mutated.data, preview: inspected.data, applied: true }, [...mutated.warnings, ...inspected.warnings]);
  } catch (error) {
    return failure([problem('CONTENT_LOCALIZATION_ASSET_MUTATION_FAILED', String(error), mutation.sourcePath)], 'COMMAND_FAILED');
  }
};

/** Validate a Structure metadata mutation through the shared compiler and add
 * its fixture-backed target projection to the normal EDITOR-009 document
 * preview. Applying still delegates to the content-aware atomic writer. */
export const mutateCampaignStructureDocument = async (
  options: ContentExecutionOptions,
  mutation: ContentStructureMutation,
): Promise<OperationResult<unknown>> => {
  const paths = operationPaths(options);
  let stageProjectRoot = '';
  try {
    if (!mutation.expectedContentGeneration) {
      return failure([problem('CONTENT_EXPECTED_GENERATION_REQUIRED', 'Structure mutation requires expectedContentGeneration', mutation.sourcePath)], 'USAGE_ERROR');
    }
    const before = await discoverCampaignIrBundle(paths.contentRoot);
    if (!before.ok || !before.bundle) return failure(before.problems, 'COMMAND_FAILED');
    if (before.bundle.snapshot.contentGeneration !== mutation.expectedContentGeneration) {
      return failure([problem('CONTENT_GENERATION_STALE', 'Authored content changed before this Structure mutation', mutation.sourcePath)], 'COMMAND_FAILED');
    }
    const structureRoot = (before.bundle.manifest.directories?.structures || 'structures').replace(/\\/gu, '/').replace(/\/$/u, '');
    const segments = mutation.sourcePath.replace(/\\/gu, '/').split('/');
    if (!mutation.sourcePath.startsWith(`${structureRoot}/`) || segments.some((entry) => entry === '.' || entry === '..') || path.posix.extname(mutation.sourcePath).toLowerCase() !== '.json') {
      return failure([problem('CONTENT_STRUCTURE_PATH_UNAUTHORIZED', `Structure metadata must stay inside ${structureRoot}/ and end in .json`, mutation.sourcePath)], 'PATH_ERROR');
    }
    const target = await documentPath(paths.contentRoot, mutation.sourcePath);
    const targetExists = await exists(target);
    if (mutation.operation === 'create' && targetExists) return failure([problem('CONTENT_DOCUMENT_EXISTS', 'Document already exists', mutation.sourcePath)], 'COMMAND_FAILED');
    if (mutation.operation !== 'create' && !targetExists) return failure([problem('CONTENT_DOCUMENT_MISSING', 'Document does not exist', mutation.sourcePath)], 'COMMAND_FAILED');
    if ((mutation.operation === 'create' || mutation.operation === 'update') && typeof mutation.content !== 'string') {
      return failure([problem('CONTENT_DOCUMENT_CONTENT_REQUIRED', `${mutation.operation} requires document content`, mutation.sourcePath)], 'USAGE_ERROR');
    }

    stageProjectRoot = path.join(path.resolve(options.projectRoot), `.structure-stage-${process.pid}-${Date.now()}`);
    const stage = path.join(stageProjectRoot, 'campaign', 'content');
    await fs.mkdir(path.dirname(stage), { recursive: true });
    await fs.cp(paths.contentRoot, stage, { recursive: true, errorOnExist: true });
    const stagedTarget = await documentPath(stage, mutation.sourcePath);
    if (mutation.operation === 'delete') await fs.rm(stagedTarget);
    else await atomicWriteText(stagedTarget, mutation.content as string, mutation.operation !== 'create');

    const compiled = await compileCore({ ...options, projectRoot: stageProjectRoot, contentRoot: stage }, true);
    const layered = await validateLayeredCampaign({ checkOnly: true, compileCheck: () => compiled });
    const stagedBundle = await discoverCampaignIrBundle(stage);
    const structureIndex = stagedBundle.bundle?.structures.findIndex((entry) => entry.sourcePath === mutation.sourcePath) ?? -1;
    const projection = !layered.ok || structureIndex < 0 ? null : compiled.structureProjections?.[structureIndex] || null;
    const preview = {
      sourcePath: mutation.sourcePath,
      operation: mutation.operation,
      projection,
      capability: {
        status: 'assumed',
        contractVersion: YGOMASTER_TARGET_CONTRACT_VERSION,
        evidence: 'CAMPAIGN-008 approved v1.77 fixture adapter',
        limitation: 'Structure reward quantity and one-copy behavior require runtime QA',
      },
    };
    const editedPointers: Record<string, string> = {
      STRUCTURE_DECK_MISSING: '/payload/deck',
      STRUCTURE_DECK_REFERENCE_INVALID: '/payload/deck',
      STRUCTURE_REWARD_ORPHAN: '/payload/reward',
      STRUCTURE_FOCUS_MISSING: '/payload/focus',
      CARD_NAME_UNRESOLVED: '/payload/focus',
    };
    const locateEditedProblem = (entry: Problem): Problem => editedPointers[entry.code] && !entry.sourcePath && !entry.path
      ? { ...entry, sourcePath: mutation.sourcePath, path: mutation.sourcePath, jsonPointer: entry.jsonPointer || editedPointers[entry.code] }
      : entry;
    const locatedProblems = layered.problems.map(locateEditedProblem);
    const locatedWarnings = layered.warnings.map(locateEditedProblem);
    if (!layered.ok) return { ...failure(locatedProblems, 'COMMAND_FAILED', locatedWarnings), data: preview };
    if (!mutation.confirmApply) return result({ ...preview, requiresConfirmation: true }, locatedWarnings);

    const applied = await mutateCampaignContentDocument(options, mutation);
    if (!applied.ok) return applied;
    return result({ ...preview, mutation: applied.data, applied: true }, [...locatedWarnings, ...applied.warnings]);
  } catch (error) {
    return failure([problem('CONTENT_STRUCTURE_MUTATION_FAILED', String(error), mutation.sourcePath)], 'COMMAND_FAILED');
  } finally {
    if (stageProjectRoot) await fs.rm(stageProjectRoot, { recursive: true, force: true });
  }
};

const regulationRoot = (manifest: ContentManifest): string =>
  (manifest.directories?.regulations || 'regulations').replace(/\\/gu, '/').replace(/\/$/u, '');

class ContentRegulationPathError extends Error {
  readonly sourcePath: string;
  constructor(message: string, sourcePath: string) {
    super(message);
    this.name = 'ContentRegulationPathError';
    this.sourcePath = sourcePath;
  }
}

const assertRegulationDocumentPaths = async (
  contentRoot: string,
  manifest: ContentManifest,
  mutation: Pick<ContentRegulationMutation, 'metadata' | 'rules'>,
): Promise<void> => {
  const root = regulationRoot(manifest);
  const metadata = mutation.metadata.sourcePath.replace(/\\/gu, '/');
  const rules = mutation.rules.sourcePath.replace(/\\/gu, '/');
  for (const [sourcePath, extension] of [[metadata, '.json'], [rules, '.regulation']] as const) {
    const segments = sourcePath.split('/');
    if (!sourcePath.startsWith(`${root}/`) || segments.some((entry) => entry === '.' || entry === '..') || path.posix.extname(sourcePath).toLowerCase() !== extension) {
      throw new ContentRegulationPathError(`Regulation document must stay inside ${root}/ and end in ${extension}`, sourcePath);
    }
    await documentPath(contentRoot, sourcePath);
  }
  if (metadata.slice(0, -'.json'.length) !== rules.slice(0, -'.regulation'.length)) {
    throw new ContentRegulationPathError('Regulation metadata and rules must use the same path stem', rules);
  }
};

const normalizedRegulation = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('regulation:') ? trimmed : `regulation:${trimmed}`;
};

const regulationImpacts = (
  bundle: NonNullable<Awaited<ReturnType<typeof discoverCampaignIrBundle>>['bundle']>,
  regulationId: string,
) => {
  const decks = Object.values(bundle.decks)
    .filter((entry) => normalizedRegulation(entry.regulation) === regulationId);
  const deckReferences = new Set(decks.flatMap((entry) => {
    const stem = entry.key.replace(/\.decklist$/iu, '');
    return [entry.key, entry.source.sourcePath, `deck:${stem}`, stem];
  }));
  const gates = bundle.gates.flatMap((entry) => {
    const parsed = parseGateContent(entry.value, entry.sourcePath);
    return parsed.document?.gate.regulation === regulationId ? [entry.sourcePath] : [];
  });
  const structures = bundle.structures.flatMap((entry) => {
    const parsed = parseStructureContent(entry.value, entry.sourcePath);
    const payload = parsed.payload;
    const reference = [payload?.deck, payload?.deckRef, payload?.decklist, payload?.decklistRef]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return reference && deckReferences.has(reference) ? [{ sourcePath: entry.sourcePath, viaDeck: reference }] : [];
  });
  return {
    decks: decks.map((entry) => entry.source.sourcePath).sort(),
    gates: gates.sort(),
    structures: structures.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
  };
};

export const readCampaignRegulationDocuments = async (
  options: ContentOperationPaths & { sourcePath: string },
): Promise<OperationResult<unknown>> => {
  try {
    const paths = operationPaths(options);
    const loaded = await discoverCampaignIrBundle(paths.contentRoot);
    if (!loaded.ok || !loaded.bundle) return failure(loaded.problems, 'COMMAND_FAILED');
    const root = regulationRoot(loaded.bundle.manifest);
    if (!options.sourcePath.startsWith(`${root}/`) || !options.sourcePath.endsWith('.json')) {
      return failure([problem('CONTENT_REGULATION_PATH_UNAUTHORIZED', `Regulation metadata must stay inside ${root}/`, options.sourcePath)], 'PATH_ERROR');
    }
    const regulation = Object.values(loaded.bundle.regulations).find((entry) => entry.metadata.sourcePath === options.sourcePath);
    if (!regulation) return failure([problem('CONTENT_REGULATION_DOCUMENT_MISSING', 'Regulation metadata or its paired rules document is missing', options.sourcePath)], 'COMMAND_FAILED');
    return result({
      contentGeneration: loaded.bundle.snapshot.contentGeneration,
      metadata: { sourcePath: regulation.metadata.sourcePath, content: await fs.readFile(await documentPath(paths.contentRoot, regulation.metadata.sourcePath), 'utf8') },
      rules: { sourcePath: regulation.rules.sourcePath, content: await fs.readFile(await documentPath(paths.contentRoot, regulation.rules.sourcePath), 'utf8') },
    });
  } catch (error) {
    return failure([problem('CONTENT_REGULATION_READ_FAILED', String(error), options.sourcePath)], 'PATH_ERROR');
  }
};

/** Preview or atomically publish a paired Regulation metadata/rules edit.
 * Runtime Regulation Data remains unsupported; this operation validates only
 * authored legality and every existing core consumer. */
export const mutateCampaignRegulationDocuments = async (
  options: ContentExecutionOptions,
  mutation: ContentRegulationMutation,
): Promise<OperationResult<unknown>> => {
  const paths = operationPaths(options);
  let stagingPath = '';
  try {
    if (!mutation.expectedContentGeneration) return failure([problem('CONTENT_EXPECTED_GENERATION_REQUIRED', 'Regulation mutation requires expectedContentGeneration')], 'USAGE_ERROR');
    const before = await discoverCampaignIrBundle(paths.contentRoot);
    if (!before.ok || !before.bundle) return failure(before.problems, 'COMMAND_FAILED');
    if (before.bundle.snapshot.contentGeneration !== mutation.expectedContentGeneration) return failure([problem('CONTENT_GENERATION_STALE', 'Authored content changed before this Regulation mutation', mutation.metadata.sourcePath)], 'COMMAND_FAILED');
    await assertRegulationDocumentPaths(paths.contentRoot, before.bundle.manifest, mutation);
    const metadataTarget = await documentPath(paths.contentRoot, mutation.metadata.sourcePath);
    const rulesTarget = await documentPath(paths.contentRoot, mutation.rules.sourcePath);
    const pairExists = [await exists(metadataTarget), await exists(rulesTarget)];
    if (mutation.operation === 'create' && pairExists.some(Boolean)) return failure([problem('CONTENT_DOCUMENT_EXISTS', 'Regulation metadata or rules already exists', mutation.metadata.sourcePath)], 'COMMAND_FAILED');
    if (mutation.operation !== 'create' && pairExists.some((value) => !value)) return failure([problem('CONTENT_DOCUMENT_MISSING', 'Regulation metadata or rules does not exist', mutation.metadata.sourcePath)], 'COMMAND_FAILED');
    const deletedSource = mutation.operation === 'delete' ? {
      metadata: await fs.readFile(metadataTarget, 'utf8'),
      rules: await fs.readFile(rulesTarget, 'utf8'),
    } : undefined;

    let metadataValue: unknown;
    if (mutation.operation === 'delete') {
      metadataValue = Object.values(before.bundle.regulations).find((entry) => entry.metadata.sourcePath === mutation.metadata.sourcePath)?.metadata.value;
    } else {
      try { metadataValue = JSON.parse(mutation.metadata.content) as unknown; } catch (error) {
        return failure([problem('CONTENT_REGULATION_METADATA_INVALID', String(error), mutation.metadata.sourcePath)], 'COMMAND_FAILED');
      }
    }
    const parsedMetadata = parseRegulationMetadata(metadataValue, mutation.metadata.sourcePath);
    if (!parsedMetadata.document) return failure(parsedMetadata.problems, 'COMMAND_FAILED');
    const regulationId = parsedMetadata.document.metadata.normalizedRegulationId;
    const parent = path.dirname(paths.contentRoot);
    const token = `${process.pid}-${Date.now()}`;
    stagingPath = path.join(parent, `.content-regulation-stage-${token}`);
    const backupPath = path.join(parent, `.content-regulation-backup-${token}`);
    await fs.cp(paths.contentRoot, stagingPath, { recursive: true, errorOnExist: true });
    if (mutation.operation === 'delete') {
      await fs.rm(await documentPath(stagingPath, mutation.metadata.sourcePath));
      await fs.rm(await documentPath(stagingPath, mutation.rules.sourcePath));
    } else {
      await atomicWriteText(await documentPath(stagingPath, mutation.metadata.sourcePath), mutation.metadata.content, mutation.operation === 'update');
      await atomicWriteText(await documentPath(stagingPath, mutation.rules.sourcePath), mutation.rules.content, mutation.operation === 'update');
    }

    const stagedBundle = await discoverCampaignIrBundle(stagingPath);
    const stagedRegulation = stagedBundle.bundle && Object.values(stagedBundle.bundle.regulations)
      .find((entry) => entry.metadata.sourcePath === mutation.metadata.sourcePath);
    const inputs = await executionInputs(options);
    const validation = stagedRegulation ? validateRegulationContent({
      metadata: stagedRegulation.metadata.value,
      rules: stagedRegulation.rules.value,
      metadataSourcePath: stagedRegulation.metadata.sourcePath,
      rulesSourcePath: stagedRegulation.rules.sourcePath,
    }, inputs.resolver) : undefined;
    const impacts = regulationImpacts(stagedBundle.bundle || before.bundle, regulationId);
    const capability = { ...regulationCapabilityGolden(), deployable: false, projection: null };
    const preview = {
      sourcePaths: { metadata: mutation.metadata.sourcePath, rules: mutation.rules.sourcePath },
      operation: mutation.operation,
      contentLegality: validation ? {
        status: validation.ok ? 'valid' : 'invalid',
        regulationId,
        cutoffRef: validation.metadata?.metadata.cutoffRef,
        allowedRef: validation.metadata?.metadata.allowedRef,
        sections: Object.fromEntries(Object.entries(validation.rules.sections).map(([key, entries]) => [key, entries.length])),
        resolutions: validation.resolutions.map((entry) => ({
          sourceName: entry.sourceName,
          ...(entry.runtimeId === undefined ? {} : { runtimeId: entry.runtimeId }),
          matchKind: entry.lockEntry?.matchKind,
          candidates: entry.candidates,
          suggestions: entry.suggestions,
          problems: entry.problems,
          sourceSpan: entry.lockEntry?.sourceSpan,
        })),
        impacts,
      } : { status: mutation.operation === 'delete' ? 'removed' : 'invalid', regulationId, impacts },
      runtimeTarget: capability,
    };
    if (!stagedBundle.ok || !stagedBundle.bundle) return { ...failure(stagedBundle.problems, 'COMMAND_FAILED'), data: preview };
    const compiled = await compileCore({ ...options, contentRoot: stagingPath }, true);
    const layered = await validateLayeredCampaign({ checkOnly: true, compileCheck: () => compiled });
    const directProblems = validation?.problems.filter((entry) => entry.severity !== 'warning') || [];
    if (directProblems.length || !layered.ok) return { ...failure([...directProblems, ...layered.problems], 'COMMAND_FAILED', [...(validation?.warnings || []), ...layered.warnings]), data: preview };
    if (!mutation.confirmApply) return result({ ...preview, requiresConfirmation: true }, layered.warnings);

    const current = await discoverCampaignIrBundle(paths.contentRoot);
    if (!current.ok || !current.bundle) return failure(current.problems, 'COMMAND_FAILED');
    if (current.bundle.snapshot.contentGeneration !== mutation.expectedContentGeneration) return failure([problem('CONTENT_GENERATION_STALE', 'Authored content changed while validating this Regulation mutation', mutation.metadata.sourcePath)], 'COMMAND_FAILED');
    if (mutation.operation === 'delete' && deletedSource) {
      await atomicWriteText(await documentPath(stagingPath, mutation.metadata.sourcePath), deletedSource.metadata, false);
      await atomicWriteText(await documentPath(stagingPath, mutation.rules.sourcePath), deletedSource.rules, false);
      await moveToTrash(stagingPath, mutation.metadata.sourcePath, 'regulation');
      await moveToTrash(stagingPath, mutation.rules.sourcePath, 'regulation');
    }
    await publishAtomicDirectory({ root: parent, stagingPath, finalPath: paths.contentRoot, backupPath });
    stagingPath = '';
    const after = await discoverCampaignIrBundle(paths.contentRoot);
    return result({ ...preview, contentGeneration: after.bundle?.snapshot.contentGeneration, applied: true }, layered.warnings);
  } catch (error) {
    if (error instanceof ContentRegulationPathError) return failure([problem('CONTENT_REGULATION_PATH_UNAUTHORIZED', error.message, error.sourcePath)], 'PATH_ERROR');
    return failure([problem('CONTENT_REGULATION_MUTATION_FAILED', String(error), mutation.metadata?.sourcePath)], 'COMMAND_FAILED');
  } finally {
    if (stagingPath) await fs.rm(stagingPath, { recursive: true, force: true });
  }
};

export interface ContentOperationPaths {
  projectRoot: string;
  contentRoot?: string;
  irRoot?: string;
  registryPath?: string;
}

export interface ContentExecutionOptions extends ContentOperationPaths {
  resolver?: CardNameResolver;
  registry?: IdRegistry;
  /**
   * The shared project compiler owns an approved compatibility adapter for
   * the fixture-backed Structure projection.  This does not promote the
   * upstream target capability; callers can explicitly set false to retain
   * the low-level fail-closed path.
   */
  verifiedStructureAdapter?: boolean;
  allowAssumedStructure?: boolean;
  deckOptions?: CompileCampaignContentOptions['deckOptions'];
}

export interface ContentCompileOptions extends ContentExecutionOptions {
  /** False/missing is check-only. Publishing requires explicit apply:true. */
  apply?: boolean;
  expectedContentGeneration?: string;
  expectedRegistryGeneration?: string;
  expectedPlannedRegistryGeneration?: string;
}

const operationPaths = (options: ContentOperationPaths) => ({
  contentRoot: path.resolve(options.contentRoot || path.join(options.projectRoot, 'campaign', 'content')),
  irRoot: path.resolve(options.irRoot || path.join(options.projectRoot, 'campaign', 'source')),
  registryPath: path.resolve(options.registryPath || path.join(options.projectRoot, 'campaign', 'id-registry.json')),
});

const executionInputs = async (options: ContentExecutionOptions): Promise<{ resolver: CardNameResolver; registry: IdRegistry }> => ({
  resolver: options.resolver || await loadCardResolver(options.projectRoot),
  registry: options.registry || (await exists(operationPaths(options).registryPath)
    ? await readRegistry(operationPaths(options).registryPath)
    : createEmptyRegistry()),
});

const capabilityProblems = (unconsumed: readonly string[], manifest: { directories?: { shop?: string; target?: string } }): Problem[] => {
  const shopRoot = `${manifest.directories?.shop || 'shop'}/`;
  const targetRoot = `${manifest.directories?.target || 'target/ygomaster'}/`;
  return unconsumed.filter((sourcePath) => !sourcePath.endsWith('/.gitkeep') && sourcePath !== '.gitkeep').flatMap((sourcePath) => sourcePath.startsWith(shopRoot)
    ? [problem('SHOP_TARGET_UNSUPPORTED', 'Shop authored content cannot be projected by the current target contract', sourcePath)]
    : sourcePath.startsWith(targetRoot)
      ? [problem('TARGET_CAPABILITY_UNSUPPORTED', 'Unrecognized YgoMaster target extension is not deployable', sourcePath)]
      : []);
};

export const inspectCampaignContent = async (
  options: ContentOperationPaths,
): Promise<OperationResult<unknown>> => {
  try {
    const paths = operationPaths(options);
    const loaded = await discoverCampaignIrBundle(paths.contentRoot);
    if (!loaded.ok || !loaded.bundle) return failure(loaded.problems, 'COMMAND_FAILED');
    const bundle = loaded.bundle;
    let generationStatus: Record<string, unknown> = {
      state: 'missing',
      contentGeneration: bundle.snapshot.contentGeneration,
      irGeneration: null,
      mismatches: ['generation.json is missing'],
    };
    if (await exists(path.join(paths.irRoot, IR_GENERATION_METADATA_FILE))) {
      try {
        const metadata = await readIrGenerationMetadata(paths.irRoot);
        const mismatches = [
          ...(metadata.contentGeneration === bundle.snapshot.contentGeneration ? [] : ['contentGeneration']),
          ...(metadata.compilerVersion === IR_COMPILER_VERSION ? [] : ['compilerVersion']),
          ...(metadata.targetContractVersion === YGOMASTER_TARGET_CONTRACT_VERSION ? [] : ['targetContractVersion']),
        ];
        generationStatus = {
          state: mismatches.length === 0 ? 'current' : 'stale',
          contentGeneration: bundle.snapshot.contentGeneration,
          irGeneration: metadata.contentGeneration,
          compilerVersion: metadata.compilerVersion,
          targetContractVersion: metadata.targetContractVersion,
          mismatches,
        };
      } catch (error) {
        generationStatus = {
          state: 'invalid',
          contentGeneration: bundle.snapshot.contentGeneration,
          irGeneration: null,
          mismatches: [String(error)],
        };
      }
    }
    return result({
      paths,
      contentGeneration: bundle.snapshot.contentGeneration,
      generationStatus,
      campaign: bundle.manifest.campaign,
      families: {
        decks: Object.keys(bundle.decks),
        gates: bundle.gates.map((entry) => entry.sourcePath),
        structures: bundle.structures.map((entry) => entry.sourcePath),
        shops: bundle.shops.map((entry) => entry.metadata.sourcePath),
        releases: bundle.releaseGraphs.map((entry) => entry.sourcePath),
        regulations: Object.keys(bundle.regulations),
        localizationLanguages: bundle.localization ? Object.keys(bundle.localization.languages).sort() : [],
      },
      consumedPaths: bundle.consumedPaths,
      unconsumedPaths: bundle.unconsumedPaths,
      capabilities: capabilityProblems(bundle.unconsumedPaths, bundle.manifest),
      compilerVersion: IR_COMPILER_VERSION,
      targetContractVersion: YGOMASTER_TARGET_CONTRACT_VERSION,
    });
  } catch (error) {
    return failure([problem('CONTENT_INSPECT_FAILED', String(error))], 'PATH_ERROR');
  }
};

const compileCore = async (options: ContentCompileOptions, checkOnly: boolean) => {
  const paths = operationPaths(options);
  const inputs = await executionInputs(options);
  return compileCampaignContent({
    projectRoot: options.projectRoot,
    contentRoot: paths.contentRoot,
    irRoot: paths.irRoot,
    resolver: inputs.resolver,
    catalogGeneration: inputs.resolver.catalogGeneration,
    registry: inputs.registry,
    checkOnly,
    verifiedStructureAdapter: options.verifiedStructureAdapter ?? options.allowAssumedStructure ?? true,
    allowAssumedStructure: options.allowAssumedStructure,
    deckOptions: options.deckOptions,
  });
};

export const compileCampaignContentOperation = async (
  options: ContentCompileOptions,
): Promise<OperationResult<unknown>> => {
  try {
    const apply = options.apply === true;
    const paths = operationPaths(options);
    const inspected = await discoverCampaignIrBundle(paths.contentRoot);
    if (!inspected.ok || !inspected.bundle) return failure(inspected.problems, 'COMMAND_FAILED');
    const actualGeneration = inspected.bundle.snapshot.contentGeneration;
    if (apply && !options.expectedContentGeneration) {
      return failure([problem('CONTENT_EXPECTED_GENERATION_REQUIRED', 'Applied compile requires expectedContentGeneration from content inspect')], 'USAGE_ERROR');
    }
    if (options.expectedContentGeneration && options.expectedContentGeneration !== actualGeneration) {
      return failure([problem('CONTENT_GENERATION_STALE', `Expected content generation ${options.expectedContentGeneration}, received ${actualGeneration}`, 'campaign/content')], 'COMMAND_FAILED');
    }
    const inputs = await executionInputs(options);
    if (options.expectedRegistryGeneration && options.expectedRegistryGeneration !== inputs.registry.generation) {
      return failure([problem('ID_REGISTRY_STALE_PLAN', `Expected registry generation ${options.expectedRegistryGeneration}, received ${inputs.registry.generation}`, paths.registryPath)], 'COMMAND_FAILED');
    }
    const compile = (checkOnly: boolean) => compileCampaignContent({
      projectRoot: options.projectRoot,
      contentRoot: paths.contentRoot,
      irRoot: paths.irRoot,
      resolver: inputs.resolver,
      catalogGeneration: inputs.resolver.catalogGeneration,
      registry: inputs.registry,
      checkOnly,
      ...(!checkOnly && options.expectedPlannedRegistryGeneration
        ? { expectedOutputRegistryGeneration: options.expectedPlannedRegistryGeneration }
        : {}),
      verifiedStructureAdapter: options.verifiedStructureAdapter ?? options.allowAssumedStructure ?? true,
      allowAssumedStructure: options.allowAssumedStructure,
      deckOptions: options.deckOptions,
    });
    let compiled = await compile(!apply || Boolean(options.expectedPlannedRegistryGeneration));
    if (!compiled.ok) return failure(compiled.problems, 'COMMAND_FAILED', compiled.warnings);
    if (apply && options.expectedPlannedRegistryGeneration && compiled.registry?.generation !== options.expectedPlannedRegistryGeneration) {
      return failure([problem('ID_REGISTRY_STALE_PLAN', `Reviewed registry plan ${options.expectedPlannedRegistryGeneration} changed to ${compiled.registry?.generation || 'missing'}`, paths.registryPath)], 'COMMAND_FAILED', compiled.warnings);
    }
    if (apply && options.expectedPlannedRegistryGeneration) compiled = await compile(false);
    if (!compiled.ok) return failure(compiled.problems, 'COMMAND_FAILED', compiled.warnings);
    const registryReview = compiled.registry ? reviewRegistryPlan(inputs.registry, compiled.registry) : undefined;
    let registryUpdate: unknown;
    if (apply && compiled.registry && compiled.registry.generation !== inputs.registry.generation) {
      const plan: RegistryPlan = {
        dryRun: true,
        baseGeneration: inputs.registry.generation,
        generation: compiled.registry.generation,
        registry: compiled.registry,
        diff: diffRegistry(inputs.registry, compiled.registry),
      };
      registryUpdate = await applyRegistryPlan(paths.registryPath, plan, { accept: true });
    }
    return result({
      mode: apply ? 'apply' : 'check',
      contentGeneration: actualGeneration,
      generation: compiled.generation,
      published: compiled.published,
      zeroDiff: compiled.zeroDiff,
      diff: compiled.diff,
      staleDisposition: compiled.staleDisposition,
      registry: compiled.registry,
      registryReview,
      registryUpdate,
      provenance: compiled.provenance,
    }, compiled.warnings);
  } catch (error) {
    const nested = error && typeof error === 'object' && 'problems' in error && Array.isArray(error.problems)
      ? error.problems as Problem[]
      : [problem('CONTENT_COMPILE_FAILED', String(error))];
    return failure(nested, 'COMMAND_FAILED');
  }
};

export const validateCampaignContentOperation = async (
  options: ContentExecutionOptions,
): Promise<OperationResult<unknown>> => {
  try {
    const compiled = await compileCore(options, true);
    const layered = await validateLayeredCampaign({
      checkOnly: true,
      compileCheck: () => compiled,
    });
    return layered;
  } catch (error) {
    return failure([problem('CONTENT_VALIDATE_FAILED', String(error))], 'COMMAND_FAILED');
  }
};

const isResolverProblem = (entry: Problem): boolean =>
  entry.code.startsWith('CARD_NAME_') || entry.code.startsWith('CARD_RUNTIME_') || entry.code === 'CARD_ALIAS_UNREVIEWED';

export const resolveCampaignContent = async (
  options: ContentExecutionOptions,
): Promise<OperationResult<unknown>> => {
  try {
    const compiled = await compileCore(options, true);
    const unresolved = compiled.problems.filter(isResolverProblem).sort((left, right) =>
      (left.sourcePath || left.path || '').localeCompare(right.sourcePath || right.path || '')
      || (left.line || 0) - (right.line || 0)
      || left.code.localeCompare(right.code));
    const data = { unresolved, count: unresolved.length };
    return unresolved.length ? { ...failure(unresolved, 'COMMAND_FAILED'), data } : result(data, compiled.warnings.filter(isResolverProblem));
  } catch (error) {
    return failure([problem('CONTENT_RESOLVE_FAILED', String(error))], 'COMMAND_FAILED');
  }
};

export const diffCampaignContent = async (
  options: ContentExecutionOptions,
): Promise<OperationResult<unknown>> => {
  const compiled = await compileCampaignContentOperation({ ...options, apply: false });
  if (!compiled.ok) return compiled;
  const data = compiled.data as Record<string, unknown>;
  return result({ contentGeneration: data.contentGeneration, zeroDiff: data.zeroDiff, diff: data.diff, staleDisposition: data.staleDisposition }, compiled.warnings);
};

export const contentInspect = inspectCampaignContent;
export const contentResolve = resolveCampaignContent;
export const contentValidate = validateCampaignContentOperation;
export const contentCompile = compileCampaignContentOperation;
export const contentDiff = diffCampaignContent;
export const contentDocumentList = listCampaignContentDocuments;
export const contentDocumentRead = readCampaignContentDocument;
export const contentDocumentMutate = mutateCampaignContentDocument;
export const contentDeckPreview = previewCampaignDeckDocument;
export const contentDeckWorkspace = inspectCampaignDeckWorkspace;
export const contentGateDeckScopeMutate = mutateCampaignGateDeckScopeDocument;
export const contentDeckFoldersBootstrap = bootstrapCampaignDeckFolders;
export const contentShopRead = readCampaignShopDocuments;
export const contentShopMutate = mutateCampaignShopDocuments;
export const contentStructureMutate = mutateCampaignStructureDocument;
export const contentRegulationRead = readCampaignRegulationDocuments;
export const contentRegulationMutate = mutateCampaignRegulationDocuments;
