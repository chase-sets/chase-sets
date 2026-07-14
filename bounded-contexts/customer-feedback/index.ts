export { default as contextManifest } from "./context.json";

import { defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { customerFeedbackRetentionExemptions } from "./support/runtime-support/retention-policy";
import { customerFeedbackSchemaSql } from "./support/runtime-support/schema";
import {
  createCustomerFeedbackServices,
  type CustomerFeedbackHostPorts,
  type CustomerFeedbackServices,
} from "./support/runtime-support/services";

/**
 * Customer Feedback bounded-context module.
 *
 * The context is established as an event-sourced source context that owns the
 * versioned CSAT contract, invitation aggregate, authoritative recording flow,
 * and invitation-unique CSAT analytics projections. Survey UI composes on this
 * foundation separately.
 */
export const module = defineBoundedContextModule<
  CustomerFeedbackServices,
  PgTransactionalPool,
  CustomerFeedbackHostPorts
>({
  manifest: contextManifest,
  schemaSql: customerFeedbackSchemaSql,
  retentionExemptions: customerFeedbackRetentionExemptions,
  createServices: (pool, ports) => createCustomerFeedbackServices(pool, ports),
  buildApis: () => [],
  projectionHandlerSets: (services) => services.projectors,
});
