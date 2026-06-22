import { createHash } from "node:crypto";

import { t } from "@chase-sets/localization";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  CATALOG_PROVIDER_CREDENTIAL_REDACTED_VALUE,
  createCatalogProviderCredentialReadiness,
} from "../catalog-integration-credential-readiness";
import { defineCatalogIntegrationUnitKey } from "../integration-unit";
import type {
  ProviderAdapter,
  ProviderImportPlan,
  ProviderImportScope,
  ProviderOptionItem,
  ProviderOptionQueryInput,
  ProviderOptionQueryResult,
  ProviderPayloadEnvelope,
  ProviderTransportDiagnostic,
} from "./provider-adapter";

export const SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "scrydex",
  productDomain: "one-piece",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export const SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "scrydex",
  productDomain: "one-piece",
  productForm: "set",
  ingestionPurpose: "reference-data",
});

export const SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "scrydex",
  productDomain: "one-piece",
  productForm: "sealed-product",
  ingestionPurpose: "source-observation-import",
});

export const SCRYDEX_ONE_PIECE_PRODUCTION_PROFILE_VERSION = "2026.06.22";

const scrydexOnePieceBaseUrl = "https://api.scrydex.com/onepiece/v1";
const scrydexExpansionPageSize = 100;
const scrydexCardPageSize = 250;
const scrydexSealedPageSize = 100;
const scrydexExpansionSelect = "id,name,code,total,release_date,language,language_code";
const scrydexCardSelect = "id,name,number,printed_number,rarity,rarity_code,type,language,language_code,expansion";
const scrydexSealedSelect = "id,name,type,language,language_code,expansion";

export type ScrydexOnePieceCredentials = Readonly<{
  apiKey?: string | null;
  teamId?: string | null;
}>;

export type ScrydexOnePieceProviderAdapterOptions = Readonly<{
  credentials?: ScrydexOnePieceCredentials;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  now?: () => Date;
  profileVersion?: string;
}>;

export type ScrydexOnePieceExpansion = Readonly<{
  id?: string;
  name?: string;
  code?: string;
  total?: number | string;
  release_date?: string;
  language?: string;
  language_code?: string;
}>;

export type ScrydexOnePieceCard = Readonly<{
  id?: string;
  name?: string;
  number?: string;
  printed_number?: string;
  rarity?: string;
  rarity_code?: string;
  type?: string;
  language?: string;
  language_code?: string;
  expansion?: ScrydexOnePieceExpansion;
}>;

export type ScrydexOnePieceSealedProduct = Readonly<{
  id?: string;
  name?: string;
  type?: string;
  language?: string;
  language_code?: string;
  expansion?: ScrydexOnePieceExpansion;
}>;

export type ScrydexOnePieceProviderPayload =
  | Readonly<{
      kind: "one-piece-set-reference";
      expansion: ScrydexOnePieceExpansion;
      sourceUrl: string;
    }>
  | Readonly<{
      kind: "one-piece-card";
      card: ScrydexOnePieceCard;
      sourceUrl: string;
    }>
  | Readonly<{
      kind: "one-piece-sealed-product";
      sealedProduct: ScrydexOnePieceSealedProduct;
      sourceUrl: string;
    }>;

type ScrydexPagedResponse = Readonly<Record<string, JsonValue>>;

type ScrydexPage<TItem> = Readonly<{
  items: readonly TItem[];
  sourceUrl: string;
}>;

export function createScrydexOnePieceProviderAdapter(
  options: ScrydexOnePieceProviderAdapterOptions = {},
): ProviderAdapter<ScrydexOnePieceProviderPayload> {
  return {
    providerKey: "scrydex",
    capabilities: {
      supportsOptionQueries: true,
      supportsImportPlanning: true,
      supportsPayloadFetch: true,
    },
    async listIntegrationUnits() {
      const profileVersion = options.profileVersion ?? SCRYDEX_ONE_PIECE_PRODUCTION_PROFILE_VERSION;
      return [
        {
          unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
          providerKey: "scrydex",
          productDomain: "one-piece",
          productForm: "single-card",
          ingestionPurpose: "source-observation-import",
          displayName: "Scrydex One Piece single-card Source Observation import",
          profileVersion,
        },
        {
          unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
          providerKey: "scrydex",
          productDomain: "one-piece",
          productForm: "set",
          ingestionPurpose: "reference-data",
          displayName: "Scrydex One Piece set reference data",
          profileVersion,
        },
        {
          unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
          providerKey: "scrydex",
          productDomain: "one-piece",
          productForm: "sealed-product",
          ingestionPurpose: "source-observation-import",
          displayName: "Scrydex One Piece sealed-product Source Observation import",
          profileVersion,
        },
      ];
    },
    async listOptions(input) {
      return listScrydexOnePieceOptions(input, options);
    },
    async planImport(scope) {
      assertScrydexOnePieceUnit(scope.unitKey);

      if (scope.unitKey === SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY) {
        return planScrydexOnePieceSetImport(scope);
      }

      if (scope.unitKey === SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
        return planScrydexOnePieceCardImport(scope);
      }

      return planScrydexOnePieceSealedImport(scope);
    },
    async *fetchPayloads(plan, fetchOptions) {
      assertScrydexOnePieceUnit(plan.unitKey);
      const fetchedAt = (options.now ?? (() => new Date()))().toISOString();

      if (plan.unitKey === SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY) {
        const expansionId = requireString(
          plan.scope.values.expansionId,
          "Scrydex One Piece set reference payload fetch requires expansionId.",
        );
        const sourceUrl = scrydexUrl(`expansions/${encodeURIComponent(expansionId)}`, {}, options);
        const expansion = sanitizeScrydexExpansion(await fetchScrydexJson(sourceUrl, options));
        yield scrydexEnvelope({
          unitKey: plan.unitKey,
          externalKey: `set:${requireString(
            expansion.id ?? expansionId,
            "Scrydex One Piece set reference payload is missing id.",
          )}`,
          payload: { kind: "one-piece-set-reference", expansion, sourceUrl },
          sourceUrl,
          sourceUpdatedAt: expansion.release_date,
          fetchedAt,
        });
        await fetchOptions?.onProgress?.({
          phase: "fetching",
          completed: 1,
          total: 1,
          currentLabel: expansion.name ?? expansionId,
        });
        return;
      }

      if (plan.unitKey === SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
        if (plan.scope.scopeKey === "single-card") {
          const cardId = requireString(
            plan.scope.values.cardId,
            "Scrydex One Piece card payload fetch requires cardId.",
          );
          const sourceUrl = scrydexUrl(`cards/${encodeURIComponent(cardId)}`, {}, options);
          const card = sanitizeScrydexCard(await fetchScrydexJson(sourceUrl, options));
          yield scrydexEnvelope({
            unitKey: plan.unitKey,
            externalKey: `card:${requireString(card.id ?? cardId, "Scrydex One Piece card payload is missing id.")}`,
            payload: { kind: "one-piece-card", card, sourceUrl },
            sourceUrl,
            sourceUpdatedAt: card.expansion?.release_date,
            fetchedAt,
          });
          await fetchOptions?.onProgress?.({
            phase: "fetching",
            completed: 1,
            total: 1,
            currentLabel: card.name ?? cardId,
          });
          return;
        }

        const expansionId = requireString(
          plan.scope.values.expansionId,
          "Scrydex One Piece expansion card payload fetch requires expansionId.",
        );
        const pages = await fetchScrydexPagedJson<ScrydexOnePieceCard>(
          `expansions/${encodeURIComponent(expansionId)}/cards`,
          { page_size: String(scrydexCardPageSize), select: scrydexCardSelect },
          options,
        );
        const cards = pages.flatMap((page) =>
          page.items.map((card) => ({ card: sanitizeScrydexCard(card), sourceUrl: page.sourceUrl })),
        );
        for (let index = 0; index < cards.length; index += 1) {
          const current = cards[index]!;
          yield scrydexEnvelope({
            unitKey: plan.unitKey,
            externalKey: `card:${requireString(current.card.id, "Scrydex One Piece card payload is missing id.")}`,
            payload: { kind: "one-piece-card", card: current.card, sourceUrl: current.sourceUrl },
            sourceUrl: current.sourceUrl,
            sourceUpdatedAt: current.card.expansion?.release_date,
            fetchedAt,
          });
          await fetchOptions?.onProgress?.({
            phase: "fetching",
            completed: index + 1,
            total: cards.length,
            currentLabel: current.card.name ?? current.card.id ?? null,
          });
        }
        return;
      }

      if (plan.scope.scopeKey === "single-sealed-product") {
        const sealedId = requireString(
          plan.scope.values.sealedProductId,
          "Scrydex One Piece sealed-product payload fetch requires sealedProductId.",
        );
        const sourceUrl = scrydexUrl(`sealed/${encodeURIComponent(sealedId)}`, {}, options);
        const sealedProduct = sanitizeScrydexSealedProduct(await fetchScrydexJson(sourceUrl, options));
        yield scrydexEnvelope({
          unitKey: plan.unitKey,
          externalKey: `sealed:${requireString(
            sealedProduct.id ?? sealedId,
            "Scrydex One Piece sealed-product payload is missing id.",
          )}`,
          payload: { kind: "one-piece-sealed-product", sealedProduct, sourceUrl },
          sourceUrl,
          sourceUpdatedAt: sealedProduct.expansion?.release_date,
          fetchedAt,
        });
        await fetchOptions?.onProgress?.({
          phase: "fetching",
          completed: 1,
          total: 1,
          currentLabel: sealedProduct.name ?? sealedId,
        });
        return;
      }

      const expansionId = requireString(
        plan.scope.values.expansionId,
        "Scrydex One Piece expansion sealed-product payload fetch requires expansionId.",
      );
      const pages = await fetchScrydexPagedJson<ScrydexOnePieceSealedProduct>(
        `expansions/${encodeURIComponent(expansionId)}/sealed`,
        { page_size: String(scrydexSealedPageSize), select: scrydexSealedSelect },
        options,
      );
      const sealedProducts = pages.flatMap((page) =>
        page.items.map((sealedProduct) => ({
          sealedProduct: sanitizeScrydexSealedProduct(sealedProduct),
          sourceUrl: page.sourceUrl,
        })),
      );
      for (let index = 0; index < sealedProducts.length; index += 1) {
        const current = sealedProducts[index]!;
        yield scrydexEnvelope({
          unitKey: plan.unitKey,
          externalKey: `sealed:${requireString(
            current.sealedProduct.id,
            "Scrydex One Piece sealed-product payload is missing id.",
          )}`,
          payload: {
            kind: "one-piece-sealed-product",
            sealedProduct: current.sealedProduct,
            sourceUrl: current.sourceUrl,
          },
          sourceUrl: current.sourceUrl,
          sourceUpdatedAt: current.sealedProduct.expansion?.release_date,
          fetchedAt,
        });
        await fetchOptions?.onProgress?.({
          phase: "fetching",
          completed: index + 1,
          total: sealedProducts.length,
          currentLabel: current.sealedProduct.name ?? current.sealedProduct.id ?? null,
        });
      }
    },
    async getCredentialReadiness() {
      const readiness = scrydexCredentialState(options);
      const checkedAt = (options.now ?? (() => new Date()))().toISOString();
      return scrydexOnePieceUnitKeys().map((unitKey) =>
        createCatalogProviderCredentialReadiness({
          providerKey: "scrydex",
          unitKey,
          requirement: "required",
          sourceKind: "environment-secret",
          state: readiness.configured ? "configured" : "missing",
          message: readiness.configured
            ? "Scrydex One Piece credentials are configured."
            : "Scrydex One Piece credentials require X-Api-Key and X-Team-ID before option queries or imports.",
          checkedAt,
          scope: {
            environmentKey: "runtime",
            secretReference: "scrydex-one-piece-api-key-and-team-id",
          },
          evidence: {
            credentialRequirement: "required",
            credentialState: readiness.configured ? "configured" : "missing",
            apiKeyConfigured: readiness.apiKeyConfigured,
            teamIdConfigured: readiness.teamIdConfigured,
            requiredHeaders: {
              "X-Api-Key": CATALOG_PROVIDER_CREDENTIAL_REDACTED_VALUE,
              "X-Team-ID": CATALOG_PROVIDER_CREDENTIAL_REDACTED_VALUE,
            },
          },
        }),
      );
    },
    async getTransportDiagnostics() {
      const readiness = scrydexCredentialState(options);
      const credentialDiagnostics: ProviderTransportDiagnostic[] = readiness.configured
        ? [
            {
              code: "scrydex-one-piece-credentials-configured",
              severity: "info",
              message: t(
                "catalog.features.sourceObservations.api.providerAdapters.scrydex.onePiece.credential.configured",
              ),
            },
          ]
        : [
            {
              code: "credential-missing",
              severity: "error",
              message: t(
                "catalog.features.sourceObservations.api.providerAdapters.scrydex.onePiece.credential.missing",
              ),
            },
          ];

      return [
        ...credentialDiagnostics,
        ...scrydexOnePieceUnitKeys().map((unitKey) => ({
          code: "scrydex-one-piece-bulk-first-transport-configured",
          severity: "info" as const,
          message: t(
            "catalog.features.sourceObservations.api.providerAdapters.scrydex.onePiece.bulk.first.transport.configured",
          ),
          unitKey,
        })),
      ];
    },
  };
}

async function listScrydexOnePieceOptions(
  input: ProviderOptionQueryInput,
  options: ScrydexOnePieceProviderAdapterOptions,
): Promise<ProviderOptionQueryResult> {
  assertScrydexOnePieceUnit(input.unitKey);
  requireScrydexCredentials(options);
  const optionKind = input.optionKind.trim().toLowerCase();

  if (optionKind === "expansions" || optionKind === "expansion" || optionKind === "sets" || optionKind === "set") {
    const expansions = await fetchScrydexExpansions(options);
    return { items: expansions.map(expansionOptionItem) };
  }

  if (optionKind === "cards" || optionKind === "card") {
    const expansionId = requireString(
      input.parentValues?.expansionId ?? input.parentValues?.setId ?? input.parentValues?.parentValue,
      "Scrydex One Piece card option queries require an expansionId parent value.",
    );
    const pages = await fetchScrydexPagedJson<ScrydexOnePieceCard>(
      `expansions/${encodeURIComponent(expansionId)}/cards`,
      { page_size: String(scrydexCardPageSize), select: scrydexCardSelect },
      options,
    );
    return {
      items: pages.flatMap((page) => page.items.map((card) => cardOptionItem(sanitizeScrydexCard(card), expansionId))),
    };
  }

  if (optionKind === "sealed" || optionKind === "sealed-products" || optionKind === "sealed-product") {
    const expansionId = requireString(
      input.parentValues?.expansionId ?? input.parentValues?.setId ?? input.parentValues?.parentValue,
      "Scrydex One Piece sealed-product option queries require an expansionId parent value.",
    );
    const pages = await fetchScrydexPagedJson<ScrydexOnePieceSealedProduct>(
      `expansions/${encodeURIComponent(expansionId)}/sealed`,
      { page_size: String(scrydexSealedPageSize), select: scrydexSealedSelect },
      options,
    );
    return {
      items: pages.flatMap((page) =>
        page.items.map((sealedProduct) =>
          sealedProductOptionItem(sanitizeScrydexSealedProduct(sealedProduct), expansionId),
        ),
      ),
    };
  }

  return { items: [] };
}

function planScrydexOnePieceSetImport(scope: ProviderImportScope): ProviderImportPlan {
  const expansionId = requireString(
    scope.values.expansionId ?? scope.values.setId ?? scope.values.id ?? scope.values.parentValue,
    "Scrydex One Piece set reference import planning requires expansionId.",
  );
  return {
    unitKey: scope.unitKey,
    planKey: `scrydex:one-piece:set:${normalizePlanSegment(expansionId)}`,
    scope: { unitKey: scope.unitKey, scopeKey: "set-reference", values: { ...scope.values, expansionId } },
    estimatedPayloads: 1,
    transportSteps: [
      "Fetch Scrydex One Piece expansion by id",
      "Sanitize set reference payload",
      "Attach payload provenance",
    ],
  };
}

function planScrydexOnePieceCardImport(scope: ProviderImportScope): ProviderImportPlan {
  const cardId = stringValue(scope.values.cardId ?? scope.values.id);
  if (cardId) {
    return {
      unitKey: scope.unitKey,
      planKey: `scrydex:one-piece:card:${normalizePlanSegment(cardId)}`,
      scope: { unitKey: scope.unitKey, scopeKey: "single-card", values: { ...scope.values, cardId } },
      estimatedPayloads: 1,
      transportSteps: ["Fetch Scrydex One Piece card by id", "Sanitize card payload", "Attach payload provenance"],
    };
  }

  const expansionId = requireString(
    scope.values.expansionId ?? scope.values.setId ?? scope.values.parentValue,
    "Scrydex One Piece card import planning requires expansionId or cardId.",
  );
  return {
    unitKey: scope.unitKey,
    planKey: `scrydex:one-piece:expansion:${normalizePlanSegment(expansionId)}:cards`,
    scope: { unitKey: scope.unitKey, scopeKey: "expansion-cards", values: { ...scope.values, expansionId } },
    transportSteps: [
      "Fetch Scrydex One Piece expansion cards with max page size",
      "Sanitize card payloads",
      "Attach payload provenance",
    ],
  };
}

function planScrydexOnePieceSealedImport(scope: ProviderImportScope): ProviderImportPlan {
  const sealedProductId = stringValue(scope.values.sealedProductId ?? scope.values.sealedId ?? scope.values.id);
  if (sealedProductId) {
    return {
      unitKey: scope.unitKey,
      planKey: `scrydex:one-piece:sealed:${normalizePlanSegment(sealedProductId)}`,
      scope: {
        unitKey: scope.unitKey,
        scopeKey: "single-sealed-product",
        values: { ...scope.values, sealedProductId },
      },
      estimatedPayloads: 1,
      transportSteps: [
        "Fetch Scrydex One Piece sealed product by id",
        "Sanitize sealed-product payload",
        "Attach payload provenance",
      ],
    };
  }

  const expansionId = requireString(
    scope.values.expansionId ?? scope.values.setId ?? scope.values.parentValue,
    "Scrydex One Piece sealed-product import planning requires expansionId or sealedProductId.",
  );
  return {
    unitKey: scope.unitKey,
    planKey: `scrydex:one-piece:expansion:${normalizePlanSegment(expansionId)}:sealed`,
    scope: { unitKey: scope.unitKey, scopeKey: "expansion-sealed-products", values: { ...scope.values, expansionId } },
    transportSteps: [
      "Fetch Scrydex One Piece expansion sealed products with max page size",
      "Sanitize sealed-product payloads",
      "Attach payload provenance",
    ],
  };
}

async function fetchScrydexExpansions(
  options: ScrydexOnePieceProviderAdapterOptions,
): Promise<readonly ScrydexOnePieceExpansion[]> {
  const pages = await fetchScrydexPagedJson<ScrydexOnePieceExpansion>(
    "expansions",
    { page_size: String(scrydexExpansionPageSize), select: scrydexExpansionSelect },
    options,
  );
  return pages.flatMap((page) => page.items.map(sanitizeScrydexExpansion));
}

async function fetchScrydexPagedJson<TItem>(
  path: string,
  query: Readonly<Record<string, string>>,
  options: ScrydexOnePieceProviderAdapterOptions,
): Promise<readonly ScrydexPage<TItem>[]> {
  const pages: ScrydexPage<TItem>[] = [];
  const pageSize = Number(query.page_size);
  let page = 1;
  let nextUrl: string | null = scrydexUrl(path, { page: String(page), ...query }, options);

  while (nextUrl) {
    const sourceUrl = nextUrl;
    const body = await fetchScrydexJson(sourceUrl, options);
    const items = extractScrydexItems<TItem>(body);
    pages.push({ items, sourceUrl });
    const explicitNextUrl = stringValue(recordValue(body, "next_page") ?? recordValue(body, "nextPage"));
    if (explicitNextUrl) {
      nextUrl = absoluteScrydexUrl(explicitNextUrl, options);
      page += 1;
      continue;
    }

    const totalPages =
      positiveInteger(recordValue(body, "total_pages")) ??
      positiveInteger(recordValue(body, "totalPages")) ??
      positiveInteger(recordValue(body, "pages")) ??
      positiveInteger(recordValue(recordValue(body, "meta"), "total_pages")) ??
      positiveInteger(recordValue(recordValue(body, "pagination"), "total_pages"));
    if (totalPages !== null && page < totalPages) {
      page += 1;
      nextUrl = scrydexUrl(path, { page: String(page), ...query }, options);
      continue;
    }

    const hasMore =
      booleanValue(recordValue(body, "has_more") ?? recordValue(body, "hasMore")) ??
      booleanValue(recordValue(recordValue(body, "meta"), "has_more")) ??
      booleanValue(recordValue(recordValue(body, "pagination"), "has_more"));
    if (hasMore && items.length >= pageSize) {
      page += 1;
      nextUrl = scrydexUrl(path, { page: String(page), ...query }, options);
      continue;
    }

    nextUrl = null;
  }

  return pages;
}

async function fetchScrydexJson(url: string, options: ScrydexOnePieceProviderAdapterOptions): Promise<JsonValue> {
  const credentials = requireScrydexCredentials(options);
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    headers: {
      Accept: "application/json",
      "X-Api-Key": credentials.apiKey,
      "X-Team-ID": credentials.teamId,
    },
  });
  if (!response.ok) {
    throw new Error(`Scrydex One Piece request failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as JsonValue;
}

function extractScrydexItems<TItem>(body: JsonValue): readonly TItem[] {
  if (Array.isArray(body)) {
    return body as TItem[];
  }
  const data = recordValue(body, "data");
  if (Array.isArray(data)) {
    return data as TItem[];
  }
  const items = recordValue(body, "items");
  if (Array.isArray(items)) {
    return items as TItem[];
  }
  const results = recordValue(body, "results");
  if (Array.isArray(results)) {
    return results as TItem[];
  }
  return [];
}

function expansionOptionItem(expansion: ScrydexOnePieceExpansion): ProviderOptionItem {
  const expansionId = requireString(expansion.id, "Scrydex One Piece expansion option is missing id.");
  return {
    value: expansionId,
    label: stringValue(expansion.name) ?? expansionId,
    metadata: optionalMetadata({
      expansionId,
      code: expansion.code,
      total: stringValue(expansion.total),
      releaseDate: expansion.release_date,
      language: expansion.language,
      languageCode: expansion.language_code,
    }),
  };
}

function cardOptionItem(card: ScrydexOnePieceCard, expansionId: string): ProviderOptionItem {
  const cardId = requireString(card.id, "Scrydex One Piece card option is missing id.");
  const number = stringValue(card.printed_number ?? card.number);
  return {
    value: cardId,
    label: [card.name, number].filter((value) => stringValue(value)).join(" #"),
    parentValue: expansionId,
    metadata: optionalMetadata({
      cardId,
      expansionId: card.expansion?.id ?? expansionId,
      number: card.number,
      printedNumber: card.printed_number,
      rarity: card.rarity,
      rarityCode: card.rarity_code,
      type: card.type,
      language: card.language,
      languageCode: card.language_code,
    }),
  };
}

function sealedProductOptionItem(sealedProduct: ScrydexOnePieceSealedProduct, expansionId: string): ProviderOptionItem {
  const sealedProductId = requireString(sealedProduct.id, "Scrydex One Piece sealed-product option is missing id.");
  return {
    value: sealedProductId,
    label: stringValue(sealedProduct.name) ?? sealedProductId,
    parentValue: expansionId,
    metadata: optionalMetadata({
      sealedProductId,
      expansionId: sealedProduct.expansion?.id ?? expansionId,
      type: sealedProduct.type,
      language: sealedProduct.language,
      languageCode: sealedProduct.language_code,
    }),
  };
}

function sanitizeScrydexCard(value: JsonValue): ScrydexOnePieceCard {
  const record = jsonRecord(value);
  return compactRecord({
    id: stringValue(record.id),
    name: stringValue(record.name),
    number: stringValue(record.number),
    printed_number: stringValue(record.printed_number),
    rarity: stringValue(record.rarity),
    rarity_code: stringValue(record.rarity_code),
    type: stringValue(record.type),
    language: stringValue(record.language),
    language_code: stringValue(record.language_code),
    expansion: sanitizeScrydexExpansion(record.expansion),
  });
}

function sanitizeScrydexSealedProduct(value: JsonValue): ScrydexOnePieceSealedProduct {
  const record = jsonRecord(value);
  return compactRecord({
    id: stringValue(record.id),
    name: stringValue(record.name),
    type: stringValue(record.type),
    language: stringValue(record.language),
    language_code: stringValue(record.language_code),
    expansion: sanitizeScrydexExpansion(record.expansion),
  });
}

function sanitizeScrydexExpansion(value: JsonValue): ScrydexOnePieceExpansion {
  const record = jsonRecord(value);
  return compactRecord({
    id: stringValue(record.id),
    name: stringValue(record.name),
    code: stringValue(record.code),
    total: stringOrNumberValue(record.total),
    release_date: stringValue(record.release_date),
    language: stringValue(record.language),
    language_code: stringValue(record.language_code),
  });
}

function scrydexEnvelope(input: {
  unitKey: string;
  externalKey: string;
  payload: ScrydexOnePieceProviderPayload;
  sourceUrl: string;
  sourceUpdatedAt?: string;
  fetchedAt: string;
}): ProviderPayloadEnvelope<ScrydexOnePieceProviderPayload> {
  return {
    unitKey: input.unitKey,
    providerKey: "scrydex",
    externalKey: input.externalKey,
    payload: input.payload,
    provenance: {
      sourceUrl: input.sourceUrl,
      sourceUpdatedAt: input.sourceUpdatedAt,
      fetchedAt: input.fetchedAt,
      contentHash: `sha256:${createHash("sha256").update(stableStringify(input.payload)).digest("hex")}`,
    },
  };
}

function scrydexUrl(
  path: string,
  query: Readonly<Record<string, string>>,
  options: ScrydexOnePieceProviderAdapterOptions,
): string {
  const base = (options.baseUrl ?? scrydexOnePieceBaseUrl).replace(/\/$/, "");
  const url = new URL(`${base}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function absoluteScrydexUrl(value: string, options: ScrydexOnePieceProviderAdapterOptions): string {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  const base = (options.baseUrl ?? scrydexOnePieceBaseUrl).replace(/\/$/, "");
  return new URL(value, `${base}/`).toString();
}

function requireScrydexCredentials(
  options: ScrydexOnePieceProviderAdapterOptions,
): Readonly<{ apiKey: string; teamId: string }> {
  const apiKey = stringValue(options.credentials?.apiKey);
  const teamId = stringValue(options.credentials?.teamId);
  if (!apiKey || !teamId) {
    throw new Error("Scrydex One Piece credentials are required for provider transport.");
  }
  return { apiKey, teamId };
}

function scrydexCredentialState(options: ScrydexOnePieceProviderAdapterOptions): Readonly<{
  configured: boolean;
  apiKeyConfigured: boolean;
  teamIdConfigured: boolean;
}> {
  const apiKeyConfigured = Boolean(stringValue(options.credentials?.apiKey));
  const teamIdConfigured = Boolean(stringValue(options.credentials?.teamId));
  return { configured: apiKeyConfigured && teamIdConfigured, apiKeyConfigured, teamIdConfigured };
}

function assertScrydexOnePieceUnit(unitKey: string): void {
  if (
    unitKey !== SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY &&
    unitKey !== SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY &&
    unitKey !== SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY
  ) {
    throw new Error(`Scrydex One Piece adapter does not support Catalog integration unit '${unitKey}'.`);
  }
}

function scrydexOnePieceUnitKeys(): readonly [
  typeof SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  typeof SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
  typeof SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
] {
  return [
    SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
    SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  ];
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

function stringOrNumberValue(value: unknown): string | number | null {
  return typeof value === "number" ? value : stringValue(value);
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const normalized = stringValue(value);
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function recordValue(value: unknown, key: string): JsonValue | undefined {
  return isJsonRecord(value) ? value[key] : undefined;
}

function jsonRecord(value: JsonValue): Readonly<Record<string, JsonValue>> {
  return isJsonRecord(value) ? value : {};
}

function isJsonRecord(value: unknown): value is ScrydexPagedResponse {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactRecord<TRecord extends Readonly<Record<string, unknown>>>(
  record: TRecord,
): Partial<{ [K in keyof TRecord]: Exclude<TRecord[K], null | undefined> }> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null),
  ) as Partial<{ [K in keyof TRecord]: Exclude<TRecord[K], null | undefined> }>;
}

function normalizePlanSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJsonValue(entryValue)]),
    );
  }
  return value;
}
