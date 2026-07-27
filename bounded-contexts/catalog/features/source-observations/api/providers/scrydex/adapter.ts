import { createHash } from "node:crypto";

import { t } from "@chase-sets/localization";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  runCatalogIntegrationDryRun,
  type CatalogIntegrationDryRunResult,
  type CatalogIntegrationObservationFact,
} from "../../catalog-integration-engine";
import {
  CATALOG_PROVIDER_CREDENTIAL_REDACTED_VALUE,
  createCatalogProviderCredentialReadiness,
} from "../../catalog-integration-credential-readiness";
import { defineCatalogIntegrationUnitKey } from "../../integration-unit";
import type {
  ProviderAdapter,
  ProviderImportPlan,
  ProviderImportScope,
  ProviderOptionItem,
  ProviderOptionQueryInput,
  ProviderOptionQueryResult,
  ProviderPayloadEnvelope,
  ProviderTransportDiagnostic,
  ProviderUsageEstimate,
} from "../../provider-adapters/provider-adapter";

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

export const SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "scrydex",
  productDomain: "lorcana",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export const SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "scrydex",
  productDomain: "lorcana",
  productForm: "set",
  ingestionPurpose: "reference-data",
});

export const SCRYDEX_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "scrydex",
  productDomain: "lorcana",
  productForm: "sealed-product",
  ingestionPurpose: "source-observation-import",
});

export const SCRYDEX_ONE_PIECE_PRODUCTION_PROFILE_VERSION = "2026.06.22";
export const SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION = "2026.06.23";

const scrydexOnePieceBaseUrl = "https://api.scrydex.com/onepiece/v1";
const scrydexLorcanaBaseUrl = "https://api.scrydex.com/lorcana/v1";
const scrydexAccountBaseUrl = "https://api.scrydex.com/account/v1";
const scrydexExpansionPageSize = 100;
const scrydexCardPageSize = 250;
const scrydexSealedPageSize = 100;
const scrydexExpansionSelect = "id,name,code,total,release_date,language,language_code";
const scrydexCardSelect =
  "id,name,number,printed_number,rarity,rarity_code,type,images,language,language_code,expansion,printings,variants";
const scrydexLorcanaCardSelect =
  "id,name,number,printed_number,rarity,rarity_code,type,ink,ink_color,images,language,language_code,expansion,printings,variants,tcgplayer_id";
const scrydexSealedSelect = "id,name,type,images,language,language_code,expansion";
const scrydexUsageLagDiagnostic =
  "Scrydex usage is account-level and may lag live imports by 20-30 minutes per provider policy.";
const scrydexUsageCheckedDiagnostic = "Scrydex account usage check completed with redacted credit evidence.";
const scrydexPriceHistoryPerCardDiagnostic =
  "Scrydex One Piece price history is exposed as a per-card endpoint; production price-history sync remains source-authority-gated and disabled.";

export type ScrydexOnePieceCredentials = Readonly<{
  apiKey?: string | null;
  teamId?: string | null;
}>;

export type ScrydexOnePieceProviderAdapterOptions = Readonly<{
  credentials?: ScrydexOnePieceCredentials;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  lorcanaBaseUrl?: string;
  now?: () => Date;
  profileVersion?: string;
  lorcanaProfileVersion?: string;
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
  ink?: string;
  ink_color?: string;
  tcgplayer_id?: string | number;
  imageUrls?: readonly string[];
  language?: string;
  language_code?: string;
  expansion?: ScrydexOnePieceExpansion;
  printings?: readonly string[];
  variants?: readonly ScrydexOnePieceCardVariant[];
}>;

export type ScrydexOnePieceCardVariant = Readonly<{
  name?: string;
  printings?: readonly string[];
}>;

export type ScrydexOnePieceSealedProduct = Readonly<{
  id?: string;
  name?: string;
  type?: string;
  imageUrls?: readonly string[];
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
    }>
  | Readonly<{
      kind: "lorcana-set-reference";
      expansion: ScrydexOnePieceExpansion;
      sourceUrl: string;
    }>
  | Readonly<{
      kind: "lorcana-card";
      card: ScrydexOnePieceCard;
      sourceUrl: string;
    }>
  | Readonly<{
      kind: "lorcana-sealed-product";
      sealedProduct: ScrydexOnePieceSealedProduct;
      sourceUrl: string;
    }>;

type ScrydexPagedResponse = Readonly<Record<string, JsonValue>>;

type ScrydexPage<TItem> = Readonly<{
  items: readonly TItem[];
  sourceUrl: string;
}>;

type ScrydexOnePieceUnitKey =
  | typeof SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY
  | typeof SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY
  | typeof SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY
  | typeof SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY
  | typeof SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY
  | typeof SCRYDEX_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY;

type ScrydexProductDomain = "one-piece" | "lorcana";

type ScrydexUsageReadiness = Readonly<{
  usageCheckState: ProviderUsageEstimate["usageCheckState"];
  creditDiagnostic: string | null;
  degradedDiagnostic: string | null;
  creditState: "available" | "low" | "exhausted" | "unknown";
  totalCredits: number | null;
  remainingCredits: number | null;
  usedCredits: number | null;
  overageCreditRate: string | null;
  usageUpdatedAt: string | null;
  retryAfterSeconds?: number;
  diagnosticCode?: string;
  credentialState?: "configured" | "invalid" | "unknown";
}>;

const scrydexOnePieceProofFetchedAt = "2026-06-22T00:00:00.000Z";
const scrydexOnePieceProofExpansion: ScrydexOnePieceExpansion = {
  id: "op-01",
  name: "Romance Dawn",
  code: "OP-01",
  total: 121,
  release_date: "2022-12-02",
  language_code: "en",
};
const scrydexOnePieceProofCard: ScrydexOnePieceCard = {
  id: "op01-001",
  name: "Monkey.D.Luffy",
  number: "001",
  printed_number: "OP01-001",
  rarity: "Leader",
  rarity_code: "L",
  type: "Leader",
  language_code: "en",
  expansion: scrydexOnePieceProofExpansion,
  printings: ["OP-01"],
  variants: [{ name: "normal", printings: ["OP-01"] }],
};
const scrydexOnePieceProofSealedProduct: ScrydexOnePieceSealedProduct = {
  id: "op01-booster-box",
  name: "Romance Dawn Booster Box",
  type: "Booster Box",
  language_code: "en",
  expansion: scrydexOnePieceProofExpansion,
};
const scrydexLorcanaProofFetchedAt = "2026-06-23T00:00:00.000Z";
const scrydexLorcanaProofExpansion: ScrydexOnePieceExpansion = {
  id: "1",
  name: "The First Chapter",
  code: "TFC",
  total: 204,
  release_date: "2023-08-18",
  language_code: "en",
};
const scrydexLorcanaProofCard: ScrydexOnePieceCard = {
  id: "tfc-041",
  name: "Elsa - Snow Queen",
  number: "41",
  printed_number: "41/204",
  rarity: "Super Rare",
  rarity_code: "SR",
  type: "Character",
  ink: "Amethyst",
  language_code: "en",
  expansion: scrydexLorcanaProofExpansion,
  printings: ["TFC"],
  variants: [{ name: "standard", printings: ["TFC"] }],
  tcgplayer_id: "1005010",
};
const scrydexLorcanaProofSealedProduct: ScrydexOnePieceSealedProduct = {
  id: "tfc-booster-box",
  name: "The First Chapter Booster Box",
  type: "Booster Box",
  language_code: "en",
  expansion: scrydexLorcanaProofExpansion,
};

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
      const lorcanaProfileVersion = options.lorcanaProfileVersion ?? SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION;
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
        {
          unitKey: SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
          providerKey: "scrydex",
          productDomain: "lorcana",
          productForm: "single-card",
          ingestionPurpose: "source-observation-import",
          displayName: "Scrydex Lorcana single-card Source Observation import",
          profileVersion: lorcanaProfileVersion,
        },
        {
          unitKey: SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
          providerKey: "scrydex",
          productDomain: "lorcana",
          productForm: "set",
          ingestionPurpose: "reference-data",
          displayName: "Scrydex Lorcana set reference data",
          profileVersion: lorcanaProfileVersion,
        },
      ];
    },
    async listOptions(input) {
      return listScrydexOnePieceOptions(input, options);
    },
    async planImport(scope) {
      assertScrydexOnePieceUnit(scope.unitKey);
      const usageReadiness = await getScrydexUsageReadiness(options);
      const productDomain = scrydexProductDomainForUnit(scope.unitKey);

      if (
        scope.unitKey === SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY ||
        scope.unitKey === SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY
      ) {
        return planScrydexSetImport(scope, usageReadiness, productDomain);
      }

      if (
        scope.unitKey === SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY ||
        scope.unitKey === SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY
      ) {
        return planScrydexCardImport(scope, usageReadiness, productDomain);
      }

      return planScrydexSealedImport(scope, usageReadiness, productDomain);
    },
    async *fetchPayloads(plan, fetchOptions) {
      assertScrydexOnePieceUnit(plan.unitKey);
      const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
      const productDomain = scrydexProductDomainForUnit(plan.unitKey);
      const productLabel = scrydexProductLabel(productDomain);

      if (
        plan.unitKey === SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY ||
        plan.unitKey === SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY
      ) {
        const expansionId = requireString(
          plan.scope.values.expansionId,
          `Scrydex ${productLabel} set reference payload fetch requires expansionId.`,
        );
        const { expansion, sourceUrl } = await fetchScrydexExpansionForSetReference({
          expansionId,
          options,
          productDomain,
          productLabel,
        });
        yield scrydexEnvelope({
          unitKey: plan.unitKey,
          externalKey: `set:${requireString(
            expansion.id ?? expansionId,
            `Scrydex ${productLabel} set reference payload is missing id.`,
          )}`,
          payload: {
            kind: productDomain === "lorcana" ? "lorcana-set-reference" : "one-piece-set-reference",
            expansion,
            sourceUrl,
          },
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

      if (
        plan.unitKey === SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY ||
        plan.unitKey === SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY
      ) {
        if (plan.scope.scopeKey === "single-card") {
          const cardId = requireString(
            plan.scope.values.cardId,
            `Scrydex ${productLabel} card payload fetch requires cardId.`,
          );
          const sourceUrl = scrydexUrl(`cards/${encodeURIComponent(cardId)}`, {}, options, productDomain);
          const card = sanitizeScrydexCard(await fetchScrydexJson(sourceUrl, options));
          yield scrydexEnvelope({
            unitKey: plan.unitKey,
            externalKey: `card:${requireString(card.id ?? cardId, `Scrydex ${productLabel} card payload is missing id.`)}`,
            payload: { kind: productDomain === "lorcana" ? "lorcana-card" : "one-piece-card", card, sourceUrl },
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
          `Scrydex ${productLabel} expansion card payload fetch requires expansionId.`,
        );
        const pages = await fetchScrydexPagedJson<ScrydexOnePieceCard>(
          "cards",
          {
            page_size: String(scrydexCardPageSize),
            q: scrydexPrintingsSearchQuery(expansionId),
            select: productDomain === "lorcana" ? scrydexLorcanaCardSelect : scrydexCardSelect,
          },
          options,
          productDomain,
        );
        const cards = pages.flatMap((page) =>
          page.items.map((card) => ({ card: sanitizeScrydexCard(card), sourceUrl: page.sourceUrl })),
        );
        for (let index = 0; index < cards.length; index += 1) {
          const current = cards[index]!;
          yield scrydexEnvelope({
            unitKey: plan.unitKey,
            externalKey: `card:${requireString(current.card.id, `Scrydex ${productLabel} card payload is missing id.`)}`,
            payload: {
              kind: productDomain === "lorcana" ? "lorcana-card" : "one-piece-card",
              card: current.card,
              sourceUrl: current.sourceUrl,
            },
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
          `Scrydex ${productLabel} sealed-product payload fetch requires sealedProductId.`,
        );
        const sourceUrl = scrydexUrl(`sealed/${encodeURIComponent(sealedId)}`, {}, options, productDomain);
        const sealedProduct = sanitizeScrydexSealedProduct(await fetchScrydexJson(sourceUrl, options));
        yield scrydexEnvelope({
          unitKey: plan.unitKey,
          externalKey: `sealed:${requireString(
            sealedProduct.id ?? sealedId,
            `Scrydex ${productLabel} sealed-product payload is missing id.`,
          )}`,
          payload: {
            kind: productDomain === "lorcana" ? "lorcana-sealed-product" : "one-piece-sealed-product",
            sealedProduct,
            sourceUrl,
          },
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
        `Scrydex ${productLabel} expansion sealed-product payload fetch requires expansionId.`,
      );
      const pages = await fetchScrydexExpansionChildPagedJson<ScrydexOnePieceSealedProduct>({
        expansionId,
        childPath: "sealed",
        query: { page_size: String(scrydexSealedPageSize), select: scrydexSealedSelect },
        options,
        productDomain,
      });
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
            `Scrydex ${productLabel} sealed-product payload is missing id.`,
          )}`,
          payload: {
            kind: productDomain === "lorcana" ? "lorcana-sealed-product" : "one-piece-sealed-product",
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
      const usageReadiness = readiness.configured ? await getScrydexUsageReadiness(options) : null;
      const state = usageReadiness?.credentialState ?? (readiness.configured ? "configured" : "missing");
      return scrydexOnePieceUnitKeys().map((unitKey) =>
        createCatalogProviderCredentialReadiness({
          providerKey: "scrydex",
          unitKey,
          requirement: "required",
          sourceKind: "environment-secret",
          state,
          message:
            state === "configured"
              ? "Shared Scrydex credentials are configured for Scrydex transport with redacted usage readiness."
              : state === "missing"
                ? "Shared Scrydex credentials require X-Api-Key and X-Team-ID before option queries or imports."
                : "Scrydex credential readiness could not be validated; provider values remain redacted.",
          checkedAt,
          scope: {
            environmentKey: "runtime",
            secretReference: "scrydex-api-key-and-team-id",
          },
          evidence: {
            credentialRequirement: "required",
            credentialState: state,
            apiKeyConfigured: readiness.apiKeyConfigured,
            teamIdConfigured: readiness.teamIdConfigured,
            requiredHeaders: {
              "X-Api-Key": CATALOG_PROVIDER_CREDENTIAL_REDACTED_VALUE,
              "X-Team-ID": CATALOG_PROVIDER_CREDENTIAL_REDACTED_VALUE,
            },
            usageCheckState: usageReadiness?.usageCheckState ?? "unavailable",
            creditState: usageReadiness?.creditState ?? "unknown",
            totalCredits: usageReadiness?.totalCredits ?? null,
            remainingCredits: usageReadiness?.remainingCredits ?? null,
            usedCredits: usageReadiness?.usedCredits ?? null,
            overageCreditRate: usageReadiness?.overageCreditRate ?? null,
            usageUpdatedAt: usageReadiness?.usageUpdatedAt ?? null,
            creditDiagnostic: usageReadiness?.creditDiagnostic ?? null,
            degradedDiagnostic: usageReadiness?.degradedDiagnostic ?? null,
          },
        }),
      );
    },
    async getTransportDiagnostics() {
      const readiness = scrydexCredentialState(options);
      const usageReadiness = readiness.configured ? await getScrydexUsageReadiness(options) : null;
      const credentialDiagnostics: ProviderTransportDiagnostic[] = readiness.configured
        ? [
            {
              code: "scrydex-credentials-configured",
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
          code: `${scrydexProductDomainForUnit(unitKey) === "lorcana" ? "scrydex-lorcana" : "scrydex-one-piece"}-bulk-first-transport-configured`,
          severity: "info" as const,
          message: t(
            "catalog.features.sourceObservations.api.providerAdapters.scrydex.bulk.first.transport.configured",
            {
              productLine: scrydexProductLabel(scrydexProductDomainForUnit(unitKey)),
            },
          ),
          unitKey,
        })),
        ...scrydexUsageTransportDiagnostics(usageReadiness),
        {
          code: "scrydex-one-piece-price-history-source-authority-gated",
          severity: "info",
          message: scrydexPriceHistoryPerCardDiagnostic,
          unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        },
      ];
    },
  };
}

export async function runScrydexOnePieceSingleCardSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  const sourceUrl = `${scrydexOnePieceBaseUrl}/expansions/op-01/cards`;
  return runScrydexOnePieceProofDryRun({
    unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    payloads: [
      scrydexEnvelope({
        unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        externalKey: "card:op01-001",
        payload: {
          kind: "one-piece-card",
          card: scrydexOnePieceProofCard,
          sourceUrl,
        },
        sourceUrl,
        sourceUpdatedAt: scrydexOnePieceProofExpansion.release_date,
        fetchedAt: scrydexOnePieceProofFetchedAt,
      }),
    ],
  });
}

export async function runScrydexOnePieceSetReferenceValidationDryRun(): Promise<CatalogIntegrationDryRunResult> {
  const sourceUrl = `${scrydexOnePieceBaseUrl}/expansions/op-01`;
  return runScrydexOnePieceProofDryRun({
    unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
    payloads: [
      scrydexEnvelope({
        unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
        externalKey: "set:op-01",
        payload: {
          kind: "one-piece-set-reference",
          expansion: scrydexOnePieceProofExpansion,
          sourceUrl,
        },
        sourceUrl,
        sourceUpdatedAt: scrydexOnePieceProofExpansion.release_date,
        fetchedAt: scrydexOnePieceProofFetchedAt,
      }),
    ],
  });
}

export async function runScrydexOnePieceSealedProductSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  const sourceUrl = `${scrydexOnePieceBaseUrl}/expansions/op-01/sealed`;
  return runScrydexOnePieceProofDryRun({
    unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    payloads: [
      scrydexEnvelope({
        unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        externalKey: "sealed:op01-booster-box",
        payload: {
          kind: "one-piece-sealed-product",
          sealedProduct: scrydexOnePieceProofSealedProduct,
          sourceUrl,
        },
        sourceUrl,
        sourceUpdatedAt: scrydexOnePieceProofExpansion.release_date,
        fetchedAt: scrydexOnePieceProofFetchedAt,
      }),
    ],
  });
}

export async function runScrydexLorcanaSingleCardSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  const sourceUrl = `${scrydexLorcanaBaseUrl}/expansions/1/cards`;
  return runScrydexOnePieceProofDryRun({
    unitKey: SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    payloads: [
      scrydexEnvelope({
        unitKey: SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        externalKey: "card:tfc-041",
        payload: {
          kind: "lorcana-card",
          card: scrydexLorcanaProofCard,
          sourceUrl,
        },
        sourceUrl,
        sourceUpdatedAt: scrydexLorcanaProofExpansion.release_date,
        fetchedAt: scrydexLorcanaProofFetchedAt,
      }),
    ],
  });
}

export async function runScrydexLorcanaSetReferenceValidationDryRun(): Promise<CatalogIntegrationDryRunResult> {
  const sourceUrl = `${scrydexLorcanaBaseUrl}/expansions/1`;
  return runScrydexOnePieceProofDryRun({
    unitKey: SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
    payloads: [
      scrydexEnvelope({
        unitKey: SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
        externalKey: "set:1",
        payload: {
          kind: "lorcana-set-reference",
          expansion: scrydexLorcanaProofExpansion,
          sourceUrl,
        },
        sourceUrl,
        sourceUpdatedAt: scrydexLorcanaProofExpansion.release_date,
        fetchedAt: scrydexLorcanaProofFetchedAt,
      }),
    ],
  });
}

export async function runScrydexLorcanaSealedProductSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  const sourceUrl = `${scrydexLorcanaBaseUrl}/expansions/1/sealed`;
  return runScrydexOnePieceProofDryRun({
    unitKey: SCRYDEX_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    payloads: [
      scrydexEnvelope({
        unitKey: SCRYDEX_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        externalKey: "sealed:tfc-booster-box",
        payload: {
          kind: "lorcana-sealed-product",
          sealedProduct: scrydexLorcanaProofSealedProduct,
          sourceUrl,
        },
        sourceUrl,
        sourceUpdatedAt: scrydexLorcanaProofExpansion.release_date,
        fetchedAt: scrydexLorcanaProofFetchedAt,
      }),
    ],
  });
}

function runScrydexOnePieceProofDryRun(input: {
  unitKey: ScrydexOnePieceUnitKey;
  payloads: readonly ProviderPayloadEnvelope<ScrydexOnePieceProviderPayload>[];
}): CatalogIntegrationDryRunResult {
  return runCatalogIntegrationDryRun({
    unitKey: input.unitKey,
    profileVersion:
      scrydexProductDomainForUnit(input.unitKey) === "lorcana"
        ? SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION
        : SCRYDEX_ONE_PIECE_PRODUCTION_PROFILE_VERSION,
    payloads: input.payloads,
    normalize: (envelope) => normalizeScrydexOnePieceProofPayload(envelope),
  });
}

function normalizeScrydexOnePieceProofPayload(
  envelope: ProviderPayloadEnvelope<ScrydexOnePieceProviderPayload>,
): CatalogIntegrationObservationFact {
  if (envelope.payload.kind === "one-piece-card") {
    const card = envelope.payload.card;
    return {
      unitKey: envelope.unitKey,
      providerKey: envelope.providerKey,
      externalKey: envelope.externalKey,
      profileVersion: SCRYDEX_ONE_PIECE_PRODUCTION_PROFILE_VERSION,
      normalizedFacts: compactStringRecord({
        tcg: "one-piece",
        productLineName: "One Piece Card Game",
        name: card.name,
        cardNumber: card.printed_number ?? card.number,
        setId: card.expansion?.id,
        setCode: card.expansion?.code,
        setName: card.expansion?.name,
        rarity: card.rarity,
        cardType: card.type,
        printings: card.printings?.join(","),
        variants: card.variants
          ?.map((variant) => variant.name)
          .filter(Boolean)
          .join(","),
      }),
      sourceUrl: envelope.provenance.sourceUrl,
      sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
      sourceHash: envelope.provenance.contentHash,
    };
  }

  if (envelope.payload.kind === "one-piece-set-reference") {
    const expansion = envelope.payload.expansion;
    return {
      unitKey: envelope.unitKey,
      providerKey: envelope.providerKey,
      externalKey: envelope.externalKey,
      profileVersion: SCRYDEX_ONE_PIECE_PRODUCTION_PROFILE_VERSION,
      normalizedFacts: compactStringRecord({
        tcg: "one-piece",
        productLineName: "One Piece Card Game",
        name: expansion.name,
        setId: expansion.id,
        setCode: expansion.code,
        setName: expansion.name,
        cardCount: stringOrNumberToString(expansion.total),
      }),
      sourceUrl: envelope.provenance.sourceUrl,
      sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
      sourceHash: envelope.provenance.contentHash,
    };
  }

  if (envelope.payload.kind === "lorcana-card") {
    const card = envelope.payload.card;
    return {
      unitKey: envelope.unitKey,
      providerKey: envelope.providerKey,
      externalKey: envelope.externalKey,
      profileVersion: SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
      normalizedFacts: compactStringRecord({
        tcg: "lorcana",
        productLineName: "Disney Lorcana",
        name: card.name,
        cardNumber: card.printed_number ?? card.number,
        setId: card.expansion?.id,
        setCode: card.expansion?.code,
        setName: card.expansion?.name,
        rarity: card.rarity,
        cardType: card.type,
        inkColor: card.ink ?? card.ink_color,
        tcgplayerProductId: stringOrNumberToString(card.tcgplayer_id),
      }),
      sourceUrl: envelope.provenance.sourceUrl,
      sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
      sourceHash: envelope.provenance.contentHash,
    };
  }

  if (envelope.payload.kind === "lorcana-set-reference") {
    const expansion = envelope.payload.expansion;
    return {
      unitKey: envelope.unitKey,
      providerKey: envelope.providerKey,
      externalKey: envelope.externalKey,
      profileVersion: SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
      normalizedFacts: compactStringRecord({
        tcg: "lorcana",
        productLineName: "Disney Lorcana",
        name: expansion.name,
        setId: expansion.id,
        setCode: expansion.code,
        setName: expansion.name,
        cardCount: stringOrNumberToString(expansion.total),
      }),
      sourceUrl: envelope.provenance.sourceUrl,
      sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
      sourceHash: envelope.provenance.contentHash,
    };
  }

  if (envelope.payload.kind === "lorcana-sealed-product") {
    const sealedProduct = envelope.payload.sealedProduct;
    return {
      unitKey: envelope.unitKey,
      providerKey: envelope.providerKey,
      externalKey: envelope.externalKey,
      profileVersion: SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
      normalizedFacts: compactStringRecord({
        tcg: "lorcana",
        productLineName: "Disney Lorcana",
        name: sealedProduct.name,
        setId: sealedProduct.expansion?.id,
        setCode: sealedProduct.expansion?.code,
        setName: sealedProduct.expansion?.name,
        sealedProductForm: "sealed-product",
        productKind: sealedProduct.type,
      }),
      sourceUrl: envelope.provenance.sourceUrl,
      sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
      sourceHash: envelope.provenance.contentHash,
    };
  }

  const sealedProduct = envelope.payload.sealedProduct;
  return {
    unitKey: envelope.unitKey,
    providerKey: envelope.providerKey,
    externalKey: envelope.externalKey,
    profileVersion: SCRYDEX_ONE_PIECE_PRODUCTION_PROFILE_VERSION,
    normalizedFacts: compactStringRecord({
      tcg: "one-piece",
      productLineName: "One Piece Card Game",
      name: sealedProduct.name,
      setId: sealedProduct.expansion?.id,
      setCode: sealedProduct.expansion?.code,
      setName: sealedProduct.expansion?.name,
      sealedProductForm: "sealed-product",
      productKind: sealedProduct.type,
    }),
    sourceUrl: envelope.provenance.sourceUrl,
    sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
    sourceHash: envelope.provenance.contentHash,
  };
}

async function listScrydexOnePieceOptions(
  input: ProviderOptionQueryInput,
  options: ScrydexOnePieceProviderAdapterOptions,
): Promise<ProviderOptionQueryResult> {
  assertScrydexOnePieceUnit(input.unitKey);
  requireScrydexCredentials(options);
  const productDomain = scrydexProductDomainForUnit(input.unitKey);
  const productLabel = scrydexProductLabel(productDomain);
  const optionKind = input.optionKind.trim().toLowerCase();

  if (optionKind === "expansions" || optionKind === "expansion" || optionKind === "sets" || optionKind === "set") {
    const expansions = await fetchScrydexExpansions(options, productDomain);
    return { items: expansions.map(expansionOptionItem) };
  }

  if (optionKind === "cards" || optionKind === "card") {
    const expansionId = requireString(
      input.parentValues?.expansionId ?? input.parentValues?.setId ?? input.parentValues?.parentValue,
      `Scrydex ${productLabel} card option queries require an expansionId parent value.`,
    );
    const pages = await fetchScrydexPagedJson<ScrydexOnePieceCard>(
      "cards",
      {
        page_size: String(scrydexCardPageSize),
        q: scrydexPrintingsSearchQuery(expansionId),
        select: productDomain === "lorcana" ? scrydexLorcanaCardSelect : scrydexCardSelect,
      },
      options,
      productDomain,
    );
    return {
      items: pages.flatMap((page) => page.items.map((card) => cardOptionItem(sanitizeScrydexCard(card), expansionId))),
    };
  }

  if (optionKind === "sealed" || optionKind === "sealed-products" || optionKind === "sealed-product") {
    const expansionId = requireString(
      input.parentValues?.expansionId ?? input.parentValues?.setId ?? input.parentValues?.parentValue,
      `Scrydex ${productLabel} sealed-product option queries require an expansionId parent value.`,
    );
    const pages = await fetchScrydexPagedJson<ScrydexOnePieceSealedProduct>(
      `expansions/${encodeURIComponent(expansionId)}/sealed`,
      { page_size: String(scrydexSealedPageSize), select: scrydexSealedSelect },
      options,
      productDomain,
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

function planScrydexSetImport(
  scope: ProviderImportScope,
  usageReadiness: ScrydexUsageReadiness,
  productDomain: ScrydexProductDomain,
): ProviderImportPlan {
  const productLabel = scrydexProductLabel(productDomain);
  const productSegment = scrydexProductSegment(productDomain);
  const expansionId = requireString(
    scope.values.expansionId ?? scope.values.setId ?? scope.values.id ?? scope.values.parentValue,
    `Scrydex ${productLabel} set reference import planning requires expansionId.`,
  );
  return {
    unitKey: scope.unitKey,
    planKey: `scrydex:${productSegment}:set:${normalizePlanSegment(expansionId)}`,
    scope: { unitKey: scope.unitKey, scopeKey: "set-reference", values: { ...scope.values, expansionId } },
    estimatedPayloads: 1,
    transportSteps: [
      `Fetch Scrydex ${productLabel} expansion by id`,
      "Sanitize set reference payload",
      "Attach payload provenance",
    ],
    usageEstimate: scrydexSingleRecordUsageEstimate({
      estimatedRequestCount: 1,
      selectedFields: [],
      perRecordFallbackReason: "Selected set-reference import uses the Scrydex expansion detail endpoint.",
      usageReadiness,
    }),
  };
}

function planScrydexCardImport(
  scope: ProviderImportScope,
  usageReadiness: ScrydexUsageReadiness,
  productDomain: ScrydexProductDomain,
): ProviderImportPlan {
  const productLabel = scrydexProductLabel(productDomain);
  const productSegment = scrydexProductSegment(productDomain);
  const cardId = stringValue(scope.values.cardId ?? scope.values.id);
  if (cardId) {
    return {
      unitKey: scope.unitKey,
      planKey: `scrydex:${productSegment}:card:${normalizePlanSegment(cardId)}`,
      scope: { unitKey: scope.unitKey, scopeKey: "single-card", values: { ...scope.values, cardId } },
      estimatedPayloads: 1,
      transportSteps: [
        `Fetch Scrydex ${productLabel} card by id`,
        "Sanitize card payload",
        "Attach payload provenance",
      ],
      usageEstimate: scrydexSingleRecordUsageEstimate({
        estimatedRequestCount: 1,
        selectedFields: [],
        perRecordFallbackReason: "Operator selected one explicit Scrydex card id.",
        usageReadiness,
      }),
    };
  }

  const expansionId = requireString(
    scope.values.expansionId ?? scope.values.setId ?? scope.values.parentValue,
    `Scrydex ${productLabel} card import planning requires expansionId or cardId.`,
  );
  return {
    unitKey: scope.unitKey,
    planKey: `scrydex:${productSegment}:expansion:${normalizePlanSegment(expansionId)}:cards`,
    scope: { unitKey: scope.unitKey, scopeKey: "expansion-cards", values: { ...scope.values, expansionId } },
    transportSteps: [
      `Search Scrydex ${productLabel} cards by printings set with max page size`,
      "Sanitize card payloads",
      "Attach payload provenance",
    ],
    usageEstimate: scrydexBulkFirstUsageEstimate({
      pageSize: scrydexCardPageSize,
      selectedFields: productDomain === "lorcana" ? scrydexLorcanaCardSelect : scrydexCardSelect,
      estimateReason:
        "Card page count is available only after the first Scrydex paged search response; set imports use q=printings:<set> to include reprints.",
      usageReadiness,
    }),
  };
}

function planScrydexSealedImport(
  scope: ProviderImportScope,
  usageReadiness: ScrydexUsageReadiness,
  productDomain: ScrydexProductDomain,
): ProviderImportPlan {
  const productLabel = scrydexProductLabel(productDomain);
  const productSegment = scrydexProductSegment(productDomain);
  const sealedProductId = stringValue(scope.values.sealedProductId ?? scope.values.sealedId ?? scope.values.id);
  if (sealedProductId) {
    return {
      unitKey: scope.unitKey,
      planKey: `scrydex:${productSegment}:sealed:${normalizePlanSegment(sealedProductId)}`,
      scope: {
        unitKey: scope.unitKey,
        scopeKey: "single-sealed-product",
        values: { ...scope.values, sealedProductId },
      },
      estimatedPayloads: 1,
      transportSteps: [
        `Fetch Scrydex ${productLabel} sealed product by id`,
        "Sanitize sealed-product payload",
        "Attach payload provenance",
      ],
      usageEstimate: scrydexSingleRecordUsageEstimate({
        estimatedRequestCount: 1,
        selectedFields: [],
        perRecordFallbackReason: "Operator selected one explicit Scrydex sealed product id.",
        usageReadiness,
      }),
    };
  }

  const expansionId = requireString(
    scope.values.expansionId ?? scope.values.setId ?? scope.values.parentValue,
    `Scrydex ${productLabel} sealed-product import planning requires expansionId or sealedProductId.`,
  );
  return {
    unitKey: scope.unitKey,
    planKey: `scrydex:${productSegment}:expansion:${normalizePlanSegment(expansionId)}:sealed`,
    scope: { unitKey: scope.unitKey, scopeKey: "expansion-sealed-products", values: { ...scope.values, expansionId } },
    transportSteps: [
      `Fetch Scrydex ${productLabel} expansion sealed products with max page size`,
      "Sanitize sealed-product payloads",
      "Attach payload provenance",
    ],
    usageEstimate: scrydexBulkFirstUsageEstimate({
      pageSize: scrydexSealedPageSize,
      selectedFields: scrydexSealedSelect,
      estimateReason: "Sealed-product page count is available only after the first Scrydex paged response.",
      usageReadiness,
    }),
  };
}

function scrydexBulkFirstUsageEstimate(input: {
  pageSize: number;
  selectedFields: string;
  estimateReason: string;
  usageReadiness: ScrydexUsageReadiness;
}): ProviderUsageEstimate {
  return {
    requestStrategy: "bulk-first",
    estimateState: "estimate-unavailable",
    estimatedRequestCount: null,
    estimateReason: input.estimateReason,
    pageSize: input.pageSize,
    selectedFields: selectedFieldList(input.selectedFields),
    perRecordFallbackReason: null,
    usageCheckState: input.usageReadiness.usageCheckState,
    creditDiagnostic: input.usageReadiness.creditDiagnostic,
    degradedDiagnostic: input.usageReadiness.degradedDiagnostic,
  };
}

function scrydexSingleRecordUsageEstimate(input: {
  estimatedRequestCount: number;
  selectedFields: readonly string[];
  perRecordFallbackReason: string;
  usageReadiness: ScrydexUsageReadiness;
}): ProviderUsageEstimate {
  return {
    requestStrategy: "single-record",
    estimateState: "estimated",
    estimatedRequestCount: input.estimatedRequestCount,
    estimateReason: null,
    pageSize: null,
    selectedFields: input.selectedFields,
    perRecordFallbackReason: input.perRecordFallbackReason,
    usageCheckState: input.usageReadiness.usageCheckState,
    creditDiagnostic: input.usageReadiness.creditDiagnostic,
    degradedDiagnostic: input.usageReadiness.degradedDiagnostic,
  };
}

function selectedFieldList(select: string): readonly string[] {
  return select
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
}

async function fetchScrydexExpansions(
  options: ScrydexOnePieceProviderAdapterOptions,
  productDomain: ScrydexProductDomain = "one-piece",
): Promise<readonly ScrydexOnePieceExpansion[]> {
  const pages = await fetchScrydexPagedJson<ScrydexOnePieceExpansion>(
    "expansions",
    { page_size: String(scrydexExpansionPageSize), select: scrydexExpansionSelect },
    options,
    productDomain,
  );
  return pages.flatMap((page) => page.items.map(sanitizeScrydexExpansion));
}

async function fetchScrydexExpansionForSetReference(input: {
  expansionId: string;
  options: ScrydexOnePieceProviderAdapterOptions;
  productDomain: ScrydexProductDomain;
  productLabel: string;
}): Promise<Readonly<{ expansion: ScrydexOnePieceExpansion; sourceUrl: string }>> {
  const sourceUrl = scrydexUrl(
    `expansions/${encodeURIComponent(input.expansionId)}`,
    {},
    input.options,
    input.productDomain,
  );
  let detailError: unknown = null;
  try {
    const expansion = sanitizeScrydexExpansion(
      extractScrydexSingleRecord(await fetchScrydexJson(sourceUrl, input.options)),
    );
    if (hasScrydexExpansionIdentity(expansion)) {
      return { expansion, sourceUrl };
    }
  } catch (error) {
    if (!isScrydexMissingExpansionDetailError(error)) {
      throw error;
    }
    detailError = error;
  }

  const fallback = await findScrydexExpansionFromList({
    expansionId: input.expansionId,
    options: input.options,
    productDomain: input.productDomain,
  });
  if (fallback) {
    return fallback;
  }
  if (detailError) {
    throw detailError;
  }

  throw new Error(`Scrydex ${input.productLabel} set reference payload is missing id or name.`);
}

async function fetchScrydexExpansionChildPagedJson<TItem>(input: {
  expansionId: string;
  childPath: string;
  query: Readonly<Record<string, string>>;
  options: ScrydexOnePieceProviderAdapterOptions;
  productDomain: ScrydexProductDomain;
}): Promise<readonly ScrydexPage<TItem>[]> {
  const path = (expansionId: string) => `expansions/${encodeURIComponent(expansionId)}/${input.childPath}`;
  try {
    return await fetchScrydexPagedJson<TItem>(path(input.expansionId), input.query, input.options, input.productDomain);
  } catch (error) {
    if (!isScrydexMissingExpansionDetailError(error)) {
      throw error;
    }
    const fallback = await findScrydexExpansionFromList({
      expansionId: input.expansionId,
      options: input.options,
      productDomain: input.productDomain,
    });
    const fallbackExpansionId = stringValue(fallback?.expansion.id);
    if (!fallbackExpansionId || fallbackExpansionId === input.expansionId) {
      if (fallback && input.childPath === "sealed") {
        return [];
      }
      throw error;
    }
    return fetchScrydexPagedJson<TItem>(path(fallbackExpansionId), input.query, input.options, input.productDomain);
  }
}

async function findScrydexExpansionFromList(input: {
  expansionId: string;
  options: ScrydexOnePieceProviderAdapterOptions;
  productDomain: ScrydexProductDomain;
}): Promise<Readonly<{ expansion: ScrydexOnePieceExpansion; sourceUrl: string }> | null> {
  const pages = await fetchScrydexPagedJson<ScrydexOnePieceExpansion>(
    "expansions",
    { page_size: String(scrydexExpansionPageSize), select: scrydexExpansionSelect },
    input.options,
    input.productDomain,
  );
  for (const page of pages) {
    for (const item of page.items) {
      const expansion = sanitizeScrydexExpansion(item);
      if (scrydexExpansionMatchesSelectedValue(expansion, input.expansionId)) {
        return { expansion, sourceUrl: page.sourceUrl };
      }
    }
  }
  return null;
}

async function fetchScrydexPagedJson<TItem>(
  path: string,
  query: Readonly<Record<string, string>>,
  options: ScrydexOnePieceProviderAdapterOptions,
  productDomain: ScrydexProductDomain = "one-piece",
): Promise<readonly ScrydexPage<TItem>[]> {
  const pages: ScrydexPage<TItem>[] = [];
  const pageSize = Number(query.page_size);
  let page = 1;
  let nextUrl: string | null = scrydexUrl(path, { page: String(page), ...query }, options, productDomain);

  while (nextUrl) {
    const sourceUrl = nextUrl;
    const body = await fetchScrydexJson(sourceUrl, options);
    const items = extractScrydexItems<TItem>(body);
    pages.push({ items, sourceUrl });
    const explicitNextUrl = stringValue(recordValue(body, "next_page") ?? recordValue(body, "nextPage"));
    if (explicitNextUrl) {
      nextUrl = absoluteScrydexUrl(explicitNextUrl, options, productDomain);
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
      nextUrl = scrydexUrl(path, { page: String(page), ...query }, options, productDomain);
      continue;
    }

    const hasMore =
      booleanValue(recordValue(body, "has_more") ?? recordValue(body, "hasMore")) ??
      booleanValue(recordValue(recordValue(body, "meta"), "has_more")) ??
      booleanValue(recordValue(recordValue(body, "pagination"), "has_more"));
    if (hasMore && items.length >= pageSize) {
      page += 1;
      nextUrl = scrydexUrl(path, { page: String(page), ...query }, options, productDomain);
      continue;
    }

    nextUrl = null;
  }

  return pages;
}

async function getScrydexUsageReadiness(
  options: ScrydexOnePieceProviderAdapterOptions,
): Promise<ScrydexUsageReadiness> {
  if (!scrydexCredentialState(options).configured) {
    return {
      usageCheckState: "unavailable",
      creditDiagnostic: "Scrydex usage check skipped because API key or team ID is missing.",
      degradedDiagnostic: null,
      creditState: "unknown",
      totalCredits: null,
      remainingCredits: null,
      usedCredits: null,
      overageCreditRate: null,
      usageUpdatedAt: null,
      credentialState: "unknown",
      diagnosticCode: "credential-missing",
    };
  }

  try {
    const body = await fetchScrydexJson(scrydexAccountUrl("usage", options), options);
    const usage = sanitizeScrydexUsage(body);
    const creditState = scrydexCreditState(usage);
    return {
      usageCheckState: "checked",
      creditDiagnostic: scrydexCreditDiagnostic(creditState),
      degradedDiagnostic: scrydexUsageLagDiagnostic,
      creditState,
      ...usage,
      credentialState: "configured",
    };
  } catch (error) {
    if (error instanceof ScrydexTransportError) {
      return {
        usageCheckState: "unavailable",
        creditDiagnostic:
          error.diagnosticCode === "scrydex-credit-exhausted"
            ? "Scrydex account credits appear exhausted; imports should remain stopped until operators review plan and overage posture."
            : null,
        degradedDiagnostic: error.message,
        creditState: error.diagnosticCode === "scrydex-credit-exhausted" ? "exhausted" : "unknown",
        totalCredits: null,
        remainingCredits: null,
        usedCredits: null,
        overageCreditRate: null,
        usageUpdatedAt: null,
        retryAfterSeconds: error.retryAfterSeconds,
        diagnosticCode: error.diagnosticCode,
        credentialState:
          error.diagnosticCode === "credential-invalid"
            ? "invalid"
            : error.diagnosticCode === "adapter-authentication-failed"
              ? "unknown"
              : "configured",
      };
    }

    return {
      usageCheckState: "unavailable",
      creditDiagnostic: null,
      degradedDiagnostic: "Scrydex account usage check failed before returning redacted credit evidence.",
      creditState: "unknown",
      totalCredits: null,
      remainingCredits: null,
      usedCredits: null,
      overageCreditRate: null,
      usageUpdatedAt: null,
      diagnosticCode: "provider-degraded",
      credentialState: "configured",
    };
  }
}

function scrydexUsageTransportDiagnostics(
  usageReadiness: ScrydexUsageReadiness | null,
): readonly ProviderTransportDiagnostic[] {
  if (!usageReadiness) {
    return [];
  }

  const diagnostics: ProviderTransportDiagnostic[] = [
    {
      code:
        usageReadiness.usageCheckState === "checked"
          ? "scrydex-account-usage-checked"
          : (usageReadiness.diagnosticCode ?? "scrydex-account-usage-unavailable"),
      severity:
        usageReadiness.creditState === "exhausted" ||
        usageReadiness.diagnosticCode === "credential-invalid" ||
        usageReadiness.diagnosticCode === "adapter-authentication-failed"
          ? "error"
          : usageReadiness.usageCheckState === "checked"
            ? "info"
            : "warning",
      message:
        usageReadiness.usageCheckState === "checked"
          ? scrydexUsageCheckedDiagnostic
          : (usageReadiness.degradedDiagnostic ?? "Scrydex account usage check is unavailable."),
      retryAfterSeconds: usageReadiness.retryAfterSeconds,
    },
  ];

  if (usageReadiness.creditState === "low") {
    diagnostics.push({
      code: "scrydex-credit-low",
      severity: "warning",
      message: usageReadiness.creditDiagnostic ?? "Scrydex account credits are low.",
    });
  }

  if (usageReadiness.creditState === "exhausted") {
    diagnostics.push({
      code: "scrydex-credit-exhausted",
      severity: "error",
      message: usageReadiness.creditDiagnostic ?? "Scrydex account credits are exhausted.",
    });
  }

  if (usageReadiness.usageCheckState === "checked") {
    diagnostics.push({
      code: "scrydex-account-usage-stale-window",
      severity: "info",
      message: scrydexUsageLagDiagnostic,
    });
  }

  return diagnostics;
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
    throw await scrydexTransportError(response);
  }
  return (await response.json()) as JsonValue;
}

async function scrydexTransportError(response: Response): Promise<ScrydexTransportError> {
  const bodyText = await response.text().catch(() => "");
  const body = parseJsonText(bodyText);
  const retryAfterSeconds = retryAfterSecondsFromHeader(response.headers.get("retry-after"));
  const bodyMentionsCredit = stableStringify(body ?? {})
    .toLowerCase()
    .includes("credit");

  if (response.status === 401) {
    return new ScrydexTransportError({
      status: response.status,
      diagnosticCode: "credential-invalid",
      diagnosticText: "Scrydex rejected the redacted API credentials with HTTP 401.",
      retryAfterSeconds,
    });
  }

  if (response.status === 403) {
    return new ScrydexTransportError({
      status: response.status,
      diagnosticCode: "adapter-authentication-failed",
      diagnosticText: "Scrydex denied access with HTTP 403; verify redacted team, key, and plan readiness.",
      retryAfterSeconds,
    });
  }

  if (response.status === 429) {
    return new ScrydexTransportError({
      status: response.status,
      diagnosticCode: "provider-rate-limited",
      diagnosticText: "Scrydex rate-limited the request with HTTP 429.",
      retryAfterSeconds,
    });
  }

  if (response.status === 402 || bodyMentionsCredit) {
    return new ScrydexTransportError({
      status: response.status,
      diagnosticCode: "scrydex-credit-exhausted",
      diagnosticText: "Scrydex reported credit exhaustion or payment-required state; provider details are redacted.",
      retryAfterSeconds,
    });
  }

  if (response.status >= 500) {
    return new ScrydexTransportError({
      status: response.status,
      diagnosticCode: "provider-degraded",
      diagnosticText: `Scrydex provider appears degraded with HTTP ${response.status}.`,
      retryAfterSeconds,
    });
  }

  return new ScrydexTransportError({
    status: response.status,
    diagnosticCode: "provider-request-failed",
    diagnosticText: `Scrydex request failed with HTTP ${response.status}; provider response body is redacted.`,
    retryAfterSeconds,
  });
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

function extractScrydexSingleRecord(body: JsonValue): JsonValue {
  if (!isJsonRecord(body)) {
    return body;
  }

  for (const key of ["data", "item", "result", "record", "expansion"]) {
    const value = body[key];
    if (isJsonRecord(value)) {
      return value;
    }
    if (Array.isArray(value)) {
      const firstRecord = value.find(isJsonRecord);
      if (firstRecord) {
        return firstRecord;
      }
    }
  }

  return body;
}

function hasScrydexExpansionIdentity(expansion: ScrydexOnePieceExpansion): boolean {
  return Boolean(stringValue(expansion.id) && stringValue(expansion.name));
}

function isScrydexMissingExpansionDetailError(error: unknown): boolean {
  return error instanceof ScrydexTransportError && error.diagnosticCode === "provider-request-failed";
}

function scrydexExpansionMatchesSelectedValue(expansion: ScrydexOnePieceExpansion, selectedValue: string): boolean {
  const selected = normalizedScrydexExpansionMatchValue(selectedValue);
  return [expansion.id, expansion.code, expansion.name]
    .map(stringValue)
    .filter((value): value is string => Boolean(value))
    .some((value) => normalizedScrydexExpansionMatchValue(value) === selected);
}

function normalizedScrydexExpansionMatchValue(value: string): string {
  return normalizePlanSegment(value);
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
  const printings = stringArrayValue(record.printings);
  const variants = sanitizeScrydexCardVariants(record.variants);
  const imageUrls = scrydexImageUrls(record.images);
  return compactRecord({
    id: stringValue(record.id),
    name: stringValue(record.name),
    number: stringValue(record.number),
    printed_number: stringValue(record.printed_number),
    rarity: stringValue(record.rarity),
    rarity_code: stringValue(record.rarity_code),
    type: stringValue(record.type),
    ink: stringValue(record.ink ?? record.ink_color),
    ink_color: stringValue(record.ink_color ?? record.ink),
    tcgplayer_id: stringOrNumberValue(record.tcgplayer_id ?? record.tcgplayerId),
    imageUrls: imageUrls.length > 0 ? imageUrls : null,
    language: stringValue(record.language),
    language_code: stringValue(record.language_code),
    expansion: sanitizeScrydexExpansion(record.expansion),
    printings: printings.length > 0 ? printings : null,
    variants: variants.length > 0 ? variants : null,
  });
}

function sanitizeScrydexCardVariants(value: JsonValue | undefined): readonly ScrydexOnePieceCardVariant[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const record = jsonRecord(entry);
      const printings = stringArrayValue(record.printings);
      return compactRecord({
        name: stringValue(record.name),
        printings: printings.length > 0 ? printings : null,
      }) as ScrydexOnePieceCardVariant;
    })
    .filter((variant) => Boolean(variant.name) || Boolean(variant.printings?.length));
}

function sanitizeScrydexSealedProduct(value: JsonValue): ScrydexOnePieceSealedProduct {
  const record = unwrapScrydexSealedProductRecord(value);
  const expansion = sanitizeScrydexExpansion(record.expansion);
  const imageUrls = scrydexImageUrls(record.images);
  return compactRecord({
    id: stringValue(
      record.id ?? record.sealed_product_id ?? record.sealedProductId ?? record.product_id ?? record.productId,
    ),
    name:
      stringValue(record.name ?? record.title ?? record.product_name ?? record.productName) ??
      scrydexSealedProductFallbackName(record, expansion),
    type: stringValue(record.type ?? record.product_type ?? record.productType),
    imageUrls: imageUrls.length > 0 ? imageUrls : null,
    language: stringValue(record.language),
    language_code: stringValue(record.language_code ?? record.languageCode),
    expansion,
  });
}

function unwrapScrydexSealedProductRecord(value: JsonValue): Readonly<Record<string, JsonValue>> {
  const responseRecord = jsonRecord(value);
  const record = unwrapScrydexProductResponseRecord(responseRecord);
  for (const key of ["sealedProduct", "sealed_product", "product"]) {
    const nested = record[key];
    if (isJsonRecord(nested)) {
      return nested;
    }
  }
  return record;
}

function unwrapScrydexProductResponseRecord(
  record: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  for (const key of ["data", "result", "item", "record"]) {
    const nested = record[key];
    if (isJsonRecord(nested)) {
      return nested;
    }
    if (Array.isArray(nested)) {
      const firstRecord = nested.find(isJsonRecord);
      if (firstRecord) {
        return firstRecord;
      }
    }
  }
  return record;
}

function scrydexSealedProductFallbackName(
  record: Readonly<Record<string, JsonValue>>,
  expansion: ScrydexOnePieceExpansion,
): string | null {
  const type = stringValue(record.type ?? record.product_type ?? record.productType);
  if (!type) {
    return null;
  }

  const expansionLabel = stringValue(expansion.name ?? expansion.code ?? expansion.id);
  return expansionLabel ? `${expansionLabel} ${type}` : null;
}

function scrydexImageUrls(value: JsonValue | undefined): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value.flatMap((entry) => {
        const directUrl = stringValue(entry);
        if (directUrl && isHttpsUrl(directUrl)) {
          return [directUrl];
        }
        const record = jsonRecord(entry);
        return [record.large, record.medium, record.small, record.url]
          .map(stringValue)
          .filter((url): url is string => typeof url === "string" && isHttpsUrl(url));
      }),
    ),
  ];
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
  productDomain: ScrydexProductDomain = "one-piece",
): string {
  const base = scrydexBaseUrl(options, productDomain).replace(/\/$/, "");
  const url = new URL(`${base}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function scrydexAccountUrl(path: string, options: ScrydexOnePieceProviderAdapterOptions): string {
  const base = accountBaseUrl(options).replace(/\/$/, "");
  return new URL(`${base}/${path.replace(/^\//, "")}`).toString();
}

function accountBaseUrl(options: ScrydexOnePieceProviderAdapterOptions): string {
  if (!options.baseUrl) {
    return scrydexAccountBaseUrl;
  }

  return options.baseUrl.replace(/\/(?:onepiece|lorcana)\/v1\/?$/i, "/account/v1");
}

function scrydexBaseUrl(options: ScrydexOnePieceProviderAdapterOptions, productDomain: ScrydexProductDomain): string {
  if (productDomain === "lorcana") {
    return (
      options.lorcanaBaseUrl ?? options.baseUrl?.replace(/\/onepiece\/v1\/?$/i, "/lorcana/v1") ?? scrydexLorcanaBaseUrl
    );
  }
  return options.baseUrl ?? scrydexOnePieceBaseUrl;
}

function scrydexPrintingsSearchQuery(expansionId: string): string {
  const normalized = requireString(expansionId, "Scrydex One Piece printings search requires a set value.");
  const queryValue = /^[a-z0-9_-]+$/i.test(normalized) ? normalized : `"${normalized.replace(/"/g, '\\"')}"`;
  return `printings:${queryValue}`;
}

function absoluteScrydexUrl(
  value: string,
  options: ScrydexOnePieceProviderAdapterOptions,
  productDomain: ScrydexProductDomain = "one-piece",
): string {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  const base = scrydexBaseUrl(options, productDomain).replace(/\/$/, "");
  return new URL(value, `${base}/`).toString();
}

function requireScrydexCredentials(
  options: ScrydexOnePieceProviderAdapterOptions,
): Readonly<{ apiKey: string; teamId: string }> {
  const apiKey = stringValue(options.credentials?.apiKey);
  const teamId = stringValue(options.credentials?.teamId);
  if (!apiKey || !teamId) {
    throw new Error("Shared Scrydex credentials are required for Scrydex provider transport.");
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
    unitKey !== SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY &&
    unitKey !== SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY &&
    unitKey !== SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY &&
    unitKey !== SCRYDEX_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY
  ) {
    throw new Error(`Scrydex adapter does not support Catalog integration unit '${unitKey}'.`);
  }
}

function scrydexOnePieceUnitKeys(): readonly ScrydexOnePieceUnitKey[] {
  return [
    SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
    SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  ];
}

function scrydexProductDomainForUnit(unitKey: string): ScrydexProductDomain {
  if (
    unitKey === SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY ||
    unitKey === SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY ||
    unitKey === SCRYDEX_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY
  ) {
    return "lorcana";
  }
  return "one-piece";
}

function scrydexProductLabel(productDomain: ScrydexProductDomain): string {
  return productDomain === "lorcana" ? "Lorcana" : "One Piece";
}

function scrydexProductSegment(productDomain: ScrydexProductDomain): string {
  return productDomain;
}

function scrydexOnePieceOnlyUnitKeys(): readonly [
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

function stringArrayValue(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(stringValue).filter((entry): entry is string => Boolean(entry));
}

function stringOrNumberValue(value: unknown): string | number | null {
  return typeof value === "number" ? value : stringValue(value);
}

function stringOrNumberToString(value: unknown): string | undefined {
  return stringValue(value) ?? undefined;
}

function compactStringRecord(
  values: Readonly<Record<string, string | null | undefined>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const normalized = stringValue(value);
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
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

function sanitizeScrydexUsage(
  value: JsonValue,
): Omit<
  ScrydexUsageReadiness,
  "usageCheckState" | "creditDiagnostic" | "degradedDiagnostic" | "creditState" | "credentialState"
> {
  const record = jsonRecord(value);
  return {
    totalCredits: numberValue(record.total_credits ?? record.totalCredits),
    remainingCredits: numberValue(record.remaining_credits ?? record.remainingCredits),
    usedCredits: numberValue(record.used_credits ?? record.usedCredits),
    overageCreditRate: stringValue(record.overage_credit_rate ?? record.overageCreditRate),
    usageUpdatedAt: stringValue(
      record.updated_at ?? record.updatedAt ?? record.usage_updated_at ?? record.usageUpdatedAt ?? record.last_updated,
    ),
  };
}

function scrydexCreditState(
  usage: Pick<ScrydexUsageReadiness, "remainingCredits" | "totalCredits">,
): ScrydexUsageReadiness["creditState"] {
  if (usage.remainingCredits === null) {
    return "unknown";
  }

  if (usage.remainingCredits <= 0) {
    return "exhausted";
  }

  if (usage.totalCredits !== null && usage.totalCredits > 0 && usage.remainingCredits / usage.totalCredits <= 0.1) {
    return "low";
  }

  return "available";
}

function scrydexCreditDiagnostic(creditState: ScrydexUsageReadiness["creditState"]): string {
  if (creditState === "exhausted") {
    return "Scrydex account credits are exhausted; stop paid imports until operators review credits and overage posture.";
  }

  if (creditState === "low") {
    return "Scrydex account credits are low; operators should review call budgets before running imports.";
  }

  if (creditState === "unknown") {
    return "Scrydex account usage response did not include remaining-credit evidence.";
  }

  return scrydexUsageCheckedDiagnostic;
}

function retryAfterSecondsFromHeader(value: string | null): number | undefined {
  const retryAfter = stringValue(value);
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds);
  }

  const retryAt = Date.parse(retryAfter);
  if (Number.isNaN(retryAt)) {
    return undefined;
  }

  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

function parseJsonText(value: string): JsonValue | null {
  if (!value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return null;
  }
}

function jsonRecord(value: JsonValue): Readonly<Record<string, JsonValue>> {
  return isJsonRecord(value) ? value : {};
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
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

class ScrydexTransportError extends Error {
  readonly status: number;
  readonly diagnosticCode: string;
  readonly retryAfterSeconds?: number;

  constructor(input: { status: number; diagnosticCode: string; diagnosticText: string; retryAfterSeconds?: number }) {
    super(input.diagnosticText);
    this.name = "ScrydexTransportError";
    this.status = input.status;
    this.diagnosticCode = input.diagnosticCode;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}
