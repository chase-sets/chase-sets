export { default as contextManifest } from "./context.json";

import { defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { customerFeedbackSchemaSql } from "./support/runtime-support/schema";
import {
  createCustomerFeedbackServices,
  type CustomerFeedbackHostPorts,
  type CustomerFeedbackServices,
} from "./support/runtime-support/services";

/**
 * Customer Feedback bounded-context module (start gate,).
 *
 * The context is established as an event-sourced source context that owns the
 * versioned CSAT contract. It mounts no API and owns no projection yet — the
 * invitation aggregate + API and the presentation/CSAT projection
 * activate those surfaces on this foundation.
 */
export const module = defineBoundedContextModule<
  CustomerFeedbackServices,
  PgTransactionalPool,
  CustomerFeedbackHostPorts
>({
  manifest: contextManifest,
  schemaSql: customerFeedbackSchemaSql,
  createServices: (pool, ports) => createCustomerFeedbackServices(pool, ports),
  buildApis: () => [],
});
