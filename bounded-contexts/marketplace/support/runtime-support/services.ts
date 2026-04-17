import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createMarketplaceCommercialTermsResolver } from "../../api";
import { createMarketplaceListingRuntime } from "../../features/listings/api/runtime";
import { createMarketplaceOfferRuntime } from "../../features/offers/api/runtime";

export type MarketplaceServiceOptions = void;

export type MarketplaceServices = Readonly<{
  listings: ReturnType<typeof createMarketplaceListingRuntime>;
  offers: ReturnType<typeof createMarketplaceOfferRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createMarketplaceServices(
  pool: PgTransactionalPool,
): MarketplaceServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const deps = {
    eventStore,
    checkpointStore,
    db,
    commercialTermsResolver: createMarketplaceCommercialTermsResolver(db),
  } as const;
  const listings = createMarketplaceListingRuntime(deps);
  const offers = createMarketplaceOfferRuntime(deps);

  return {
    listings,
    offers,
    projectors: [...listings.projectors, ...offers.projectors],
    pool,
    db,
  };
}
