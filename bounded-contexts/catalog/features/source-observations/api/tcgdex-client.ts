import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type { SourceObservationPokemonCardNormalized } from "../domain/domain";
import type { CatalogAssetStorage } from "./asset-storage";
import { normalizeProductAssetSet, type CatalogImageProcessor } from "./product-asset-normalization";
import {
  type CatalogProviderIntegrationProfile,
  type CatalogProviderExternalReferenceRule,
  type CatalogProviderVariantRule,
  type TcgdexJsonConnectorProfile,
} from "./provider-integration-profiles";
import {
  dropRepeatedCatalogItemReferencesAcrossVariants,
  extractCatalogProviderExternalReferences,
} from "./provider-external-reference-extractor";

type JsonRecord = Record<string, unknown>;

export type TcgdexCardBrief = Readonly<{
  id: string;
  localId: string | number;
  name: string;
  image?: string;
}>;

export type TcgdexLanguageOption = Readonly<{
  languageCode: string;
}>;

export type TcgdexSeriesOption = Readonly<{
  seriesId: string;
  name: string;
  logoUrl: string | null;
}>;

export type TcgdexExpansionOption = Readonly<{
  expansionId: string;
  name: string;
  seriesId: string | null;
  seriesName: string | null;
  logoUrl: string | null;
  symbolUrl: string | null;
  cardCount: number | null;
  officialCardCount: number | null;
}>;

export type TcgdexSet = Readonly<{
  id: string;
  name: string;
  releaseDate?: string;
  cardCount?: Readonly<{
    official?: number;
    reverse?: number;
    total?: number;
  }>;
  abbreviation?: Readonly<{
    official?: string;
  }>;
  tcgOnline?: string;
  serie?: Readonly<{
    id: string;
    name: string;
  }>;
  cards: readonly TcgdexCardBrief[];
}>;

export type TcgdexSetBrief = Readonly<{
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
  cardCount?: Readonly<{
    official?: number;
    total?: number;
  }>;
}>;

export type TcgdexSeries = Readonly<{
  id: string;
  name: string;
  logo?: string;
  sets: readonly TcgdexSetBrief[];
}>;

export type TcgdexCard = Readonly<{
  id: string;
  localId: string | number;
  name: string;
  image?: string;
  category: string;
  illustrator?: string;
  rarity?: string;
  updated?: string;
  /** National Pokedex / species ids. Present for Pokemon, absent for Trainer/Energy. */
  dexId?: readonly number[];
  set: Readonly<{
    id: string;
    name: string;
  }>;
  variants?: Readonly<Record<string, boolean>>;
  variants_detailed?: readonly JsonRecord[];
  pricing?: JsonRecord;
}>;

export type TcgdexObservationPayload = Readonly<{
  observedAt: string;
  payload: JsonObject;
}>;

type PokemonCardVariant = Readonly<{
  key: string;
  displayName: string;
  sourceKey: string | null;
  isPrimaryImage: boolean;
  parallelSet: boolean;
}>;

export type TcgdexSetImportProgress = Readonly<{
  phase: "fetching" | "recording" | "completed";
  completed: number;
  total: number;
  currentName: string | null;
}>;

export function listTcgdexLanguageOptions(profile: CatalogProviderIntegrationProfile): readonly TcgdexLanguageOption[] {
  return profile.languageOptions.map((languageCode) => ({ languageCode }));
}

export async function fetchTcgdexSeriesOptions(input: {
  profile: CatalogProviderIntegrationProfile;
  languageCode: string;
  fetch?: typeof globalThis.fetch;
}): Promise<readonly TcgdexSeriesOption[]> {
  const languageCode = normalizeKey(input.languageCode || "en");
  const fetcher = input.fetch ?? globalThis.fetch;
  const connector = requireTcgdexConnector(input.profile);
  const url = tcgdexUrl(connector, connector.endpoints.seriesList, { language: languageCode });
  const series = await fetchJson<readonly Omit<TcgdexSeries, "sets">[]>(fetcher, url);

  return series
    .map((item) => ({
      seriesId: item.id,
      name: item.name,
      logoUrl: item.logo ?? null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function fetchTcgdexExpansionOptions(input: {
  profile: CatalogProviderIntegrationProfile;
  languageCode: string;
  seriesId?: string | null;
  fetch?: typeof globalThis.fetch;
}): Promise<readonly TcgdexExpansionOption[]> {
  const languageCode = normalizeKey(input.languageCode || "en");
  const seriesId = input.seriesId ? normalizeKey(input.seriesId) : null;
  const fetcher = input.fetch ?? globalThis.fetch;
  const connector = requireTcgdexConnector(input.profile);

  if (seriesId) {
    const url = tcgdexUrl(connector, connector.endpoints.seriesDetail, { language: languageCode, seriesId });
    const series = await fetchJson<TcgdexSeries>(fetcher, url);

    return series.sets.map((item) => toExpansionOption(item, series));
  }

  const url = tcgdexUrl(connector, connector.endpoints.expansionList, { language: languageCode });
  const sets = await fetchJson<readonly TcgdexSetBrief[]>(fetcher, url);

  return sets.map((item) => toExpansionOption(item, null));
}

export async function fetchTcgdexSetObservationPayloads(input: {
  profile: CatalogProviderIntegrationProfile;
  languageCode: string;
  setId: string;
  seriesId?: string | null;
  fetch?: typeof globalThis.fetch;
  observedAt?: string;
  onProgress?: (progress: TcgdexSetImportProgress) => void | Promise<void>;
}): Promise<readonly TcgdexObservationPayload[]> {
  const languageCode = normalizeKey(input.languageCode || "en");
  const setId = normalizeKey(input.setId);
  const seriesId = input.seriesId ? normalizeKey(input.seriesId) : null;
  const fetcher = input.fetch ?? globalThis.fetch;
  const connector = requireTcgdexConnector(input.profile);
  const setUrl = tcgdexUrl(connector, connector.endpoints.expansionDetail, {
    language: languageCode,
    expansionId: setId,
  });
  const set = await fetchJson<TcgdexSet>(fetcher, setUrl);
  const observedAt = input.observedAt ?? new Date().toISOString();
  const observations: TcgdexObservationPayload[] = [];
  await input.onProgress?.({
    phase: "fetching",
    completed: 0,
    total: set.cards.length,
    currentName: null,
  });

  for (const [index, cardBrief] of set.cards.entries()) {
    const cardUrl = tcgdexUrl(connector, connector.endpoints.productDetail, {
      language: languageCode,
      cardId: cardBrief.id,
    });
    const card = await fetchJson<TcgdexCard>(fetcher, cardUrl);
    observations.push(
      ...(await toObservations({
        profile: input.profile,
        card,
        set,
        languageCode,
        seriesId,
        sourceUrl: cardUrl,
        observedAt,
      })),
    );
    await input.onProgress?.({
      phase: "fetching",
      completed: index + 1,
      total: set.cards.length,
      currentName: card.name,
    });
  }

  return observations;
}

/** An id+name pair from the TCGdex English mirror endpoint, or null when absent. */
export type TcgdexEnglishMirrorEntity = Readonly<{ id: string; name: string }>;

/**
 * Fetch a single TCGdex English-mirror entity (set, series, or card) by id.
 *
 * Returns null when the English endpoint did not exist (404 or any transport
 * failure) or did not return a usable id/name. This is the network half of the
 * same-id English match: the pure alignment rule lives in
 * `matchTcgdexEnglishEndpointEntity` so source-option labels and alias intake share it. Reads
 * the explicit English locale (`en`), never the Indonesian `id` code.
 */
export async function fetchTcgdexEnglishMirrorEntity(input: {
  profile: CatalogProviderIntegrationProfile;
  entity: "set" | "series" | "card";
  id: string;
  fetch?: typeof globalThis.fetch;
}): Promise<TcgdexEnglishMirrorEntity | null> {
  const id = input.id.trim();
  if (!id) {
    return null;
  }

  const fetcher = input.fetch ?? globalThis.fetch;
  const connector = requireTcgdexConnector(input.profile);
  const url = tcgdexUrl(connector, englishMirrorEndpoint(connector, input.entity), {
    language: "en",
    ...englishMirrorParam(input.entity, id),
  });

  try {
    const response = await fetcher(url);
    if (!response.ok) {
      return null;
    }
    const entity = (await response.json()) as Readonly<{ id?: unknown; name?: unknown }>;
    const entityId = typeof entity.id === "string" ? entity.id.trim() : "";
    const entityName = typeof entity.name === "string" ? entity.name.trim() : "";
    if (!entityId || !entityName) {
      return null;
    }
    return { id: entityId, name: entityName };
  } catch {
    return null;
  }
}

function englishMirrorEndpoint(connector: TcgdexJsonConnectorProfile, entity: "set" | "series" | "card"): string {
  if (entity === "set") {
    return connector.endpoints.expansionDetail;
  }
  if (entity === "series") {
    return connector.endpoints.seriesDetail;
  }
  return connector.endpoints.productDetail;
}

function englishMirrorParam(entity: "set" | "series" | "card", id: string): Readonly<Record<string, string>> {
  if (entity === "set") {
    return { expansionId: id };
  }
  if (entity === "series") {
    return { seriesId: id };
  }
  return { cardId: id };
}

function toExpansionOption(
  set: TcgdexSetBrief,
  series: Pick<TcgdexSeries, "id" | "name"> | null,
): TcgdexExpansionOption {
  return {
    expansionId: set.id,
    name: set.name,
    seriesId: series?.id ?? null,
    seriesName: series?.name ?? null,
    logoUrl: set.logo ?? null,
    symbolUrl: set.symbol ?? null,
    cardCount: set.cardCount?.total ?? set.cardCount?.official ?? null,
    officialCardCount: set.cardCount?.official ?? null,
  };
}

async function toObservations(input: {
  profile: CatalogProviderIntegrationProfile;
  card: TcgdexCard;
  set: TcgdexSet;
  languageCode: string;
  seriesId: string | null;
  sourceUrl: string;
  observedAt: string;
}): Promise<readonly TcgdexObservationPayload[]> {
  const connector = requireTcgdexConnector(input.profile);
  const releaseYear = releaseYearFromDate(input.set.releaseDate);
  const sourcePayload = toJsonValue(sanitizeTcgdexCardPayload(input.card));
  const sourceImageUrls = input.card.image ? [`${input.card.image}/${connector.highQualityAssetVariant}`] : [];
  const variants = normalizeVariants(input.card.variants);
  const cardVariants = normalizeCardVariants(input.profile, input.card.variants);
  const externalCatalogItemReferencesByVariant = marketplaceCatalogItemReferencesByVariantKey(
    input.profile,
    input.card,
    cardVariants,
  );

  return cardVariants.map((variant) => {
    const externalCatalogItemReferences = externalCatalogItemReferencesByVariant.get(variant.key) ?? [];
    const mappingPayload = {
      card: input.card,
      set: input.set,
      variant,
      languageCode: input.languageCode,
      observationId: buildObservationId(input.languageCode, input.card.id, variant.isPrimaryImage ? null : variant.key),
      externalKey: variant.isPrimaryImage ? input.card.id : `${input.card.id}:${variant.key}`,
      sourceUrl: input.sourceUrl,
      sourceUpdatedAt: input.card.updated ?? null,
      sourcePayload,
      sourceImageUrls,
      expansionAbbreviation: expansionAbbreviation(input.set),
      expansionCardCount: input.set.cardCount?.official ?? input.set.cardCount?.total ?? null,
      expansionParallelSetCardCount: input.set.cardCount?.reverse ?? null,
      seriesId: input.set.serie?.id ?? input.seriesId,
      seriesName: input.set.serie?.name ?? null,
      releaseDate: input.set.releaseDate ?? null,
      releaseYear,
      imageBaseUrl: input.card.image ?? null,
      imageDisclaimer: input.card.image && !variant.isPrimaryImage ? buildImageDisclaimer(variant.displayName) : null,
      variants,
      externalCatalogItemReferences,
      mergeIdentity: {
        tcg: "pokemon",
        productLineName: "Pokemon",
        setName: input.set.name,
        printedProductName: input.card.name,
        collectorNumber: String(input.card.localId),
        languageCode: input.languageCode,
        productForm: "single",
        barcode: null,
      },
    };

    return {
      observedAt: input.observedAt,
      payload: toJsonValue({
        ...mappingPayload,
        catalogHashMaterial: {
          normalized: {
            kind: "pokemon-card",
            tcg: "pokemon",
            languageCode: input.languageCode,
            name: input.card.name,
            cardNumber: String(input.card.localId),
            setId: input.set.id,
            setName: input.set.name,
            expansionId: input.set.id,
            expansionName: input.set.name,
            expansionAbbreviation: mappingPayload.expansionAbbreviation,
            expansionCardCount: mappingPayload.expansionCardCount,
            expansionParallelSetCardCount: mappingPayload.expansionParallelSetCardCount,
            seriesId: mappingPayload.seriesId,
            seriesName: mappingPayload.seriesName,
            rarity: input.card.rarity ?? null,
            illustrator: input.card.illustrator ?? null,
            releaseDate: mappingPayload.releaseDate,
            releaseYear,
            category: input.card.category,
            imageBaseUrl: mappingPayload.imageBaseUrl,
            imageUrls: sourceImageUrls,
            mergeIdentity: mappingPayload.mergeIdentity,
            productAssetSet: null,
            parallelSet: variant.parallelSet,
            cardVariantKey: variant.key,
            cardVariantLabel: variant.displayName,
            cardVariantSourceKey: variant.sourceKey,
            cardVariantIsPrimaryImage: variant.isPrimaryImage,
            imageDisclaimer: mappingPayload.imageDisclaimer,
            variants,
            externalCatalogItemReferences,
          },
          sourcePayload,
        },
      }) as JsonObject,
    };
  });
}

export async function normalizeTcgdexImageAsset(input: {
  profile: CatalogProviderIntegrationProfile;
  imageBaseUrl: string;
  storageBaseKey: string;
  observedAt: string;
  fetcher: typeof globalThis.fetch;
  assetStorage: CatalogAssetStorage;
  imageProcessor?: CatalogImageProcessor;
}): Promise<NonNullable<SourceObservationPokemonCardNormalized["productAssetSet"]>> {
  const connector = requireTcgdexConnector(input.profile);
  const assetUrl = `${input.imageBaseUrl}/${connector.highQualityAssetVariant}`;
  const response = await input.fetcher(assetUrl);
  if (!response.ok) {
    throw new Error(`TCGdex asset request failed with ${response.status} for ${assetUrl}.`);
  }

  const body = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/webp";

  if (contentType !== "image/webp") {
    throw new Error(`TCGdex high quality asset must be image/webp for ${assetUrl}.`);
  }

  return normalizeProductAssetSet({
    sourceBody: body,
    sourceContentType: contentType,
    sourceProviderKey: "tcgdex",
    sourceUrl: assetUrl,
    storageBaseKey: input.storageBaseKey,
    generatedAt: input.observedAt,
    assetStorage: input.assetStorage,
    imageProcessor: input.imageProcessor,
  });
}

function sanitizeTcgdexCardPayload(card: TcgdexCard): JsonRecord {
  const { pricing: _pricing, ...payload } = card as TcgdexCard & {
    pricing?: unknown;
  };
  return payload;
}

function marketplaceCatalogItemReferencesByVariantKey(
  profile: CatalogProviderIntegrationProfile,
  card: TcgdexCard,
  cardVariants: readonly PokemonCardVariant[],
): Map<
  string,
  readonly NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number][]
> {
  const referencesByVariant = new Map<
    string,
    NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number][]
  >();

  for (const variant of cardVariants) {
    const variantScope = variantRuleByVariantKey(profile, variant.key) ?? {
      variantKey: variant.key,
      sourceKeys: variant.sourceKey ? [variant.sourceKey] : [],
      pricingKeys: [variant.key],
    };
    const payloads = [
      card,
      ...(card.variants_detailed ?? []).filter((detail) => variantDetailMatches(profile, detail, variant)),
    ];
    const resultReferences = payloads.flatMap(
      (payload) =>
        extractCatalogProviderExternalReferences({
          rules: marketplaceReferenceRules(profile).filter((rule) => rule.target === "catalog-item-reference"),
          payload: toJsonValue(payload),
          variant: variantScope,
        }).externalCatalogItemReferences,
    );
    referencesByVariant.set(variant.key, uniqueExternalCatalogItemReferences(resultReferences));
  }

  return new Map(dropRepeatedCatalogItemReferencesAcrossVariants(referencesByVariant));
}

function variantDetailMatches(
  profile: CatalogProviderIntegrationProfile,
  detail: JsonRecord,
  variant: PokemonCardVariant,
): boolean {
  const sourceKey = stringField(detail, ["type", "variant", "variantType", "key", "name"]);
  return sourceKey ? normalizeVariantKey(profile, sourceKey) === variant.key : false;
}

function valueField(record: JsonRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key && record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }

  return null;
}

function stringField(record: JsonRecord, keys: readonly string[]): string | null {
  const value = valueField(record, keys);
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function uniqueExternalCatalogItemReferences(
  references: readonly NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number][],
): NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number][] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.providerKey.trim().toLowerCase()}:${reference.externalKey.trim().toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeVariants(variants: Readonly<Record<string, boolean>> | undefined): JsonObject {
  if (!variants) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(variants)
      .filter(([, value]) => typeof value === "boolean")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeCardVariants(
  profile: CatalogProviderIntegrationProfile,
  variants: Readonly<Record<string, boolean>> | undefined,
): readonly PokemonCardVariant[] {
  const sourceKeysByVariantKey = new Map<string, string>();
  Object.entries(variants ?? {})
    .filter(([, value]) => value === true)
    .map(([key]) => key.trim())
    .filter((key) => key.length > 0)
    .sort(compareVariantSourceKeysForProfile(profile))
    .forEach((sourceKey) => {
      const variantKey = normalizeVariantKey(profile, sourceKey);
      if (!sourceKeysByVariantKey.has(variantKey)) {
        sourceKeysByVariantKey.set(variantKey, sourceKey);
      }
    });
  const sourceKeys = Array.from(sourceKeysByVariantKey.values());

  if (sourceKeys.length === 0) {
    return [
      {
        key: "standard",
        displayName: "Standard Set",
        sourceKey: null,
        isPrimaryImage: true,
        parallelSet: false,
      },
    ];
  }

  const primaryKey =
    sourceKeys.find((key) => normalizeVariantKey(profile, key) === "standard") ?? sourceKeys[0] ?? null;

  return sourceKeys.map((sourceKey) => {
    const key = normalizeVariantKey(profile, sourceKey);

    return {
      key,
      displayName: variantLabel(profile, sourceKey),
      sourceKey,
      isPrimaryImage: sourceKey === primaryKey,
      parallelSet: isParallelSetVariant(profile, key),
    };
  });
}

function compareVariantSourceKeysForProfile(profile: CatalogProviderIntegrationProfile) {
  return (left: string, right: string): number => {
    const leftOrder = variantSortOrder(profile, left);
    const rightOrder = variantSortOrder(profile, right);

    return leftOrder === rightOrder ? left.localeCompare(right) : leftOrder - rightOrder;
  };
}

function variantSortOrder(profile: CatalogProviderIntegrationProfile, sourceKey: string): number {
  return variantRuleBySourceKey(profile, sourceKey)?.sortOrder ?? 100;
}

function isParallelSetVariant(profile: CatalogProviderIntegrationProfile, variantKey: string): boolean {
  return variantRuleByVariantKey(profile, variantKey)?.parallelSet ?? false;
}

function normalizeVariantKey(profile: CatalogProviderIntegrationProfile, sourceKey: string): string {
  const key = sourceKey.trim();
  const compact = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const rule = variantRuleByCompactSourceKey(profile, compact);

  if (rule) {
    return rule.variantKey;
  }

  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function variantLabel(profile: CatalogProviderIntegrationProfile, sourceKey: string): string {
  return (
    variantRuleBySourceKey(profile, sourceKey)?.displayName ??
    `${profile.normalizedObservationMapping.unknownVariantLabelPrefix} - ${humanizeVariantKey(sourceKey)}`
  );
}

function marketplaceReferenceRules(
  profile: CatalogProviderIntegrationProfile,
): readonly CatalogProviderExternalReferenceRule[] {
  return profile.externalReferenceExtractionRules.rules;
}

function variantRules(profile: CatalogProviderIntegrationProfile): readonly CatalogProviderVariantRule[] {
  return profile.normalizedObservationMapping.variantRules;
}

function variantRuleBySourceKey(
  profile: CatalogProviderIntegrationProfile,
  sourceKey: string,
): CatalogProviderVariantRule | null {
  return variantRuleByCompactSourceKey(profile, sourceKey.toLowerCase().replace(/[^a-z0-9]+/g, ""));
}

function variantRuleByCompactSourceKey(
  profile: CatalogProviderIntegrationProfile,
  compactSourceKey: string,
): CatalogProviderVariantRule | null {
  return (
    variantRules(profile).find((rule) =>
      rule.sourceKeys.some((sourceKey) => sourceKey.toLowerCase().replace(/[^a-z0-9]+/g, "") === compactSourceKey),
    ) ?? null
  );
}

function variantRuleByVariantKey(
  profile: CatalogProviderIntegrationProfile,
  variantKey: string,
): CatalogProviderVariantRule | null {
  return variantRules(profile).find((rule) => rule.variantKey === variantKey) ?? null;
}

function humanizeVariantKey(sourceKey: string): string {
  return sourceKey
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function buildImageDisclaimer(variantLabel: string): string {
  return `TCGDex provides one image for this card number. This Catalog Item represents the ${variantLabel} variant, so the image may not show the exact foil or pattern.`;
}

function buildObservationId(languageCode: string, cardId: string, variantKey: string | null): string {
  return ["tcgdex", normalizeKey(languageCode), cardId.trim().toLowerCase(), variantKey]
    .filter((part): part is string => Boolean(part))
    .join("_")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/(^_|_$)/g, "");
}

function releaseYearFromDate(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const year = Number.parseInt(value.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function expansionAbbreviation(set: TcgdexSet): string | null {
  return set.abbreviation?.official ?? set.tcgOnline ?? null;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }

  if (typeof value === "object") {
    const output: JsonObject = {};
    for (const [key, entry] of Object.entries(value as JsonRecord)) {
      output[key] = toJsonValue(entry);
    }
    return output;
  }

  return String(value);
}

async function fetchJson<T>(fetcher: typeof globalThis.fetch, url: string): Promise<T> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`TCGdex request failed with ${response.status} for ${url}.`);
  }

  return response.json() as Promise<T>;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function requireTcgdexConnector(profile: CatalogProviderIntegrationProfile): TcgdexJsonConnectorProfile {
  if (profile.connector.kind !== "tcgdex-json") {
    throw new Error(`Catalog provider '${profile.providerKey}' does not use the TCGdex JSON connector.`);
  }

  return profile.connector;
}

function tcgdexUrl(
  connector: TcgdexJsonConnectorProfile,
  template: string,
  params: Readonly<Record<string, string>>,
): string {
  const path = Object.entries(params).reduce(
    (current, [key, value]) => current.replace(`{${key}}`, encodeURIComponent(value)),
    template,
  );
  return `${connector.baseUrl}${path}`;
}
