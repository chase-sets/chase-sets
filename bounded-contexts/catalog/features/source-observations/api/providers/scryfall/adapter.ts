import { createHash } from "node:crypto";

import { t } from "@chase-sets/localization";
import { runCatalogIntegrationDryRun } from "../../governance/catalog-integration-engine";
import type { CatalogIntegrationDryRunResult } from "../../governance/catalog-integration-engine";
import { createCatalogProviderCredentialReadiness } from "../../governance/catalog-integration-credential-readiness";
import { defineCatalogIntegrationUnitKey } from "../../governance/integration-unit";
import type {
  ProviderAdapter,
  ProviderImportPlan,
  ProviderOptionItem,
  ProviderOptionQueryInput,
  ProviderOptionQueryResult,
  ProviderPayloadEnvelope,
} from "../../provider-adapters/provider-adapter";

export const SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "scryfall",
  productDomain: "mtg",
  productForm: "single-card",
  ingestionPurpose: "reference-data",
});

export const SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "scryfall",
  productDomain: "mtg",
  productForm: "single-card",
  ingestionPurpose: "image-evidence",
});

export const SCRYFALL_PRODUCTION_PROFILE_VERSION = "2026.06.19";
export const SCRYFALL_VALIDATION_PROFILE_VERSION = "scryfall-validation-2026.06.08";

export type ScryfallProviderPayload =
  | Readonly<{
      kind: "single-card";
      card: ScryfallCard;
    }>
  | Readonly<{
      kind: "image-evidence";
      card: ScryfallCard;
      imageUris: Readonly<Record<string, string>>;
    }>;

export type ScryfallProviderAdapterOptions = Readonly<{
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  now?: () => Date;
  userAgent?: string;
  profileVersion?: string;
}>;

type ScryfallListResponse<T> = Readonly<{
  object?: "list";
  has_more?: boolean;
  next_page?: string;
  data?: readonly T[];
}>;

type ScryfallBulkData = Readonly<{
  type?: string;
  name?: string;
  updated_at?: string;
  download_uri?: string;
  content_type?: string;
  content_encoding?: string;
}>;

type ScryfallSet = Readonly<{
  id?: string;
  code?: string;
  name?: string;
  set_type?: string;
  released_at?: string;
  card_count?: number;
  digital?: boolean;
}>;

type ScryfallCard = Readonly<{
  id?: string;
  oracle_id?: string;
  name?: string;
  lang?: string;
  released_at?: string;
  uri?: string;
  scryfall_uri?: string;
  layout?: string;
  image_status?: string;
  image_uris?: Readonly<Record<string, string>>;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  set?: string;
  set_id?: string;
  set_name?: string;
  collector_number?: string;
  rarity?: string;
  artist?: string;
  finishes?: readonly string[];
  tcgplayer_id?: string | number;
  prices?: Readonly<Record<string, string | null>>;
}>;

export function createScryfallProviderAdapter(
  options: ScryfallProviderAdapterOptions = {},
): ProviderAdapter<ScryfallProviderPayload> {
  return {
    providerKey: "scryfall",
    capabilities: {
      supportsOptionQueries: true,
      supportsImportPlanning: true,
      supportsPayloadFetch: true,
    },
    async listIntegrationUnits() {
      const profileVersion = options.profileVersion ?? SCRYFALL_PRODUCTION_PROFILE_VERSION;
      return [
        {
          unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
          providerKey: "scryfall",
          productDomain: "mtg",
          productForm: "single-card",
          ingestionPurpose: "reference-data",
          displayName: "Scryfall MTG single-card reference data",
          profileVersion,
        },
        {
          unitKey: SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
          providerKey: "scryfall",
          productDomain: "mtg",
          productForm: "single-card",
          ingestionPurpose: "image-evidence",
          displayName: "Scryfall MTG image evidence",
          profileVersion,
        },
      ];
    },
    async listOptions(input) {
      return listScryfallOptions(input, options);
    },
    async planImport(scope) {
      assertScryfallUnit(scope.unitKey);
      const setCode = stringValue(scope.values.setCode ?? scope.values.setId ?? scope.values.code);
      const cardId = stringValue(scope.values.cardId ?? scope.values.id);
      const exactName = stringValue(scope.values.exactName ?? scope.values.cardName ?? scope.values.name);

      if (setCode) {
        return {
          unitKey: scope.unitKey,
          planKey: `scryfall:${scope.unitKey === SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY ? "image" : "card"}:set:${setCode.toLowerCase()}`,
          scope: {
            unitKey: scope.unitKey,
            scopeKey: "set",
            values: { ...scope.values, setCode },
          },
          transportSteps: ["Search Scryfall prints by set", "Attach Scryfall card provenance"],
        };
      }

      if (!cardId && !exactName) {
        throw new Error("Scryfall import planning requires setCode, cardId, or exactName.");
      }

      return {
        unitKey: scope.unitKey,
        planKey: `scryfall:${scope.unitKey === SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY ? "image" : "card"}:${
          cardId ?? exactName
        }`,
        scope: {
          unitKey: scope.unitKey,
          scopeKey: scope.unitKey === SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY ? "image-evidence" : "single-card",
          values: { ...scope.values, ...(cardId ? { cardId } : {}), ...(exactName ? { exactName } : {}) },
        },
        estimatedPayloads: 1,
        transportSteps: ["Query Scryfall card endpoint", "Attach Scryfall card provenance"],
      };
    },
    async *fetchPayloads(plan, fetchOptions) {
      assertScryfallUnit(plan.unitKey);
      const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
      if (plan.scope.scopeKey === "set") {
        const setCode = requireString(plan.scope.values.setCode, "Scryfall set import requires setCode.");
        const cards = await fetchAllScryfallSearch(`set:${setCode}`, options);

        for (let index = 0; index < cards.length; index += 1) {
          const card = cards[index] ?? {};
          const sanitizedCard = sanitizeScryfallCard(card);
          const cardId = requireString(sanitizedCard.id, "Scryfall card payload is missing id.");
          yield scryfallEnvelope({
            unitKey: plan.unitKey,
            externalKey: plan.unitKey === SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY ? `image:${cardId}` : `card:${cardId}`,
            payload:
              plan.unitKey === SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY
                ? { kind: "image-evidence", card: sanitizedCard, imageUris: sanitizedCard.image_uris ?? {} }
                : { kind: "single-card", card: sanitizedCard },
            sourceUrl: sanitizedCard.uri ?? scryfallCardUrl(cardId, options),
            sourceUpdatedAt: sanitizedCard.released_at,
            fetchedAt,
          });
          await fetchOptions?.onProgress?.({
            phase: "fetching",
            completed: index + 1,
            total: cards.length,
            currentLabel: sanitizedCard.name ?? cardId,
          });
        }
        return;
      }

      const card = await fetchScryfallCard(plan.scope.values, options);
      const sanitizedCard = sanitizeScryfallCard(card);
      const cardId = requireString(sanitizedCard.id, "Scryfall card payload is missing id.");

      if (plan.unitKey === SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY) {
        yield scryfallEnvelope({
          unitKey: plan.unitKey,
          externalKey: `image:${cardId}`,
          payload: { kind: "image-evidence", card: sanitizedCard, imageUris: sanitizedCard.image_uris ?? {} },
          sourceUrl: sanitizedCard.uri ?? scryfallCardUrl(cardId, options),
          sourceUpdatedAt: sanitizedCard.released_at,
          fetchedAt,
        });
        await fetchOptions?.onProgress?.({
          phase: "fetching",
          completed: 1,
          total: 1,
          currentLabel: sanitizedCard.name ?? cardId,
        });
        return;
      }

      yield scryfallEnvelope({
        unitKey: plan.unitKey,
        externalKey: `card:${cardId}`,
        payload: { kind: "single-card", card: sanitizedCard },
        sourceUrl: sanitizedCard.uri ?? scryfallCardUrl(cardId, options),
        sourceUpdatedAt: sanitizedCard.released_at,
        fetchedAt,
      });
      await fetchOptions?.onProgress?.({
        phase: "fetching",
        completed: 1,
        total: 1,
        currentLabel: sanitizedCard.name ?? cardId,
      });
    },
    async getCredentialReadiness() {
      return [
        createCatalogProviderCredentialReadiness({
          providerKey: "scryfall",
          unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
          requirement: "not-required",
          sourceKind: "none",
          state: "not-required",
          message: t("catalog.features.sourceObservations.api.providerAdapters.scryfall.credential.not.required"),
          evidence: { credentialRequirement: "not-required", publicApi: true },
        }),
        createCatalogProviderCredentialReadiness({
          providerKey: "scryfall",
          unitKey: SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
          requirement: "not-required",
          sourceKind: "none",
          state: "not-required",
          message: t("catalog.features.sourceObservations.api.providerAdapters.scryfall.credential.not.required"),
          evidence: { credentialRequirement: "not-required", publicApi: true },
        }),
      ];
    },
    async getTransportDiagnostics() {
      return [
        {
          code: "scryfall-public-api-transport-configured",
          severity: "info",
          message: t(
            "catalog.features.sourceObservations.api.providerAdapters.scryfall.public.api.transport.configured",
          ),
          unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
        },
        {
          code: "scryfall-public-api-transport-configured",
          severity: "info",
          message: t(
            "catalog.features.sourceObservations.api.providerAdapters.scryfall.public.api.transport.configured",
          ),
          unitKey: SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
        },
      ];
    },
  };
}

export function createScryfallValidationProviderAdapter(): ProviderAdapter<ScryfallProviderPayload> {
  return createScryfallProviderAdapter({
    fetch: scryfallValidationFetch,
    now: () => new Date("2026-06-08T00:00:00.000Z"),
    profileVersion: SCRYFALL_VALIDATION_PROFILE_VERSION,
  });
}

export async function runScryfallSourceObservationValidationDryRun(
  adapter: ProviderAdapter<ScryfallProviderPayload> = createScryfallValidationProviderAdapter(),
): Promise<CatalogIntegrationDryRunResult> {
  const plan = await adapter.planImport({
    unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    scopeKey: "single-card",
    values: { cardId: "0000579f-7b35-4ed3-b44c-db2a538066fe" },
  });
  const payloads: ProviderPayloadEnvelope<ScryfallProviderPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan)) {
    payloads.push(payload);
  }

  return runCatalogIntegrationDryRun({
    unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    profileVersion: SCRYFALL_VALIDATION_PROFILE_VERSION,
    payloads,
    normalize: (envelope) => {
      if (envelope.payload.kind !== "single-card") {
        throw new Error("Scryfall single-card dry run received a non-card payload.");
      }

      return {
        unitKey: envelope.unitKey,
        providerKey: envelope.providerKey,
        externalKey: envelope.externalKey,
        profileVersion: SCRYFALL_VALIDATION_PROFILE_VERSION,
        normalizedFacts: {
          name: stringValue(envelope.payload.card.name) ?? "",
          cardNumber: stringValue(envelope.payload.card.collector_number) ?? "",
          setCode: stringValue(envelope.payload.card.set) ?? "",
          setName: stringValue(envelope.payload.card.set_name) ?? "",
          rarity: stringValue(envelope.payload.card.rarity) ?? "",
          layout: stringValue(envelope.payload.card.layout) ?? "",
          oracleId: stringValue(envelope.payload.card.oracle_id) ?? "",
          imageStatus: stringValue(envelope.payload.card.image_status) ?? "",
        },
        sourceUrl: envelope.provenance.sourceUrl,
        sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
        sourceHash: envelope.provenance.contentHash,
      };
    },
  });
}

export async function runScryfallImageEvidenceValidationDryRun(
  adapter: ProviderAdapter<ScryfallProviderPayload> = createScryfallValidationProviderAdapter(),
): Promise<CatalogIntegrationDryRunResult> {
  const plan = await adapter.planImport({
    unitKey: SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
    scopeKey: "image-evidence",
    values: { cardId: "0000579f-7b35-4ed3-b44c-db2a538066fe" },
  });
  const payloads: ProviderPayloadEnvelope<ScryfallProviderPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan)) {
    payloads.push(payload);
  }

  return runCatalogIntegrationDryRun({
    unitKey: SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
    profileVersion: SCRYFALL_VALIDATION_PROFILE_VERSION,
    payloads,
    normalize: (envelope) => {
      if (envelope.payload.kind !== "image-evidence") {
        throw new Error("Scryfall image-evidence dry run received a non-image payload.");
      }

      return {
        unitKey: envelope.unitKey,
        providerKey: envelope.providerKey,
        externalKey: envelope.externalKey,
        profileVersion: SCRYFALL_VALIDATION_PROFILE_VERSION,
        normalizedFacts: {
          name: stringValue(envelope.payload.card.name) ?? "",
          cardNumber: stringValue(envelope.payload.card.collector_number) ?? "",
          setCode: stringValue(envelope.payload.card.set) ?? "",
          imageStatus: stringValue(envelope.payload.card.image_status) ?? "",
          imageCount: String(Object.keys(envelope.payload.imageUris).length),
        },
        sourceUrl: envelope.provenance.sourceUrl,
        sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
        sourceHash: envelope.provenance.contentHash,
      };
    },
  });
}

async function listScryfallOptions(
  input: ProviderOptionQueryInput,
  options: ScryfallProviderAdapterOptions,
): Promise<ProviderOptionQueryResult> {
  assertScryfallUnit(input.unitKey);
  const optionKind = input.optionKind.trim().toLowerCase();

  if (optionKind === "cards" || optionKind === "card") {
    const setCode = stringValue(input.parentValues?.setCode ?? input.parentValues?.parentValue);
    const query =
      stringValue(input.parentValues?.query ?? input.parentValues?.q) ?? (setCode ? `set:${setCode}` : null);
    if (!query) {
      throw new Error("Scryfall card option queries require a query or setCode parent value.");
    }
    const response = await fetchScryfallSearch(query, options);
    return {
      items: (response.data ?? []).map((card) => cardOptionItem(card)),
      nextCursor: response.next_page,
    };
  }

  if (optionKind === "sets" || optionKind === "set") {
    const response = await fetchScryfallSets(options);
    return {
      items: (response.data ?? []).map((set) => ({
        value: requireString(set.code, "Scryfall set option is missing code."),
        label: stringValue(set.name) ?? stringValue(set.code) ?? "",
        metadata: optionalMetadata({
          setId: set.id ?? null,
          setCode: set.code ?? null,
          setType: set.set_type ?? null,
          releasedAt: set.released_at ?? null,
          cardCount: set.card_count === undefined ? null : String(set.card_count),
          digital: set.digital === undefined ? null : String(set.digital),
        }),
      })),
    };
  }

  if (optionKind === "bulk-data" || optionKind === "bulk") {
    const response = await fetchScryfallBulkData(options);
    return {
      items: (response.data ?? []).map((item) => ({
        value: stringValue(item.type) ?? "",
        label: stringValue(item.name) ?? stringValue(item.type) ?? "",
        metadata: optionalMetadata({
          updatedAt: item.updated_at ?? null,
          downloadUri: item.download_uri ?? null,
          contentType: item.content_type ?? null,
          contentEncoding: item.content_encoding ?? null,
        }),
      })),
    };
  }

  return { items: [] };
}

async function fetchScryfallCard(
  values: Readonly<Record<string, string>>,
  options: ScryfallProviderAdapterOptions,
): Promise<ScryfallCard> {
  const cardId = stringValue(values.cardId ?? values.id);
  if (cardId) {
    return fetchJson(scryfallCardUrl(cardId, options), options);
  }

  const exactName = requireString(
    values.exactName ?? values.cardName ?? values.name,
    "Scryfall card fetch requires cardId or exactName.",
  );
  const response = await fetchScryfallSearch(`!"${exactName}"`, options);
  const card = response.data?.[0];
  if (!card) {
    throw new Error(`Scryfall search did not return a card for '${exactName}'.`);
  }
  return card;
}

async function fetchScryfallSearch(
  query: string,
  options: ScryfallProviderAdapterOptions,
): Promise<ScryfallListResponse<ScryfallCard>> {
  return fetchJson(`${scryfallUrl("cards/search", options)}?q=${encodeURIComponent(query)}&unique=prints`, options);
}

async function fetchAllScryfallSearch(
  query: string,
  options: ScryfallProviderAdapterOptions,
): Promise<readonly ScryfallCard[]> {
  const cards: ScryfallCard[] = [];
  let nextUrl: string | null = `${scryfallUrl("cards/search", options)}?q=${encodeURIComponent(query)}&unique=prints`;

  while (nextUrl) {
    const response: ScryfallListResponse<ScryfallCard> = await fetchJson(nextUrl, options);
    cards.push(...(response.data ?? []));
    nextUrl = response.has_more && response.next_page ? response.next_page : null;
  }

  return cards;
}

async function fetchScryfallBulkData(
  options: ScryfallProviderAdapterOptions,
): Promise<ScryfallListResponse<ScryfallBulkData>> {
  return fetchJson(scryfallUrl("bulk-data", options), options);
}

async function fetchScryfallSets(options: ScryfallProviderAdapterOptions): Promise<ScryfallListResponse<ScryfallSet>> {
  return fetchJson(scryfallUrl("sets", options), options);
}

async function fetchJson<T>(url: string, options: ScryfallProviderAdapterOptions): Promise<T> {
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    headers: {
      "User-Agent":
        options.userAgent ??
        "ChaseSetsCatalogValidation/1.0 (engineering-validation; https://github.com/chase-sets/chase-sets)",
      Accept: "application/json;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`Scryfall request failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as T;
}

function scryfallCardUrl(cardId: string, options: ScryfallProviderAdapterOptions): string {
  return scryfallUrl(`cards/${cardId}`, options);
}

function scryfallUrl(path: string, options: ScryfallProviderAdapterOptions): string {
  return `${(options.baseUrl ?? "https://api.scryfall.com").replace(/\/$/, "")}/${path}`;
}

function cardOptionItem(card: ScryfallCard): ProviderOptionItem {
  return {
    value: requireString(card.id, "Scryfall card option is missing id."),
    label: [card.name, card.set?.toUpperCase(), card.collector_number]
      .filter((value) => stringValue(value))
      .join(" - "),
    metadata: optionalMetadata({
      oracleId: card.oracle_id ?? null,
      setCode: card.set ?? null,
      setName: card.set_name ?? null,
      collectorNumber: card.collector_number ?? null,
      rarity: card.rarity ?? null,
      imageStatus: card.image_status ?? null,
    }),
  };
}

function scryfallEnvelope(input: {
  unitKey: string;
  externalKey: string;
  payload: ScryfallProviderPayload;
  sourceUrl: string;
  sourceUpdatedAt?: string;
  fetchedAt: string;
}): ProviderPayloadEnvelope<ScryfallProviderPayload> {
  return {
    unitKey: input.unitKey,
    providerKey: "scryfall",
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

function sanitizeScryfallCard(card: ScryfallCard): ScryfallCard {
  const { prices: _prices, ...catalogSafeCard } = card;
  return catalogSafeCard;
}

function assertScryfallUnit(unitKey: string): void {
  if (
    unitKey !== SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY &&
    unitKey !== SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY
  ) {
    throw new Error(`Scryfall adapter does not support Catalog integration unit '${unitKey}'.`);
  }
}

function optionalMetadata(values: Readonly<Record<string, string | null>>): ProviderOptionItem["metadata"] {
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

function scryfallValidationFetch(input: RequestInfo | URL): Promise<Response> {
  const response = scryfallValidationResponses[String(input)];
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

const scryfallValidationCard = {
  object: "card",
  id: "0000579f-7b35-4ed3-b44c-db2a538066fe",
  oracle_id: "44623693-51d6-49ad-8cd7-140505caf02f",
  name: "Fury Sliver",
  lang: "en",
  released_at: "2006-10-06",
  uri: "https://api.scryfall.com/cards/0000579f-7b35-4ed3-b44c-db2a538066fe",
  scryfall_uri: "https://scryfall.com/card/tsp/157/fury-sliver?utm_source=api",
  layout: "normal",
  image_status: "highres_scan",
  image_uris: {
    normal: "https://cards.scryfall.io/normal/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.jpg",
    png: "https://cards.scryfall.io/png/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.png",
  },
  mana_cost: "{5}{R}",
  type_line: "Creature - Sliver",
  oracle_text: "All Sliver creatures have double strike.",
  set: "tsp",
  set_name: "Time Spiral",
  collector_number: "157",
  rarity: "uncommon",
  finishes: ["nonfoil", "foil"],
  artist: "Pete Venters",
  tcgplayer_id: 14240,
  prices: { usd: "0.53", usd_foil: "2.60" },
};

const scryfallValidationResponses: Readonly<Record<string, unknown>> = {
  "https://api.scryfall.com/cards/0000579f-7b35-4ed3-b44c-db2a538066fe": scryfallValidationCard,
  "https://api.scryfall.com/cards/search?q=!%22Fury%20Sliver%22&unique=prints": {
    object: "list",
    has_more: false,
    data: [scryfallValidationCard],
  },
  "https://api.scryfall.com/cards/search?q=set%3ATSP&unique=prints": {
    object: "list",
    has_more: false,
    data: [scryfallValidationCard],
  },
  "https://api.scryfall.com/cards/search?q=set%3Atsp&unique=prints": {
    object: "list",
    has_more: false,
    data: [scryfallValidationCard],
  },
  "https://api.scryfall.com/sets": {
    object: "list",
    has_more: false,
    data: [
      {
        object: "set",
        id: "c1d109bc-ffd8-428f-8d7d-3f8d7e648046",
        code: "tsp",
        name: "Time Spiral",
        set_type: "expansion",
        released_at: "2006-10-06",
        card_count: 301,
        digital: false,
      },
    ],
  },
  "https://api.scryfall.com/bulk-data": {
    object: "list",
    has_more: false,
    data: [
      {
        object: "bulk_data",
        type: "default_cards",
        name: "Default Cards",
        updated_at: "2026-06-08T09:13:03.704+00:00",
        download_uri: "https://data.scryfall.io/default-cards/default-cards-20260608091303.json",
        content_type: "application/json",
        content_encoding: "gzip",
      },
    ],
  },
};
