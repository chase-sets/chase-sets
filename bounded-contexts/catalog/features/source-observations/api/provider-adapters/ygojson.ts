import { createHash } from "node:crypto";

import { t } from "@chase-sets/localization";
import { runCatalogIntegrationDryRun } from "../catalog-integration-engine";
import type { CatalogIntegrationDryRunResult } from "../catalog-integration-engine";
import { createCatalogProviderCredentialReadiness } from "../catalog-integration-credential-readiness";
import { defineCatalogIntegrationUnitKey } from "../integration-unit";
import type {
  ProviderAdapter,
  ProviderImportPlan,
  ProviderOptionItem,
  ProviderOptionQueryInput,
  ProviderOptionQueryResult,
  ProviderPayloadEnvelope,
} from "./provider-adapter";

export const YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "ygojson",
  productDomain: "yugioh",
  productForm: "set",
  ingestionPurpose: "reference-data",
});

export const YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "ygojson",
  productDomain: "yugioh",
  productForm: "sealed-product",
  ingestionPurpose: "reference-data",
});

export const YGOJSON_PRODUCTION_PROFILE_VERSION = "2026.06.21";
export const YGOJSON_YUGIOH_SEALED_PRODUCT_PROFILE_VERSION = "2026.07.14";
export const YGOJSON_VALIDATION_PROFILE_VERSION = "ygojson-validation-2026.06.21";

export type YgojsonProviderPayload =
  | Readonly<{
      kind: "set-reference";
      set: YgojsonSetData;
      sourceUrl: string;
    }>
  | Readonly<{
      kind: "sealed-product-reference";
      sealedProduct: YgojsonSealedProductData;
      sourceUrl: string;
    }>;

export type YgojsonProviderAdapterOptions = Readonly<{
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  now?: () => Date;
  profileVersion?: string;
}>;

type YgojsonLocalizedText = Readonly<Record<string, string | undefined>>;

type YgojsonExternalIds = Readonly<{
  yugipedia?: Readonly<{
    id?: string | number;
    name?: string;
  }>;
  dbIDs?: readonly (string | number)[];
}>;

type YgojsonLocaleData = Readonly<{
  language?: string;
  date?: string;
  image?: string;
  externalIDs?: YgojsonExternalIds;
}>;

type YgojsonSetData = Readonly<{
  id?: string;
  name?: YgojsonLocalizedText;
  locales?: Readonly<Record<string, YgojsonLocaleData | undefined>>;
  contents?: readonly YgojsonSetContents[];
  externalIDs?: YgojsonExternalIds;
}>;

type YgojsonSetContents = Readonly<{
  locales?: readonly string[];
  formats?: readonly string[];
  editions?: readonly string[];
  cards?: readonly YgojsonSetCardPrint[];
  packs?: readonly YgojsonPackContent[];
}>;

type YgojsonSetCardPrint = Readonly<{
  id?: string;
  card?: string;
  suffix?: string;
  rarity?: string;
  qty?: number;
}>;

type YgojsonSealedProductData = Readonly<{
  id?: string;
  name?: YgojsonLocalizedText;
  boxOf?: readonly string[];
  locales?: Readonly<Record<string, YgojsonLocaleData | undefined>>;
  contents?: readonly YgojsonSealedProductContents[];
  externalIDs?: YgojsonExternalIds;
}>;

type YgojsonSealedProductContents = Readonly<{
  locales?: readonly string[];
  packs?: readonly YgojsonPackContent[];
  items?: readonly YgojsonSealedItemContent[];
}>;

type YgojsonPackContent = Readonly<{
  set?: string;
  qty?: number;
}>;

type YgojsonSealedItemContent = Readonly<{
  name?: string;
  qty?: number;
}>;

export function createYgojsonProviderAdapter(
  options: YgojsonProviderAdapterOptions = {},
): ProviderAdapter<YgojsonProviderPayload> {
  return {
    providerKey: "ygojson",
    capabilities: {
      supportsOptionQueries: true,
      supportsImportPlanning: true,
      supportsPayloadFetch: true,
    },
    async listIntegrationUnits() {
      const profileVersion = options.profileVersion ?? YGOJSON_PRODUCTION_PROFILE_VERSION;
      return [
        {
          unitKey: YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
          providerKey: "ygojson",
          productDomain: "yugioh",
          productForm: "set",
          ingestionPurpose: "reference-data",
          displayName: "YGOJSON Yu-Gi-Oh set reference data",
          profileVersion,
        },
        {
          unitKey: YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
          providerKey: "ygojson",
          productDomain: "yugioh",
          productForm: "sealed-product",
          ingestionPurpose: "reference-data",
          displayName: "YGOJSON Yu-Gi-Oh sealed-product reference data",
          profileVersion: options.profileVersion ?? YGOJSON_YUGIOH_SEALED_PRODUCT_PROFILE_VERSION,
        },
      ];
    },
    async listOptions(input) {
      return listYgojsonOptions(input, options);
    },
    async planImport(scope) {
      assertYgojsonUnit(scope.unitKey);

      if (scope.unitKey === YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY) {
        const setId = requireString(
          scope.values.setId ?? scope.values.id,
          "YGOJSON set import planning requires setId.",
        );
        return {
          unitKey: scope.unitKey,
          planKey: `ygojson:set:${setId}`,
          scope: {
            unitKey: scope.unitKey,
            scopeKey: "set",
            values: { ...scope.values, setId },
          },
          estimatedPayloads: 1,
          transportSteps: ["Fetch YGOJSON set file", "Attach set reference provenance"],
        };
      }

      const sealedProductId = requireString(
        scope.values.sealedProductId ?? scope.values.productId ?? scope.values.id,
        "YGOJSON sealed-product import planning requires sealedProductId.",
      );
      return {
        unitKey: scope.unitKey,
        planKey: `ygojson:sealed-product:${sealedProductId}`,
        scope: {
          unitKey: scope.unitKey,
          scopeKey: "sealed-product",
          values: { ...scope.values, sealedProductId },
        },
        estimatedPayloads: 1,
        transportSteps: ["Fetch YGOJSON sealed product file", "Attach sealed-product reference provenance"],
      };
    },
    async *fetchPayloads(plan, fetchOptions) {
      assertYgojsonUnit(plan.unitKey);
      const fetchedAt = (options.now ?? (() => new Date()))().toISOString();

      if (plan.unitKey === YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY) {
        const setId = requireString(plan.scope.values.setId, "YGOJSON set payload fetch requires setId.");
        const sourceUrl = ygojsonIndividualUrl("sets", setId, options);
        const set = await fetchJson<YgojsonSetData>(sourceUrl, options);
        const externalKey = `set:${requireString(set.id ?? setId, "YGOJSON set payload is missing id.")}`;
        yield ygojsonEnvelope({
          unitKey: plan.unitKey,
          externalKey,
          payload: { kind: "set-reference", set, sourceUrl },
          sourceUrl,
          sourceUpdatedAt: ygojsonReleaseDate(set),
          fetchedAt,
        });
        await fetchOptions?.onProgress?.({
          phase: "fetching",
          completed: 1,
          total: 1,
          currentLabel: ygojsonName(set.name) ?? setId,
        });
        return;
      }

      const sealedProductId = requireString(
        plan.scope.values.sealedProductId,
        "YGOJSON sealed-product payload fetch requires sealedProductId.",
      );
      const sourceUrl = ygojsonIndividualUrl("sealedProducts", sealedProductId, options);
      const sealedProduct = await fetchJson<YgojsonSealedProductData>(sourceUrl, options);
      const externalKey = `sealed-product:${requireString(
        sealedProduct.id ?? sealedProductId,
        "YGOJSON sealed-product payload is missing id.",
      )}`;
      yield ygojsonEnvelope({
        unitKey: plan.unitKey,
        externalKey,
        payload: { kind: "sealed-product-reference", sealedProduct, sourceUrl },
        sourceUrl,
        sourceUpdatedAt: ygojsonReleaseDate(sealedProduct),
        fetchedAt,
      });
      await fetchOptions?.onProgress?.({
        phase: "fetching",
        completed: 1,
        total: 1,
        currentLabel: ygojsonName(sealedProduct.name) ?? sealedProductId,
      });
    },
    async getCredentialReadiness() {
      return ygojsonUnitKeys().map((unitKey) =>
        createCatalogProviderCredentialReadiness({
          providerKey: "ygojson",
          unitKey,
          requirement: "not-required",
          sourceKind: "none",
          state: "not-required",
          message: t("catalog.features.sourceObservations.api.providerAdapters.ygojson.credential.not.required"),
          evidence: { credentialRequirement: "not-required", publicJson: true },
        }),
      );
    },
    async getTransportDiagnostics() {
      return ygojsonUnitKeys().map((unitKey) => ({
        code: "ygojson-public-json-transport-configured",
        severity: "info",
        message: t("catalog.features.sourceObservations.api.providerAdapters.ygojson.public.json.transport.configured"),
        unitKey,
      }));
    },
  };
}

export function createYgojsonValidationProviderAdapter(): ProviderAdapter<YgojsonProviderPayload> {
  return createYgojsonProviderAdapter({
    fetch: ygojsonValidationFetch,
    now: () => new Date("2026-06-21T00:00:00.000Z"),
    profileVersion: YGOJSON_VALIDATION_PROFILE_VERSION,
  });
}

export async function runYgojsonSetReferenceValidationDryRun(
  adapter: ProviderAdapter<YgojsonProviderPayload> = createYgojsonValidationProviderAdapter(),
): Promise<CatalogIntegrationDryRunResult> {
  const plan = await adapter.planImport({
    unitKey: YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
    scopeKey: "set",
    values: { setId: ygojsonValidationSet.id },
  });
  const payloads: ProviderPayloadEnvelope<YgojsonProviderPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan)) {
    payloads.push(payload);
  }

  return runCatalogIntegrationDryRun({
    unitKey: YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
    profileVersion: YGOJSON_VALIDATION_PROFILE_VERSION,
    payloads,
    normalize: (envelope) => {
      if (envelope.payload.kind !== "set-reference") {
        throw new Error("YGOJSON set-reference dry run received a non-set payload.");
      }

      return {
        unitKey: envelope.unitKey,
        providerKey: envelope.providerKey,
        externalKey: envelope.externalKey,
        profileVersion: YGOJSON_VALIDATION_PROFILE_VERSION,
        normalizedFacts: {
          productLineName: "Yu-Gi-Oh!",
          name: ygojsonName(envelope.payload.set.name) ?? "",
          ygojsonId: stringValue(envelope.payload.set.id) ?? "",
          releaseDate: ygojsonReleaseDate(envelope.payload.set) ?? "",
          localeCount: String(localeCodes(envelope.payload.set).length),
          printCount: String(setPrintCount(envelope.payload.set)),
          packContentEvidenceCount: String(setPackContentCount(envelope.payload.set)),
          yugipediaId: stringValue(envelope.payload.set.externalIDs?.yugipedia?.id) ?? "",
        },
        sourceUrl: envelope.provenance.sourceUrl,
        sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
        sourceHash: envelope.provenance.contentHash,
      };
    },
  });
}

export async function runYgojsonSealedProductReferenceValidationDryRun(
  adapter: ProviderAdapter<YgojsonProviderPayload> = createYgojsonValidationProviderAdapter(),
): Promise<CatalogIntegrationDryRunResult> {
  const plan = await adapter.planImport({
    unitKey: YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
    scopeKey: "sealed-product",
    values: { sealedProductId: ygojsonValidationSealedProduct.id },
  });
  const payloads: ProviderPayloadEnvelope<YgojsonProviderPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan)) {
    payloads.push(payload);
  }

  return runCatalogIntegrationDryRun({
    unitKey: YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
    profileVersion: YGOJSON_VALIDATION_PROFILE_VERSION,
    payloads,
    normalize: (envelope) => {
      if (envelope.payload.kind !== "sealed-product-reference") {
        throw new Error("YGOJSON sealed-product dry run received a non-sealed-product payload.");
      }

      return {
        unitKey: envelope.unitKey,
        providerKey: envelope.providerKey,
        externalKey: envelope.externalKey,
        profileVersion: YGOJSON_VALIDATION_PROFILE_VERSION,
        normalizedFacts: {
          productLineName: "Yu-Gi-Oh!",
          name: ygojsonName(envelope.payload.sealedProduct.name) ?? "",
          ygojsonId: stringValue(envelope.payload.sealedProduct.id) ?? "",
          releaseDate: ygojsonReleaseDate(envelope.payload.sealedProduct) ?? "",
          localeCount: String(localeCodes(envelope.payload.sealedProduct).length),
          boxOfSetCount: String(envelope.payload.sealedProduct.boxOf?.length ?? 0),
          packContentEvidenceCount: String(sealedProductPackContentCount(envelope.payload.sealedProduct)),
          yugipediaId: stringValue(envelope.payload.sealedProduct.externalIDs?.yugipedia?.id) ?? "",
        },
        sourceUrl: envelope.provenance.sourceUrl,
        sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
        sourceHash: envelope.provenance.contentHash,
      };
    },
  });
}

async function listYgojsonOptions(
  input: ProviderOptionQueryInput,
  options: YgojsonProviderAdapterOptions,
): Promise<ProviderOptionQueryResult> {
  assertYgojsonUnit(input.unitKey);
  const optionKind = input.optionKind.trim().toLowerCase();

  if (optionKind === "sets" || optionKind === "set") {
    const sets = await fetchYgojsonAggregate<YgojsonSetData>("sets", options);
    return {
      items: sets.map((set) => ({
        value: requireString(set.id, "YGOJSON set option is missing id."),
        label: ygojsonName(set.name) ?? requireString(set.id, "YGOJSON set option is missing id."),
        metadata: optionalMetadata({
          releaseDate: ygojsonReleaseDate(set) ?? null,
          localeCount: String(localeCodes(set).length),
          printCount: String(setPrintCount(set)),
          yugipediaId: stringValue(set.externalIDs?.yugipedia?.id),
        }),
      })),
    };
  }

  if (optionKind === "sealed-products" || optionKind === "sealed-product" || optionKind === "products") {
    const sealedProducts = await fetchYgojsonAggregate<YgojsonSealedProductData>("sealedProducts", options);
    return {
      items: sealedProducts.map((sealedProduct) => ({
        value: requireString(sealedProduct.id, "YGOJSON sealed-product option is missing id."),
        label:
          ygojsonName(sealedProduct.name) ??
          requireString(sealedProduct.id, "YGOJSON sealed-product option is missing id."),
        metadata: optionalMetadata({
          releaseDate: ygojsonReleaseDate(sealedProduct) ?? null,
          localeCount: String(localeCodes(sealedProduct).length),
          boxOfSetCount: String(sealedProduct.boxOf?.length ?? 0),
          packContentEvidenceCount: String(sealedProductPackContentCount(sealedProduct)),
          yugipediaId: stringValue(sealedProduct.externalIDs?.yugipedia?.id),
        }),
      })),
    };
  }

  return { items: [] };
}

async function fetchYgojsonAggregate<TItem>(
  collection: "sets" | "sealedProducts",
  options: YgojsonProviderAdapterOptions,
): Promise<readonly TItem[]> {
  return fetchJson<readonly TItem[]>(ygojsonAggregateUrl(collection, options), options);
}

async function fetchJson<T>(url: string, options: YgojsonProviderAdapterOptions): Promise<T> {
  const response = await (options.fetch ?? globalThis.fetch)(url);
  if (!response.ok) {
    throw new Error(`YGOJSON request failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as T;
}

function ygojsonAggregateUrl(collection: "sets" | "sealedProducts", options: YgojsonProviderAdapterOptions): string {
  return ygojsonUrl(`aggregate/${collection}.json`, options);
}

function ygojsonIndividualUrl(
  collection: "sets" | "sealedProducts",
  id: string,
  options: YgojsonProviderAdapterOptions,
): string {
  return ygojsonUrl(`individual/${collection}/${id}.json`, options);
}

function ygojsonUrl(path: string, options: YgojsonProviderAdapterOptions): string {
  return `${(options.baseUrl ?? "https://raw.githubusercontent.com/iconmaster5326/YGOJSON/v1").replace(
    /\/$/,
    "",
  )}/${path}`;
}

function ygojsonEnvelope(input: {
  unitKey: string;
  externalKey: string;
  payload: YgojsonProviderPayload;
  sourceUrl: string;
  sourceUpdatedAt?: string;
  fetchedAt: string;
}): ProviderPayloadEnvelope<YgojsonProviderPayload> {
  return {
    unitKey: input.unitKey,
    providerKey: "ygojson",
    externalKey: input.externalKey,
    payload: input.payload,
    provenance: {
      sourceUrl: input.sourceUrl,
      sourceUpdatedAt: input.sourceUpdatedAt,
      fetchedAt: input.fetchedAt,
      contentHash: `sha256:${createHash("sha256").update(JSON.stringify(input.payload)).digest("hex")}`,
    },
  };
}

function ygojsonName(name: YgojsonLocalizedText | undefined): string | null {
  return stringValue(name?.en) ?? stringValue(Object.values(name ?? {}).find((value) => stringValue(value)));
}

function ygojsonReleaseDate(record: Pick<YgojsonSetData | YgojsonSealedProductData, "locales">): string | undefined {
  const locales = record.locales ?? {};
  return (
    stringValue(locales.en?.date) ??
    stringValue(Object.values(locales).find((locale) => stringValue(locale?.date))?.date) ??
    undefined
  );
}

function localeCodes(record: Pick<YgojsonSetData | YgojsonSealedProductData, "locales">): readonly string[] {
  return Object.keys(record.locales ?? {}).sort();
}

function setPrintCount(set: YgojsonSetData): number {
  return (set.contents ?? []).reduce((total, content) => total + (content.cards?.length ?? 0), 0);
}

function setPackContentCount(set: YgojsonSetData): number {
  return (set.contents ?? []).reduce(
    (total, content) => total + (content.packs ?? []).reduce((sum, pack) => sum + (pack.qty ?? 1), 0),
    0,
  );
}

function sealedProductPackContentCount(sealedProduct: YgojsonSealedProductData): number {
  return (sealedProduct.contents ?? []).reduce(
    (total, content) => total + (content.packs ?? []).reduce((sum, pack) => sum + (pack.qty ?? 1), 0),
    0,
  );
}

function assertYgojsonUnit(unitKey: string): void {
  if (
    unitKey !== YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY &&
    unitKey !== YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY
  ) {
    throw new Error(`YGOJSON adapter does not support Catalog integration unit '${unitKey}'.`);
  }
}

function ygojsonUnitKeys(): readonly [
  typeof YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
  typeof YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
] {
  return [YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY, YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY];
}

function optionalMetadata(values: Readonly<Record<string, string | null | undefined>>): ProviderOptionItem["metadata"] {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function requireString(value: unknown, message: string): string {
  const normalized = stringValue(value);
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  return null;
}

function ygojsonValidationFetch(input: RequestInfo | URL): Promise<Response> {
  const response = ygojsonValidationResponses[String(input)];
  if (!response) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }

  return Promise.resolve(
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

const ygojsonValidationSet = {
  id: "11111111-1111-4111-8111-111111111111",
  name: { en: "Legend of Blue Eyes White Dragon" },
  locales: {
    en: {
      language: "en",
      date: "2002-03-08",
      image: "https://ms.yugipedia.com//placeholder/LOB-EN.png",
      externalIDs: { dbIDs: [100000001] },
    },
  },
  contents: [
    {
      locales: ["en"],
      formats: ["tcg"],
      editions: ["unlimited"],
      cards: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          card: "44444444-4444-4444-8444-444444444444",
          suffix: "LOB-001",
          rarity: "ultra",
        },
      ],
    },
  ],
  externalIDs: {
    yugipedia: {
      id: 12345,
      name: "Legend of Blue Eyes White Dragon",
    },
  },
} as const satisfies YgojsonSetData;

const ygojsonValidationSealedProduct = {
  id: "22222222-2222-4222-8222-222222222222",
  name: { en: "Legend of Blue Eyes White Dragon Booster Box" },
  boxOf: [ygojsonValidationSet.id],
  locales: {
    en: {
      language: "en",
      date: "2002-03-08",
      externalIDs: { dbIDs: [100000002] },
    },
  },
  contents: [
    {
      locales: ["en"],
      packs: [{ set: ygojsonValidationSet.id, qty: 24 }],
    },
  ],
  externalIDs: {
    yugipedia: {
      id: 67890,
      name: "Legend of Blue Eyes White Dragon Booster Box",
    },
  },
} as const satisfies YgojsonSealedProductData;

const ygojsonValidationResponses: Readonly<Record<string, unknown>> = {
  "https://raw.githubusercontent.com/iconmaster5326/YGOJSON/v1/aggregate/sets.json": [ygojsonValidationSet],
  "https://raw.githubusercontent.com/iconmaster5326/YGOJSON/v1/aggregate/sealedProducts.json": [
    ygojsonValidationSealedProduct,
  ],
  [`https://raw.githubusercontent.com/iconmaster5326/YGOJSON/v1/individual/sets/${ygojsonValidationSet.id}.json`]:
    ygojsonValidationSet,
  [`https://raw.githubusercontent.com/iconmaster5326/YGOJSON/v1/individual/sealedProducts/${ygojsonValidationSealedProduct.id}.json`]:
    ygojsonValidationSealedProduct,
};
