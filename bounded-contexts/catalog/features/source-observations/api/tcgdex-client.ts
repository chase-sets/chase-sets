import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
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

export type TcgdexSetImportProgress = Readonly<{
  phase: "fetching" | "recording" | "completed";
  completed: number;
  total: number;
  currentName: string | null;
}>;

const TCGDEX_LANGUAGE_OPTIONS: readonly TcgdexLanguageOption[] = [
  { languageCode: "en" },
  { languageCode: "fr" },
  { languageCode: "es" },
  { languageCode: "it" },
  { languageCode: "pt" },
  { languageCode: "pt-br" },
  { languageCode: "pt-pt" },
  { languageCode: "de" },
  { languageCode: "nl" },
  { languageCode: "pl" },
  { languageCode: "ru" },
  { languageCode: "ja" },
  { languageCode: "ko" },
  { languageCode: "zh-tw" },
  { languageCode: "id" },
  { languageCode: "th" },
  { languageCode: "zh-cn" },
];

export function listTcgdexLanguageOptions(): readonly TcgdexLanguageOption[] {
  return TCGDEX_LANGUAGE_OPTIONS;
}

export async function fetchTcgdexSeriesOptions(input: {
  languageCode: string;
  fetch?: typeof globalThis.fetch;
}): Promise<readonly TcgdexSeriesOption[]> {
  const languageCode = normalizeKey(input.languageCode || "en");
  const fetcher = input.fetch ?? globalThis.fetch;
  const url = `${TCGDEX_BASE_URL}/${languageCode}/series`;
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
    const url = `${TCGDEX_BASE_URL}/${languageCode}/series/${encodeURIComponent(seriesId)}`;
    const series = await fetchJson<TcgdexSeries>(fetcher, url);

    return series.sets.map((item) => toExpansionOption(item, series));
  }

  const url = `${TCGDEX_BASE_URL}/${languageCode}/sets`;
  const sets = await fetchJson<readonly TcgdexSetBrief[]>(fetcher, url);

  return sets.map((item) => toExpansionOption(item, null));
}

export async function fetchTcgdexSetObservations(input: {
  languageCode: string;
  setId: string;
  fetch?: typeof globalThis.fetch;
  onProgress?: (progress: TcgdexSetImportProgress) => void;
}): Promise<readonly TcgdexObservationInput[]> {
  const languageCode = normalizeKey(input.languageCode || "en");
  const setId = input.setId.trim();
  const fetcher = input.fetch ?? globalThis.fetch;
  const setUrl = `${TCGDEX_BASE_URL}/${languageCode}/sets/${encodeURIComponent(setId)}`;
  const set = await fetchJson<TcgdexSet>(fetcher, setUrl);
  const observedAt = new Date().toISOString();
  const observations: TcgdexObservationInput[] = [];
  input.onProgress?.({
    phase: "fetching",
    completed: 0,
    total: set.cards.length,
    currentName: null,
  });

  for (const [index, cardBrief] of set.cards.entries()) {
    const cardUrl = `${TCGDEX_BASE_URL}/${languageCode}/cards/${encodeURIComponent(cardBrief.id)}`;
    const card = await fetchJson<TcgdexCard>(fetcher, cardUrl);
    observations.push(
      await toObservation({
        card,
        set,
        languageCode,
        sourceUrl: cardUrl,
        observedAt,
      }),
    );
    input.onProgress?.({
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

async function toObservation(input: {
  card: TcgdexCard;
  set: TcgdexSet;
  languageCode: string;
  sourceUrl: string;
  observedAt: string;
}): Promise<TcgdexObservationInput> {
  const releaseYear = releaseYearFromDate(input.set.releaseDate);
  const sourcePayload = toJsonValue(sanitizeTcgdexCardPayload(input.card));
  const sourceImageUrls = input.card.image
    ? [`${input.card.image}/${HIGH_QUALITY_ASSET_VARIANT}`]
    : [];
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
    imageUrls: sourceImageUrls,
    productAssetSet: null,
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

export async function normalizeTcgdexImageAsset(input: {
  imageBaseUrl: string;
  storageBaseKey: string;
  observedAt: string;
  fetcher: typeof globalThis.fetch;
  assetStorage: CatalogAssetStorage;
  imageProcessor?: CatalogImageProcessor;
}): Promise<NonNullable<SourceObservationNormalized["productAssetSet"]>> {
  const assetUrl = `${input.imageBaseUrl}/${HIGH_QUALITY_ASSET_VARIANT}`;
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
