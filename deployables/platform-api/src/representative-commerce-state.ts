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
  reconcileRepresentativeOrderingSupplyState,
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

type ChromeUatPersonaAlias = "card-vault" | "sealed-stockroom";
type ChromeUatReadinessStatus = "ready" | "operator-action-required";
type ChromeUatPersonaBlocker =
  | "chrome-login-not-ready"
  | "payout-not-ready"
  | "owned-inventory-missing"
  | "owned-active-listing-missing";

type ChromeUatPersonaCandidate = Readonly<{
  alias: ChromeUatPersonaAlias;
  accountId: string;
  userId: string;
}>;

export type ChromeUatPersonaReadiness = Readonly<{
  personaAlias: ChromeUatPersonaAlias;
  chromeLogin: "magic-link-ready" | "not-ready";
  payoutReadiness: "ready" | "not-ready";
  listingState: "owned-mutable" | "missing";
  activeListingCount: number;
  mutableListingCount: number;
  inventoryItemCount: number;
  blockerCategories: readonly ChromeUatPersonaBlocker[];
}>;

export type ChromeUatRepresentativePersonaSelection = Readonly<{
  schemaVersion: "representative-commerce-state.chrome-uat-selector/v1";
  status: ChromeUatReadinessStatus;
  selectedPersonaAlias: ChromeUatPersonaAlias | null;
  recommendedOperatorActionPersonaAlias: ChromeUatPersonaAlias | null;
  checkedPersonaCount: number;
  personas: readonly ChromeUatPersonaReadiness[];
  evidencePolicy: "support-safe";
  nextOperatorAction:
    | "use-selected-private-login-and-record-redacted-uat"
    | "complete-private-payout-setup-for-recommended-persona"
    | "refresh-representative-state-and-rerun-selector";
}>;

export type PendingPaymentSaleRepresentativeSelection = Readonly<{
  schemaVersion: "representative-commerce-state.pending-payment-sale-selector/v1";
  status: "ready" | "not-available";
  selectedPersonaAlias: ChromeUatPersonaAlias | null;
  checkedPersonaCount: number;
  personas: readonly Readonly<{
    personaAlias: ChromeUatPersonaAlias;
    chromeLogin: "magic-link-ready" | "not-ready";
    pendingPaymentSaleCount: number;
    pendingPaymentOfferAcceptanceSaleCount: number;
  }>[];
  evidencePolicy: "support-safe";
  sellerSalesPath: "/account/sales";
  selectedSaleRouteTemplate: "/account/sales/:orderId" | null;
  nextOperatorAction:
    | "use-selected-private-login-open-sales-and-record-redacted-pending-payment-uat"
    | "refresh-representative-state-and-rerun-selector";
}>;

const chromeUatPersonaCandidates: readonly ChromeUatPersonaCandidate[] = [
  {
    alias: "card-vault",
    accountId: "acc_repr_card_vault_account",
    userId: "usr_repr_card_vault_user",
  },
  {
    alias: "sealed-stockroom",
    accountId: "acc_repr_sealed_stockroom_account",
    userId: "usr_repr_sealed_stockroom_user",
  },
];

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
    await syncRepresentativeProjection(runtime, "inventory", "inventory-item-projection");
    await syncRepresentativeProjection(runtime, "inventory", "inventory-hold-projection");
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
    await syncRepresentativeProjection(runtime, "inventory", "inventory-order-reservation-workflow");
    await syncRepresentativeProjection(runtime, "ordering", "ordering-inventory-reservation-outcomes");
    await syncRepresentativeProjection(runtime, "ordering", "ordering-order-projection");
    const orderingSupplyState = await runRepresentativeStep("reconcile representative ordering supply state", () =>
      reconcileRepresentativeOrderingSupplyState(
        {
          inventoryDb: getInventoryDb(runtime.services),
          marketplaceDb: getMarketplaceDb(runtime.services),
          orderingDb: getOrderingDb(runtime.services),
        },
        {
          listingIds: listings.map((listing) => listing.listingId),
          existingRepresentativeLimit: readCandidateLimit(),
        },
      ),
    );
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
    const chromeUatSelector = await runRepresentativeStep("select support-safe Chrome UAT persona", () =>
      selectChromeUatRepresentativePersona({
        identityDb: getIdentityDb(runtime.services),
        inventoryDb: getInventoryDb(runtime.services),
        marketplaceDb: getMarketplaceDb(runtime.services),
        settlementDb: getSettlementDb(runtime.services),
      }),
    );
    const pendingPaymentSaleSelector = await runRepresentativeStep("select support-safe pending-payment sale", () =>
      selectPendingPaymentSaleRepresentativePersona({
        identityDb: getIdentityDb(runtime.services),
        orderingDb: getOrderingDb(runtime.services),
      }),
    );

    console.log(
      JSON.stringify({
        type: "representative-commerce-state.complete",
        environmentName: config.deploymentEnvironment ?? null,
        dataProfiles: representativeCommerceStateDataProfiles,
        sourceCatalogCandidateCount: sourceCandidates.length,
        untouchedCatalogCandidateCount: candidates.length,
        marketplaceReconciledCatalogItemCount: marketplaceReconciledCount,
        inventoryReconciledCatalogItemCount: inventoryReconciledCount,
        representativeInventoryStockCount: inventoryStock.length,
        representativeInventoryStockAccountCount: new Set(inventoryStock.map((stock) => stock.accountId)).size,
        representativeListingCount: listings.length,
        representativeListingAccountCount: new Set(listings.map((listing) => listing.accountId)).size,
        representativeOfferCount: offers.length,
        representativeOfferBuyerAccountCount: new Set(offers.map((offer) => offer.buyerAccountId)).size,
        representativeAcceptedOfferCount: acceptedOffers.filter(
          (offer) => offer.status === "accepted" || offer.status === "already-accepted",
        ).length,
        representativeAcceptedOfferSkippedCount: acceptedOffers.filter((offer) => offer.status === "skipped").length,
        representativeOrderingSupplyState: orderingSupplyState,
        representativeDiscoveryMarketState: discoveryMarketState,
        chromeUatSelector,
        pendingPaymentSaleSelector,
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

function getIdentityDb(services: Readonly<Record<string, unknown>>): Pick<PgQueryable, "query"> {
  return getServiceDb(services, "identity", "Representative commerce state requires mounted Identity services.");
}

function getSettlementDb(services: Readonly<Record<string, unknown>>): Pick<PgQueryable, "query"> {
  return getServiceDb(services, "settlement", "Representative commerce state requires mounted Settlement services.");
}

function getDiscoveryDb(services: Readonly<Record<string, unknown>>): Pick<PgQueryable, "query"> {
  return getServiceDb(services, "discovery", "Representative commerce state requires mounted Discovery services.");
}

function getOrderingDb(services: Readonly<Record<string, unknown>>): Pick<PgQueryable, "query"> {
  return getServiceDb(services, "ordering", "Representative commerce state requires mounted Ordering services.");
}

function getServiceDb(
  services: Readonly<Record<string, unknown>>,
  serviceName: string,
  errorMessage: string,
): Pick<PgQueryable, "query"> {
  const service = services[serviceName];
  if (
    !service ||
    typeof service !== "object" ||
    !("db" in service) ||
    !service.db ||
    typeof service.db !== "object" ||
    !("query" in service.db) ||
    typeof service.db.query !== "function"
  ) {
    throw new Error(errorMessage);
  }

  return service.db as Pick<PgQueryable, "query">;
}

function getInventoryDb(services: Readonly<Record<string, unknown>>): Pick<PgQueryable, "query"> {
  const inventory = getInventoryServices(services);
  if (
    !("db" in inventory) ||
    !inventory.db ||
    typeof inventory.db !== "object" ||
    !("query" in inventory.db) ||
    typeof inventory.db.query !== "function"
  ) {
    throw new Error("Representative commerce state requires mounted Inventory services with a queryable db.");
  }

  return inventory.db as Pick<PgQueryable, "query">;
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

export async function selectChromeUatRepresentativePersona(
  services: Readonly<{
    identityDb: Pick<PgQueryable, "query">;
    inventoryDb: Pick<PgQueryable, "query">;
    marketplaceDb: Pick<PgQueryable, "query">;
    settlementDb: Pick<PgQueryable, "query">;
  }>,
  candidates: readonly ChromeUatPersonaCandidate[] = chromeUatPersonaCandidates,
): Promise<ChromeUatRepresentativePersonaSelection> {
  const personas = await Promise.all(candidates.map((candidate) => evaluateChromeUatPersona(services, candidate)));
  const selectedPersona = personas.find((persona) => persona.blockerCategories.length === 0) ?? null;
  const payoutOnlyPersona = personas.find((persona) => hasOnlyPayoutBlocker(persona)) ?? null;
  const recommendedPersona = selectedPersona ?? payoutOnlyPersona;

  return {
    schemaVersion: "representative-commerce-state.chrome-uat-selector/v1",
    status: selectedPersona ? "ready" : "operator-action-required",
    selectedPersonaAlias: selectedPersona?.personaAlias ?? null,
    recommendedOperatorActionPersonaAlias: recommendedPersona?.personaAlias ?? null,
    checkedPersonaCount: personas.length,
    personas,
    evidencePolicy: "support-safe",
    nextOperatorAction: selectedPersona
      ? "use-selected-private-login-and-record-redacted-uat"
      : payoutOnlyPersona
        ? "complete-private-payout-setup-for-recommended-persona"
        : "refresh-representative-state-and-rerun-selector",
  };
}

export async function selectPendingPaymentSaleRepresentativePersona(
  services: Readonly<{
    identityDb: Pick<PgQueryable, "query">;
    orderingDb: Pick<PgQueryable, "query">;
  }>,
  candidates: readonly ChromeUatPersonaCandidate[] = chromeUatPersonaCandidates,
): Promise<PendingPaymentSaleRepresentativeSelection> {
  const personas = await Promise.all(
    candidates.map((candidate) => evaluatePendingPaymentSalePersona(services, candidate)),
  );
  const selectedPersona =
    personas.find((persona) => persona.chromeLogin === "magic-link-ready" && persona.pendingPaymentSaleCount > 0) ??
    null;

  return {
    schemaVersion: "representative-commerce-state.pending-payment-sale-selector/v1",
    status: selectedPersona ? "ready" : "not-available",
    selectedPersonaAlias: selectedPersona?.personaAlias ?? null,
    checkedPersonaCount: personas.length,
    personas,
    evidencePolicy: "support-safe",
    sellerSalesPath: "/account/sales",
    selectedSaleRouteTemplate: selectedPersona ? "/account/sales/:orderId" : null,
    nextOperatorAction: selectedPersona
      ? "use-selected-private-login-open-sales-and-record-redacted-pending-payment-uat"
      : "refresh-representative-state-and-rerun-selector",
  };
}

async function evaluateChromeUatPersona(
  services: Parameters<typeof selectChromeUatRepresentativePersona>[0],
  candidate: ChromeUatPersonaCandidate,
): Promise<ChromeUatPersonaReadiness> {
  const [login, payout, listing] = await Promise.all([
    readChromeLoginPosture(services.identityDb, candidate),
    readPayoutReadinessPosture(services.settlementDb, candidate.accountId),
    readListingPosture(services.marketplaceDb, candidate.accountId),
  ]);
  const inventory = await readInventoryPosture(
    services.inventoryDb,
    candidate.accountId,
    listing.representativeInventoryItemIds,
  );
  const blockerCategories: ChromeUatPersonaBlocker[] = [];

  if (!login.magicLinkReady) {
    blockerCategories.push("chrome-login-not-ready");
  }
  if (!payout.ready) {
    blockerCategories.push("payout-not-ready");
  }
  if (inventory.inventoryItemCount < 1) {
    blockerCategories.push("owned-inventory-missing");
  }
  if (listing.activeListingCount < 1) {
    blockerCategories.push("owned-active-listing-missing");
  }

  return {
    personaAlias: candidate.alias,
    chromeLogin: login.magicLinkReady ? "magic-link-ready" : "not-ready",
    payoutReadiness: payout.ready ? "ready" : "not-ready",
    listingState:
      listing.mutableListingCount > 0 && listing.activeListingCount > 0 && inventory.inventoryItemCount > 0
        ? "owned-mutable"
        : "missing",
    activeListingCount: listing.activeListingCount,
    mutableListingCount: listing.mutableListingCount,
    inventoryItemCount: inventory.inventoryItemCount,
    blockerCategories,
  };
}

function hasOnlyPayoutBlocker(persona: ChromeUatPersonaReadiness): boolean {
  return persona.blockerCategories.length === 1 && persona.blockerCategories[0] === "payout-not-ready";
}

async function evaluatePendingPaymentSalePersona(
  services: Parameters<typeof selectPendingPaymentSaleRepresentativePersona>[0],
  candidate: ChromeUatPersonaCandidate,
): Promise<PendingPaymentSaleRepresentativeSelection["personas"][number]> {
  const [login, sale] = await Promise.all([
    readChromeLoginPosture(services.identityDb, candidate),
    readPendingPaymentSalePosture(services.orderingDb, candidate.accountId),
  ]);

  return {
    personaAlias: candidate.alias,
    chromeLogin: login.magicLinkReady ? "magic-link-ready" : "not-ready",
    pendingPaymentSaleCount: sale.pendingPaymentSaleCount,
    pendingPaymentOfferAcceptanceSaleCount: sale.pendingPaymentOfferAcceptanceSaleCount,
  };
}

async function readChromeLoginPosture(
  db: Pick<PgQueryable, "query">,
  candidate: ChromeUatPersonaCandidate,
): Promise<Readonly<{ magicLinkReady: boolean }>> {
  const result = await db.query<{
    account_ready: boolean;
    membership_ready: boolean;
    magic_link_ready: boolean;
  }>(
    `SELECT
       EXISTS (
         SELECT 1
         FROM identity_accounts
         WHERE account_id = $1
           AND status = 'active'
       ) AS account_ready,
       EXISTS (
         SELECT 1
         FROM identity_memberships
         WHERE account_id = $1
           AND user_id = $2
           AND status = 'active'
       ) AS membership_ready,
       EXISTS (
         SELECT 1
         FROM identity_users
         WHERE user_id = $2
           AND status = 'active'
           AND auth_methods ? 'magic-link'
       ) AS magic_link_ready`,
    [candidate.accountId, candidate.userId],
  );
  const row = result.rows[0];

  return {
    magicLinkReady: Boolean(row?.account_ready && row.membership_ready && row.magic_link_ready),
  };
}

async function readPayoutReadinessPosture(
  db: Pick<PgQueryable, "query">,
  accountId: string,
): Promise<Readonly<{ ready: boolean }>> {
  const result = await db.query<{
    status: string;
    has_provider_reference: boolean;
    onboarding_status: string;
    payout_capability_status: string;
    payout_destination_status: string;
  }>(
    `SELECT
       status,
       provider_reference IS NOT NULL AS has_provider_reference,
       onboarding_status,
       payout_capability_status,
       payout_destination_status
     FROM settlement_payout_readiness_pages
     WHERE account_id = $1`,
    [accountId],
  );
  const row = result.rows[0];

  return {
    ready: Boolean(
      row?.status === "ready" &&
      row.has_provider_reference &&
      row.onboarding_status === "complete" &&
      row.payout_capability_status === "active" &&
      row.payout_destination_status === "ready",
    ),
  };
}

async function readPendingPaymentSalePosture(
  db: Pick<PgQueryable, "query">,
  sellerAccountId: string,
): Promise<Readonly<{ pendingPaymentSaleCount: number; pendingPaymentOfferAcceptanceSaleCount: number }>> {
  const result = await db.query<{
    pending_payment_sale_count: number | string | null;
    pending_payment_offer_acceptance_sale_count: number | string | null;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending-payment')::int AS pending_payment_sale_count,
       COUNT(*) FILTER (WHERE status = 'pending-payment' AND source_type = 'offer-acceptance')::int
         AS pending_payment_offer_acceptance_sale_count
     FROM ordering_order_pages
     WHERE seller_account_id = $1`,
    [sellerAccountId],
  );
  const row = result.rows[0];

  return {
    pendingPaymentSaleCount: normalizeCount(row?.pending_payment_sale_count),
    pendingPaymentOfferAcceptanceSaleCount: normalizeCount(row?.pending_payment_offer_acceptance_sale_count),
  };
}

async function readListingPosture(
  db: Pick<PgQueryable, "query">,
  accountId: string,
): Promise<
  Readonly<{
    activeListingCount: number;
    mutableListingCount: number;
    representativeInventoryItemIds: readonly string[];
  }>
> {
  const result = await db.query<{
    active_listing_count: number | string | null;
    mutable_listing_count: number | string | null;
    representative_inventory_item_ids: string[] | null;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active')::int AS active_listing_count,
       COUNT(*) FILTER (WHERE status IN ('active', 'draft', 'paused'))::int AS mutable_listing_count,
       COALESCE(
         array_agg(DISTINCT inventory_item_id)
           FILTER (WHERE status IN ('active', 'draft', 'paused') AND inventory_item_id IS NOT NULL),
         ARRAY[]::text[]
       ) AS representative_inventory_item_ids
     FROM marketplace_listing_pages
     WHERE account_id = $1
       AND listing_id LIKE 'lst$_repr$_%' ESCAPE '$'`,
    [accountId],
  );
  const row = result.rows[0];

  return {
    activeListingCount: normalizeCount(row?.active_listing_count),
    mutableListingCount: normalizeCount(row?.mutable_listing_count),
    representativeInventoryItemIds: normalizeTextArray(row?.representative_inventory_item_ids),
  };
}

async function readInventoryPosture(
  db: Pick<PgQueryable, "query">,
  accountId: string,
  representativeInventoryItemIds: readonly string[],
): Promise<Readonly<{ inventoryItemCount: number }>> {
  if (representativeInventoryItemIds.length > 0) {
    const result = await db.query<{ inventory_item_count: number | string | null }>(
      `SELECT COUNT(*)::int AS inventory_item_count
       FROM inventory_items
       WHERE account_id = $1
         AND item_id = ANY($2::text[])
         AND total_quantity > 0`,
      [accountId, representativeInventoryItemIds],
    );

    return { inventoryItemCount: normalizeCount(result.rows[0]?.inventory_item_count) };
  }

  const result = await db.query<{ inventory_item_count: number | string | null }>(
    `SELECT COUNT(*)::int AS inventory_item_count
     FROM inventory_items
     WHERE account_id = $1
       AND (
         item_id LIKE 'inv$_repr$_%' ESCAPE '$'
         OR item_id LIKE 'inv$_listing$_stock$_%' ESCAPE '$'
       )
       AND total_quantity > 0`,
    [accountId],
  );

  return { inventoryItemCount: normalizeCount(result.rows[0]?.inventory_item_count) };
}

function normalizeTextArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function normalizeCount(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? "0"), 10);

  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runRepresentativeCommerceState().catch((error) => {
    console.error("Representative commerce state refresh failed.", error);
    process.exit(1);
  });
}
