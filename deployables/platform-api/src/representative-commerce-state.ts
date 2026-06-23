import { pathToFileURL } from "node:url";
import { createStripePaymentProcessorGateway } from "@chase-sets/stripe-payments";
import { createStripeConnectMoneyMovementGateway } from "@chase-sets/stripe-connect";
import { createEasyPostPostageLabelProvider } from "@chase-sets/easypost-postage";
import { createFilesystemObjectStorage, createS3ObjectStorage, type ObjectStorage } from "@chase-sets/object-storage";
import { getProjectionGroup, syncProjectionGroup } from "@chase-sets/bounded-context-runtime";
import { bootstrapPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { representativeCommerceStateDataProfiles, seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { settlementOperationLogFields } from "@chase-sets/settlement/server";
import {
  normalizeRepresentativeCandidateLimit,
  acceptRepresentativeOffers,
  filterUntouchedMarketplaceCatalogUsageCandidates,
  prepareRepresentativeCatalogUsageCandidates,
  publishRepresentativeListings,
  reconcileRepresentativeMarketplaceCatalogItems,
  submitRepresentativeOffers,
  ensureRepresentativeInventoryStock,
  reconcileRepresentativeInventoryCatalogItems,
  reconcileRepresentativeDiscoveryMarketState,
  type CatalogRepresentativeServices,
  type RepresentativeInventoryServices,
  type RepresentativeMarketplaceServices,
} from "@chase-sets/catalog-seed";
import { apiContextRegistry } from "./generated/api-context-registry";
import { createPlatformApiHost } from "./app";
import {
  loadConfig,
  type PlatformApiCatalogAssetStorageConfig,
  type PlatformApiListingPhotoStorageConfig,
} from "./config";
import { closePlatformApiPools, createPlatformApiPools } from "./database-pools";
import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "./test-support/provider-gateways";

const CONFIRMATION_PHRASE = "seed staging commerce";
const DEFAULT_STEP_TIMEOUT_MS = 120_000;
const MAX_STEP_TIMEOUT_MS = 600_000;

export function assertRepresentativeCommerceStateRunAllowed(
  input: Readonly<{
    deploymentEnvironment: string | null | undefined;
    confirmation: string | null | undefined;
    localOverride?: string | null | undefined;
  }>,
): void {
  if (input.deploymentEnvironment === "production") {
    throw new Error("representative-commerce-state cannot run when DEPLOYMENT_ENVIRONMENT=production.");
  }
  if (input.confirmation !== CONFIRMATION_PHRASE) {
    throw new Error(
      `REPRESENTATIVE_COMMERCE_STATE_CONFIRM must exactly equal '${CONFIRMATION_PHRASE}' before representative commerce state can run.`,
    );
  }

  const environmentName = input.deploymentEnvironment ?? "dev";
  if (environmentName === "staging" || environmentName === "test" || environmentName === "dev") {
    return;
  }
  if (input.localOverride === "true") {
    return;
  }

  throw new Error(
    "representative-commerce-state requires DEPLOYMENT_ENVIRONMENT=staging, test/dev runtime, or REPRESENTATIVE_COMMERCE_STATE_ALLOW_LOCAL=true.",
  );
}

export async function runRepresentativeCommerceState(): Promise<void> {
  const config = loadConfig();
  assertRepresentativeCommerceStateRunAllowed({
    deploymentEnvironment: config.deploymentEnvironment,
    confirmation: process.env.REPRESENTATIVE_COMMERCE_STATE_CONFIRM,
    localOverride: process.env.REPRESENTATIVE_COMMERCE_STATE_ALLOW_LOCAL,
  });

  const pools = createPlatformApiPools(config);
  try {
    await bootstrapPlatformControlPlane(pools.control);
    const runtime = createPlatformApiHost({
      pools,
      hostPorts: {
        processorGateway:
          config.paymentProcessor.kind === "stripe"
            ? createStripePaymentProcessorGateway({
                secretKey: config.paymentProcessor.secretKey,
                publishableKey: config.paymentProcessor.publishableKey,
                webhookSecret: config.paymentProcessor.webhookSecret,
                apiBaseUrl: config.paymentProcessor.apiBaseUrl,
              })
            : createFakePaymentProcessorGateway(),
        moneyMovementGateway:
          config.moneyMovement.kind === "stripe"
            ? createStripeConnectMoneyMovementGateway({
                secretKey: config.moneyMovement.secretKey,
                webhookSecret: config.moneyMovement.webhookSecret,
                apiBaseUrl: config.moneyMovement.apiBaseUrl,
              })
            : createFakeMoneyMovementGateway(),
        operationsRecorder: {
          record(event: Record<string, unknown>) {
            console.log("Settlement operation recorded.", JSON.stringify(settlementOperationLogFields(event)));
          },
        },
        postageLabelProvider:
          config.postage.kind === "easypost"
            ? createEasyPostPostageLabelProvider({
                apiKey: config.postage.apiKey,
                apiBaseUrl: config.postage.apiBaseUrl,
                mode: config.postage.mode,
              })
            : createSandboxPostageLabelProvider(),
        catalogAssetStorage: createObjectStorage(config.catalogAssetStorage),
        listingPhotoStorage: createObjectStorage(config.listingPhotoStorage),
      },
    });

    await runRepresentativeStep("seed data profiles", () =>
      seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, {
        enabledDataProfiles: representativeCommerceStateDataProfiles,
        environmentName: config.deploymentEnvironment ?? null,
      }),
    );
    await syncRepresentativeProjection(runtime, "marketplace", "marketplace-identity-account-projection");
    const sourceCandidates = await runRepresentativeStep(
      "prepare current catalog usage candidates",
      () =>
        prepareRepresentativeCatalogUsageCandidates(getCatalogServices(runtime.services), {
          limit: readCandidateSourceLimit(),
        }),
      { timeoutMs: MAX_STEP_TIMEOUT_MS },
    );
    const candidates = await runRepresentativeStep("filter untouched marketplace catalog candidates", () =>
      filterUntouchedMarketplaceCatalogUsageCandidates(getMarketplaceDb(runtime.services), sourceCandidates, {
        limit: readCandidateLimit(),
      }),
    );
    const marketplaceReconciledCount = await runRepresentativeStep("reconcile selected marketplace catalog items", () =>
      reconcileRepresentativeMarketplaceCatalogItems(getMarketplaceDb(runtime.services), candidates),
    );
    const inventoryReconciledCount = await runRepresentativeStep("reconcile selected inventory catalog items", () =>
      reconcileRepresentativeInventoryCatalogItems(getInventoryServices(runtime.services), candidates),
    );
    const inventoryStock = await runRepresentativeStep("ensure representative inventory stock", () =>
      ensureRepresentativeInventoryStock(getInventoryServices(runtime.services), candidates),
    );
    await syncRepresentativeProjection(runtime, "marketplace", "marketplace-inventory-supply-projection");
    await syncRepresentativeProjection(runtime, "ordering", "ordering-inventory-supply-input-projection");
    const listings = await runRepresentativeStep("publish representative listings", () =>
      publishRepresentativeListings(getMarketplaceServices(runtime.services), inventoryStock),
    );
    await syncRepresentativeProjection(runtime, "marketplace", "marketplace-listing-projection");
    await syncRepresentativeProjection(runtime, "ordering", "ordering-marketplace-supply-input-projection");
    const offers = await runRepresentativeStep("submit representative offers", () =>
      submitRepresentativeOffers(getMarketplaceServices(runtime.services), inventoryStock),
    );
    await syncRepresentativeProjection(runtime, "marketplace", "marketplace-offer-projection");
    const acceptedOffers = await runRepresentativeStep("accept representative offers", () =>
      acceptRepresentativeOffers(getMarketplaceServices(runtime.services), inventoryStock),
    );
    await syncRepresentativeProjection(runtime, "marketplace", "marketplace-offer-projection");
    await syncRepresentativeProjection(runtime, "ordering", "ordering-marketplace-offer-acceptance");
    await syncRepresentativeProjection(runtime, "ordering", "ordering-order-projection");
    const discoveryMarketState = await runRepresentativeStep("reconcile representative discovery market state", () =>
      reconcileRepresentativeDiscoveryMarketState(
        {
          discoveryDb: getDiscoveryDb(runtime.services),
          marketplaceDb: getMarketplaceDb(runtime.services),
        },
        {
          listingIds: listings.map((listing) => listing.listingId),
          offerIds: offers.map((offer) => offer.offerId),
          existingRepresentativeLimit: readCandidateLimit(),
        },
      ),
    );

    console.log(
      JSON.stringify({
        type: "representative-commerce-state.complete",
        environmentName: config.deploymentEnvironment ?? null,
        dataProfiles: representativeCommerceStateDataProfiles,
        sourceCatalogCandidateCount: sourceCandidates.length,
        untouchedCatalogCandidateCount: candidates.length,
        untouchedCatalogCandidates: candidates.map((candidate) => candidate.catalogItemId),
        marketplaceReconciledCatalogItemCount: marketplaceReconciledCount,
        inventoryReconciledCatalogItemCount: inventoryReconciledCount,
        representativeInventoryStockCount: inventoryStock.length,
        representativeInventoryStock: inventoryStock.map((stock) => ({
          catalogItemId: stock.catalogItemId,
          accountId: stock.accountId,
          inventoryItemId: stock.inventoryItemId,
        })),
        representativeListingCount: listings.length,
        representativeListings: listings.map((listing) => ({
          catalogItemId: listing.catalogItemId,
          accountId: listing.accountId,
          listingId: listing.listingId,
        })),
        representativeOfferCount: offers.length,
        representativeOffers: offers.map((offer) => ({
          catalogItemId: offer.catalogItemId,
          buyerAccountId: offer.buyerAccountId,
          offerId: offer.offerId,
        })),
        representativeAcceptedOfferCount: acceptedOffers.filter(
          (offer) => offer.status === "accepted" || offer.status === "already-accepted",
        ).length,
        representativeAcceptedOffers: acceptedOffers.map((offer) => ({
          catalogItemId: offer.catalogItemId,
          sellerAccountId: offer.sellerAccountId,
          offerId: offer.offerId,
          status: offer.status,
          reason: offer.reason,
        })),
        representativeDiscoveryMarketState: discoveryMarketState,
        contexts: runtime.mountedContexts.map((context) => context.contextName),
      }),
    );
  } finally {
    await closePlatformApiPools(pools);
  }
}

function createObjectStorage(
  config: PlatformApiCatalogAssetStorageConfig | PlatformApiListingPhotoStorageConfig,
): ObjectStorage {
  return config.kind === "s3" ? createS3ObjectStorage(config) : createFilesystemObjectStorage(config);
}

function readCandidateLimit(): number {
  const rawValue = process.env.REPRESENTATIVE_COMMERCE_STATE_CATALOG_ITEM_LIMIT;
  if (!rawValue) {
    return normalizeRepresentativeCandidateLimit(undefined);
  }

  const parsed = Number.parseInt(rawValue, 10);
  return normalizeRepresentativeCandidateLimit(parsed);
}

function readCandidateSourceLimit(): number {
  return normalizeRepresentativeCandidateLimit(readCandidateLimit() * 5);
}

function readStepTimeoutMs(): number {
  return readRepresentativeTimeoutMs("REPRESENTATIVE_COMMERCE_STATE_STEP_TIMEOUT_MS", DEFAULT_STEP_TIMEOUT_MS);
}

function readRepresentativeTimeoutMs(envName: string, defaultValue: number): number {
  const rawValue = process.env[envName];
  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return Math.min(Math.trunc(parsed), MAX_STEP_TIMEOUT_MS);
}

async function runRepresentativeStep<T>(
  stepName: string,
  run: () => Promise<T>,
  options: Readonly<{ timeoutMs?: number }> = {},
): Promise<T> {
  const startedAt = Date.now();
  console.log(JSON.stringify({ type: "representative-commerce-state.step.started", stepName }));

  try {
    const result = await withRepresentativeStepTimeout(stepName, run(), options.timeoutMs);
    console.log(
      JSON.stringify({
        type: "representative-commerce-state.step.completed",
        stepName,
        durationMs: Date.now() - startedAt,
      }),
    );
    return result;
  } catch (error) {
    console.log(
      JSON.stringify({
        type: "representative-commerce-state.step.failed",
        stepName,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Unknown representative commerce state step failure.",
      }),
    );
    throw error;
  }
}

async function withRepresentativeStepTimeout<T>(
  stepName: string,
  promise: Promise<T>,
  timeoutMs: number = readStepTimeoutMs(),
): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Representative commerce state step '${stepName}' exceeded ${timeoutMs}ms. Check projection backlog and retry after workers catch up.`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function syncRepresentativeProjection(
  runtime: Parameters<typeof getProjectionGroup>[0],
  contextName: string,
  projectionName: string,
  options: Readonly<{ timeoutMs?: number }> = {},
): Promise<void> {
  await runRepresentativeStep(
    `sync ${contextName}.${projectionName}`,
    async () => {
      await syncProjectionGroup(getProjectionGroup(runtime, contextName, projectionName));
    },
    options,
  );
}

function getMarketplaceDb(services: Readonly<Record<string, unknown>>): Pick<PgQueryable, "query"> {
  return getMarketplaceServices(services).db;
}

function getDiscoveryDb(services: Readonly<Record<string, unknown>>): Pick<PgQueryable, "query"> {
  const discovery = services.discovery;
  if (
    !discovery ||
    typeof discovery !== "object" ||
    !("db" in discovery) ||
    !discovery.db ||
    typeof discovery.db !== "object" ||
    !("query" in discovery.db) ||
    typeof discovery.db.query !== "function"
  ) {
    throw new Error("Representative commerce state requires mounted Discovery services with a queryable db.");
  }

  return discovery.db as Pick<PgQueryable, "query">;
}

function getCatalogServices(services: Readonly<Record<string, unknown>>): CatalogRepresentativeServices {
  const catalog = services.catalog;
  if (
    !catalog ||
    typeof catalog !== "object" ||
    !("db" in catalog) ||
    !("productMeasures" in catalog) ||
    !catalog.db ||
    typeof catalog.db !== "object" ||
    !("query" in catalog.db) ||
    typeof catalog.db.query !== "function" ||
    !catalog.productMeasures ||
    typeof catalog.productMeasures !== "object" ||
    !("resolveCatalogItemMeasures" in catalog.productMeasures) ||
    typeof catalog.productMeasures.resolveCatalogItemMeasures !== "function"
  ) {
    throw new Error(
      "Representative commerce state requires mounted Catalog services with product measures and a queryable db.",
    );
  }

  return catalog as CatalogRepresentativeServices;
}

function getMarketplaceServices(services: Readonly<Record<string, unknown>>): RepresentativeMarketplaceServices {
  const marketplace = services.marketplace;
  if (
    !marketplace ||
    typeof marketplace !== "object" ||
    !("db" in marketplace) ||
    !marketplace.db ||
    typeof marketplace.db !== "object" ||
    !("query" in marketplace.db) ||
    typeof marketplace.db.query !== "function"
  ) {
    throw new Error("Representative commerce state requires mounted Marketplace services with a queryable db.");
  }

  return marketplace as RepresentativeMarketplaceServices;
}

function getInventoryServices(services: Readonly<Record<string, unknown>>): RepresentativeInventoryServices {
  const inventory = services.inventory;
  if (!inventory || typeof inventory !== "object" || !("catalogItems" in inventory) || !("items" in inventory)) {
    throw new Error("Representative commerce state requires mounted Inventory services.");
  }

  return inventory as RepresentativeInventoryServices;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runRepresentativeCommerceState().catch((error) => {
    console.error("Representative commerce state refresh failed.", error);
    process.exit(1);
  });
}
