import { pathToFileURL } from "node:url";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing-testing";
import { createStripePaymentProcessorGateway } from "@chase-sets/stripe-payments";
import { createFakeMoneyMovementGateway } from "@chase-sets/money-movement-testing";
import { createStripeConnectMoneyMovementGateway } from "@chase-sets/stripe-connect";
import { createEasyPostPostageLabelProvider } from "@chase-sets/easypost-postage";
import { createSandboxPostageLabelProvider } from "@chase-sets/postage-labels-testing";
import { createFilesystemObjectStorage, createS3ObjectStorage, type ObjectStorage } from "@chase-sets/object-storage";
import { drainContextRuntime, syncContextProjectionGroups } from "@chase-sets/bounded-context-runtime";
import { bootstrapPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { representativeCommerceStateDataProfiles, seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  loadUntouchedMarketplaceCatalogUsageCandidates,
  normalizeRepresentativeCandidateLimit,
  acceptRepresentativeOffers,
  publishRepresentativeListings,
  submitRepresentativeOffers,
} from "@chase-sets/marketplace/server";
import { ensureRepresentativeInventoryStock } from "@chase-sets/inventory/server";
import { apiContextRegistry } from "./generated/api-context-registry";
import { createPlatformApiHost } from "./app";
import {
  loadConfig,
  type PlatformApiCatalogAssetStorageConfig,
  type PlatformApiListingPhotoStorageConfig,
} from "./config";
import { closePlatformApiPools, createPlatformApiPools } from "./database-pools";

const CONFIRMATION_PHRASE = "seed staging commerce";

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
                checkoutUiMode: config.paymentProcessor.checkoutUiMode,
              })
            : createFakePaymentProcessorGateway(),
        moneyMovementGateway:
          config.moneyMovement.kind === "stripe"
            ? createStripeConnectMoneyMovementGateway({
                secretKey: config.moneyMovement.secretKey,
                webhookSecret: config.moneyMovement.webhookSecret,
                apiBaseUrl: config.moneyMovement.apiBaseUrl,
                onboardingReturnUrl: config.moneyMovement.onboardingReturnUrl,
                onboardingRefreshUrl: config.moneyMovement.onboardingRefreshUrl,
              })
            : createFakeMoneyMovementGateway(),
        operationsRecorder: {
          record(event: Record<string, unknown>) {
            console.log("Settlement operation recorded.", JSON.stringify(event));
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

    await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, {
      enabledDataProfiles: representativeCommerceStateDataProfiles,
      environmentName: config.deploymentEnvironment ?? null,
    });
    const candidates = await loadUntouchedMarketplaceCatalogUsageCandidates(getMarketplaceDb(runtime.services), {
      limit: readCandidateLimit(),
    });
    const inventoryStock = await ensureRepresentativeInventoryStock(getInventoryServices(runtime.services), candidates);
    await syncContextProjectionGroups(runtime, "marketplace");
    const listings = await publishRepresentativeListings(getMarketplaceServices(runtime.services), inventoryStock);
    await syncContextProjectionGroups(runtime, "marketplace");
    const offers = await submitRepresentativeOffers(getMarketplaceServices(runtime.services), inventoryStock);
    await syncContextProjectionGroups(runtime, "marketplace");
    const acceptedOffers = await acceptRepresentativeOffers(getMarketplaceServices(runtime.services), inventoryStock);
    await syncContextProjectionGroups(runtime, "marketplace");
    await syncContextProjectionGroups(runtime, "ordering");
    await drainContextRuntime(runtime);

    console.log(
      JSON.stringify({
        type: "representative-commerce-state.complete",
        environmentName: config.deploymentEnvironment ?? null,
        dataProfiles: representativeCommerceStateDataProfiles,
        untouchedCatalogCandidateCount: candidates.length,
        untouchedCatalogCandidates: candidates.map((candidate) => candidate.catalogItemId),
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

function getMarketplaceDb(services: Readonly<Record<string, unknown>>): Pick<PgQueryable, "query"> {
  return getMarketplaceServices(services).db;
}

function getMarketplaceServices(services: Readonly<Record<string, unknown>>) {
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

  return marketplace as Parameters<typeof publishRepresentativeListings>[0];
}

function getInventoryServices(services: Readonly<Record<string, unknown>>) {
  const inventory = services.inventory;
  if (!inventory || typeof inventory !== "object" || !("catalogItems" in inventory) || !("items" in inventory)) {
    throw new Error("Representative commerce state requires mounted Inventory services.");
  }

  return inventory as Parameters<typeof ensureRepresentativeInventoryStock>[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runRepresentativeCommerceState().catch((error) => {
    console.error("Representative commerce state refresh failed.", error);
    process.exit(1);
  });
}
