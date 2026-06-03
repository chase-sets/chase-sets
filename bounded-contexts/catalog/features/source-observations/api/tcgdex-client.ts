import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type { SourceObservationPokemonCardNormalized } from "../domain/domain";
import type { CatalogAssetStorage } from "./asset-storage";
import { normalizeProductAssetSet, type CatalogImageProcessor } from "./product-asset-normalization";
import {
  tcgdexPokemonTcgProviderProfile,
  type CatalogProviderExternalReferenceRule,
  type CatalogProviderVariantRule,
} from "./provider-integration-profiles";

const TCGDEX_PROFILE = tcgdexPokemonTcgProviderProfile;
const PROVIDER_KEY = TCGDEX_PROFILE.providerKey;

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
  set: Readonly<{
    id: string;
    name: string;
  }>;
  variants?: Readonly<Record<string, boolean>>;
  variants_detailed?: readonly JsonRecord[];
  pricing?: JsonRecord;
}>;

export type TcgdexObservationInput = Readonly<{
  observationId: string;
  providerKey: typeof PROVIDER_KEY;
  externalKey: string;
  sourceUrl: string;
  languageCode: string;
  sourceRecordHash: string;
  sourceUpdatedAt: string | null;
  observedAt: string;
  normalized: SourceObservationPokemonCardNormalized;
  sourcePayload: JsonValue;
}>;

type PokemonCardVariant = Readonly<{
  key: string;
  displayName: string;
  sourceKey: string | null;
  isPrimaryImage: boolean;
  parallelSet: boolean;
}>;

export type TcgdexSetImportResult = Readonly<{
  setId: string;
  expansionId: string;
  languageCode: string;
  observed: number;
  observationIds: readonly string[];
}>;

export type TcgdexSetImportProgress = Readonly<{
  phase: "fetching" | "recording" | "completed";
  completed: number;
  total: number;
  currentName: string | null;
}>;

export function listTcgdexLanguageOptions(): readonly TcgdexLanguageOption[] {
  return TCGDEX_PROFILE.languageOptions.map((languageCode) => ({ languageCode }));
}

export async function fetchTcgdexSeriesOptions(input: {
  languageCode: string;
  fetch?: typeof globalThis.fetch;
}): Promise<readonly TcgdexSeriesOption[]> {
  const languageCode = normalizeKey(input.languageCode || "en");
  const fetcher = input.fetch ?? globalThis.fetch;
  const url = tcgdexUrl(TCGDEX_PROFILE.connector.endpoints.seriesList, { language: languageCode });
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
  languageCode: string;
  seriesId?: string | null;
  fetch?: typeof globalThis.fetch;
}): Promise<readonly TcgdexExpansionOption[]> {
  const languageCode = normalizeKey(input.languageCode || "en");
  const seriesId = input.seriesId?.trim();
  const fetcher = input.fetch ?? globalThis.fetch;

  if (seriesId) {
    const url = tcgdexUrl(TCGDEX_PROFILE.connector.endpoints.seriesDetail, { language: languageCode, seriesId });
    const series = await fetchJson<TcgdexSeries>(fetcher, url);

    return series.sets.map((item) => toExpansionOption(item, series));
  }

  const url = tcgdexUrl(TCGDEX_PROFILE.connector.endpoints.expansionList, { language: languageCode });
  const sets = await fetchJson<readonly TcgdexSetBrief[]>(fetcher, url);

  return sets.map((item) => toExpansionOption(item, null));
}

export async function fetchTcgdexSetObservations(input: {
  languageCode: string;
  setId: string;
  fetch?: typeof globalThis.fetch;
  onProgress?: (progress: TcgdexSetImportProgress) => void | Promise<void>;
}): Promise<readonly TcgdexObservationInput[]> {
  const languageCode = normalizeKey(input.languageCode || "en");
  const setId = input.setId.trim();
  const fetcher = input.fetch ?? globalThis.fetch;
  const setUrl = tcgdexUrl(TCGDEX_PROFILE.connector.endpoints.expansionDetail, {
    language: languageCode,
    expansionId: setId,
  });
  const set = await fetchJson<TcgdexSet>(fetcher, setUrl);
  const observedAt = new Date().toISOString();
  const observations: TcgdexObservationInput[] = [];
  await input.onProgress?.({
    phase: "fetching",
    completed: 0,
    total: set.cards.length,
    currentName: null,
  });

  for (const [index, cardBrief] of set.cards.entries()) {
    const cardUrl = tcgdexUrl(TCGDEX_PROFILE.connector.endpoints.productDetail, {
      language: languageCode,
      cardId: cardBrief.id,
    });
    const card = await fetchJson<TcgdexCard>(fetcher, cardUrl);
    observations.push(
      ...(await toObservations({
        card,
        set,
        languageCode,
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
  card: TcgdexCard;
  set: TcgdexSet;
  languageCode: string;
  sourceUrl: string;
  observedAt: string;
}): Promise<readonly TcgdexObservationInput[]> {
  const releaseYear = releaseYearFromDate(input.set.releaseDate);
  const sourcePayload = toJsonValue(sanitizeTcgdexCardPayload(input.card));
  const sourceImageUrls = input.card.image
    ? [`${input.card.image}/${TCGDEX_PROFILE.connector.highQualityAssetVariant}`]
    : [];
  const variants = normalizeVariants(input.card.variants);
  const cardVariants = normalizeCardVariants(input.card.variants);
  const externalCatalogItemReferencesByVariant = marketplaceCatalogItemReferencesByVariantKey(input.card, cardVariants);

  return cardVariants.map((variant) => {
    const normalized: SourceObservationPokemonCardNormalized = {
      kind: "pokemon-card",
      tcg: "pokemon",
      languageCode: input.languageCode,
      name: input.card.name,
      cardNumber: String(input.card.localId),
      setId: input.set.id,
      setName: input.set.name,
      expansionId: input.set.id,
      expansionName: input.set.name,
      expansionAbbreviation: expansionAbbreviation(input.set),
      expansionCardCount: input.set.cardCount?.official ?? input.set.cardCount?.total ?? null,
      expansionParallelSetCardCount: input.set.cardCount?.reverse ?? null,
      seriesId: input.set.serie?.id ?? null,
      seriesName: input.set.serie?.name ?? null,
      rarity: input.card.rarity ?? null,
      illustrator: input.card.illustrator ?? null,
      releaseDate: input.set.releaseDate ?? null,
      releaseYear,
      category: input.card.category,
      imageBaseUrl: input.card.image ?? null,
      imageUrls: sourceImageUrls,
      mergeIdentity: {
        tcg: "pokemon",
        productLineName: "Pokemon",
        setName: input.set.name,
        printedProductName: input.card.name,
        collectorNumber: String(input.card.localId),
        languageCode: input.languageCode,
      },
      productAssetSet: null,
      parallelSet: variant.parallelSet,
      cardVariantKey: variant.key,
      cardVariantLabel: variant.displayName,
      cardVariantSourceKey: variant.sourceKey,
      cardVariantIsPrimaryImage: variant.isPrimaryImage,
      imageDisclaimer: input.card.image && !variant.isPrimaryImage ? buildImageDisclaimer(variant.displayName) : null,
      variants,
      externalCatalogItemReferences: externalCatalogItemReferencesByVariant.get(variant.key) ?? [],
    };
    const providerNormalizedForHash: SourceObservationPokemonCardNormalized = {
      ...normalized,
      imageUrls: sourceImageUrls,
      productAssetSet: null,
    };

    return {
      observationId: buildObservationId(input.languageCode, input.card.id, variant.isPrimaryImage ? null : variant.key),
      providerKey: PROVIDER_KEY,
      externalKey: variant.isPrimaryImage ? input.card.id : `${input.card.id}:${variant.key}`,
      sourceUrl: input.sourceUrl,
      languageCode: input.languageCode,
      sourceRecordHash: hashJson({
        normalized: providerNormalizedForHash,
        sourcePayload,
      }),
      sourceUpdatedAt: input.card.updated ?? null,
      observedAt: input.observedAt,
      normalized,
      sourcePayload,
    };
  });
}

export async function normalizeTcgdexImageAsset(input: {
  imageBaseUrl: string;
  storageBaseKey: string;
  observedAt: string;
  fetcher: typeof globalThis.fetch;
  assetStorage: CatalogAssetStorage;
  imageProcessor?: CatalogImageProcessor;
}): Promise<NonNullable<SourceObservationPokemonCardNormalized["productAssetSet"]>> {
  const assetUrl = `${input.imageBaseUrl}/${TCGDEX_PROFILE.connector.highQualityAssetVariant}`;
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
    referencesByVariant.set(
      variant.key,
      uniqueExternalReferences([
        ...marketplaceReferencesFromVariantDetails(card.variants_detailed, variant),
        ...marketplaceReferencesFromPricing(card.pricing, variant),
      ]),
    );
  }

  const occurrences = new Map<string, number>();
  for (const references of referencesByVariant.values()) {
    for (const reference of uniqueExternalReferences(references)) {
      const key = externalReferenceIdentity(reference);
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    }
  }

  return new Map(
    Array.from(referencesByVariant.entries()).map(([variantKey, references]) => [
      variantKey,
      references.filter((reference) => occurrences.get(externalReferenceIdentity(reference)) === 1),
    ]),
  );
}

function marketplaceReferencesFromVariantDetails(
  variantDetails: readonly JsonRecord[] | undefined,
  variant: PokemonCardVariant,
): NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number][] {
  return (variantDetails ?? [])
    .filter((detail) => variantDetailMatches(detail, variant))
    .flatMap(marketplaceReferencesFromRecord);
}

function variantDetailMatches(detail: JsonRecord, variant: PokemonCardVariant): boolean {
  const sourceKey = stringField(detail, ["type", "variant", "variantType", "key", "name"]);
  return sourceKey ? normalizeVariantKey(sourceKey) === variant.key : false;
}

function marketplaceReferencesFromPricing(
  pricing: JsonRecord | undefined,
  variant: PokemonCardVariant,
): NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number][] {
  if (!pricing) {
    return [];
  }

  return marketplaceReferenceRules().flatMap((rule) => {
    const providerPricing = recordField(pricing, rule.pricingRootKeys);
    if (!providerPricing) {
      return [];
    }

    if (rule.pricingScope === "card") {
      return providerReferencesFromValue(rule, providerPricing);
    }

    const variantPricing = recordField(providerPricing, pricingKeysForVariant(rule, variant));
    return providerReferencesFromValue(rule, variantPricing);
  });
}

function marketplaceReferencesFromRecord(
  record: JsonRecord,
): NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number][] {
  return uniqueExternalReferences(
    marketplaceReferenceRules().flatMap((rule) => {
      const containers = [record, ...rule.containerKeys.map((key) => recordField(record, [key]))].filter(
        (value): value is JsonRecord => Boolean(value),
      );

      return containers.flatMap((container) =>
        providerReferencesFromValue(rule, valueField(container, rule.valueKeys)),
      );
    }),
  );
}

function providerReferencesFromValue(
  rule: CatalogProviderExternalReferenceRule,
  value: unknown,
): NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number][] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => providerReferencesFromValue(rule, entry));
  }

  if (isRecord(value)) {
    return providerReferenceIdsFromRecord(rule, value)
      .map((id) => toMarketplaceReference(rule, id))
      .filter(
        (
          reference,
        ): reference is NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number] =>
          Boolean(reference),
      );
  }

  return cleanMarketplaceId(value)
    .map((id) => toMarketplaceReference(rule, id))
    .filter(
      (
        reference,
      ): reference is NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number] =>
        Boolean(reference),
    );
}

function providerReferenceIdsFromRecord(rule: CatalogProviderExternalReferenceRule, record: JsonRecord): string[] {
  return rule.recordIdKeys.flatMap((key) => cleanMarketplaceId(record[key]));
}

function toMarketplaceReference(
  rule: CatalogProviderExternalReferenceRule,
  id: string,
): NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number] | null {
  const normalizedId = id.trim().toLowerCase();
  if (!normalizedId) {
    return null;
  }

  return {
    providerKey: rule.providerKey,
    externalKey: normalizedId.startsWith(rule.externalKeyPrefix)
      ? normalizedId
      : `${rule.externalKeyPrefix}${normalizedId}`,
  };
}

function cleanMarketplaceId(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number") {
    const cleaned = String(value).trim();
    return cleaned ? [cleaned] : [];
  }

  return [];
}

function uniqueExternalReferences(
  references: readonly NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number][],
): NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number][] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = externalReferenceIdentity(reference);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function externalReferenceIdentity(
  reference: NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number],
): string {
  return `${reference.providerKey.trim().toLowerCase()}:${reference.externalKey.trim().toLowerCase()}`;
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

function recordField(record: JsonRecord, keys: readonly string[]): JsonRecord | null {
  const value = valueField(record, keys);
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function normalizeCardVariants(variants: Readonly<Record<string, boolean>> | undefined): readonly PokemonCardVariant[] {
  const sourceKeysByVariantKey = new Map<string, string>();
  Object.entries(variants ?? {})
    .filter(([, value]) => value === true)
    .map(([key]) => key.trim())
    .filter((key) => key.length > 0)
    .sort(compareVariantSourceKeys)
    .forEach((sourceKey) => {
      const variantKey = normalizeVariantKey(sourceKey);
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

  const primaryKey = sourceKeys.find((key) => normalizeVariantKey(key) === "standard") ?? sourceKeys[0] ?? null;

  return sourceKeys.map((sourceKey) => {
    const key = normalizeVariantKey(sourceKey);

    return {
      key,
      displayName: variantLabel(sourceKey),
      sourceKey,
      isPrimaryImage: sourceKey === primaryKey,
      parallelSet: isParallelSetVariant(key),
    };
  });
}

function compareVariantSourceKeys(left: string, right: string): number {
  const leftOrder = variantSortOrder(left);
  const rightOrder = variantSortOrder(right);

  return leftOrder === rightOrder ? left.localeCompare(right) : leftOrder - rightOrder;
}

function variantSortOrder(sourceKey: string): number {
  return variantRuleBySourceKey(sourceKey)?.sortOrder ?? 100;
}

function isParallelSetVariant(variantKey: string): boolean {
  return variantRuleByVariantKey(variantKey)?.parallelSet ?? false;
}

function normalizeVariantKey(sourceKey: string): string {
  const key = sourceKey.trim();
  const compact = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const rule = variantRuleByCompactSourceKey(compact);

  if (rule) {
    return rule.variantKey;
  }

  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function variantLabel(sourceKey: string): string {
  return (
    variantRuleBySourceKey(sourceKey)?.displayName ??
    `${TCGDEX_PROFILE.normalizedObservationMapping.unknownVariantLabelPrefix} - ${humanizeVariantKey(sourceKey)}`
  );
}

function marketplaceReferenceRules(): readonly CatalogProviderExternalReferenceRule[] {
  return TCGDEX_PROFILE.externalReferenceExtractionRules.rules;
}

function pricingKeysForVariant(
  rule: CatalogProviderExternalReferenceRule,
  variant: PokemonCardVariant,
): readonly string[] {
  const variantRule = variantRuleByVariantKey(variant.key);
  return [
    ...(variantRule?.pricingKeys ?? []),
    ...(variant.sourceKey ? [variant.sourceKey] : []),
    variant.key,
    ...rule.valueKeys,
  ];
}

function variantRules(): readonly CatalogProviderVariantRule[] {
  return TCGDEX_PROFILE.normalizedObservationMapping.variantRules;
}

function variantRuleBySourceKey(sourceKey: string): CatalogProviderVariantRule | null {
  return variantRuleByCompactSourceKey(sourceKey.toLowerCase().replace(/[^a-z0-9]+/g, ""));
}

function variantRuleByCompactSourceKey(compactSourceKey: string): CatalogProviderVariantRule | null {
  return (
    variantRules().find((rule) =>
      rule.sourceKeys.some((sourceKey) => sourceKey.toLowerCase().replace(/[^a-z0-9]+/g, "") === compactSourceKey),
    ) ?? null
  );
}

function variantRuleByVariantKey(variantKey: string): CatalogProviderVariantRule | null {
  return variantRules().find((rule) => rule.variantKey === variantKey) ?? null;
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

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
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

function tcgdexUrl(template: string, params: Readonly<Record<string, string>>): string {
  const path = Object.entries(params).reduce(
    (current, [key, value]) => current.replace(`{${key}}`, encodeURIComponent(value)),
    template,
  );
  return `${TCGDEX_PROFILE.connector.baseUrl}${path}`;
}
