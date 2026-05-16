import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import { productAssetSetCompatibilityImageUrls } from "../../../support/runtime-support/product-assets";
import type { SourceObservationNormalized } from "../domain/domain";
import type { CatalogAssetStorage } from "./asset-storage";
import {
  normalizeProductAssetSet,
  type CatalogImageProcessor,
} from "./product-asset-normalization";

const TCGDEX_BASE_URL = "https://api.tcgdex.net/v2";
const PROVIDER_KEY = "tcgdex";
const HIGH_QUALITY_ASSET_VARIANT = "high.webp";

type JsonRecord = Record<string, unknown>;

export type TcgdexCardBrief = Readonly<{
  id: string;
  localId: string | number;
  name: string;
  image?: string;
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
  normalized: SourceObservationNormalized;
  sourcePayload: JsonValue;
}>;

export type TcgdexSetImportResult = Readonly<{
  setId: string;
  expansionId: string;
  languageCode: string;
  observed: number;
  observationIds: readonly string[];
}>;

export async function fetchTcgdexSetObservations(input: {
  languageCode: string;
  setId: string;
  fetch?: typeof globalThis.fetch;
  assetStorage?: CatalogAssetStorage;
  imageProcessor?: CatalogImageProcessor;
}): Promise<readonly TcgdexObservationInput[]> {
  const languageCode = normalizeKey(input.languageCode || "en");
  const setId = input.setId.trim();
  const fetcher = input.fetch ?? globalThis.fetch;
  const setUrl = `${TCGDEX_BASE_URL}/${languageCode}/sets/${encodeURIComponent(setId)}`;
  const set = await fetchJson<TcgdexSet>(fetcher, setUrl);
  const observedAt = new Date().toISOString();
  const observations: TcgdexObservationInput[] = [];

  for (const cardBrief of set.cards) {
    const cardUrl = `${TCGDEX_BASE_URL}/${languageCode}/cards/${encodeURIComponent(cardBrief.id)}`;
    const card = await fetchJson<TcgdexCard>(fetcher, cardUrl);
    observations.push(
      await toObservation({
        card,
        set,
        languageCode,
        sourceUrl: cardUrl,
        observedAt,
        fetcher,
        assetStorage: input.assetStorage,
        imageProcessor: input.imageProcessor,
      }),
    );
  }

  return observations;
}

async function toObservation(input: {
  card: TcgdexCard;
  set: TcgdexSet;
  languageCode: string;
  sourceUrl: string;
  observedAt: string;
  fetcher: typeof globalThis.fetch;
  assetStorage?: CatalogAssetStorage;
  imageProcessor?: CatalogImageProcessor;
}): Promise<TcgdexObservationInput> {
  const releaseYear = releaseYearFromDate(input.set.releaseDate);
  const sourcePayload = toJsonValue(sanitizeTcgdexCardPayload(input.card));
  const sourceImageUrls = input.card.image
    ? [`${input.card.image}/${HIGH_QUALITY_ASSET_VARIANT}`]
    : [];
  const productAssetSet = await mirrorTcgdexImageAsset({
    card: input.card,
    languageCode: input.languageCode,
    observedAt: input.observedAt,
    fetcher: input.fetcher,
    assetStorage: input.assetStorage,
    imageProcessor: input.imageProcessor,
  });
  const imageUrls = productAssetSetCompatibilityImageUrls(productAssetSet);
  const normalized: SourceObservationNormalized = {
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
    imageUrls,
    productAssetSet,
    parallelSet: input.card.variants?.reverse === true,
    variants: normalizeVariants(input.card.variants),
  };
  const providerNormalizedForHash: SourceObservationNormalized = {
    ...normalized,
    imageUrls: sourceImageUrls,
    productAssetSet: null,
  };

  return {
    observationId: buildObservationId(input.languageCode, input.card.id),
    providerKey: PROVIDER_KEY,
    externalKey: input.card.id,
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
}

async function mirrorTcgdexImageAsset(input: {
  card: TcgdexCard;
  languageCode: string;
  observedAt: string;
  fetcher: typeof globalThis.fetch;
  assetStorage?: CatalogAssetStorage;
  imageProcessor?: CatalogImageProcessor;
}): Promise<SourceObservationNormalized["productAssetSet"]> {
  if (!input.card.image) {
    return null;
  }

  if (!input.assetStorage) {
    throw new Error("Catalog asset storage is required to import TCGdex image assets.");
  }

  const assetUrl = `${input.card.image}/${HIGH_QUALITY_ASSET_VARIANT}`;
  const response = await input.fetcher(assetUrl);
  if (!response.ok) {
    throw new Error(`TCGdex asset request failed with ${response.status} for ${assetUrl}.`);
  }

  const body = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ||
    "image/webp";

  if (contentType !== "image/webp") {
    throw new Error(`TCGdex high quality asset must be image/webp for ${assetUrl}.`);
  }

  return normalizeProductAssetSet({
    sourceBody: body,
    sourceContentType: contentType,
    storageBaseKey: tcgdexAssetObjectBaseKey(input.languageCode, input.card.id),
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

function buildObservationId(languageCode: string, cardId: string): string {
  return `tcgdex_${normalizeKey(languageCode)}_${cardId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function tcgdexAssetObjectBaseKey(languageCode: string, cardId: string): string {
  const externalKey = cardId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return `catalog/source-observations/tcgdex/${normalizeKey(languageCode)}/${externalKey}`;
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

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
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
