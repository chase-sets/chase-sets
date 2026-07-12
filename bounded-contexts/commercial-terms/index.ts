export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildCommercialTermsApi, buildCommercialTermsPublicApi } from "./api";
import { buildCommercialTermsAccountProjectionHandlers } from "./features/resolutions/integrations/account-source/account-projection";
import { commercialTermsSchemaSql } from "./support/runtime-support/schema";
import { commercialTermsUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { seedCommercialTermsDatabase } from "./support/runtime-support/seed";
import type { CommercialTermsServices } from "./support/runtime-support/services";
import { createCommercialTermsServices } from "./support/runtime-support/services";

export const module = defineBoundedContextModule<CommercialTermsServices, PgTransactionalPool, void>({
  manifest: contextManifest,
  schemaSql: commercialTermsSchemaSql,
  schemaMigrations: commercialTermsUnloggedProjectionSchemaMigrations,
  createServices: (pool) => createCommercialTermsServices(pool),
  buildApis: (services) => [buildCommercialTermsApi(services), buildCommercialTermsPublicApi(services)],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "commercial-terms",
      manifest: contextManifest,
      handlers: {
        "identity.commercial-terms-account-projection": () =>
          buildCommercialTermsAccountProjectionHandlers(services.db),
      },
    }),
  seedProfiles: ["critical-bootstrap", "scenario-seed"],
  seed: seedCommercialTermsDatabase,
});
