export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildExperienceApi } from "./api";
import type { ExperienceServices } from "./support/runtime-support/services";
import { createExperienceServices } from "./support/runtime-support/services";
import { experienceSchemaSql } from "./support/runtime-support/schema";
import { seedExperienceDatabase } from "./support/runtime-support/seed";

const projectionGroups =
  (contextManifest.projectionGroups ?? []) as readonly BcProjectionGroupDeclaration[];

export const module: BcApiModule<ExperienceServices, PgTransactionalPool, void> = {
  contextName: "experience",
  routePrefix: "/api/experience",
  streamPrefix: "experience.",
  schemaSql: experienceSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<
    ExperienceServices,
    PgTransactionalPool,
    void
  >["apiMounts"],
  projectionGroups,
  createServices: (pool) => createExperienceServices(pool),
  buildApis: (services) => [buildExperienceApi(services)],
  projectors: (services) => services.projectors,
  buildSubscriptions: () => [],
  seed: seedExperienceDatabase,
};
