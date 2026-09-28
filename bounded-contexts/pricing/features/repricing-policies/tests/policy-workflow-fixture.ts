import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import type { ListingTargetAuthority } from "@chase-sets/marketplace/server";
import { createListingAuthorityFence } from "@chase-sets/platform-runtime/listing-authority-fence";
import { identityFixture } from "../../../../identity/features/access-hub/api/listing-authority-test-support";
import { createIdentityListingAuthority } from "../../../../identity/features/access-hub/api/listing-authority";
import { createListingSqlFixture } from "../../../../marketplace/tests/test-support/listing-authority-sql";
import { createMarketplaceListingRuntime } from "../../../../marketplace/features/listings/api/runtime";
import { createPricingServices } from "../../../support/runtime-support/services";

/** Identity authenticates a runtime-created key using its in-memory credential fixture.
 * Listing/Pricing writers use SQL; non-Identity remote facts use the Marketplace fixture.
 */
export async function policyWorkflowFixture(pricing: PgTransactionalPool, marketplace: PgTransactionalPool) {
  const identity = await identityFixture();
  const { context, accountId } = identity;
  const listing = createListingSqlFixture(marketplace);
  const consumer = createListingAuthorityFence({
    eventStore: listing.eventStore,
    owner: "marketplace",
    participants: [],
  });
  const identityAuthority = createIdentityListingAuthority({
    eventStore: identity.memory.eventStore,
    credentials: identity.credentials,
    listingAuthorityConsumer: () => consumer.forParticipant("identity"),
  });
  const authority: ListingTargetAuthority = {
    ...listing.authority,
    participants: [
      ...listing.authority.participants.filter((port) => port.participant.owner !== "identity"),
      identityAuthority.port,
    ],
    authorizeManage: async (_input, commandContext, operation) => ({
      value: true,
      reservations: [await identityAuthority.source.prepare(operation, commandContext)],
    }),
    readInventory: async (...args: Parameters<NonNullable<typeof listing.authority.readInventory>>) =>
      (await listing.authority.readInventory!(...args)).map((entry) => ({
        ...entry,
        value: entry.value ? { ...entry.value, accountId } : null,
      })),
    readNativeReadiness: async (...args: Parameters<NonNullable<typeof listing.authority.readNativeReadiness>>) =>
      (await listing.authority.readNativeReadiness!(...args)).map((entry) => ({
        ...entry,
        value: entry.value ? { ...entry.value, accountId } : null,
      })),
  };
  const listings = createMarketplaceListingRuntime({
    eventStore: listing.eventStore,
    checkpointStore: createPostgresProjectionStore({ db: marketplace }),
    listingTargetAuthority: authority,
    commercialTermsResolver: createNoopCommercialTermsResolver(),
    db: {
      async query<Row>(sql: string, values?: readonly unknown[]) {
        if (!sql.includes("FROM marketplace_supply_items AS item")) return marketplace.query<Row>(sql, values);
        return {
          rows: [
            {
              item_id: "inv_synthetic",
              account_id: accountId,
              catalog_catalog_item_id: "cat_synthetic",
              product_id: "cat_synthetic::",
              selected_options: [],
              item_title: "Synthetic policy workflow",
              item_subtitle: null,
              item_language_code: null,
              product_summary: null,
              product_measure_snapshot: null,
              graded_card: null,
              storage_location_name: null,
              ship_from_code: null,
              available_quantity: 3,
              ship_from_address: {
                name: "Synthetic Seller",
                company: null,
                line1: "1 Test St",
                line2: null,
                city: "Austin",
                state: "TX",
                postalCode: "78701",
                country: "US",
                phone: null,
                email: null,
              },
            },
          ] as Row[],
        };
      },
    },
  });
  const services = createPricingServices(pricing, {
    tcgplayerMarketTransport: { kind: "not-mounted" },
    tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
    commercialTermsResolver: createNoopCommercialTermsResolver(),
    channelConnectionIdentityReader: { resolve: async () => null },
    pricingListingAuthorityConsumer: () => consumer.forParticipant("pricing"),
  });
  const sourceStore = createPostgresEventStore({ pool: pricing });
  return {
    context,
    accountId,
    listings,
    services,
    sourceStore,
    consumerStore: listing.eventStore,
    listingInput: { ...listing.input, accountId, priceCurrencyCode: "USD" },
  };
}
