export { default as contextManifest } from "./context.json" with { type: "json" };

import {
  buildEventReactionsFromManifest,
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
  type BcContextManifest,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json" with { type: "json" };
import { buildCommercialTermsApi, buildCommercialTermsPublicApi } from "./api";
import { buildCommercialTermsAccountProjectionHandlers } from "./features/resolutions/integrations/account-source/account-projection";
import { commercialTermsSchemaSql } from "./support/runtime-support/schema";
import { commercialTermsUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { reconcileCommercialTermsBootstrapState, seedCommercialTermsDatabase } from "./support/runtime-support/seed";
import type { CommercialTermsServices } from "./support/runtime-support/services";
import { createCommercialTermsServices } from "./support/runtime-support/services";
import { buildFoundersWindowReactionHandlers } from "./features/agreements/integrations/identity/founders-window-reaction";

const commercialTermsContextManifest = contextManifest as BcContextManifest;

export const module = defineBoundedContextModule<CommercialTermsServices, PgTransactionalPool, void>({
  manifest: commercialTermsContextManifest,
  schemaSql: commercialTermsSchemaSql,
  schemaMigrations: commercialTermsUnloggedProjectionSchemaMigrations,
  createServices: (pool) => createCommercialTermsServices(pool),
  buildApis: (services) => [
    {
      mountPath: "/api/commercial-terms",
      contextMountOrdinal: 1,
      router: buildCommercialTermsApi(services),
    },
    {
      mountPath: "/api/public/commercial-terms",
      contextMountOrdinal: 2,
      router: buildCommercialTermsPublicApi(services),
    },
  ],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => [
    ...buildEventSubscriptionsFromManifest({
      contextName: "commercial-terms",
      manifest: commercialTermsContextManifest,
      handlers: {
        "identity.commercial-terms-account-projection": () =>
          buildCommercialTermsAccountProjectionHandlers(services.db),
      },
    }),
    ...buildEventReactionsFromManifest({
      contextName: "commercial-terms",
      manifest: commercialTermsContextManifest,
      handlers: {
        "identity.commercial-terms-founders-window-reaction": () =>
          buildFoundersWindowReactionHandlers(services.agreements),
      },
    }),
  ],
  seedProfiles: ["critical-bootstrap", "scenario-seed"],
  seed: seedCommercialTermsDatabase,
  reconcileBootstrapState: reconcileCommercialTermsBootstrapState,
});
