export { SettlementDomainError } from "./common";
export { buildSettlementApi } from "./api";
export type { SettlementApiEnv } from "./api";
export { createSettlementServices } from "./services";
export type { SettlementServices } from "./services";
export { settlementSchemaSql } from "./schema";
export { seedSettlementDatabase } from "./seed";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
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
  createServices: (pool) => createSettlementServices(pool),
  buildApi: buildSettlementApi,
  projectors: (services) => services.projectors,
  seed: seedSettlementDatabase,
};
