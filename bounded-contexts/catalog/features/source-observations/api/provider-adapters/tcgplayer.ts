import { t } from "@chase-sets/localization";
import {
  runCatalogIntegrationDryRun,
  type CatalogIntegrationDryRunResult,
  type CatalogIntegrationObservationFact,
} from "../catalog-integration-engine";
import { createCatalogProviderCredentialReadiness } from "../catalog-integration-credential-readiness";
import { defineCatalogIntegrationUnitKey } from "../integration-unit";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../provider-integration-profiles";
import { assembleCatalogProviderIngestionUnitProfileSections } from "../provider-profile-sections";
import {
  TCGPLAYER_LORCANA_SINGLE_CARD_PROFILE_VERSION,
  TCGPLAYER_LORCANA_SEALED_PRODUCT_PROFILE_VERSION,
  TCGPLAYER_MTG_SEALED_PRODUCT_PROFILE_VERSION,
  TCGPLAYER_MTG_SINGLE_CARD_PROFILE_VERSION,
  TCGPLAYER_ONE_PIECE_SINGLE_CARD_PROFILE_VERSION,
  TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_PROFILE_VERSION,
  TCGPLAYER_POKEMON_SINGLE_CARD_PROFILE_VERSION,
  TCGPLAYER_POKEMON_SEALED_PRODUCT_PROFILE_VERSION,
  TCGPLAYER_YUGIOH_SINGLE_CARD_PROFILE_VERSION,
} from "../tcgplayer-executable-mapping-contract";
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

export const TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "tcgplayer",
  productDomain: "yugioh",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export const TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "tcgplayer",
  productDomain: "one-piece",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export const TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "tcgplayer",
  productDomain: "one-piece",
  productForm: "sealed-product",
  ingestionPurpose: "source-observation-import",
});

export const TCGPLAYER_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "tcgplayer",
  productDomain: "lorcana",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export const TCGPLAYER_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "tcgplayer",
  productDomain: "lorcana",
  productForm: "sealed-product",
  ingestionPurpose: "source-observation-import",
});

export const TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "tcgplayer",
  productDomain: "mtg",
  productForm: "sealed-product",
  ingestionPurpose: "source-observation-import",
});

export const TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "tcgplayer",
  productDomain: "pokemon",
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

      const productLineId = positiveIntegerValue(plan.scope.values.productLineId ?? plan.scope.values.categoryId);
      const scopedProducts = await listTcgplayerSetProducts({
        client,
        constraints,
        productLineId,
        productLineName,
        setName,
      });
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
          sourceKind: "environment-secret",
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

async function listTcgplayerSetProducts(input: {
  client: TcgplayerAutomationCatalogClient;
  constraints: TcgplayerUnitConstraints;
  productLineId: number | null;
  productLineName: string;
  setName: string;
}): Promise<readonly TcgplayerAutomationProductSearchProduct[]> {
  const products = await listTcgplayerSetProductsByTerms(input, true);
  const scopedProducts = filterTcgplayerSetProducts(products, input.constraints, input.productLineId);
  if (scopedProducts.length > 0 || input.productLineId === null) {
    return scopedProducts;
  }

  const fallbackProducts = await listTcgplayerSetProductsByTerms(input, false);
  return filterTcgplayerSetProducts(fallbackProducts, input.constraints, input.productLineId);
}

async function listTcgplayerSetProductsByTerms(
  input: {
    client: TcgplayerAutomationCatalogClient;
    productLineName: string;
    setName: string;
  },
  includeProductLineName: boolean,
): Promise<readonly TcgplayerAutomationProductSearchProduct[]> {
  return input.client.listAllProducts({
    size: 24,
    filters: {
      term: {
        ...(includeProductLineName ? { productLineName: [input.productLineName] } : {}),
        setName: [input.setName],
      },
    },
    sort: {
      field: "product-sorting-name",
      order: "asc",
    },
  });
}

function filterTcgplayerSetProducts(
  products: readonly TcgplayerAutomationProductSearchProduct[],
  constraints: TcgplayerUnitConstraints,
  productLineId: number | null,
): readonly TcgplayerAutomationProductSearchProduct[] {
  return products.filter(
    (product) =>
      (productLineId === null || product.productLineId === productLineId) &&
      productLineMatchesUnit(product, constraints) &&
      productSummaryFormCanMatchUnit(product, constraints),
  );
}

export async function runTcgplayerMtgSingleCardSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerMtgSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_MTG_SINGLE_CARD_PROFILE_VERSION,
    detail: tcgplayerMtgSingleCardProofDetail,
  });
}

export async function runTcgplayerMtgSealedProductSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerMtgSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_MTG_SEALED_PRODUCT_PROFILE_VERSION,
    detail: tcgplayerMtgSealedProductProofDetail,
  });
}

export async function runTcgplayerPokemonSingleCardSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_POKEMON_SINGLE_CARD_PROFILE_VERSION,
    detail: tcgplayerPokemonSingleCardProofDetail,
    fetchedAt: "2026-06-03T00:00:00.000Z",
  });
}

export async function runTcgplayerPokemonSealedProductSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_POKEMON_SEALED_PRODUCT_PROFILE_VERSION,
    detail: tcgplayerPokemonSealedProductProofDetail,
    fetchedAt: "2026-07-13T00:00:00.000Z",
  });
}

export async function runTcgplayerYugiohSingleCardSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_YUGIOH_SINGLE_CARD_PROFILE_VERSION,
    detail: tcgplayerYugiohSingleCardProofDetail,
    fetchedAt: "2026-06-21T00:00:00.000Z",
  });
}

export async function runTcgplayerOnePieceSingleCardSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_ONE_PIECE_SINGLE_CARD_PROFILE_VERSION,
    detail: tcgplayerOnePieceSingleCardProofDetail,
    fetchedAt: "2026-06-22T00:00:00.000Z",
  });
}

export async function runTcgplayerOnePieceSealedProductSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_PROFILE_VERSION,
    detail: tcgplayerOnePieceSealedProductProofDetail,
    fetchedAt: "2026-06-23T00:00:00.000Z",
  });
}

export async function runTcgplayerLorcanaSingleCardSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_LORCANA_SINGLE_CARD_PROFILE_VERSION,
    detail: tcgplayerLorcanaSingleCardProofDetail,
    fetchedAt: "2026-06-23T00:00:00.000Z",
  });
}

export async function runTcgplayerLorcanaSealedProductSourceObservationImportProofDryRun(): Promise<CatalogIntegrationDryRunResult> {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    unitKey: TCGPLAYER_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    profileVersion: TCGPLAYER_LORCANA_SEALED_PRODUCT_PROFILE_VERSION,
    detail: tcgplayerLorcanaSealedProductProofDetail,
    fetchedAt: "2026-06-23T00:00:00.000Z",
  });
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

function runTcgplayerMtgSourceObservationImportProofDryRun(input: {
  unitKey:
    | typeof TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY
    | typeof TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY;
  profileVersion: string;
  detail: TcgplayerAutomationProductDetail;
}): CatalogIntegrationDryRunResult {
  return runTcgplayerProviderProductSourceObservationImportProofDryRun({
    ...input,
    fetchedAt: "2026-06-19T00:00:00.000Z",
  });
}

function runTcgplayerProviderProductSourceObservationImportProofDryRun(input: {
  unitKey: string;
  profileVersion: string;
  detail: TcgplayerAutomationProductDetail;
  fetchedAt: string;
}): CatalogIntegrationDryRunResult {
  const payload = detailEnvelope(
    {
      unitKey: input.unitKey,
      planKey: `tcgplayer:proof:${input.detail.productId}`,
      scope: {
        unitKey: input.unitKey,
        scopeKey: "set-name",
        values: {
          productLineName: input.detail.productLineName,
          setName: input.detail.setName,
        },
      },
      estimatedPayloads: 1,
      transportSteps: ["Use fixture-backed TCGplayer product detail proof"],
    },
    input.detail,
    input.fetchedAt,
  );

  return runCatalogIntegrationDryRun({
    unitKey: input.unitKey,
    profileVersion: input.profileVersion,
    payloads: [payload],
    normalize: (envelope) => normalizeTcgplayerMtgProofPayload(envelope, input.profileVersion),
  });
}

function normalizeTcgplayerMtgProofPayload(
  envelope: ProviderPayloadEnvelope<TcgplayerProviderPayload>,
  profileVersion: string,
): CatalogIntegrationObservationFact {
  if (envelope.payload.kind !== "product-detail") {
    throw new Error("TCGplayer Magic proof dry run received a non-detail payload.");
  }

  const detail = envelope.payload.detail;
  return {
    unitKey: envelope.unitKey,
    providerKey: envelope.providerKey,
    externalKey: envelope.externalKey,
    profileVersion,
    normalizedFacts: compactStringRecord({
      productId: String(detail.productId),
      name: detail.productName,
      setCode: detail.setCode,
      setName: detail.setName,
      productLineName: detail.productLineName,
      productTypeName: detail.productTypeName,
      productForm: detail.sealed ? "sealed" : "single",
      cardNumber: detail.customAttributes.number,
      releaseDate: detail.customAttributes.releaseDate,
      skuCount: String(detail.skus.length),
      firstSkuId: detail.skus[0] ? String(detail.skus[0].sku) : undefined,
      firstSkuCondition: detail.skus[0]?.condition,
      firstSkuVariant: detail.skus[0]?.variant,
      firstSkuLanguage: detail.skus[0]?.language,
    }),
    sourceUrl: envelope.provenance.sourceUrl,
    sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
  };
}

function compactStringRecord(values: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])));
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

const tcgplayerMtgSingleCardProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Cards",
  rarityName: "Uncommon",
  sealed: false,
  productName: "Fury Sliver",
  setId: 1001,
  setCode: "TSP",
  productId: 14240,
  setName: "Time Spiral",
  productLineId: 1,
  productStatusId: 1,
  productLineName: "Magic",
  customAttributes: { number: "157", releaseDate: "2006-10-06", cardType: ["Creature"] },
  formattedAttributes: { Artist: "Paolo Parente" },
  skus: [{ sku: 50014240, condition: "Near Mint", variant: "Normal", language: "English" }],
  marketPrice: 1.23,
  lowestPrice: 1.01,
  lowestPriceWithShipping: 1.23,
  medianPrice: 1.5,
  listings: 25,
};

const tcgplayerMtgSealedProductProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Sealed Products",
  rarityName: "Sealed",
  sealed: true,
  productName: "Time Spiral Booster Pack",
  setId: 1001,
  setCode: "TSP",
  productId: 96601,
  setName: "Time Spiral",
  productLineId: 1,
  productStatusId: 1,
  productLineName: "Magic",
  customAttributes: { number: "PACK", releaseDate: "2006-10-06", cardType: ["Sealed"] },
  barcode: "0653569123456",
  formattedAttributes: {},
  skus: [{ sku: 50096601, condition: "Sealed", variant: "Sealed", language: "English" }],
  marketPrice: 12.34,
  lowestPrice: 10.01,
  lowestPriceWithShipping: 11.23,
  medianPrice: 12.5,
  listings: 25,
};

const tcgplayerPokemonSingleCardProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Cards",
  rarityName: "Common",
  sealed: false,
  productName: "Sprigatito",
  setId: 10001,
  setCode: "SVI",
  productId: 493958,
  setName: "Scarlet & Violet",
  productLineId: 3,
  productStatusId: 1,
  productLineName: "Pokemon",
  customAttributes: { number: "001/198", releaseDate: "2023-03-31", cardType: ["Pokemon"] },
  formattedAttributes: {},
  skus: [{ sku: 15500001, condition: "Near Mint", variant: "Normal", language: "English" }],
  marketPrice: 0.12,
  lowestPrice: 0.08,
  lowestPriceWithShipping: 1.01,
  medianPrice: 0.19,
  listings: 42,
};

const tcgplayerYugiohSingleCardProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Cards",
  rarityName: "Ultra Rare",
  sealed: false,
  productName: "Dark Magician",
  setId: 2002,
  setCode: "SDY",
  productId: 17851,
  setName: "Starter Deck: Yugi",
  productLineId: 2,
  productStatusId: 1,
  productLineName: "Yu-Gi-Oh!",
  customAttributes: { number: "SDY-006", releaseDate: "2002-03-29", cardType: ["Normal Monster"] },
  formattedAttributes: {},
  skus: [{ sku: 60017851, condition: "Near Mint", variant: "Unlimited", language: "English" }],
  marketPrice: 2.34,
  lowestPrice: 2.01,
  lowestPriceWithShipping: 2.89,
  medianPrice: 3.5,
  listings: 25,
};

const tcgplayerOnePieceSingleCardProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Cards",
  rarityName: "Leader",
  sealed: false,
  productName: "Monkey.D.Luffy",
  setId: 6801,
  setCode: "OP-01",
  productId: 987650,
  setName: "Romance Dawn",
  productLineId: 68,
  productStatusId: 1,
  productLineName: "One Piece Card Game",
  customAttributes: { number: "OP01-001", releaseDate: "2022-12-02", cardType: ["Leader"] },
  formattedAttributes: {},
  skus: [{ sku: 900987650, condition: "Near Mint", variant: "Normal", language: "English" }],
  marketPrice: 2.34,
  lowestPrice: 2.01,
  lowestPriceWithShipping: 2.89,
  medianPrice: 3.5,
  listings: 25,
};

const tcgplayerOnePieceSealedProductProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Sealed Products",
  rarityName: "Sealed",
  sealed: true,
  productName: "Romance Dawn Booster Box",
  setId: 6801,
  setCode: "OP-01",
  productId: 987660,
  setName: "Romance Dawn",
  productLineId: 68,
  productStatusId: 1,
  productLineName: "One Piece Card Game",
  customAttributes: { number: "BOX", releaseDate: "2022-12-02", cardType: ["Sealed"] },
  barcode: "811039041234",
  formattedAttributes: {},
  skus: [{ sku: 900987660, condition: "Sealed", variant: "Sealed", language: "English" }],
};

const tcgplayerLorcanaSingleCardProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Cards",
  rarityName: "Rare",
  sealed: false,
  productName: "Elsa - Snow Queen",
  setId: 5010,
  setCode: "TFC",
  productId: 1005010,
  setName: "The First Chapter",
  productLineId: 71,
  productStatusId: 1,
  productLineName: "Disney Lorcana",
  customAttributes: { number: "3/204", releaseDate: "2023-08-18", cardType: ["Character"] },
  formattedAttributes: {},
  skus: [{ sku: 91005010, condition: "Near Mint", variant: "Normal", language: "English" }],
  marketPrice: 2.34,
  lowestPrice: 2.01,
  lowestPriceWithShipping: 2.89,
  medianPrice: 3.5,
  listings: 25,
};

const tcgplayerLorcanaSealedProductProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Sealed Products",
  rarityName: "Sealed",
  sealed: true,
  productName: "The First Chapter Booster Box",
  setId: 5010,
  setCode: "TFC",
  productId: 1005020,
  setName: "The First Chapter",
  productLineId: 71,
  productStatusId: 1,
  productLineName: "Disney Lorcana",
  customAttributes: { number: "BOX", releaseDate: "2023-08-18", cardType: ["Sealed"] },
  barcode: "4050368981234",
  formattedAttributes: {},
  skus: [{ sku: 91005020, condition: "Sealed", variant: "Sealed", language: "English" }],
};

const tcgplayerPokemonSealedProductProofDetail: TcgplayerAutomationProductDetail = {
  productTypeName: "Sealed Products",
  rarityName: "Sealed",
  sealed: true,
  productName: "Scarlet & Violet Elite Trainer Box",
  setId: 10001,
  setCode: "SVI",
  productId: 497105,
  setName: "Scarlet & Violet",
  productLineId: 3,
  productStatusId: 1,
  productLineName: "Pokemon",
  customAttributes: { number: "ETB", releaseDate: "2023-03-31", cardType: ["Sealed"] },
  barcode: "0820650851234",
  formattedAttributes: {},
  skus: [{ sku: 15501001, condition: "Sealed", variant: "Sealed", language: "English" }],
};

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
  if (unitKey === TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
    return {
      unitKey,
      productLineNames: ["yu-gi-oh!", "yugioh", "yu-gi-oh", "yu gi oh"],
      productLineUrlNames: ["yugioh", "yu-gi-oh"],
      defaultProductLineName: "Yu-Gi-Oh!",
      productForm: "single-card",
    };
  }
  if (unitKey === TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
    return {
      unitKey,
      productLineNames: ["one piece card game", "one piece", "onepiece", "opcg"],
      productLineUrlNames: ["one-piece-card-game", "one-piece", "onepiece"],
      defaultProductLineName: "One Piece Card Game",
      productForm: "single-card",
    };
  }
  if (unitKey === TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
    return {
      unitKey,
      productLineNames: ["one piece card game", "one piece", "onepiece", "opcg"],
      productLineUrlNames: ["one-piece-card-game", "one-piece", "onepiece"],
      defaultProductLineName: "One Piece Card Game",
      productForm: "sealed-product",
    };
  }
  if (unitKey === TCGPLAYER_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
    return {
      unitKey,
      productLineNames: ["disney lorcana", "lorcana"],
      productLineUrlNames: ["disney-lorcana", "lorcana"],
      defaultProductLineName: "Disney Lorcana",
      productForm: "single-card",
    };
  }
  if (unitKey === TCGPLAYER_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
    return {
      unitKey,
      productLineNames: ["disney lorcana", "lorcana"],
      productLineUrlNames: ["disney-lorcana", "lorcana"],
      defaultProductLineName: "Disney Lorcana",
      productForm: "sealed-product",
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
  if (unitKey === TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
    return {
      unitKey,
      productLineNames: ["pokemon", "pokemon trading card game", "pokemon tcg"],
      productLineUrlNames: ["pokemon", "pokemon-tcg"],
      defaultProductLineName: "Pokemon",
      productForm: "sealed-product",
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

function productSummaryFormCanMatchUnit(
  product: Pick<TcgplayerAutomationProductSearchProduct, "sealed" | "productTypeName">,
  constraints: TcgplayerUnitConstraints,
): boolean {
  const normalizedProductType = normalizeProviderValue(product.productTypeName);
  if (constraints.productForm === "single-card") {
    return !product.sealed && !productTypeLooksSealed(normalizedProductType);
  }

  return product.sealed || productTypeLooksSealed(normalizedProductType);
}

function productFormMatchesUnit(
  product: Pick<TcgplayerAutomationProductSearchProduct, "sealed" | "productTypeName">,
  constraints: TcgplayerUnitConstraints,
): boolean {
  const normalizedProductType = normalizeProviderValue(product.productTypeName);
  if (constraints.productForm === "single-card") {
    return !product.sealed && normalizedProductType.includes("card");
  }

  return product.sealed || productTypeLooksSealed(normalizedProductType);
}

function productTypeLooksSealed(normalizedProductType: string): boolean {
  return (
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
