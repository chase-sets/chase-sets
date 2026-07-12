import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { createPlatformFeedbackRuntime } from "../../features/platform-feedback/api/runtime";
import { createDashboardQueryService } from "../../features/insights-dashboards/read-model/queries";
import { createOpsDashboardRuntime } from "../../features/insights-dashboards/api/ops-runtime";
import type { OpsMarketAnalyticsCrossContextPort } from "../../features/insights-dashboards/api/ops-contracts";
import { createOfferEconomicsRuntime } from "../../features/offer-economics/api/offer-economics-runtime";
import type { OfferEconomicsCrossContextPort } from "../../features/offer-economics/api/offer-economics-contracts";
import { rateLimitPolicy } from "../../features/rate-limit-policy/domain/rate-limit-policy";
import { createReportedContentRuntime } from "../../features/reported-content/api/runtime";
import { createRiskAlertRuntime } from "../../features/risk-alerts/api/runtime";
import { supportDeadlinePolicy } from "../../features/support-requests/domain/support-deadline-policy";
import { createSupportRequestRuntime } from "../../features/support-requests/api/runtime";
import type { PolicyConsoleCrossContextPort, PolicyConsoleEntry } from "../../features/policy-console/api/contracts";
import { createSupportReferenceLookupRuntime } from "../../features/support-reference-lookup/api/runtime";
import type {
  SupportReferenceLookupCrossContextPort,
  SupportReferenceLookupSource,
} from "../../features/support-reference-lookup/api/contracts";
import {
  getSupportRequestByDisplayReference,
  getSupportRequestById,
} from "../../features/support-requests/read-model/queries";

export type PlatformOperationsHostPorts = Readonly<{
  notificationOutbox?: NotificationOutbox;
  /**
   * Cross-context policy sources for the platform policy console: Settlement
   * and Commercial Terms' declared policies, assembled once in the
   * `platform-api` composition root so this context never imports those
   * contexts' domain code directly (see `allowedContextDependencies` in
   * `context.json`).
   */
  policyConsoleCrossContext?: PolicyConsoleCrossContextPort;
  /**
   * Cross-context sources for the unified support-reference lookup:
   * Ordering, Fulfillment, Settlement, and Checkout's own reference lookups,
   * assembled once in the `platform-api` composition root so this context
   * never imports those contexts' domain code directly.
   */
  supportReferenceLookupCrossContext?: SupportReferenceLookupCrossContextPort;
  /**
   * Pricing's platform-wide GMV/liquidity reads for the ops dashboard,
   * assembled once in the `platform-api` composition root from
   * pricing's own exported query functions bound to pricing's pool -- this
   * context never queries `pricing_market_trades` or the rollup tables
   * directly (see `allowedContextDependencies` in `context.json`).
   */
  opsMarketAnalyticsCrossContext?: OpsMarketAnalyticsCrossContextPort;
  /**
   * Marketplace's 0%-locked-fee listing cohort, Pricing's cohort-scoped GMV
   * reads, and Commercial Terms' published standard schedule -- the
   * offer-economics monitor's three cross-context sources, all
   * assembled once in the `platform-api` composition root from those
   * contexts' own exported functions bound to their own pools.
   */
  offerEconomicsCrossContext?: OfferEconomicsCrossContextPort;
}>;

export type PlatformOperationsServices = Readonly<{
  db: PgTransactionalPool;
  insightsDashboards: ReturnType<typeof createDashboardQueryService>;
  opsDashboard: ReturnType<typeof createOpsDashboardRuntime>;
  offerEconomics: ReturnType<typeof createOfferEconomicsRuntime>;
  platformFeedback: ReturnType<typeof createPlatformFeedbackRuntime>;
  reportedContent: ReturnType<typeof createReportedContentRuntime>;
  riskAlerts: ReturnType<typeof createRiskAlertRuntime>;
  supportRequests: ReturnType<typeof createSupportRequestRuntime>;
  /** The shared platform-policy runtime, mounted for this context's `definePolicy` documents (the rate-limit policy and the support-flow deadline policy). */
  policies: PolicyRuntime;
  /** The platform policy console's full registry: this context's own two policies plus any injected cross-context ones. */
  policyConsoleEntries: readonly PolicyConsoleEntry[];
  /** The unified support-reference lookup, routing to whichever cross-context sources were injected. */
  supportReferenceLookup: ReturnType<typeof createSupportReferenceLookupRuntime>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createPlatformOperationsServices(
  pool: PgTransactionalPool,
  ports: PlatformOperationsHostPorts = {},
): PlatformOperationsServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({
      sourceContextName: "platform-operations",
    }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const platformFeedback = createPlatformFeedbackRuntime({
    eventStore,
    checkpointStore,
    db,
  });
  const reportedContent = createReportedContentRuntime({ db, eventStore });
  const riskAlerts = createRiskAlertRuntime({ db, eventStore });
  const notificationOutbox = ports.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const policies = createPolicyRuntime({ eventStore, db });
  const supportRequests = createSupportRequestRuntime({
    eventStore,
    checkpointStore,
    db,
    notificationOutbox,
    policies,
  });

  const ownPolicyDefinitions = [
    rateLimitPolicy,
    supportDeadlinePolicy,
  ] as unknown as readonly PolicyDefinition<JsonValue>[];
  const policyConsoleEntries: readonly PolicyConsoleEntry[] = [
    ...ownPolicyDefinitions.map(
      (definition): PolicyConsoleEntry => ({
        policyKey: definition.policyKey,
        contextName: "platform-operations",
        db,
        definition,
        write: policies,
      }),
    ),
    ...(ports.policyConsoleCrossContext?.sources ?? []).flatMap((source) =>
      source.definitions.map(
        (definition): PolicyConsoleEntry => ({
          policyKey: definition.policyKey,
          contextName: source.contextName,
          db: source.db,
          definition,
          write: source.write,
        }),
      ),
    ),
  ];

  const ownSupportReferenceLookup: SupportReferenceLookupSource = {
    contextName: "platform-operations",
    lookupByReference: async (reference) => {
      const row = await getSupportRequestByDisplayReference(db, reference);
      return row
        ? {
            contextName: "platform-operations",
            entityType: "support-case",
            displayReference: row.display_reference || null,
            status: row.status,
            summary: `Support case ${row.display_reference || row.support_request_id}`,
            adminHref: `/support/requests/${encodeURIComponent(row.support_request_id)}`,
          }
        : null;
    },
    lookupById: async (id) => {
      const row = await getSupportRequestById(db, id);
      return row
        ? {
            contextName: "platform-operations",
            entityType: "support-case",
            displayReference: row.display_reference || null,
            status: row.status,
            summary: `Support case ${row.display_reference || row.support_request_id}`,
            adminHref: `/support/requests/${encodeURIComponent(row.support_request_id)}`,
          }
        : null;
    },
  };
  const supportReferenceLookup = createSupportReferenceLookupRuntime({
    sources: [ownSupportReferenceLookup, ...(ports.supportReferenceLookupCrossContext?.sources ?? [])],
  });

  return {
    db: pool,
    insightsDashboards: createDashboardQueryService(new Map()),
    opsDashboard: createOpsDashboardRuntime({ db, crossContext: ports.opsMarketAnalyticsCrossContext }),
    offerEconomics: createOfferEconomicsRuntime({ crossContext: ports.offerEconomicsCrossContext }),
    platformFeedback,
    reportedContent,
    riskAlerts,
    supportRequests,
    policies,
    policyConsoleEntries,
    supportReferenceLookup,
    projectors: [
      ...platformFeedback.projectors,
      ...reportedContent.projectors,
      ...riskAlerts.projectors,
      ...supportRequests.projectors,
      ...policies.projectors,
    ],
  };
}
