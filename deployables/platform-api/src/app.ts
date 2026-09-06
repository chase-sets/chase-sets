import { Hono, type Context, type Next } from "hono";
import { module as authModule } from "@chase-sets/auth";
import {
  createUcpOAuthMetadataRoutes,
  createUcpOAuthRoutes,
  UCP_OAUTH_SUPPORTED_SCOPES,
} from "@chase-sets/auth/server";
import {
  createCheckoutUcpHandlers,
  lookupCheckoutSupportReference,
  type CheckoutSupportLookupResult,
} from "@chase-sets/checkout/server";
import type { SavedListInventoryImportBatchCreator } from "@chase-sets/collections/server";
import {
  authenticityFeePolicy,
  checkoutProcessingFeePolicy,
  marketplaceSalesFeeSchedulePolicy,
  createAuthenticityFeePolicyResolver,
  createCheckoutProcessingFeePolicyResolver,
  createCommercialTermsResolver,
  createStandardScheduleResolver,
  type CommercialTermsAccountSource,
} from "@chase-sets/commercial-terms/server";
import {
  createDiscoveryUcpHandlers,
  discoveryRealtimeManifest,
  discoveryRealtimeTopicPolicyManifest,
} from "@chase-sets/discovery/server";
import {
  catalogRealtimeManifest,
  catalogRealtimeTopicPolicyManifest,
  resolveCatalogProductSelection,
} from "@chase-sets/catalog/server";
import type { SavedListProductCatalog } from "@chase-sets/collections/server";
import { pricingRealtimeManifest } from "@chase-sets/pricing/server";
import { module as identityModule } from "@chase-sets/identity";
import { createIdentityTermsAcceptanceResolver, identityTermsOfServicePolicy } from "@chase-sets/identity/server";
import {
  createImportResolutionAttentionSourceFromReadModel,
  createInventoryHoldCleanupAuthorityForPool,
  type InventoryDraftListingCreator,
  type InventorySavedListImportBatchCreator,
} from "@chase-sets/inventory/server";
import {
  createOrderingUcpHandlers,
  lookupOrderBySupportId,
  lookupOrderBySupportReference,
  type OrderingInventoryCleanupAuthorityCapability,
  type OrderingSupportLookupRow,
} from "@chase-sets/ordering/server";
import {
  createShipByAttentionSourceFromReadModel,
  lookupShipmentBySupportId,
  lookupShipmentBySupportReference,
  type FulfillmentSupportLookupRow,
} from "@chase-sets/fulfillment/server";
import {
  createPaymentsUcpHandoff,
  type PaymentsServices,
  type UcpAp2MandateVerifier,
} from "@chase-sets/payments/server";
import {
  getLockedFeeListingCohortSummary,
  marketplaceListingGatePolicy,
  marketplaceRealtimeManifest,
  marketplaceRealtimeTopicPolicyManifest,
  marketplaceSellerBehavioralMetricsPolicy,
} from "@chase-sets/marketplace/server";
import {
  createRateLimitPolicyResolver,
  type OfferEconomicsCrossContextPort,
  rateLimitPolicy,
  type OpsMarketAnalyticsCrossContextPort,
  type PolicyConsoleCrossContextPort,
  type PolicyConsoleWritePort,
  type SupportReferenceLookupCrossContextPort,
  type SupportReferenceLookupResult,
  supportDeadlinePolicy,
} from "@chase-sets/platform-operations/server";
import {
  betaWavePolicy,
  findAdmittedWaitlistSignupByEmail,
  type PublicPolicySource,
} from "@chase-sets/public-presence/server";
import {
  getPlatformGmvSeries,
  getPlatformKpiSummary,
  getPlatformLiquiditySummary,
  getSellerCohortGmvSummary,
  getSellerCohortWeeklyGmv,
  getTopCatalogItemsByGmv,
  marketAnalyticsDisplayPolicy,
  marketEstimatePolicy,
  marketStatHygienePolicy,
  repricingEnginePolicy,
} from "@chase-sets/pricing/server";
import {
  createBlockedPayoutAttentionSourceFromReadModel,
  createSettlementBalanceCreditResolver,
  createSettlementWalletSpendHoldPort,
  getProtectionReserveSummary,
  lookupPayoutBySupportId,
  lookupPayoutBySupportReference,
  lookupWalletAdjustmentBySupportId,
  lookupWalletAdjustmentBySupportReference,
  settlementClearancePolicy,
  settlementPayoutBoundsPolicy,
  type SettlementSupportLookupRow,
  type SettlementWalletAdjustmentSupportLookupRow,
} from "@chase-sets/settlement/server";
import {
  attachApiMountMiddleware,
  assertApiRouteTableHasNoCollisions,
  attachReadConsistencyMiddleware,
  attachWriteConsistencyMiddleware,
  mountApiRouters,
  type ReadConsistencyAuditRecord,
  type ReadConsistencyMiddlewareOptions,
} from "@chase-sets/bounded-context-runtime";
import {
  createHonoObservabilityMiddleware,
  recordProjectionFreshnessAudit,
  recordProjectionInlineApplyOutcome,
} from "@chase-sets/observability";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  createHealthRoutes,
  type HealthProjectionReplaySummary,
  type ReadinessCheck,
} from "@chase-sets/platform-runtime/health";
import { createApiHost, resolveApiHostMounts, type ApiHostRuntime } from "@chase-sets/platform-runtime/api";
import {
  createEvidenceWindowRegistrationRoutes,
  type EvidenceWindowRoutesOptions,
  type PlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import {
  buildMcpHandlersFromModules,
  createMcpOAuthProtectedResourceMetadataRoutes,
  createMcpRoutes,
  type CreateMcpRoutesOptions,
} from "@chase-sets/platform-runtime/mcp";
import {
  createProjectionOperationsRoutes,
  type ProjectionWakeStatusWorkSignalStore,
} from "@chase-sets/platform-runtime/projection-operations-routes";
import {
  createUcpMcpRoutes,
  createUcpProfileRoutes,
  createUcpRestRoutes,
  addUcpAp2MerchantAuthorization,
  type CreateUcpRoutesOptions,
} from "@chase-sets/platform-runtime/ucp";
import type { AgentGrantConsentDirectory, AgentGrantSpendPolicy } from "@chase-sets/platform-runtime/agent-guardrails";
import type { AgentGrantActivityDirectory } from "@chase-sets/platform-runtime/mcp-audit-log";
import {
  createRealtimeStatusSnapshot,
  createRealtimeRoutes,
  composeRealtimeTopicPolicyManifest,
  type RealtimeCursorSigningKeySet,
  type RealtimeObserver,
  type RealtimeResourceLimits,
  type RealtimeRouteTuning,
} from "@chase-sets/platform-runtime/realtime";
import {
  createIdentityAuthMiddleware,
  createPlatformActorMiddleware,
  type AnonymousRouteDeclaration,
  type PlatformActorResolver,
  type TenantContextEnv,
} from "./middleware/auth-context";
import type { PlatformApiRuntimeProfile } from "@chase-sets/platform-runtime/runtime-profiles";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import { authenticationRequiredResponse, forbiddenResponse } from "@chase-sets/http/responses";
import type { PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import { listActivePolicyDocuments } from "@chase-sets/platform-policy/queries";
import type { JsonValue } from "@chase-sets/primitives/json";
import { apiContextRegistry } from "./generated/api-context-registry";

export type PlatformIdentityServices = Readonly<{
  auth: ReturnType<typeof authModule.createServices>;
  identity: ReturnType<typeof identityModule.createServices>;
}>;

export type BuildPlatformApiOptions = Readonly<{
  runtimeProfile?: PlatformApiRuntimeProfile;
  getProjectionReplay?: () => HealthProjectionReplaySummary | Promise<HealthProjectionReplaySummary>;
  readinessChecks?: readonly ReadinessCheck[];
  resolveActor?: PlatformActorResolver;
  realtimeObserver?: RealtimeObserver;
  realtimeResourceLimits?: RealtimeResourceLimits;
  realtimeRouteTuning?: RealtimeRouteTuning;
  realtimeCursorSigningSecret?: string;
  realtimeCursorSigningKeys?: RealtimeCursorSigningKeySet;
  realtimeStreamLimiter?: Parameters<typeof createRealtimeRoutes>[0]["streamLimiter"];
  realtimeWakeSignal?: Parameters<typeof createRealtimeRoutes>[0]["wakeSignal"];
  realtimeActiveConnectionCount?: () => number;
  isDraining?: () => boolean;
  mcp?: CreateMcpRoutesOptions;
  ucp?: CreateUcpRoutesOptions;
  agentGrantSpendPolicy?: AgentGrantSpendPolicy;
  agentGrantConsent?: AgentGrantConsentDirectory;
  agentGrantActivity?: AgentGrantActivityDirectory;
  ucpAp2MandateVerifier?: UcpAp2MandateVerifier;
  internalAuthSecret?: string;
  adminRegistrationEnabled?: boolean;
  controlPlane?: PlatformControlPlane;
  evidenceWindowRegistration?: EvidenceWindowRoutesOptions;
  workSignalStore?: ProjectionWakeStatusWorkSignalStore;
  readConsistencyAuditLogger?: Readonly<{
    info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  }>;
  readConsistency?: Pick<
    ReadConsistencyMiddlewareOptions,
    "timeoutMs" | "pollIntervalMs" | "exactDependencyMode" | "routeTuning" | "workSignalGateway"
  >;
  projectionInlineApplyEnabled?: boolean;
}>;

export function createPlatformApiHost(
  options: Parameters<typeof createApiHost>[2] &
    Readonly<{
      runtimeProfile?: PlatformApiRuntimeProfile;
    }>,
): ApiHostRuntime {
  let runtime: ApiHostRuntime | null = null;
  const runtimeProfile = options.runtimeProfile ?? "public";
  const commercialTermsPool = getPlatformApiPool(options.pools["commercial-terms"]);
  const identityPool = getPlatformApiPool(options.pools.identity);
  const settlementPool = getPlatformApiPool(options.pools.settlement);
  const platformOperationsPool = getPlatformApiPool(options.pools["platform-operations"]);
  const marketplacePool = getPlatformApiPool(options.pools.marketplace);
  const inventoryPool = getPlatformApiPool(options.pools.inventory);
  const checkoutPool = getPlatformApiPool(options.pools.checkout);
  const catalogPool = getPlatformApiPool(options.pools.catalog);
  const orderingPool = getPlatformApiPool(options.pools.ordering);
  const fulfillmentPool = getPlatformApiPool(options.pools.fulfillment);
  const pricingPool = getPlatformApiPool(options.pools.pricing);
  const publicPresencePool = getPlatformApiPool(options.pools["public-presence"]);
  const sellerAttentionSources = [
    ...(fulfillmentPool ? [createShipByAttentionSourceFromReadModel(fulfillmentPool)] : []),
    ...(inventoryPool ? [createImportResolutionAttentionSourceFromReadModel(inventoryPool)] : []),
    ...(settlementPool ? [createBlockedPayoutAttentionSourceFromReadModel(settlementPool)] : []),
  ];
  const opsMarketAnalyticsCrossContext: OpsMarketAnalyticsCrossContextPort | undefined = pricingPool
    ? {
        getPlatformGmvSeries: (params) => getPlatformGmvSeries(pricingPool, params),
        getPlatformKpiSummary: (params) => getPlatformKpiSummary(pricingPool, params),
        getPlatformLiquiditySummary: (params) => getPlatformLiquiditySummary(pricingPool, params),
        getTopCatalogItemsByGmv: (params) => getTopCatalogItemsByGmv(pricingPool, params),
      }
    : undefined;
  const commercialTermsResolver = commercialTermsPool
    ? createCommercialTermsResolver({
        db: commercialTermsPool,
        accountSource: createIdentityCommercialTermsAccountSource(
          () => runtime?.services.identity as ReturnType<typeof identityModule.createServices> | undefined,
        ),
      })
    : undefined;
  const standardScheduleResolver = commercialTermsPool
    ? createStandardScheduleResolver(commercialTermsPool)
    : undefined;
  // Offer-economics monitor: locked-fee cohort (marketplace) + cohort
  // GMV/platform GMV (pricing) + published standard schedule (commercial
  // terms) + protection reserve facts (settlement). Requires all four pools; degrades to the runtime's own
  // all-zero fallback (see offer-economics-runtime.ts) if any is absent
  // rather than partially wiring an inconsistent port.
  const offerEconomicsCrossContext: OfferEconomicsCrossContextPort | undefined =
    marketplacePool && pricingPool && settlementPool && standardScheduleResolver
      ? {
          getLockedFeeListingCohortSummary: (params) => getLockedFeeListingCohortSummary(marketplacePool, params),
          getSellerCohortGmvSummary: (params) => getSellerCohortGmvSummary(pricingPool, params),
          getSellerCohortWeeklyGmv: (params) => getSellerCohortWeeklyGmv(pricingPool, params),
          getPlatformGmvSummary: async (params) => {
            const summary = await getPlatformKpiSummary(pricingPool, params);
            return { gmvAmount: summary.gmvAmount };
          },
          resolveStandardScheduleTerms: (params) => standardScheduleResolver.resolveStandardScheduleTerms(params),
          getProtectionReserveSummary: (params) => getProtectionReserveSummary(settlementPool, params),
        }
      : undefined;
  const termsAcceptanceResolver = identityPool ? createIdentityTermsAcceptanceResolver(identityPool) : undefined;
  const balanceCreditResolver = settlementPool
    ? createSettlementBalanceCreditResolver(settlementPool, {
        termsAcceptanceResolver,
        // Wallet write port so checkout reserves applied balance authoritatively
        // and concurrent checkouts cannot double-spend wallet credit.
        walletSpendHolds: createSettlementWalletSpendHoldPort(settlementPool),
      })
    : undefined;
  const checkoutProcessingFeePolicyResolver = commercialTermsPool
    ? createCheckoutProcessingFeePolicyResolver(commercialTermsPool)
    : undefined;
  const authenticityFeePolicyResolver = commercialTermsPool
    ? createAuthenticityFeePolicyResolver(commercialTermsPool)
    : undefined;
  const rateLimitPolicyResolver = platformOperationsPool
    ? createRateLimitPolicyResolver(platformOperationsPool)
    : undefined;
  const savedListProductCatalog: SavedListProductCatalog | undefined = catalogPool
    ? {
        resolveProduct: async (selection) => {
          const resolved = await resolveCatalogProductSelection(catalogPool, selection);
          return {
            availability: resolved.availability,
            product: resolved.product
              ? {
                  catalogItemId: resolved.product.catalogItemId,
                  productId: resolved.product.productId,
                  selectedOptions: resolved.product.selectedOptions,
                }
              : null,
          };
        },
      }
    : undefined;
  const configuredRegistrationAdmission = (options.hostPorts as Record<string, unknown> | undefined)
    ?.registrationAdmission as Record<string, unknown> | undefined;
  const registrationAdmission = {
    ...(configuredRegistrationAdmission ?? {}),
    ...(publicPresencePool
      ? {
          findAdmittedWaitlistSignupByEmail: (email: string) =>
            findAdmittedWaitlistSignupByEmail(publicPresencePool, email),
        }
      : {}),
  };
  const policyConsoleCrossContextSources: PolicyConsoleCrossContextPort["sources"][number][] = [];
  if (identityPool) {
    policyConsoleCrossContextSources.push({
      contextName: "identity",
      db: identityPool,
      definitions: [identityTermsOfServicePolicy] as unknown as readonly PolicyDefinition<JsonValue>[],
      write: lazyPolicyConsoleWritePort(
        () => runtime?.services.identity as { policies?: PolicyConsoleWritePort } | undefined,
      ),
    });
  }
  if (settlementPool) {
    policyConsoleCrossContextSources.push({
      contextName: "settlement",
      db: settlementPool,
      definitions: [
        settlementClearancePolicy,
        settlementPayoutBoundsPolicy,
      ] as unknown as readonly PolicyDefinition<JsonValue>[],
      write: lazyPolicyConsoleWritePort(
        () => runtime?.services.settlement as { policies?: PolicyConsoleWritePort } | undefined,
      ),
    });
  }
  if (commercialTermsPool) {
    policyConsoleCrossContextSources.push({
      contextName: "commercial-terms",
      db: commercialTermsPool,
      definitions: [
        marketplaceSalesFeeSchedulePolicy,
        checkoutProcessingFeePolicy,
        authenticityFeePolicy,
      ] as unknown as readonly PolicyDefinition<JsonValue>[],
      write: lazyPolicyConsoleWritePort(
        () => runtime?.services["commercial-terms"] as { policies?: PolicyConsoleWritePort } | undefined,
      ),
    });
  }
  if (marketplacePool) {
    policyConsoleCrossContextSources.push({
      contextName: "marketplace",
      db: marketplacePool,
      definitions: [
        marketplaceListingGatePolicy,
        marketplaceSellerBehavioralMetricsPolicy,
      ] as unknown as readonly PolicyDefinition<JsonValue>[],
      write: lazyPolicyConsoleWritePort(
        () => runtime?.services.marketplace as { policies?: PolicyConsoleWritePort } | undefined,
      ),
    });
  }
  if (pricingPool) {
    policyConsoleCrossContextSources.push({
      contextName: "pricing",
      db: pricingPool,
      definitions: [
        marketStatHygienePolicy,
        marketAnalyticsDisplayPolicy,
        marketEstimatePolicy,
        repricingEnginePolicy,
      ] as unknown as readonly PolicyDefinition<JsonValue>[],
      write: lazyPolicyConsoleWritePort(
        () => runtime?.services.pricing as { policies?: PolicyConsoleWritePort } | undefined,
      ),
    });
  }
  if (publicPresencePool) {
    policyConsoleCrossContextSources.push({
      contextName: "public-presence",
      db: publicPresencePool,
      definitions: [betaWavePolicy] as unknown as readonly PolicyDefinition<JsonValue>[],
      write: lazyPolicyConsoleWritePort(
        () => runtime?.services["public-presence"] as { policies?: PolicyConsoleWritePort } | undefined,
      ),
    });
  }
  const policyConsoleCrossContext: PolicyConsoleCrossContextPort | undefined =
    policyConsoleCrossContextSources.length > 0 ? { sources: policyConsoleCrossContextSources } : undefined;
  const publicPolicySources: PublicPolicySource[] = [];
  if (commercialTermsPool) {
    publicPolicySources.push(
      createPublicPolicySource(commercialTermsPool, marketplaceSalesFeeSchedulePolicy),
      createPublicPolicySource(commercialTermsPool, checkoutProcessingFeePolicy),
    );
  }
  if (settlementPool) {
    publicPolicySources.push(
      createPublicPolicySource(settlementPool, settlementClearancePolicy),
      createPublicPolicySource(settlementPool, settlementPayoutBoundsPolicy),
    );
  }
  if (platformOperationsPool) {
    publicPolicySources.push(
      createPublicPolicySource(platformOperationsPool, rateLimitPolicy),
      createPublicPolicySource(platformOperationsPool, supportDeadlinePolicy),
    );
  }
  const supportReferenceLookupCrossContextSources: SupportReferenceLookupCrossContextPort["sources"][number][] = [];
  if (orderingPool) {
    supportReferenceLookupCrossContextSources.push({
      contextName: "ordering",
      lookupByReference: async (reference) =>
        adaptOrderingSupportLookup(await lookupOrderBySupportReference(orderingPool, reference)),
      lookupById: async (id) => adaptOrderingSupportLookup(await lookupOrderBySupportId(orderingPool, id)),
    });
  }
  if (fulfillmentPool) {
    supportReferenceLookupCrossContextSources.push({
      contextName: "fulfillment",
      lookupByReference: async (reference) =>
        adaptFulfillmentSupportLookup(await lookupShipmentBySupportReference(fulfillmentPool, reference)),
      lookupById: async (id) => adaptFulfillmentSupportLookup(await lookupShipmentBySupportId(fulfillmentPool, id)),
    });
  }
  if (settlementPool) {
    supportReferenceLookupCrossContextSources.push({
      contextName: "settlement",
      // Both payouts (PYO-/pyo_) and Wallet Adjustments (WAD-/wad_) route to
      // "settlement" -- the reference/id's own prefix disambiguates which
      // owned entity to resolve, so this dispatches on prefix rather than
      // needing two separate cross-context sources for one context name.
      lookupByReference: async (reference) =>
        reference.toUpperCase().startsWith("WAD-")
          ? adaptSettlementWalletAdjustmentSupportLookup(
              await lookupWalletAdjustmentBySupportReference(settlementPool, reference.toUpperCase()),
            )
          : adaptSettlementSupportLookup(await lookupPayoutBySupportReference(settlementPool, reference)),
      lookupById: async (id) =>
        id.toLowerCase().startsWith("wad_")
          ? adaptSettlementWalletAdjustmentSupportLookup(await lookupWalletAdjustmentBySupportId(settlementPool, id))
          : adaptSettlementSupportLookup(await lookupPayoutBySupportId(settlementPool, id)),
    });
  }
  if (checkoutPool) {
    supportReferenceLookupCrossContextSources.push({
      contextName: "checkout",
      // Checkout's own lookup already tries its buy-checkout and sell-list-confirmation
      // read models in turn; no raw-id form exists for CSG-/CS-SL- references, so this
      // source omits lookupById (the router only produces typed-id routes for ord_/shp_/pyo_).
      lookupByReference: async (reference) =>
        adaptCheckoutSupportLookup(await lookupCheckoutSupportReference(checkoutPool, reference)),
    });
  }
  const supportReferenceLookupCrossContext: SupportReferenceLookupCrossContextPort | undefined =
    supportReferenceLookupCrossContextSources.length > 0
      ? { sources: supportReferenceLookupCrossContextSources }
      : undefined;
  const draftListingCreator: InventoryDraftListingCreator = async (params, context) => {
    const marketplaceServices = runtime?.services.marketplace as
      | {
          listings?: {
            createBatchDraftListingFromInventorySnapshot?: InventoryDraftListingCreator;
          };
        }
      | undefined;
    const createDraft = marketplaceServices?.listings?.createBatchDraftListingFromInventorySnapshot;
    if (!createDraft) {
      throw new Error("Marketplace draft listing service is unavailable.");
    }

    return createDraft(params, context);
  };
  /**
   * Ordering's required cleanup-authority capability.
   *
   * Inventory's own implementation is bound to Ordering's own port type with
   * no cast and no placeholder, so a drift in either payload becomes a
   * typecheck error. Both variants are explicit: profiles that mount
   * Inventory get `available`; the source-only `landing` profile, where
   * Ordering's services are still constructed but Inventory has no pool,
   * states `not-mounted` rather than fabricating a stub.
   */
  const inventoryCleanupAuthority: OrderingInventoryCleanupAuthorityCapability = inventoryPool
    ? { kind: "available", port: createInventoryHoldCleanupAuthorityForPool(inventoryPool) }
    : { kind: "not-mounted" };
  const inventorySavedListImportBatchCreator: SavedListInventoryImportBatchCreator = async (params, context) => {
    const inventoryServices = runtime?.services.inventory as
      | {
          importBatches?: {
            createSavedListImportBatch?: InventorySavedListImportBatchCreator;
          };
        }
      | undefined;
    const createBatch = inventoryServices?.importBatches?.createSavedListImportBatch;
    if (!createBatch) {
      throw new Error("Inventory Saved List import service is unavailable.");
    }

    return createBatch(params, context);
  };

  runtime = createApiHost(apiContextRegistry, "platform-api", {
    ...options,
    runtimeProfile,
    hostPorts: {
      ...options.hostPorts,
      ...(commercialTermsResolver ? { commercialTermsResolver } : {}),
      ...(balanceCreditResolver ? { balanceCreditResolver } : {}),
      ...(checkoutProcessingFeePolicyResolver ? { checkoutProcessingFeePolicyResolver } : {}),
      ...(authenticityFeePolicyResolver ? { authenticityFeePolicyResolver } : {}),
      ...(rateLimitPolicyResolver ? { rateLimitPolicyResolver } : {}),
      ...(savedListProductCatalog ? { savedListProductCatalog } : {}),
      registrationAdmission,
      ...(policyConsoleCrossContext ? { policyConsoleCrossContext } : {}),
      ...(supportReferenceLookupCrossContext ? { supportReferenceLookupCrossContext } : {}),
      ...(opsMarketAnalyticsCrossContext ? { opsMarketAnalyticsCrossContext } : {}),
      ...(offerEconomicsCrossContext ? { offerEconomicsCrossContext } : {}),
      sellerAttentionSources,
      publicPolicySources,
      draftListingCreator,
      inventoryCleanupAuthority,
      inventorySavedListImportBatchCreator,
    },
  });
  return runtime;
}

function createPublicPolicySource<Value>(
  db: PgTransactionalPool,
  definition: PolicyDefinition<Value>,
): PublicPolicySource {
  return {
    policyKey: definition.policyKey,
    read: async (at) => {
      // A fresh resolver per public read prevents a long-lived SSR cache from
      // outliving the documented CDN propagation window.
      const current = await createPolicyResolver({ db }).resolvePolicy(definition, { at });
      const candidates = await listActivePolicyDocuments(db, definition.policyKey);
      return {
        current: { value: current.value, effectiveFrom: current.effectiveFrom },
        upcoming: candidates
          .filter((candidate) => Date.parse(candidate.effective_from) > Date.parse(at))
          .map((candidate) => ({
            value: definition.decodeValue(candidate.value as JsonValue),
            effectiveFrom: candidate.effective_from,
            effectiveUntil: candidate.effective_until,
          })),
      };
    },
  };
}

function getPlatformApiPool(value: unknown): PgTransactionalPool | undefined {
  return value && typeof value === "object" && "query" in value ? (value as PgTransactionalPool) : undefined;
}

/**
 * Lazily proxies to a cross-context policy console write port that only
 * exists once `createApiHost` has returned and `runtime.services` is
 * populated (host ports are needed before that point). Reusing the owning
 * context's own already-running `PolicyRuntime` -- rather than building a
 * second one bound to the same pool -- keeps the console's writes and that
 * context's own resolvers sharing one push-invalidated cache.
 */
function lazyPolicyConsoleWritePort(
  getServices: () => { policies?: PolicyConsoleWritePort } | undefined,
): PolicyConsoleWritePort {
  function requirePolicies(): PolicyConsoleWritePort {
    const policies = getServices()?.policies;
    if (!policies) {
      throw new Error("Cross-context policy runtime is unavailable.");
    }
    return policies;
  }

  return {
    createPolicyDocument: (definition, params, context) =>
      requirePolicies().createPolicyDocument(definition, params, context),
    revisePolicyDocument: (definition, documentId, params, context) =>
      requirePolicies().revisePolicyDocument(definition, documentId, params, context),
    resolvePolicy: (definition, params) => requirePolicies().resolvePolicy(definition, params),
  };
}

/**
 * Adapts each context's own support-lookup row/result shape into the
 * unified support-reference lookup's generic, redacted
 * `SupportReferenceLookupResult`. Kept here -- not in Platform
 * Operations -- because only the composition root imports every source
 * context's domain types; Platform Operations' own `allowedContextDependencies`
 * stays empty.
 */
function adaptOrderingSupportLookup(row: OrderingSupportLookupRow | null): SupportReferenceLookupResult | null {
  if (!row) {
    return null;
  }

  return {
    contextName: "ordering",
    entityType: "order",
    displayReference: row.display_reference || null,
    status: row.status,
    summary: `Order ${row.display_reference || row.order_id}`,
    adminHref: null,
  };
}

function adaptFulfillmentSupportLookup(row: FulfillmentSupportLookupRow | null): SupportReferenceLookupResult | null {
  if (!row) {
    return null;
  }

  return {
    contextName: "fulfillment",
    entityType: "shipment",
    displayReference: row.display_reference || null,
    status: row.status,
    summary: `Shipment ${row.display_reference || row.shipment_id}`,
    adminHref: null,
  };
}

function adaptSettlementSupportLookup(row: SettlementSupportLookupRow | null): SupportReferenceLookupResult | null {
  if (!row) {
    return null;
  }

  return {
    contextName: "settlement",
    entityType: "payout",
    displayReference: row.display_reference || null,
    status: row.status,
    summary: `Payout ${row.display_reference || row.payout_id}`,
    adminHref: null,
  };
}

function adaptSettlementWalletAdjustmentSupportLookup(
  row: SettlementWalletAdjustmentSupportLookupRow | null,
): SupportReferenceLookupResult | null {
  if (!row) {
    return null;
  }

  return {
    contextName: "settlement",
    entityType: "wallet-adjustment",
    displayReference: row.display_reference || null,
    status: row.status,
    summary: `Wallet adjustment ${row.display_reference || row.adjustment_id}`,
    adminHref: null,
  };
}

function adaptCheckoutSupportLookup(result: CheckoutSupportLookupResult | null): SupportReferenceLookupResult | null {
  if (!result) {
    return null;
  }

  return {
    contextName: "checkout",
    entityType: result.type,
    displayReference: result.supportReference,
    status: result.state,
    summary:
      result.type === "buy-checkout-session"
        ? `Checkout session ${result.supportReference}`
        : `Sell list confirmation ${result.supportReference}`,
    adminHref: null,
  };
}

function createIdentityCommercialTermsAccountSource(
  getIdentityServices: () => ReturnType<typeof identityModule.createServices> | undefined,
): CommercialTermsAccountSource {
  return {
    getAccount: async (accountId) => {
      const account = await getIdentityServices()?.accounts.getAccountState(accountId);
      if (!account?.id || !account.accountType) {
        return null;
      }

      return {
        account_id: String(account.id),
        account_type: account.accountType,
        status: account.status,
        founders_window_started_at: account.foundersWindow?.startedAt ?? null,
        founders_window_ends_at: account.foundersWindow?.endsAt ?? null,
      };
    },
  };
}

export function buildPlatformApiApp(runtime: ApiHostRuntime, options: BuildPlatformApiOptions = {}) {
  const app = new Hono<TenantContextEnv>();
  const runtimeProfile = options.runtimeProfile ?? "public";
  const marketplacePlatformRoutesEnabled = runtimeProfile !== "landing";
  const apiMounts = resolveApiHostMounts(runtime);
  const realtimeStores = runtime.mountedContexts
    .filter(
      (entry) =>
        entry.contextName === "catalog" ||
        entry.contextName === "discovery" ||
        entry.contextName === "marketplace" ||
        entry.contextName === "pricing",
    )
    .map((entry) => ({
      ...(entry.contextName === "catalog"
        ? catalogRealtimeManifest
        : entry.contextName === "discovery"
          ? discoveryRealtimeManifest
          : entry.contextName === "marketplace"
            ? marketplaceRealtimeManifest
            : pricingRealtimeManifest),
      contextName: entry.contextName,
      db: entry.pool,
    }));
  const realtimeTopicPolicyManifest = composeRealtimeTopicPolicyManifest([
    catalogRealtimeTopicPolicyManifest,
    discoveryRealtimeTopicPolicyManifest,
    marketplaceRealtimeTopicPolicyManifest,
  ]);
  const identityServices = {
    auth: runtime.services.auth as ReturnType<typeof authModule.createServices>,
    identity: runtime.services.identity as ReturnType<typeof identityModule.createServices>,
  } satisfies PlatformIdentityServices;
  const discoveryServices = runtime.services.discovery as
    | { items?: Parameters<typeof createDiscoveryUcpHandlers>[0] }
    | undefined;
  const discoveryUcpHandlers = discoveryServices?.items
    ? createDiscoveryUcpHandlers(discoveryServices.items)
    : undefined;
  const checkoutServices = runtime.services.checkout as Parameters<typeof createCheckoutUcpHandlers>[0] | undefined;
  const paymentsServices = runtime.services.payments as PaymentsServices | undefined;
  const paymentHandoff = isPaymentProcessorPublicConfig(paymentsServices?.publicConfig)
    ? createPaymentsUcpHandoff(paymentsServices.publicConfig, {
        ap2Verifier: options.ucpAp2MandateVerifier,
        merchantAuthorizationEnabled: Boolean(options.ucp?.businessSigningKeys),
      })
    : undefined;
  const checkoutUcpHandlers = checkoutServices?.sessions
    ? createCheckoutUcpHandlers(checkoutServices, {
        paymentHandoff,
        agentGrantSpendPolicy: options.agentGrantSpendPolicy,
        signCheckout: options.ucp?.businessSigningKeys
          ? (checkout) => addUcpAp2MerchantAuthorization(checkout, options.ucp?.businessSigningKeys)
          : undefined,
      })
    : undefined;
  const orderingServices = runtime.services.ordering as Parameters<typeof createOrderingUcpHandlers>[0] | undefined;
  const orderingUcpHandlers = orderingServices?.orders ? createOrderingUcpHandlers(orderingServices) : undefined;
  const moduleMcpHandlers = buildMcpHandlersFromModules(runtime.mountedModules);
  const mcpOptions = {
    ...options.mcp,
    agentGrantRateLimiter: options.mcp?.agentGrantRateLimiter ?? options.ucp?.agentGrantRateLimiter,
    toolHandlers: {
      ...moduleMcpHandlers.toolHandlers,
      ...options.mcp?.toolHandlers,
    },
    resourceHandlers: {
      ...moduleMcpHandlers.resourceHandlers,
      ...options.mcp?.resourceHandlers,
    },
  };
  const ucpOptions =
    discoveryUcpHandlers || checkoutUcpHandlers || orderingUcpHandlers
      ? {
          ...options.ucp,
          ap2Readiness: paymentHandoff
            ? {
                mandateVerification: paymentHandoff.payment.ap2.mandate_verification,
                sharedPaymentToken: paymentHandoff.payment.ap2.shared_payment_token,
                headlessCompletionEnabled: paymentHandoff.payment.ap2.headless_completion_enabled,
              }
            : undefined,
          restHandlers: {
            ...discoveryUcpHandlers?.restHandlers,
            ...checkoutUcpHandlers?.restHandlers,
            ...orderingUcpHandlers?.restHandlers,
            ...options.ucp?.restHandlers,
          },
          mcpToolHandlers: {
            ...discoveryUcpHandlers?.mcpToolHandlers,
            ...checkoutUcpHandlers?.mcpToolHandlers,
            ...orderingUcpHandlers?.mcpToolHandlers,
            ...options.ucp?.mcpToolHandlers,
          },
        }
      : options.ucp;
  const resolveActor = options.resolveActor ?? (async () => null);
  const anonymousRoutes = resolveAuthIdentityAnonymousRoutes(runtime);

  app.onError(errorHandler);
  app.use("*", createHonoObservabilityMiddleware());
  app.route(
    "/health",
    createHealthRoutes({
      getProjectionReplay: options.getProjectionReplay,
      readinessChecks: options.readinessChecks,
      isDraining: options.isDraining,
    }),
  );
  app.route(
    "/api/health",
    createHealthRoutes({
      getProjectionReplay: options.getProjectionReplay,
      readinessChecks: options.readinessChecks,
      isDraining: options.isDraining,
    }),
  );
  if (options.evidenceWindowRegistration) {
    app.route("/internal/evidence-windows", createEvidenceWindowRegistrationRoutes(options.evidenceWindowRegistration));
  }
  if (marketplacePlatformRoutesEnabled) {
    app.get("/internal/realtime/status", async (c) =>
      c.json(
        await createRealtimeStatusSnapshot({
          stores: realtimeStores,
          activeConnectionCount: options.realtimeActiveConnectionCount?.() ?? 0,
          wakeSignalConfigured: Boolean(options.realtimeWakeSignal),
          routeTuning: options.realtimeRouteTuning,
          resourceLimits: options.realtimeResourceLimits,
        }),
      ),
    );
  }

  const platformActorMiddleware = createPlatformActorMiddleware(resolveActor);
  app.use("/api/platform/projections", platformActorMiddleware);
  app.use("/api/platform/projections/*", platformActorMiddleware);
  app.route(
    "/api/platform/projections",
    createProjectionOperationsRoutes(runtime, {
      controlPlane: options.controlPlane,
      workSignalStore: options.workSignalStore,
    }),
  );
  if (marketplacePlatformRoutesEnabled) {
    app.use("/mcp", platformActorMiddleware);
    app.use("/mcp/*", platformActorMiddleware);
    app.route("/mcp", createMcpRoutes(mcpOptions));
    app.route("/.well-known", createUcpProfileRoutes(options.ucp));
    app.route("/.well-known", createUcpOAuthMetadataRoutes());
    app.route(
      "/.well-known",
      createMcpOAuthProtectedResourceMetadataRoutes({ scopesSupported: UCP_OAUTH_SUPPORTED_SCOPES }),
    );
    app.use("/ucp/oauth/*", platformActorMiddleware);
    app.route(
      "/ucp/oauth",
      createUcpOAuthRoutes({
        auth: identityServices.auth,
        linkedPlatformAuthorizations: identityServices.identity.linkedPlatformAuthorizations,
        resolveActor,
        agentGrantConsent: options.agentGrantConsent,
        agentGrantActivity: options.agentGrantActivity,
        agentWebhookOutbox: identityServices.auth.agentWebhookOutbox,
        revokeStoredPaymentMethodsForAgentGrant:
          paymentsServices?.payments?.revokeSavedCheckoutInstrumentsForAgentGrant,
      }),
    );
    app.use("/ucp/v1/*", platformActorMiddleware);
    app.use("/ucp/mcp", platformActorMiddleware);
    app.use("/ucp/mcp/*", platformActorMiddleware);
    app.route("/ucp/v1", createUcpRestRoutes(ucpOptions));
    app.route("/ucp/mcp", createUcpMcpRoutes(ucpOptions));
    app.route(
      "/api/realtime",
      createRealtimeRoutes({
        stores: realtimeStores,
        resolveActor,
        observer: options.realtimeObserver,
        wakeSignal: options.realtimeWakeSignal,
        streamLimiter: options.realtimeStreamLimiter,
        cursorSigningKeys: options.realtimeCursorSigningKeys ?? options.realtimeCursorSigningSecret,
        topicPolicyManifest: realtimeTopicPolicyManifest,
        isDraining: options.isDraining,
        ...options.realtimeRouteTuning,
        resourceLimits: options.realtimeResourceLimits ?? {
          maxTopicsPerStream: 16,
          maxActiveStreams: 1_000,
          maxActiveStreamsPerConnectionKey: 6,
        },
      }),
    );
  }

  if (runtimeProfile === "landing" && !options.adminRegistrationEnabled) {
    app.post("/api/auth/register", (c) =>
      c.json(
        {
          error: {
            code: "registration_disabled",
            message: "Admin registration is disabled.",
          },
        },
        403,
      ),
    );
  }

  attachApiMountMiddleware(
    app,
    apiMounts
      .filter((mount) => mount.contextName === "auth" || mount.contextName === "identity")
      .map((mount) => mount.mountPath),
    createIdentityAuthMiddleware(identityServices, {
      internalAuthSecret: options.internalAuthSecret,
      anonymousRoutes,
      resolveActor,
    }),
  );

  attachApiMountMiddleware(
    app,
    apiMounts
      .filter((mount) => mount.requiresAuth && mount.contextName !== "auth" && mount.contextName !== "identity")
      .map((mount) => mount.mountPath),
    platformActorMiddleware,
  );
  attachApiMountMiddleware(
    app,
    apiMounts.filter((mount) => mount.contextName === "catalog" && mount.requiresAuth).map((mount) => mount.mountPath),
    catalogApiPermissionMiddleware,
  );

  attachWriteConsistencyMiddleware(app, apiMounts, runtime.projectionGroups, {
    enabled: options.projectionInlineApplyEnabled ?? false,
    recordInlineApplyOutcome: recordProjectionInlineApplyOutcome,
  });
  attachReadConsistencyMiddleware(app, apiMounts, runtime.projectionGroups, {
    timeoutMs: options.readConsistency?.timeoutMs,
    pollIntervalMs: options.readConsistency?.pollIntervalMs,
    exactDependencyMode: options.readConsistency?.exactDependencyMode,
    routeTuning: options.readConsistency?.routeTuning,
    workSignalGateway: options.readConsistency?.workSignalGateway,
    recordReadConsistencyAudit: (record: ReadConsistencyAuditRecord) => {
      recordProjectionFreshnessAudit(record);
      options.readConsistencyAuditLogger?.info("Read-after-write freshness evaluated.", record);
    },
  });
  mountApiRouters(app, apiMounts);
  assertApiRouteTableHasNoCollisions(apiMounts);

  return app;
}

function resolveAuthIdentityAnonymousRoutes(runtime: ApiHostRuntime): readonly AnonymousRouteDeclaration[] {
  return runtime.mountedContexts
    .filter((entry) => entry.contextName === "auth" || entry.contextName === "identity")
    .flatMap((entry) => {
      const module = entry.module as Readonly<{ anonymousRoutes?: readonly AnonymousRouteDeclaration[] }>;
      return module.anonymousRoutes ?? [];
    });
}

async function catalogApiPermissionMiddleware(c: Context<TenantContextEnv>, next: Next): Promise<Response | void> {
  const actor = c.get("actor");
  if (!actor) {
    return c.json(authenticationRequiredResponse(), 401);
  }

  const method = c.req.method.toUpperCase();
  const requiredPermission =
    method === "GET" || method === "HEAD" || method === "OPTIONS" ? "catalog.view" : "catalog.manage";
  if (!actor.permissions.includes(requiredPermission)) {
    return c.json(forbiddenResponse(), 403);
  }

  await next();
}

function isPaymentProcessorPublicConfig(value: unknown): value is Parameters<typeof createPaymentsUcpHandoff>[0] {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { processorName?: unknown }).processorName === "string" &&
    (value as { confirmationExperience?: unknown }).confirmationExperience === "processor-managed-form"
  );
}
