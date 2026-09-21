import { describe, expect, it } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import contextManifest from "../../../context.json" with { type: "json" };
import type { ChannelListingCompositionServices } from "../api/runtime";
import { buildChannelCatalogDesiredStateReactionHandlers } from "../integrations/reactions";
import {
  buildChannelCatalogFactsProjectionHandlers,
  buildChannelMarketplaceFactsProjectionHandlers,
} from "../read-model/facts-projection";

// Catalog writes every catalog-item stream as `catalog.item-<catalogItemId>`
// (bounded-contexts/catalog/features/catalog-items/api/route.ts and api/seed.ts). The identity below
// is the seeded One Piece card that carries the TCGplayer reference `product:987650` in that seed.
const catalogItemId = "cat_seed_one_piece_luffy_romance_dawn";
const catalogItemStreamId = `catalog.item-${catalogItemId}`;
const tcgplayerExternalKey = "product:987650";
const listingId = "listing-one-piece-luffy";

type QueryCall = Readonly<{ sql: string; values: readonly unknown[] }>;

describe("channel-catalog-reference-stream-identity", () => {
  it("covers every catalog event the channels manifest subscribes to", () => {
    const { db } = recordingDb();
    const subscription = contextManifest.eventSubscriptions.find((entry) => entry.sourceContextName === "catalog");
    expect(subscription?.projectionName).toBe("channel-catalog-publication-facts");
    expect(subscription?.projectionHandlerSetNames).toEqual(["channel-catalog-publication-facts"]);
    // A catalog subscription without an explicit event-type list would subscribe to nothing here, so
    // the empty fallback keeps the handler-coverage assertions below meaningful rather than vacuous.
    expect(subscription?.eventTypes).toBeDefined();
    const subscribed = subscription?.eventTypes ? [...subscription.eventTypes].sort() : [];
    expect(subscribed).toContain("catalog.catalog-item.external-catalog-item-reference-linked");
    expect(Object.keys(buildChannelCatalogFactsProjectionHandlers(db)).sort()).toEqual(subscribed);
    expect(Object.keys(buildChannelCatalogDesiredStateReactionHandlers(db, compositionServices([]))).sort()).toEqual(
      subscribed,
    );
  });

  it("writes the external catalog-item reference under the identity composition reads by", async () => {
    const { db, calls } = recordingDb();
    await buildChannelMarketplaceFactsProjectionHandlers(db)["marketplace.listing.created"]!(listingCreated());
    await buildChannelCatalogFactsProjectionHandlers(db)[
      "catalog.catalog-item.external-catalog-item-reference-linked"
    ]!(
      transport(
        "catalog.catalog-item.external-catalog-item-reference-linked",
        { providerKey: "tcgplayer", externalKey: tcgplayerExternalKey },
        4,
      ),
    );
    // readReferencesForIdentity joins channels_external_catalog_item_reference_facts.catalog_item_id ($3)
    // against channels_listing_publication_facts.catalog_item_id ($4).
    const listingIdentity = writtenValue(calls, "channels_listing_publication_facts", 3);
    expect(listingIdentity).toBe(catalogItemId);
    expect(writtenValue(calls, "channels_external_catalog_item_reference_facts", 2)).toBe(listingIdentity);
  });

  it("writes the catalog-item category fact under the identity composition reads by", async () => {
    const { db, calls } = recordingDb();
    await buildChannelMarketplaceFactsProjectionHandlers(db)["marketplace.listing.created"]!(listingCreated());
    await buildChannelCatalogFactsProjectionHandlers(db)["catalog.catalog-item.category-assigned"]!(
      transport("catalog.catalog-item.category-assigned", { categoryId: "one-piece-cards" }, 3),
    );
    // readCategoryIds reads channels_catalog_item_category_facts.catalog_item_id ($1) by the listing identity.
    expect(writtenValue(calls, "channels_catalog_item_category_facts", 0)).toBe(
      writtenValue(calls, "channels_listing_publication_facts", 3),
    );
  });

  it("fans reconciliation out for the identity the listing facts carry", async () => {
    const { db, calls } = recordingDb([{ connection_id: "connection-tcgplayer" }]);
    const enqueued: EnqueuedReconciliation[] = [];
    await buildChannelCatalogDesiredStateReactionHandlers(db, compositionServices(enqueued))[
      "catalog.catalog-item.external-catalog-item-reference-linked"
    ]!(
      transport(
        "catalog.catalog-item.external-catalog-item-reference-linked",
        { providerKey: "tcgplayer", externalKey: tcgplayerExternalKey },
        4,
      ),
    );
    expect(writtenValue(calls, "channels_listing_publication_facts", 0)).toBe(catalogItemId);
    expect(enqueued).toEqual([
      { connectionId: "connection-tcgplayer", scope: "catalog-item", scopeKey: catalogItemId },
    ]);
  });

  it("refuses a stream id that is not a catalog-item stream instead of writing a derived identity", async () => {
    const { db, calls } = recordingDb();
    await expect(
      buildChannelCatalogFactsProjectionHandlers(db)["catalog.catalog-item.external-catalog-item-reference-linked"]!(
        buildTransportEvent(
          "catalog.catalog-item.external-catalog-item-reference-linked",
          { providerKey: "tcgplayer", externalKey: tcgplayerExternalKey },
          { streamId: "catalog.category-one-piece", streamVersion: 1, globalPosition: "catalog.category-one-piece:1" },
        ),
      ),
    ).rejects.toThrow('does not start with prefix "catalog.item-"');
    expect(calls).toEqual([]);
  });
});

function recordingDb(rows: readonly Record<string, unknown>[] = []): Readonly<{ db: PgQueryable; calls: QueryCall[] }> {
  const calls: QueryCall[] = [];
  const db: PgQueryable = {
    query: async <QueryRow>(sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: rows as unknown as QueryRow[], rowCount: rows.length };
    },
  };
  return { db, calls };
}

function writtenValue(calls: readonly QueryCall[], table: string, position: number): unknown {
  const call = calls.find((entry) => entry.sql.includes(table));
  if (!call) throw new Error(`No query touched ${table}.`);
  return call.values[position];
}

type EnqueuedReconciliation = Readonly<{ connectionId: string; scope: string; scopeKey: string }>;

function compositionServices(enqueued: EnqueuedReconciliation[]): ChannelListingCompositionServices {
  return {
    enqueueChannelListingDesiredStateReconciliation: async (input: EnqueuedReconciliation) => {
      enqueued.push(input);
      return { kind: "applied", value: { runId: "run-1" }, streamVersion: 1 };
    },
  } as unknown as ChannelListingCompositionServices;
}

function transport(type: string, data: Record<string, unknown>, streamVersion: number) {
  return buildTransportEvent(type, data, {
    streamId: catalogItemStreamId,
    streamVersion,
    globalPosition: `${catalogItemStreamId}:${streamVersion}`,
  });
}

function listingCreated() {
  return buildTransportEvent(
    "marketplace.listing.created",
    {
      listingId,
      accountId: "account-seller",
      inventoryItemId: "item-one-piece-luffy",
      catalogItemId,
      priceAmount: "20.00",
      priceCurrencyCode: "USD",
      quantityCap: 10,
      selectedOptions: [],
      itemTitle: "Monkey D. Luffy",
      itemSubtitle: null,
      productSummary: null,
      gradedCard: null,
    },
    {
      streamId: `marketplace.listing-${listingId}`,
      streamVersion: 1,
      globalPosition: `marketplace.listing-${listingId}:1`,
    },
  );
}
