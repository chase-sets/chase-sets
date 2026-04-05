export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { AuthServicePorts, AuthServices } from "./services";
import { createAuthServices } from "./services";
import { buildAuthApi } from "./api";

export const module: BcApiModule<AuthServices, PgTransactionalPool, AuthServicePorts> = {
  contextName: "auth",
  routePrefix: "/api/auth",
  streamPrefix: "auth.",
  schemaSql: "",
  apiMounts: contextManifest.apiMounts as BcApiModule<AuthServices, PgTransactionalPool, AuthServicePorts>["apiMounts"],
  createServices: (pool, ports) => createAuthServices(pool, ports),
  buildApis: (services) => [buildAuthApi(services)],
  projectors: (services) => services.projectors,
};
