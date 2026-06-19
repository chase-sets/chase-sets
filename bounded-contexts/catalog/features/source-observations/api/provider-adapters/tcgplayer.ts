import { t } from "@chase-sets/localization";
import { createCatalogProviderCredentialReadiness } from "../catalog-integration-credential-readiness";
import { defineCatalogIntegrationUnitKey } from "../integration-unit";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../provider-integration-profiles";
import { assembleCatalogProviderIngestionUnitProfileSections } from "../provider-profile-sections";
import type {
  TcgplayerAutomationCatalogClient,
  TcgplayerAutomationProductDetail,
  TcgplayerAutomationProductSearchProduct,
  TcgplayerAutomationProductSku,
} from "../tcgplayer-automation-catalog-client";
import {
  TCGPLAYER_AUTOMATION_DOMAINS,
  TCGPLAYER_AUTOMATION_RETRYABLE_STATUS_CODES,
} from "../tcgplayer-automation-client";
import type {
  CatalogIntegrationUnitDescriptor,
  ProviderAdapter,
  ProviderImportPlan,
  ProviderImportScope,
  ProviderOptionItem,
  ProviderOptionQueryInput,
  ProviderOptionQueryResult,
  ProviderPayloadEnvelope,
} from "./provider-adapter";

export const TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "tcgplayer",
  productDomain: "pokemon",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export const TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "tcgplayer",
  productDomain: "mtg",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export const TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "tcgplayer",
  productDomain: "mtg",
  productForm: "sealed-product",
  ingestionPurpose: "source-observation-import",
});

export type TcgplayerProviderPayload =
  | Readonly<{
      kind: "product-detail";
      detail: TcgplayerAutomationProductDetail;
    }>
  | Readonly<{
      kind: "product-detail-failure";
      productId: number;
      productName: string;
      reason: string;
    }>;

export type TcgplayerProviderAdapterOptions = Readonly<{
  loadProfileVersions: () => Promise<readonly CatalogProviderIntegrationProfileVersionRecord[]>;
  client?: TcgplayerAutomationCatalogClient;
  now?: () => Date;
}>;

export function createTcgplayerProviderAdapter(
  options: TcgplayerProviderAdapterOptions,
): ProviderAdapter<TcgplayerProviderPayload> {
  return {
    providerKey: "tcgplayer",
    capabilities: {
      supportsOptionQueries: true,
      supportsImportPlanning: true,
      supportsPayloadFetch: true,
    },
    async listIntegrationUnits() {
      const profileVersions = await loadTcgplayerImportProfileVersions(options);
      return profileVersions.map((profileVersion) => {
        const identity =
          assembleCatalogProviderIngestionUnitProfileSections(profileVersion).ingestionUnitIdentity.value;
        return {
          ...identity,
          profileVersion: profileVersion.profileVersion,
        };
      });
    },
    async listOptions(input) {
      return listTcgplayerAdapterOptions(input, options);
    },
    async planImport(scope) {
      const profileVersion = await requireTcgplayerProfileVersionForUnit(options, scope.unitKey);
      const constraints = constraintsForTcgplayerUnit(scope.unitKey);
      const productId = positiveIntegerValue(scope.values.productId);
      if (productId !== null) {
        return {
          unitKey: scope.unitKey,
          planKey: `tcgplayer:product:${productId}`,
          scope: {
            unitKey: scope.unitKey,
            scopeKey: "product",
            values: { ...scope.values, productId: String(productId) },
          },
          estimatedPayloads: 1,
          transportSteps: ["Fetch TCGplayer product detail", "Attach payload provenance"],
        };
      }

      const productLineName = stringValue(scope.values.productLineName) ?? constraints.defaultProductLineName;
      const setName = stringValue(scope.values.setName) || stringValue(scope.values.cleanSetName);
      if (!productLineName || !setName) {
        throw new Error("TCGplayer set import planning requires productLineName and setName scope values.");
      }
      assertProductLineMatchesUnit(profileVersion, productLineName);

      const productLineId = positiveIntegerValue(scope.values.productLineId ?? scope.values.categoryId);
      return {
        unitKey: scope.unitKey,
        planKey: `tcgplayer:set:${productLineId ?? productLineName}:${setName}`,
        scope: {
          unitKey: scope.unitKey,
          scopeKey: "set-name",
          values: {
            ...scope.values,
            productLineName,
            setName,
            ...(productLineId === null ? {} : { productLineId: String(productLineId) }),
          },
        },
        transportSteps: [
          "Search TCGplayer products for set scope",
          "Fetch TCGplayer product details",
          "Attach payload provenance",
        ],
      };
    },
    async *fetchPayloads(plan, fetchOptions) {
      const profileVersion = await requireTcgplayerProfileVersionForUnit(options, plan.unitKey);
      const constraints = constraintsForTcgplayerUnit(plan.unitKey);
      const client = requireClient(options);
      const productId = positiveIntegerValue(plan.scope.values.productId);
      const fetchedAt = (options.now ?? (() => new Date()))().toISOString();

      if (productId !== null) {
        await fetchOptions?.onProgress?.({
          phase: "fetching",
          completed: 0,
          total: 1,
          currentLabel: stringValue(plan.scope.values.productName) ?? `Product ${productId}`,
        });
        const detail = await client.getProductDetail({ productId });
        if (!productDetailMatchesUnit(detail, constraints)) {
          yield rejectedProductEnvelope(
            plan,
            detail.productId,
            detail.productName,
            fetchedAt,
            productMismatchReason(profileVersion, detail),
          );
          return;
        }
        await fetchOptions?.onProgress?.({
          phase: "fetching",
          completed: 1,
          total: 1,
          currentLabel: detail.productName,
        });
        yield detailEnvelope(plan, detail, fetchedAt);
        return;
      }

      const productLineName = stringValue(plan.scope.values.productLineName) ?? constraints.defaultProductLineName;
      const setName = stringValue(plan.scope.values.setName);
      if (!productLineName || !setName) {
        throw new Error("TCGplayer set payload fetch requires productLineName and setName scope values.");
      }
      assertProductLineMatchesUnit(profileVersion, productLineName);

      const products = await client.listAllProducts({
        size: 24,
        filters: {
          term: {
            productLineName: [productLineName],
            setName: [setName],
          },
        },
        sort: {
          field: "product-sorting-name",
          order: "asc",
        },
      });
      const scopedProducts = products.filter((product) => productSummaryMatchesUnit(product, constraints));
      let completed = 0;
      await fetchOptions?.onProgress?.({
        phase: "fetching",
        completed,
        total: scopedProducts.length,
        currentLabel: setName,
      });

      for (const product of scopedProducts) {
        try {
          const detail = await client.getProductDetail({ productId: product.productId });
          if (!productDetailMatchesUnit(detail, constraints)) {
            completed += 1;
            await fetchOptions?.onProgress?.({
              phase: "fetching",
              completed,
              total: scopedProducts.length,
              currentLabel: detail.productName,
            });
            yield rejectedProductEnvelope(
              plan,
              detail.productId,
              detail.productName,
              fetchedAt,
              productMismatchReason(profileVersion, detail),
            );
            continue;
          }
          completed += 1;
          await fetchOptions?.onProgress?.({
            phase: "fetching",
            completed,
            total: scopedProducts.length,
            currentLabel: detail.productName,
          });
          yield detailEnvelope(plan, detail, fetchedAt);
        } catch (error) {
          if (isCancellationLikeError(error)) {
            throw error;
          }
          await fetchOptions?.onProgress?.({
            phase: "fetching",
            completed,
            total: scopedProducts.length,
            currentLabel: product.productName,
          });
          yield failureEnvelope(plan, product, fetchedAt, error);
        }
      }
    },
    async getTransportDiagnostics() {
      const profileVersions = await loadTcgplayerImportProfileVersions(options);
      const profileUnits = profileVersions.length > 0 ? profileVersions : [null];
      const retryableCodes = TCGPLAYER_AUTOMATION_RETRYABLE_STATUS_CODES.join(", ");
      const domains = Object.values(TCGPLAYER_AUTOMATION_DOMAINS).join(", ");

      if (!options.client) {
        return profileUnits.flatMap((profileVersion) =>
          tcgplayerTransportDiagnosticsForUnit({
            profileVersion,
            unitKey: unitKeyForTcgplayerProfileVersion(profileVersion),
            clientConfigured: false,
            domains,
            retryableCodes,
          }),
        );
      }

      return profileUnits.flatMap((profileVersion) =>
        tcgplayerTransportDiagnosticsForUnit({
          profileVersion,
          unitKey: unitKeyForTcgplayerProfileVersion(profileVersion),
          clientConfigured: true,
          domains,
          retryableCodes,
        }),
      );
    },
    async getCredentialReadiness() {
      const profileVersions = await loadTcgplayerImportProfileVersions(options);
      const profileUnits = profileVersions.length > 0 ? profileVersions : [null];
      const checkedAt = (options.now ?? (() => new Date()))().toISOString();

      return profileUnits.map((profileVersion) =>
        createCatalogProviderCredentialReadiness({
          providerKey: "tcgplayer",
          unitKey: unitKeyForTcgplayerProfileVersion(profileVersion),
          requirement: "required",
          sourceKind: options.client ? "operator-session" : "environment-secret",
          state: options.client ? "configured" : "missing",
          message: options.client
            ? t("catalog.features.sourceObservations.api.providerAdapters.tcgplayer.credential.configured")
            : t("catalog.features.sourceObservations.api.providerAdapters.tcgplayer.credential.missing"),
          checkedAt,
          scope: {
            environmentKey: "runtime",
            secretReference: "tcgplayer-automation-client",
          },
          evidence: {
            connectorKind: profileVersion?.profile.connector.kind ?? "tcgplayer-automation-client",
            lifecycle: profileVersion?.lifecycle ?? "unregistered",
            credentialRequirement: "required",
            credentialState: options.client ? "configured" : "missing",
          },
        }),
      );
    },
  };
}

async function listTcgplayerAdapterOptions(
  input: ProviderOptionQueryInput,
  options: TcgplayerProviderAdapterOptions,
): Promise<ProviderOptionQueryResult> {
  const profileVersion = await requireTcgplayerProfileVersionForUnit(options, input.unitKey);
  const constraints = constraintsForTcgplayerUnit(input.unitKey);
  const client = requireClient(options);
  const optionKind = input.optionKind.trim().toLowerCase();
  const parentValues = input.parentValues ?? {};

  if (optionKind === "product-lines" || optionKind === "product-line" || optionKind === "categories") {
    const productLines = await client.listProductLines();
    return {
      items: productLines
        .filter((item) => productLineMatchesUnit(item, constraints))
        .map((item) => ({
          value: String(item.productLineId),
          label: item.productLineName,
          metadata: optionalMetadata({
            productLineId: String(item.productLineId),
            productLineName: item.productLineName,
            productLineUrlName: item.productLineUrlName,
            isDirect: String(item.isDirect),
          }),
        })),
    };
  }

  if (optionKind === "set-names" || optionKind === "set-name" || optionKind === "sets") {
    const productLineId = positiveIntegerValue(
      parentValues.productLineId ?? parentValues.categoryId ?? parentValues.parentValue,
    );
    if (productLineId === null) {
      throw new Error("TCGplayer set-name option queries require a productLineId/categoryId parent value.");
    }
    await assertProductLineIdMatchesUnit(client, profileVersion, productLineId, constraints);
    const response = await client.listCatalogSetNames({ categoryId: productLineId });
    return {
      items: response.results
        .filter((item) => item.active)
        .map((item) => ({
          value: item.cleanSetName,
          label: item.name,
          parentValue: String(productLineId),
          metadata: optionalMetadata({
            productLineId: String(productLineId),
            setNameId: String(item.setNameId),
            categoryId: String(item.categoryId),
            cleanSetName: item.cleanSetName,
            urlName: item.urlName,
            abbreviation: item.abbreviation ?? null,
            releaseDate: item.releaseDate ?? null,
            isSupplemental: String(item.isSupplemental),
            active: String(item.active),
          }),
        })),
    };
  }

  if (optionKind === "products" || optionKind === "product") {
    const setName = stringValue(parentValues.setName) || stringValue(parentValues.parentValue);
    if (!setName) {
      throw new Error("TCGplayer product option queries require a set-name parent value.");
    }
    const productLineName = stringValue(parentValues.productLineName) ?? constraints.defaultProductLineName;
    const products = await client.listAllProducts({
      size: 24,
      filters: {
        term: {
          ...(productLineName ? { productLineName: [productLineName] } : {}),
          setName: [setName],
        },
      },
      sort: {
        field: "product-sorting-name",
        order: "asc",
      },
    });
    return {
      items: products
        .filter((item) => productSummaryMatchesUnit(item, constraints))
        .map((item) => productOptionItem(item)),
    };
  }

  if (optionKind === "skus" || optionKind === "sku") {
    const productId = positiveIntegerValue(parentValues.productId ?? parentValues.parentValue);
    if (productId === null) {
      throw new Error("TCGplayer SKU option queries require a Product parent value.");
    }
    const detail = await client.getProductDetail({ productId });
    if (!productDetailMatchesUnit(detail, constraints)) {
      return { items: [] };
    }
    return {
      items: detail.skus.map((item) => skuOptionItem(item)),
    };
  }

  return { items: [] };
}

async function loadTcgplayerImportProfileVersions(
  options: TcgplayerProviderAdapterOptions,
): Promise<readonly CatalogProviderIntegrationProfileVersionRecord[]> {
  const versions = (await options.loadProfileVersions()).filter(
    (version) =>
      version.providerKey.trim().toLowerCase() === "tcgplayer" &&
      version.profile.capabilities.includes("source-observation-import"),
  );
  const activeVersions = versions.filter((version) => version.active && version.lifecycle === "active");
  return activeVersions.length > 0
    ? activeVersions
    : [...versions].sort((left, right) => right.profileVersion.localeCompare(left.profileVersion)).slice(0, 1);
}

async function requireTcgplayerProfileVersionForUnit(
  options: TcgplayerProviderAdapterOptions,
  unitKey: string,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const profileVersions = await loadTcgplayerImportProfileVersions(options);
  const profileVersion = profileVersions.find((version) => unitKeyForTcgplayerProfileVersion(version) === unitKey);
  if (!profileVersion) {
    throw new Error(`TCGplayer adapter does not support Catalog integration unit '${unitKey}'.`);
  }
  return profileVersion;
}

function detailEnvelope(
  plan: ProviderImportPlan,
  detail: TcgplayerAutomationProductDetail,
  fetchedAt: string,
): ProviderPayloadEnvelope<TcgplayerProviderPayload> {
  return {
    unitKey: plan.unitKey,
    providerKey: "tcgplayer",
    externalKey: `product:${detail.productId}`,
    payload: {
      kind: "product-detail",
      detail,
    },
    provenance: {
      sourceUrl: `https://mp-search-api.tcgplayer.com/v2/product/${detail.productId}/details`,
      sourceUpdatedAt: detail.customAttributes.releaseDate,
      fetchedAt,
    },
  };
}

function failureEnvelope(
  plan: ProviderImportPlan,
  product: TcgplayerAutomationProductSearchProduct,
  fetchedAt: string,
  error: unknown,
): ProviderPayloadEnvelope<TcgplayerProviderPayload> {
  return {
    unitKey: plan.unitKey,
    providerKey: "tcgplayer",
    externalKey: `product:${product.productId}`,
    payload: {
      kind: "product-detail-failure",
      productId: product.productId,
      productName: product.productName,
      reason: error instanceof Error ? error.message : `Product ${product.productId} failed.`,
    },
    provenance: {
      sourceUrl: `https://mp-search-api.tcgplayer.com/v2/product/${product.productId}/details`,
      fetchedAt,
    },
  };
}

function productOptionItem(item: TcgplayerAutomationProductSearchProduct): ProviderOptionItem {
  return {
    value: String(item.productId),
    label: item.productName,
    metadata: optionalMetadata({
      productId: String(item.productId),
      productName: item.productName,
      productLineId: String(item.productLineId),
      productLineName: item.productLineName,
      productTypeName: item.productTypeName ?? null,
      setId: String(item.setId),
      setName: item.setName,
      rarityName: item.rarityName,
      sealed: String(item.sealed),
    }),
  };
}

function skuOptionItem(item: TcgplayerAutomationProductSku): ProviderOptionItem {
  return {
    value: String(item.sku),
    label: String(item.sku),
    metadata: optionalMetadata({
      sku: String(item.sku),
      condition: item.condition,
      variant: item.variant,
      language: item.language,
    }),
  };
}

function unitKeyForTcgplayerProfileVersion(
  profileVersion: CatalogProviderIntegrationProfileVersionRecord | null,
): string {
  return profileVersion === null
    ? TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY
    : assembleCatalogProviderIngestionUnitProfileSections(profileVersion).ingestionUnitIdentity.value.unitKey;
}

type TcgplayerUnitConstraints = Readonly<{
  unitKey: string;
  productLineNames: readonly string[];
  productLineUrlNames: readonly string[];
  defaultProductLineName: string;
  productForm: "single-card" | "sealed-product";
}>;

function constraintsForTcgplayerUnit(unitKey: string): TcgplayerUnitConstraints {
  if (unitKey === TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
    return {
      unitKey,
      productLineNames: ["magic", "magic: the gathering", "magic the gathering", "mtg"],
      productLineUrlNames: ["magic", "magic-the-gathering", "mtg"],
      defaultProductLineName: "Magic",
      productForm: "single-card",
    };
  }
  if (unitKey === TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
    return {
      unitKey,
      productLineNames: ["magic", "magic: the gathering", "magic the gathering", "mtg"],
      productLineUrlNames: ["magic", "magic-the-gathering", "mtg"],
      defaultProductLineName: "Magic",
      productForm: "sealed-product",
    };
  }
  if (unitKey === TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
    return {
      unitKey,
      productLineNames: ["pokemon", "pokemon trading card game", "pokemon tcg"],
      productLineUrlNames: ["pokemon", "pokemon-tcg"],
      defaultProductLineName: "Pokemon",
      productForm: "single-card",
    };
  }
  throw new Error(`TCGplayer adapter does not support Catalog integration unit '${unitKey}'.`);
}

function productLineMatchesUnit(
  item:
    | Pick<TcgplayerAutomationProductSearchProduct, "productLineName">
    | { productLineName: string; productLineUrlName?: string },
  constraints: TcgplayerUnitConstraints,
): boolean {
  return (
    constraints.productLineNames.includes(normalizeProviderValue(item.productLineName)) ||
    ("productLineUrlName" in item &&
      Boolean(item.productLineUrlName) &&
      constraints.productLineUrlNames.includes(normalizeProviderValue(item.productLineUrlName)))
  );
}

function productSummaryMatchesUnit(
  product: TcgplayerAutomationProductSearchProduct,
  constraints: TcgplayerUnitConstraints,
): boolean {
  return productLineMatchesUnit(product, constraints) && productFormMatchesUnit(product, constraints);
}

function productDetailMatchesUnit(
  detail: TcgplayerAutomationProductDetail,
  constraints: TcgplayerUnitConstraints,
): boolean {
  return productLineMatchesUnit(detail, constraints) && productFormMatchesUnit(detail, constraints);
}

function productFormMatchesUnit(
  product: Pick<TcgplayerAutomationProductSearchProduct, "sealed" | "productTypeName">,
  constraints: TcgplayerUnitConstraints,
): boolean {
  const normalizedProductType = normalizeProviderValue(product.productTypeName);
  if (constraints.productForm === "single-card") {
    return !product.sealed && normalizedProductType.includes("card");
  }

  return (
    product.sealed ||
    normalizedProductType.includes("sealed") ||
    normalizedProductType.includes("booster") ||
    normalizedProductType.includes("bundle") ||
    normalizedProductType.includes("deck")
  );
}

async function assertProductLineIdMatchesUnit(
  client: TcgplayerAutomationCatalogClient,
  profileVersion: CatalogProviderIntegrationProfileVersionRecord,
  productLineId: number,
  constraints: TcgplayerUnitConstraints,
): Promise<void> {
  const productLines = await client.listProductLines();
  const productLine = productLines.find((item) => item.productLineId === productLineId);
  if (!productLine || !productLineMatchesUnit(productLine, constraints)) {
    throw new Error(
      `TCGplayer ${profileVersion.profile.displayName} option queries require the ${constraints.defaultProductLineName} product line.`,
    );
  }
}

function assertProductLineMatchesUnit(
  profileVersion: CatalogProviderIntegrationProfileVersionRecord,
  productLineName: string,
): void {
  const constraints = constraintsForTcgplayerUnit(unitKeyForTcgplayerProfileVersion(profileVersion));
  if (!productLineMatchesUnit({ productLineName }, constraints)) {
    throw new Error(
      `TCGplayer ${profileVersion.profile.displayName} imports require the ${constraints.defaultProductLineName} product line.`,
    );
  }
}

function productMismatchReason(
  profileVersion: CatalogProviderIntegrationProfileVersionRecord,
  detail: TcgplayerAutomationProductDetail,
): string {
  const constraints = constraintsForTcgplayerUnit(unitKeyForTcgplayerProfileVersion(profileVersion));
  const formLabel = constraints.productForm === "single-card" ? "single-card" : "sealed";
  return `Product ${detail.productId} is ${detail.productLineName}/${detail.productTypeName}; ${profileVersion.profile.displayName} only imports ${constraints.defaultProductLineName} ${formLabel} products.`;
}

function rejectedProductEnvelope(
  plan: ProviderImportPlan,
  productId: number,
  productName: string,
  fetchedAt: string,
  reason: string,
): ProviderPayloadEnvelope<TcgplayerProviderPayload> {
  return {
    unitKey: plan.unitKey,
    providerKey: "tcgplayer",
    externalKey: `product:${productId}`,
    payload: {
      kind: "product-detail-failure",
      productId,
      productName,
      reason,
    },
    provenance: {
      sourceUrl: `https://mp-search-api.tcgplayer.com/v2/product/${productId}/details`,
      fetchedAt,
    },
  };
}

function tcgplayerTransportDiagnosticsForUnit(input: {
  profileVersion: CatalogProviderIntegrationProfileVersionRecord | null;
  unitKey: string;
  clientConfigured: boolean;
  domains: string;
  retryableCodes: string;
}) {
  return [
    input.clientConfigured
      ? {
          code: "tcgplayer-automation-client-configured",
          severity: "info" as const,
          message: t(
            "catalog.features.sourceObservations.api.providerAdapters.tcgplayer.automation.client.configured",
            {
              connectorKind: input.profileVersion?.profile.connector.kind ?? "tcgplayer-automation-client",
              lifecycle: input.profileVersion?.lifecycle ?? "unregistered",
            },
          ),
          unitKey: input.unitKey,
        }
      : {
          code: "tcgplayer-automation-client-unconfigured",
          severity: "error" as const,
          message: t(
            "catalog.features.sourceObservations.api.providerAdapters.tcgplayer.automation.client.unconfigured",
          ),
          unitKey: input.unitKey,
        },
    {
      code: "tcgplayer-domain-rate-limit-policy-configured",
      severity: "info" as const,
      message: t(
        "catalog.features.sourceObservations.api.providerAdapters.tcgplayer.domain.rate.limit.policy.configured",
        {
          domains: input.domains,
          retryableCodes: input.retryableCodes,
        },
      ),
      unitKey: input.unitKey,
    },
  ];
}

function normalizeProviderValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value).trim().toLowerCase()
    : "";
}

function requireClient(options: TcgplayerProviderAdapterOptions): TcgplayerAutomationCatalogClient {
  if (!options.client) {
    throw new Error("TCGplayer automation Catalog client is required for TCGplayer adapter transport.");
  }

  return options.client;
}

function optionalMetadata(values: Readonly<Record<string, string | null>>): ProviderOptionItem["metadata"] {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isCancellationLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "AbortError" ||
    error.name === "DurableJobHandoffError" ||
    error.message.includes("job run was cancelled") ||
    error.message.includes("job claim was lost")
  );
}

function positiveIntegerValue(value: unknown): number | null {
  const normalized = stringValue(value);
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  return null;
}
