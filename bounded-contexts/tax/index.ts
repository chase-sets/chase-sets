export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";

export const module: BcApiModule<Readonly<Record<string, never>>, PgTransactionalPool, void> = {
  contextName: "tax",
  routePrefix: "/api/tax",
  streamPrefix: "tax.",
  schemaSql: "",
  apiMounts: contextManifest.apiMounts as BcApiModule<
    Readonly<Record<string, never>>,
    PgTransactionalPool,
    void
  >["apiMounts"],
  projectionGroups: [],
  createServices: () => ({}),
  buildApis: () => [],
  projectors: () => [],
};
