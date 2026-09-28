import type { module as authModule } from "@chase-sets/auth";
import type { module as identityModule } from "@chase-sets/identity";
import type { module as inventoryModule } from "@chase-sets/inventory";
import type { CatalogServices } from "@chase-sets/catalog/server";
import type { CommercialTermsListingAuthorityPorts } from "@chase-sets/commercial-terms/server";
import type { MarketplaceListingAuthorityPorts } from "@chase-sets/marketplace/server";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  bindListingAuthorityParticipant,
  createListingAuthorityConsumerResolver,
} from "@chase-sets/platform-runtime/listing-authority-host";

export function createListingSourceHostPorts(
  getServices: () => Readonly<Record<string, unknown>> | undefined,
  pools: Readonly<Record<string, PgTransactionalPool | undefined>>,
) {
  function service<T>(owner: string): T {
    const value = getServices()?.[owner];
    if (!value) throw new Error(`${owner} Listing authority source is not mounted.`);
    return value as T;
  }
  const auth = () => service<ReturnType<typeof authModule.createServices>>("auth").sessions.listingAuthority;
  const identity = () => service<ReturnType<typeof identityModule.createServices>>("identity").listingAuthority;
  const catalog = () => service<CatalogServices>("catalog").listingAuthority;
  const inventory = () => service<ReturnType<typeof inventoryModule.createServices>>("inventory").listingAuthority;
  const stores = {
    ...(pools.marketplace ? { marketplace: createPostgresEventStore({ pool: pools.marketplace }) } : {}),
    ...(pools.ordering ? { ordering: createPostgresEventStore({ pool: pools.ordering }) } : {}),
  };
  const consumer = (owner: Parameters<typeof createListingAuthorityConsumerResolver>[1]) =>
    createListingAuthorityConsumerResolver(stores, owner);
  const session = bindListingAuthorityParticipant(
    { owner: "auth", purpose: "authenticated-session" },
    () => auth().port,
  );
  const manage = bindListingAuthorityParticipant(
    { owner: "identity", purpose: "manage-listing" },
    () => identity().port,
  );
  return {
    "auth.listingAuthorityConsumer": consumer("auth"),
    "identity.listingAuthorityConsumer": consumer("identity"),
    "identity.sessionAuthority": session,
    "catalog.listingAuthorityConsumer": consumer("catalog"),
    "inventory.listingAuthorityConsumer": consumer("inventory"),
    "channels.listingAuthorityConsumer": consumer("channels"),
    "marketplace.listingAuthority": {
      consumer: consumer("marketplace"),
      session,
      identity: { participant: manage, sellerFacts: (reservation) => identity().sellerFacts(reservation) },
      catalog: {
        participant: bindListingAuthorityParticipant(
          { owner: "catalog", purpose: "product-measures" },
          () => catalog().source,
        ),
        readFacts: (operation) => catalog().readFacts(operation),
      },
      inventory: bindListingAuthorityParticipant(
        { owner: "inventory", purpose: "stock-allocation" },
        () => inventory().source,
      ),
    } satisfies MarketplaceListingAuthorityPorts,
    "commercial-terms.listingAuthority": {
      consumer: consumer("commercial-terms"),
      identity: { participant: manage, accountFacts: (reservation) => identity().accountFacts(reservation) },
    } satisfies CommercialTermsListingAuthorityPorts,
  };
}
