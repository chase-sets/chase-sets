import { createCustomerFeedbackAttentionDigestRunners } from "./support/runtime-support/worker-jobs";
export { default as contextManifest } from "./context.json" with { type: "json" };

import {
  buildEventSubscriptionsFromManifest,
  buildEventReactionsFromManifest,
  defineBoundedContextModule,
  type BcContextManifest,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json" with { type: "json" };
import {
  customerFeedbackRetentionExemptions,
  customerFeedbackRetentionSweeps,
} from "./support/runtime-support/retention-policy";
import { customerFeedbackSchemaMigrations, customerFeedbackSchemaSql } from "./support/runtime-support/schema";
import {
  createCustomerFeedbackServices,
  type CustomerFeedbackHostPorts,
  type CustomerFeedbackServices,
} from "./support/runtime-support/services";
import { buildFeedbackCaseOpeningReactionHandlers } from "./features/cases/integrations/csat/submission-reaction";
import { buildNotificationDeliveryReactionHandlers } from "./features/cases/integrations/notifications/delivery-reaction";
import { buildFeedbackCaseRedactionReactionHandlers } from "./features/cases/integrations/csat/redaction-reaction";
import { buildCustomerFeedbackApi } from "./api";
import { buildAuthOutcomeFactProjectionHandlers } from "./features/csat/integrations/auth/outcome-fact-projection";
import { buildDiscoveryOutcomeFactProjectionHandlers } from "./features/csat/integrations/discovery/outcome-fact-projection";
import { buildIdentityOutcomeFactProjectionHandlers } from "./features/csat/integrations/identity/outcome-fact-projection";
import { buildFulfillmentOutcomeFactProjectionHandlers } from "./features/csat/integrations/fulfillment/outcome-fact-projection";
import { buildPaymentsOutcomeFactProjectionHandlers } from "./features/csat/integrations/payments/outcome-fact-projection";
import { buildSettlementOutcomeFactProjectionHandlers } from "./features/csat/integrations/settlement/outcome-fact-projection";
import { buildSupportOutcomeFactProjectionHandlers } from "./features/csat/integrations/platform-operations/outcome-fact-projection";
import { buildMarketplaceOutcomeFactProjectionHandlers } from "./features/csat/integrations/marketplace/outcome-fact-projection";
import { buildInventoryOutcomeFactProjectionHandlers } from "./features/csat/integrations/inventory/outcome-fact-projection";

const customerFeedbackContextManifest = contextManifest as BcContextManifest;

/**
 * Customer Feedback bounded-context module.
 *
 * The context is established as an event-sourced source context that owns the
 * versioned CSAT contract, invitation aggregate, authoritative recording flow,
 * invitation-unique CSAT analytics projections, and the closed-loop case
 * lifecycle. UI composes on this foundation separately.
 */
const contextModule = defineBoundedContextModule<
  CustomerFeedbackServices,
  PgTransactionalPool,
  CustomerFeedbackHostPorts
>({
  manifest: customerFeedbackContextManifest,
  schemaSql: customerFeedbackSchemaSql,
  schemaMigrations: customerFeedbackSchemaMigrations,
  retentionExemptions: customerFeedbackRetentionExemptions,
  retentionSweeps: customerFeedbackRetentionSweeps,
  createServices: (pool, ports) => createCustomerFeedbackServices(pool, ports),
  buildApis: (services) => [
    {
      mountPath: "/api/customer-feedback",
      contextMountOrdinal: 1,
      router: buildCustomerFeedbackApi(services),
    },
  ],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => [
    ...buildEventSubscriptionsFromManifest({
      contextName: "customer-feedback",
      manifest: customerFeedbackContextManifest,
      handlers: {
        "auth.customer-feedback-csat-outcome-fact-projection": () => buildAuthOutcomeFactProjectionHandlers(),
        "identity.customer-feedback-csat-outcome-fact-projection": () => buildIdentityOutcomeFactProjectionHandlers(),
        "discovery.customer-feedback-csat-outcome-fact-projection": () => buildDiscoveryOutcomeFactProjectionHandlers(),
        "fulfillment.customer-feedback-csat-outcome-fact-projection": () =>
          buildFulfillmentOutcomeFactProjectionHandlers(),
        "payments.customer-feedback-csat-outcome-fact-projection": () => buildPaymentsOutcomeFactProjectionHandlers(),
        "settlement.customer-feedback-csat-outcome-fact-projection": () =>
          buildSettlementOutcomeFactProjectionHandlers(),
        "platform-operations.customer-feedback-csat-outcome-fact-projection": () =>
          buildSupportOutcomeFactProjectionHandlers(),
        "marketplace.customer-feedback-csat-outcome-fact-projection": () =>
          buildMarketplaceOutcomeFactProjectionHandlers(),
        "inventory.customer-feedback-csat-outcome-fact-projection": () => buildInventoryOutcomeFactProjectionHandlers(),
      },
    }),
    ...buildEventReactionsFromManifest({
      contextName: "customer-feedback",
      manifest: customerFeedbackContextManifest,
      handlers: {
        "customer-feedback.customer-feedback-feedback-case-opening": () => ({
          ...buildFeedbackCaseOpeningReactionHandlers(services.cases.openFromSubmission),
          ...buildFeedbackCaseRedactionReactionHandlers(services.cases.protectFromResponseRedaction),
        }),
        "notifications.customer-feedback-notification-delivery-recording": () =>
          buildNotificationDeliveryReactionHandlers(services.cases.executeByCaseId, services.eventStore),
      },
    }),
  ],
});

export const module = { ...contextModule, workerJobFactories: { createCustomerFeedbackAttentionDigestRunners } };
