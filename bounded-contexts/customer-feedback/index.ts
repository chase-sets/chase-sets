export { default as contextManifest } from "./context.json";

import {
  buildEventReactionsFromManifest,
  defineBoundedContextModule,
  type BcContextManifest,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
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

const customerFeedbackContextManifest = contextManifest as BcContextManifest;

/**
 * Customer Feedback bounded-context module.
 *
 * The context is established as an event-sourced source context that owns the
 * versioned CSAT contract, invitation aggregate, authoritative recording flow,
 * invitation-unique CSAT analytics projections, and the closed-loop case
 * lifecycle. UI composes on this foundation separately.
 */
export const module = defineBoundedContextModule<
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
  buildApis: (services) => [buildCustomerFeedbackApi(services)],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) =>
    buildEventReactionsFromManifest({
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
});
