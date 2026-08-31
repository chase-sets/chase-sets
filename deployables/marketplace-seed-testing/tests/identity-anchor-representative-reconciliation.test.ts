import { getProjectionGroup, syncProjectionGroup } from "@chase-sets/bounded-context-runtime";
import {
  catalogScenarioItems,
  ensureRepresentativeInventoryStock,
  publishRepresentativeListings,
  type RepresentativeInventoryServices,
  type RepresentativeMarketplaceServices,
} from "@chase-sets/catalog-seed";
import { beforeAll, expect, it } from "vitest";
import { describeWithMarketplaceSeedDatabase, useMarketplaceSeedRuntime } from "../index";

// Regression coverage for issue #7410: the out-of-band Representative Commerce
// State refresh (.github/workflows/platform-staging-representative-commerce-state.yml)
// walks every active Catalog Item, including the pinned identity anchors the
// browser E2E seed contract depends on for an exact deterministic listing shape
// (deployables/marketplace/e2e/support/seed-contract.ts). This reproduces that
// pollution against the real Bulbasaur anchor and asserts that rerunning the
// marketplace scenario seed reconciles it away, the same way the staging
// advisory lane reruns scenario-seed on every attempt.
describeWithMarketplaceSeedDatabase(
  "marketplace scenario seed reconciles stray representative listings on pinned identity anchors",
  () => {
    const seedRuntime = useMarketplaceSeedRuntime("identity-anchor-representative-reconciliation", {
      resetSchemas: "beforeAll",
    });

    let strayListingId: string | null = null;

    beforeAll(async () => {
      const runtime = await seedRuntime.seed();

      const stock = await ensureRepresentativeInventoryStock(getInventoryServices(runtime.services), [
        { catalogItemId: catalogScenarioItems.bulbasaurBaseSet },
      ]);
      await syncRepresentativeProjection(runtime, "inventory", "inventory-item-projection");
      await syncRepresentativeProjection(runtime, "marketplace", "marketplace-inventory-supply-projection");
      await syncRepresentativeProjection(runtime, "marketplace", "marketplace-listing-projection");

      const listings = await publishRepresentativeListings(getMarketplaceServices(runtime.services), stock);
      strayListingId = listings[0]?.listingId ?? null;
      if (!strayListingId) {
        throw new Error("Failed to publish a stray representative listing for the reconciliation test.");
      }
      await syncRepresentativeProjection(runtime, "marketplace", "marketplace-listing-projection");

      // The staging advisory lane reruns scenario-seed on every attempt; the
      // rerun must reconcile the stray listing away without being told about it.
      await seedRuntime.seed();
    }, 300_000);

    it("withdraws the stray representative listing so Bulbasaur keeps zero active listings", async () => {
      const listing = await seedRuntime.pools.marketplace.query<{ status: string }>(
        `SELECT status FROM marketplace_listing_pages WHERE listing_id = $1`,
        [strayListingId],
      );
      expect(listing.rows[0]?.status).toBe("withdrawn");

      const activeListings = await seedRuntime.pools.marketplace.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM marketplace_listing_pages
         WHERE catalog_catalog_item_id = $1
           AND status <> 'withdrawn'`,
        [catalogScenarioItems.bulbasaurBaseSet],
      );
      expect(Number(activeListings.rows[0]?.count ?? -1)).toBe(0);
    });

    it("leaves the deterministic reserved Charizard listings active", async () => {
      const reservedListings = await seedRuntime.pools.marketplace.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM marketplace_listing_pages
         WHERE catalog_catalog_item_id = $1
           AND listing_id NOT LIKE 'lst$_repr$_%' ESCAPE '$'
           AND status = 'active'`,
        [catalogScenarioItems.charizardBaseSet],
      );
      expect(Number(reservedListings.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    });
  },
);

type MarketplaceSeedRuntime = Awaited<ReturnType<ReturnType<typeof useMarketplaceSeedRuntime>["seed"]>>;

function getInventoryServices(services: Readonly<Record<string, unknown>>): RepresentativeInventoryServices {
  return services.inventory as RepresentativeInventoryServices;
}

function getMarketplaceServices(services: Readonly<Record<string, unknown>>): RepresentativeMarketplaceServices {
  return services.marketplace as RepresentativeMarketplaceServices;
}

async function syncRepresentativeProjection(
  runtime: MarketplaceSeedRuntime,
  contextName: string,
  projectionName: string,
): Promise<void> {
  await syncProjectionGroup(getProjectionGroup(runtime, contextName, projectionName));
}
