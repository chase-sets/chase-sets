export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildPublicPresenceAdminApi, buildPublicPresencePublicApi } from "./api";
import { seedPublicPresencePromoBarMessages } from "./features/promo-bar/api/seed";
import { buildWaitlistTransactionalEmailProjectionHandlers } from "./features/waitlist/integrations/transactional-email/transactional-email-projector";
import { buildWaitlistProjectionHandlers } from "./features/waitlist/read-model/projection";
import type { PublicPresenceServices } from "./support/runtime-support/services";
import { createPublicPresenceServices } from "./support/runtime-support/services";
import { publicPresenceSchemaSql } from "./support/runtime-support/schema";
import { publicPresenceUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { seedBetaWavePolicyIfMissing } from "./features/waitlist/api/seed";

export const module = defineBoundedContextModule<
  PublicPresenceServices,
  PgTransactionalPool,
  Parameters<typeof createPublicPresenceServices>[1]
>({
  manifest: contextManifest,
  schemaSql: publicPresenceSchemaSql,
  schemaMigrations: publicPresenceUnloggedProjectionSchemaMigrations,
  createServices: (pool, ports) => createPublicPresenceServices(pool, ports),
  buildApis: (services) => [buildPublicPresencePublicApi(services), buildPublicPresenceAdminApi(services)],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "public-presence",
      manifest: contextManifest,
      handlers: {
        "public-presence.public-presence-waitlist-projection": () => buildWaitlistProjectionHandlers(services.db),
        "public-presence.public-presence-waitlist-transactional-email-projection": (subscription) =>
          buildWaitlistTransactionalEmailProjectionHandlers(
            services.db,
            services.notificationOutbox,
            subscription.projectionName,
          ),
        "identity.public-presence-waitlist-transactional-email-projection": (subscription) =>
          buildWaitlistTransactionalEmailProjectionHandlers(
            services.db,
            services.notificationOutbox,
            subscription.projectionName,
          ),
      },
    }),
  seedProfiles: ["critical-bootstrap", "scenario-seed"],
  seed: async (pool, services, options) => {
    const publicPresenceServices = services ?? createPublicPresenceServices(pool);
    await seedBetaWavePolicyIfMissing(publicPresenceServices);
    await seedPublicPresencePromoBarMessages(publicPresenceServices.db, options);
  },
});
