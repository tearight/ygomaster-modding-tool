import {
  discoverCampaignIrBundle,
  type DiscoveredCampaignIrBundle,
} from './content-bundle-loader';
import {
  compileCampaignIr,
  type CampaignIrBundle,
  type CompileCampaignIrOptions,
  type CompileCampaignIrResult,
} from './ir-compiler';
import { problem, type JsonObject } from './types';
import type { StructureAccessoryCatalog } from './structure-content';

export type CompileCampaignContentOptions = Omit<CompileCampaignIrOptions, 'bundle'>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Convert the complete, snapshot-bound disk discovery model into the compiler's
 * normalized family inputs. No authored value is inferred from generated IR.
 */
export const compilerBundleFromContent = (discovered: DiscoveredCampaignIrBundle): CampaignIrBundle => {
  const authoring = isRecord(discovered.manifest.authoring) ? discovered.manifest.authoring : undefined;
  const targetRoot = `${discovered.manifest.directories?.target || 'target/ygomaster'}/`;
  return {
    decks: Object.values(discovered.decks).map((entry) => ({
      // Authored references name the deterministic JSON projection while the
      // actual authored bytes remain in the adjacent .decklist file.
      key: entry.source.sourcePath.replace(/\.decklist$/iu, '.json'),
      source: entry.source.value,
      sourcePath: entry.source.sourcePath,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
      ...(entry.regulation ? { regulation: entry.regulation } : {}),
    })),
    gates: discovered.gates.map((entry) => ({ value: entry.value, sourcePath: entry.sourcePath })),
    structures: discovered.structures.map((entry) => ({ value: entry.value, sourcePath: entry.sourcePath })),
    shops: discovered.shops.map((entry) => ({
      metadata: entry.metadata.value,
      packList: entry.packList.value,
      odds: entry.odds.value,
      metadataSourcePath: entry.metadata.sourcePath,
      packListSourcePath: entry.packList.sourcePath,
      oddsSourcePath: entry.odds.sourcePath,
    })),
    regulations: Object.values(discovered.regulations).map((entry) => ({
      key: entry.key,
      metadata: entry.metadata.value,
      rules: entry.rules.value,
      metadataSourcePath: entry.metadata.sourcePath,
      rulesSourcePath: entry.rules.sourcePath,
    })),
    ...(discovered.localization ? { localization: discovered.localization } : {}),
    ...(typeof authoring?.language === 'string' ? { language: authoring.language } : {}),
    ...(typeof authoring?.fallbackLanguage === 'string' ? { fallbackLanguage: authoring.fallbackLanguage } : {}),
    ...(discovered.accessories ? { accessories: discovered.accessories.value as JsonObject as StructureAccessoryCatalog } : {}),
    gateBackgrounds: discovered.gateBackgrounds,
    cardReferences: discovered.cardReferences,
    blockingCapabilities: discovered.unconsumedPaths
      .filter((sourcePath) => sourcePath.startsWith(targetRoot) && !sourcePath.endsWith('/.gitkeep'))
      .map((sourcePath) => problem('TARGET_CAPABILITY_UNSUPPORTED', 'Unrecognized YgoMaster target extension is not deployable', sourcePath)),
    consumedSourcePaths: discovered.consumedPaths,
  };
};

/** Discover every authored family from disk and compile exactly that snapshot. */
export const compileCampaignContent = async (
  options: CompileCampaignContentOptions,
): Promise<CompileCampaignIrResult> => {
  const loaded = await discoverCampaignIrBundle(options.contentRoot);
  if (!loaded.ok || !loaded.bundle) {
    return {
      ok: false,
      checkOnly: options.checkOnly === true,
      published: false,
      zeroDiff: false,
      staleDisposition: [],
      problems: loaded.problems,
      warnings: [],
    };
  }
  return compileCampaignIr({ ...options, bundle: compilerBundleFromContent(loaded.bundle) });
};

export const runCampaignPipeline = compileCampaignContent;
