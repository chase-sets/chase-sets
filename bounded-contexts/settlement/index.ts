export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { SettlementServices } from "./services";
import { buildSettlementApi } from "./api";
import { createSettlementServices } from "./services";
import { settlementSchemaSql } from "./schema";
import { seedSettlementDatabase } from "./seed";

export const module: BcApiModule<SettlementServices, PgTransactionalPool, void> = {
  contextName: "settlement",
  routePrefix: "/api/settlement",
  streamPrefix: "settlement.",
  schemaSql: settlementSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<SettlementServices, PgTransactionalPool, void>["apiMounts"],
  createServices: (pool) => createSettlementServices(pool),
  buildApis: (services) => [buildSettlementApi(services)],
  projectors: (services) => services.projectors,
  seed: seedSettlementDatabase,
};
