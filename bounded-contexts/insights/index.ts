export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { createInsightsServices, type InsightsServices } from "./support/runtime-support/services";

export const module: BcApiModule<InsightsServices, PgTransactionalPool, void> = {
  contextName: "insights",
  routePrefix: "/api/insights",
  streamPrefix: "insights.",
  schemaSql: "",
  apiMounts: contextManifest.apiMounts as BcApiModule<InsightsServices, PgTransactionalPool, void>["apiMounts"],
  createServices: (pool) => createInsightsServices(pool),
  buildApis: () => [],
  projectionHandlerSets: (services) => services.projectors,
};
