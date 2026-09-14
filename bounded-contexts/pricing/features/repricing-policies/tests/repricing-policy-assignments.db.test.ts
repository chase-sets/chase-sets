import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import {
  buildPricingCatalogInputProjectionHandlers,
  buildPricingInventoryInputProjectionHandlers,
  buildPricingMarketplaceInputProjectionHandlers,
} from "../../recommendations/integrations/source/source-projection";
import { buildRepricingPolicyProjectionHandlers } from "../read-model/projection";
import {
  getInventoryAcquisitionCostAmount,
  getRepricingPolicyAssignmentForListing,
  listRepricingPolicyAssignments,
} from "../read-model/queries";
import { resolveRepricingFloorAmount } from "../domain/floor-resolution";
import { previewRepricingScope } from "../read-model/controls";
import type { RepricingFloor, RepricingPolicyScope, RepricingRule } from "../domain/domain";
import {
  listCandidateRepricingProducts,
  loadRepricingRoundInputsPage,
} from "../../repricing-engine/read-model/queries";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["pricing"] as const;

// Monotonic version stamped in delivery order so the projection's stream-version
// guards advance across an entity's lifecycle events even when these seed events
// are not all keyed by the same streamId (mirrors real ordered delivery).
let nextEventStreamVersion = 0;
function event(type: string, data: Record<string, unknown>, recordedAt: string, streamId?: string) {
  nextEventStreamVersion += 1;
  return {
    type,
    streamId: streamId ?? `stream_${type}`,
    streamVersion: nextEventStreamVersion,
    data,
    timing: { recordedAt },
  } as never;
}

const defaultRule: RepricingRule = {
  conditions: [],
  directive: {
    currencyCode: "USD",
    anchorChain: [{ source: "market-estimate" }],
    offset: { mode: "percent", percent: -1 },
    floor: { mode: "absolute", amount: "1.00" },
    ceiling: null,
    tolerance: { mode: "percent", percent: 2 },
    rounding: { mode: "none" },
    maxMovePercent: null,
    terminal: { kind: "hold" },
  },
};

describeDb("pricing repricing-policy assignment resolution (#4330)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  it.each([
    { kind: "all-listings" },
    { kind: "catalog-filter", categoryIds: ["catx"] },
    { kind: "listing-set", listingIds: ["lst_1", "lst_2"] },
  ] satisfies RepricingPolicyScope[])("scope preview counts reconcile overlapping assignment-view differences: $kind", async (scope) => {
    const db = pools.pricing;
    await seedListingsAndCatalog(db);
    await seedPolicy(db, { policyId: "rpp_all", scope: { kind: "all-listings" }, updatedAt: "2026-01-01T00:00:00Z" });
    await seedPolicy(db, { policyId: "rpp_catalog", scope: { kind: "catalog-filter", categoryIds: ["catx"] }, updatedAt: "2026-01-02T00:00:00Z" });
    await seedPolicy(db, { policyId: "rpp_listing", scope: { kind: "listing-set", listingIds: ["lst_1"] }, updatedAt: "2026-01-03T00:00:00Z" });
    for (const replacingPolicyId of [undefined, "rpp_listing"]) {
      const before = await listRepricingPolicyAssignments(db, { accountId: "acc_seller" });
      const preview = await previewRepricingScope(db, { accountId: "acc_seller", scope, excludedListingIds: ["lst_3"], replacingPolicyId });
      const policyId = replacingPolicyId ?? "rpp_new";
      const updatedAt = (await db.query<{ now: string }>("SELECT clock_timestamp()::text AS now")).rows[0]!.now;
      if (replacingPolicyId) await revisePolicy(db, { policyId, scope, excludedListingIds: ["lst_3"], revisedAt: updatedAt });
      else await seedPolicy(db, { policyId, scope, excludedListingIds: ["lst_3"], updatedAt });
      const after = await listRepricingPolicyAssignments(db, { accountId: "acc_seller" });
      const matchingIds = scope.kind === "catalog-filter" ? ["lst_1"] : ["lst_1", "lst_2"];
      const governedIds = after.filter((row) => row.policyId === policyId).map((row) => row.listingId);
      expect(preview.matching).toBe(matchingIds.length);
      expect(preview.governed).toBe(governedIds.length);
      const grouped = (rows: typeof before) => [...new Set(rows.map((row) => row.policyId))].sort().map((id) => ({ policyId: id, name: id, count: rows.filter((row) => row.policyId === id).length }));
      expect(preview.takenFrom).toEqual(grouped(before.filter((row) => governedIds.includes(row.listingId) && row.policyId !== replacingPolicyId)));
      expect(preview.shadowedBy).toEqual(grouped(after.filter((row) => matchingIds.includes(row.listingId) && row.policyId !== policyId)));
      expect(await previewRepricingScope(db, { accountId: "acc_foreign", scope, excludedListingIds: [] })).toEqual({ matching: 0, governed: 0, shadowedBy: [], takenFrom: [] });
    }
  });

  it.each([
    { kind: "all-listings" },
    { kind: "catalog-filter", categoryIds: ["catx"] },
    { kind: "listing-set", listingIds: ["lst_1", "lst_2"] },
  ] satisfies RepricingPolicyScope[])(
    "candidate predicate equals post-create and replacement assignment view: $kind",
    async (scope) => {
      const db = pools.pricing;
      await seedListingsAndCatalog(db);
      await seedPolicy(db, { policyId: "rpp_all", scope: { kind: "all-listings" }, updatedAt: "2026-01-01T00:00:00Z" });
      await seedPolicy(db, {
        policyId: "rpp_catalog",
        scope: { kind: "catalog-filter", categoryIds: ["catx"] },
        updatedAt: "2026-01-02T00:00:00Z",
      });
      await seedPolicy(db, {
        policyId: "rpp_listing",
        scope: { kind: "listing-set", listingIds: ["lst_1"] },
        updatedAt: "2026-01-03T00:00:00Z",
      });
      const body = { scope, excludedListingIds: ["lst_3"], rules: [defaultRule], maxChangesPerDay: 10 };
      const candidateRows = async (replacingPolicyId?: string) => {
        const candidate = { sellerAccountId: "acc_seller", body, replacingPolicyId };
        const products = await listCandidateRepricingProducts(db, candidate, null);
        const rounds = await loadRepricingRoundInputsPage(db, { products, candidate });
        return [...rounds.values()].flatMap((round) => round.listings.map((listing) => listing.listingId)).sort();
      };
      const viewRows = async (policyId: string) =>
        (
          await db.query<{ listing_id: string }>(
            `SELECT assignment.listing_id FROM pricing_repricing_policy_assignments AS assignment
       WHERE assignment.seller_account_id = 'acc_seller' AND assignment.policy_id = $1 ORDER BY assignment.listing_id`,
            [policyId],
          )
        ).rows.map((row) => row.listing_id);
      const beforeCreate = await candidateRows();
      const timestamp = async () =>
        (await db.query<{ now: string }>("SELECT clock_timestamp()::text AS now")).rows[0]!.now;
      await seedPolicy(db, { policyId: "rpp_new", scope, excludedListingIds: ["lst_3"], updatedAt: await timestamp() });
      expect(await viewRows("rpp_new")).toEqual(beforeCreate);
      const beforeReplacement = await candidateRows("rpp_listing");
      await revisePolicy(db, {
        policyId: "rpp_listing",
        scope,
        excludedListingIds: ["lst_3"],
        revisedAt: await timestamp(),
      });
      expect(await viewRows("rpp_listing")).toEqual(beforeReplacement);
      expect(beforeCreate).not.toContain("lst_3");
    },
  );

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "pricing_repricing_policies",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  it("candidate predicate yields to an equally specific newer policy and removes replacement precedence", async () => {
    const db = pools.pricing;
    await seedListingsAndCatalog(db);
    await seedPolicy(db, {
      policyId: "rpp_future",
      scope: { kind: "all-listings" },
      updatedAt: "2100-01-01T00:00:00Z",
    });
    const candidate = {
      sellerAccountId: "acc_seller",
      body: { scope: { kind: "all-listings" as const }, rules: [defaultRule], maxChangesPerDay: 10 },
    };
    expect(await listCandidateRepricingProducts(db, candidate, null)).toEqual([]);
    expect(
      await listCandidateRepricingProducts(db, { ...candidate, replacingPolicyId: "rpp_future" }, null),
    ).toHaveLength(2);
    expect(await listCandidateRepricingProducts(db, { ...candidate, sellerAccountId: "acc_other" }, null)).toEqual([]);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function seedListingsAndCatalog(pool: PgTransactionalPool) {
    const catalogHandlers = buildPricingCatalogInputProjectionHandlers(pool);
    const listingHandlers = buildPricingMarketplaceInputProjectionHandlers(pool);

    await catalogHandlers["catalog.catalog-item.created"]!(
      event("catalog.catalog-item.created", { itemId: "cat_1", title: "Card One" }, "2026-07-01T00:00:00.000Z"),
    );
    await catalogHandlers["catalog.catalog-item.created"]!(
      event("catalog.catalog-item.created", { itemId: "cat_2", title: "Card Two" }, "2026-07-01T00:00:00.000Z"),
    );
    await catalogHandlers["catalog.catalog-item.category-assigned"]!(
      event(
        "catalog.catalog-item.category-assigned",
        { categoryId: "catx" },
        "2026-07-01T00:00:00.000Z",
        "catalog.item-cat_1",
      ),
    );
    await catalogHandlers["catalog.catalog-item.category-assigned"]!(
      event(
        "catalog.catalog-item.category-assigned",
        { categoryId: "caty" },
        "2026-07-01T00:00:00.000Z",
        "catalog.item-cat_2",
      ),
    );

    for (const [listingId, catalogItemId] of [
      ["lst_1", "cat_1"],
      ["lst_2", "cat_2"],
      ["lst_3", "cat_1"],
    ] as const) {
      await listingHandlers["marketplace.listing.created"]!(
        event(
          "marketplace.listing.created",
          {
            listingId,
            accountId: "acc_seller",
            catalogItemId,
            productId: `${catalogItemId}::`,
            priceAmount: "10.00",
            quantityCap: 1,
          },
          "2026-07-01T00:00:00.000Z",
          `marketplace.listing-${listingId}`,
        ),
      );
      await listingHandlers["marketplace.listing.published"]!(
        event("marketplace.listing.published", {}, "2026-07-01T00:00:00.000Z", `marketplace.listing-${listingId}`),
      );
    }
  }

  async function seedPolicy(
    pool: PgTransactionalPool,
    params: Readonly<{
      policyId: string;
      scope: RepricingPolicyScope;
      excludedListingIds?: readonly string[];
      updatedAt: string;
    }>,
  ) {
    const handlers = buildRepricingPolicyProjectionHandlers(pool);
    await handlers["pricing.repricing-policy.created"]!(
      event(
        "pricing.repricing-policy.created",
        {
          policyId: params.policyId,
          accountId: "acc_seller",
          name: params.policyId,
          scope: params.scope,
          excludedListingIds: params.excludedListingIds ?? [],
          rules: [defaultRule],
          maxChangesPerDay: 10,
          createdAt: params.updatedAt,
        },
        params.updatedAt,
        `pricing.repricing-policy-${params.policyId}`,
      ),
    );
  }

  async function revisePolicy(
    pool: PgTransactionalPool,
    params: Readonly<{
      policyId: string;
      scope: RepricingPolicyScope;
      excludedListingIds?: readonly string[];
      revisedAt: string;
    }>,
  ) {
    const handlers = buildRepricingPolicyProjectionHandlers(pool);
    await handlers["pricing.repricing-policy.revised"]!(
      event(
        "pricing.repricing-policy.revised",
        {
          name: params.policyId,
          scope: params.scope,
          excludedListingIds: params.excludedListingIds ?? [],
          rules: [defaultRule],
          maxChangesPerDay: 10,
          revisedAt: params.revisedAt,
        },
        params.revisedAt,
        `pricing.repricing-policy-${params.policyId}`,
      ),
    );
  }

  it("resolves overlapping scopes by most-specific-wins precedence", async () => {
    const pool = pools.pricing;
    await seedListingsAndCatalog(pool);
    await seedPolicy(pool, {
      policyId: "rpp_all",
      scope: { kind: "all-listings" },
      updatedAt: "2026-07-01T01:00:00.000Z",
    });
    await seedPolicy(pool, {
      policyId: "rpp_catalog",
      scope: { kind: "catalog-filter", categoryIds: ["catx"] },
      updatedAt: "2026-07-01T02:00:00.000Z",
    });
    await seedPolicy(pool, {
      policyId: "rpp_listing",
      scope: { kind: "listing-set", listingIds: ["lst_3"] },
      updatedAt: "2026-07-01T03:00:00.000Z",
    });

    const assignments = await listRepricingPolicyAssignments(pool, { accountId: "acc_seller" });
    const byListing = Object.fromEntries(assignments.map((row) => [row.listingId, row.policyId]));

    expect(byListing.lst_1).toBe("rpp_catalog"); // catalog-filter beats all-listings
    expect(byListing.lst_2).toBe("rpp_all"); // only all-listings matches (different category)
    expect(byListing.lst_3).toBe("rpp_listing"); // explicit listing-set beats catalog-filter
  });

  it("honors per-listing opt-out even when the scope would otherwise match", async () => {
    const pool = pools.pricing;
    await seedListingsAndCatalog(pool);
    await seedPolicy(pool, {
      policyId: "rpp_catalog",
      scope: { kind: "catalog-filter", categoryIds: ["catx"] },
      excludedListingIds: ["lst_1"],
      updatedAt: "2026-07-01T01:00:00.000Z",
    });
    await seedPolicy(pool, {
      policyId: "rpp_all",
      scope: { kind: "all-listings" },
      updatedAt: "2026-07-01T00:30:00.000Z",
    });

    const lst1 = await getRepricingPolicyAssignmentForListing(pool, "lst_1");
    const lst3 = await getRepricingPolicyAssignmentForListing(pool, "lst_3");

    // lst_1 is opted out of rpp_catalog, so it falls through to the lower-precedence rpp_all.
    expect(lst1?.policyId).toBe("rpp_all");
    // lst_3 is not opted out, so the catalog-filter policy still wins there.
    expect(lst3?.policyId).toBe("rpp_catalog");
  });

  it("reassigns listings when a policy's scope is revised", async () => {
    const pool = pools.pricing;
    await seedListingsAndCatalog(pool);
    await seedPolicy(pool, {
      policyId: "rpp_narrow",
      scope: { kind: "listing-set", listingIds: ["lst_3"] },
      updatedAt: "2026-07-01T00:00:00.000Z",
    });

    expect((await getRepricingPolicyAssignmentForListing(pool, "lst_3"))?.policyId).toBe("rpp_narrow");
    expect(await getRepricingPolicyAssignmentForListing(pool, "lst_2")).toBeNull();

    await revisePolicy(pool, {
      policyId: "rpp_narrow",
      scope: { kind: "listing-set", listingIds: ["lst_2"] },
      revisedAt: "2026-07-01T04:00:00.000Z",
    });

    expect(await getRepricingPolicyAssignmentForListing(pool, "lst_3")).toBeNull();
    expect((await getRepricingPolicyAssignmentForListing(pool, "lst_2"))?.policyId).toBe("rpp_narrow");
  });

  it("excludes withdrawn listings and paused/deleted policies from assignment", async () => {
    const pool = pools.pricing;
    await seedListingsAndCatalog(pool);
    await seedPolicy(pool, {
      policyId: "rpp_all",
      scope: { kind: "all-listings" },
      updatedAt: "2026-07-01T00:00:00.000Z",
    });

    const listingHandlers = buildPricingMarketplaceInputProjectionHandlers(pool);
    await listingHandlers["marketplace.listing.withdrawn"]!(
      event("marketplace.listing.withdrawn", {}, "2026-07-01T05:00:00.000Z", "marketplace.listing-lst_1"),
    );
    expect(await getRepricingPolicyAssignmentForListing(pool, "lst_1")).toBeNull();

    const policyHandlers = buildRepricingPolicyProjectionHandlers(pool);
    await policyHandlers["pricing.repricing-policy.paused"]!(
      event(
        "pricing.repricing-policy.paused",
        { pausedAt: "2026-07-01T06:00:00.000Z" },
        "2026-07-01T06:00:00.000Z",
        "pricing.repricing-policy-rpp_all",
      ),
    );
    expect(await getRepricingPolicyAssignmentForListing(pool, "lst_2")).toBeNull();
  });

  it("resolves a cost-basis-plus-margin floor from Inventory's acquisition_cost_amount fact", async () => {
    const pool = pools.pricing;
    const inventoryHandlers = buildPricingInventoryInputProjectionHandlers(pool);
    await inventoryHandlers["inventory.item.created"]!(
      event(
        "inventory.item.created",
        {
          itemId: "inv_1",
          accountId: "acc_seller",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          totalQuantity: 4,
          acquisitionCostAmount: "8.00",
        },
        "2026-07-01T00:00:00.000Z",
      ),
    );

    const costBasis = await getInventoryAcquisitionCostAmount(pool, {
      sellerAccountId: "acc_seller",
      catalogItemId: "cat_1",
      productId: "cat_1::",
    });
    expect(costBasis).toBe("8.00");

    const floorWithCostBasis: RepricingFloor = {
      mode: "cost-basis-plus-margin",
      marginPercent: 25,
      absoluteFallbackAmount: "3.00",
    };
    expect(resolveRepricingFloorAmount(floorWithCostBasis, costBasis)).toBe("10.00");

    const missingCostBasis = await getInventoryAcquisitionCostAmount(pool, {
      sellerAccountId: "acc_seller",
      catalogItemId: "cat_missing",
      productId: "cat_missing::",
    });
    expect(missingCostBasis).toBeNull();
    expect(resolveRepricingFloorAmount(floorWithCostBasis, missingCostBasis)).toBe("3.00");
  });
});
