import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import {
  buildMarketplaceAccountProjectionHandlers,
  buildMarketplaceCatalogProjectionHandlers,
  buildMarketplaceInventoryProjectionHandlers,
} from "./supply-projection";

class ProjectionDb implements PgQueryable {
  public readonly catalogItems = new Map<string, Record<string, unknown>>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO marketplace_catalog_items")) {
      this.catalogItems.set(String(values[0]), {
        catalog_item_id: values[0],
        language_code: values[1],
        title: values[2],
        subtitle: values[3],
        status: "draft",
        updated_at: values[4],
      });
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("SELECT catalog_item_id, language_code, title, subtitle, blueprint_id, status, updated_at")) {
      const item = this.catalogItems.get(String(values[0]));
      return { rows: (item ? [item] : []) as Row[], rowCount: item ? 1 : 0 };
    }

    if (sql.includes("SET product_schema = $2")) {
      this.catalogItems.set(String(values[0]), {
        ...this.catalogItems.get(String(values[0])),
        product_schema: values[1],
        updated_at: values[2],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE marketplace_catalog_items") && sql.includes("title = $3")) {
      this.catalogItems.set(String(values[0]), {
        ...this.catalogItems.get(String(values[0])),
        language_code: values[1],
        title: values[2],
        subtitle: values[3],
        updated_at: values[4],
      });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function event(type: string, data: Record<string, unknown>, streamId = "catalog.item-cat_1"): TransportEvent {
  return buildTransportEvent(type, data, {
    id: "evt_1",
    streamId,
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
    timing: { occurredAt: "2026-05-09T00:00:00.000Z", recordedAt: "2026-05-09T00:00:00.000Z" },
  });
}

describe("marketplace catalog projection", () => {
  it("projects catalog item language and resolved English display text", async () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceCatalogProjectionHandlers(db);

    await handlers["catalog.catalog-item.created"]!(
      event("catalog.catalog-item.created", {
        itemId: "cat_1",
        languageCode: "ja",
        title: { defaultLocale: "en", values: { en: "Charizard", ja: "リザードン" } },
        subtitle: { defaultLocale: "en", values: { en: "Japanese Base Set", ja: "拡張パック" } },
      }),
    );

    expect(db.catalogItems.get("cat_1")).toMatchObject({
      catalog_item_id: "cat_1",
      language_code: "ja",
      title: "Charizard",
      subtitle: "Japanese Base Set",
    });
  });

  it("updates item labels from Catalog display identity facts", async () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceCatalogProjectionHandlers(db);

    await handlers["catalog.catalog-item.created"]!(
      event("catalog.catalog-item.created", {
        itemId: "cat_1",
        title: "Fallback",
        subtitle: null,
      }),
    );

    await handlers["catalog.catalog-item.display-identity-resolved"]!(
      event("catalog.catalog-item.display-identity-resolved", {
        catalogItemId: "cat_1",
        languageCode: "en",
        title: "Charizard 4/102",
        subtitle: "Base Set Rare Holo",
      }),
    );

    expect(db.catalogItems.get("cat_1")).toMatchObject({
      language_code: "en",
      title: "Charizard 4/102",
      subtitle: "Base Set Rare Holo",
    });
  });

  it("does not handle Catalog metadata revisions as display label changes", () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceCatalogProjectionHandlers(db);

    expect(handlers["catalog.catalog-item.metadata-revised"]).toBeUndefined();
  });

  it("mirrors stable category identities and item assignments for policy selectors", async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const handlers = buildMarketplaceCatalogProjectionHandlers(db as never);

    await handlers["catalog.category.created"]!(
      event(
        "catalog.category.created",
        {
          categoryId: "category_cards",
          name: { defaultLocale: "en", values: { en: "Trading cards" } },
        },
        "catalog.category-category_cards",
      ),
    );
    await handlers["catalog.catalog-item.category-assigned"]!(
      event("catalog.catalog-item.category-assigned", { categoryId: "category_cards" }, "catalog.catalog-item-cat_1"),
    );

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("marketplace_catalog_categories"), [
      "category_cards",
      "Trading cards",
      "2026-05-09T00:00:00.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("SET category_ids"), [
      "cat_1",
      "category_cards",
      "2026-05-09T00:00:00.000Z",
    ]);
  });
});

describe("marketplace account projection", () => {
  it("projects account badges used by high-dollar listing publication policy", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildMarketplaceAccountProjectionHandlers(db as never);

    await handlers["identity.account.badge-assigned"]!(
      event("identity.account.badge-assigned", { badgeKey: "trusted-seller" }, "identity.account-acc_seller"),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("marketplace_account_pages"), [
      "acc_seller",
      "trusted-seller",
      true,
      "2026-05-09T00:00:00.000Z",
    ]);
  });

  it("splits reputation counters into as-seller and as-buyer dimensions on review.submitted (m108)", async () => {
    const db = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => ({
        rows: [] as unknown[],
        rowCount: 0,
        params: values,
      })),
    };
    const handlers = buildMarketplaceAccountProjectionHandlers(db as never);

    await handlers["marketplace.review.submitted"]!(
      event(
        "marketplace.review.submitted",
        {
          reviewId: "rev_1",
          orderId: "ord_1",
          subjectAccountId: "acc_seller",
          authorRole: "buyer",
          rating: 5,
          submittedAt: "2026-05-09T00:00:00.000Z",
        },
        "marketplace.review-rev_1",
      ),
    );

    const reputationRefresh = vi
      .mocked(db.query)
      .mock.calls.find(([sql]) => sql.includes("INSERT INTO marketplace_account_pages"));
    expect(reputationRefresh?.[0]).toContain("COUNT(*) FILTER (WHERE author_role = 'buyer')");
    expect(reputationRefresh?.[0]).toContain("COUNT(*) FILTER (WHERE author_role = 'seller')");
    expect(reputationRefresh?.[0]).toContain("average_rating_as_seller");
    expect(reputationRefresh?.[0]).toContain("average_rating_as_buyer");

    const reviewInsert = vi
      .mocked(db.query)
      .mock.calls.find(([sql]) => sql.includes("INSERT INTO marketplace_account_reviews"));
    expect(reviewInsert?.[1]).toEqual([
      "rev_1",
      "ord_1",
      "acc_seller",
      "buyer",
      5,
      "2026-05-09T00:00:00.000Z",
      "included",
      "normal-completion",
      "resolution-aware-v1",
      "[]",
      null,
    ]);
  });

  it("keeps context-only reviews in account history while excluding their rating", async () => {
    const db = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => ({
        rows: sql.includes("UPDATE marketplace_account_reviews") ? [{ subject_account_id: "acc_seller" }] : [],
        rowCount: 1,
        params: values,
      })),
    };
    const handlers = buildMarketplaceAccountProjectionHandlers(db as never);

    await handlers["marketplace.review-scoring.disposition-projected.v1"]?.(
      event("marketplace.review-scoring.disposition-projected.v1", {
        factSchemaVersion: 1,
        orderId: "ord_1",
        policyVersion: "resolution-aware-v1",
        sourceFactVersions: [{ supportRequestId: "sup_1", sourceStreamVersion: 2, status: "resolved" }],
        buyerToSeller: { scoringDisposition: "context-only", reasonCode: "external-responsibility" },
        sellerToBuyer: { scoringDisposition: "context-only", reasonCode: "external-responsibility" },
        operationalSignal: null,
        projectedAt: "2026-05-10T00:00:00.000Z",
      }),
    );

    const update = vi.mocked(db.query).mock.calls.find(([sql]) => sql.includes("scoring_disposition = CASE"));
    expect(update?.[0]).toContain("last_scoring_stream_version");
    const refresh = vi
      .mocked(db.query)
      .mock.calls.find(([sql]) => sql.includes("INSERT INTO marketplace_account_pages"));
    expect(refresh?.[0]).toContain("scoring_disposition = 'included'");
    expect(refresh?.[0]).toContain("review_count_as_seller");
    expect(refresh?.[0]).toContain("rating_count_as_seller");
  });

  it("removes held reviews from account reputation and restores them from the released direction set", async () => {
    const db = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => ({
        rows: sql.includes("UPDATE marketplace_account_reviews") ? [{ subject_account_id: "acc_seller" }] : [],
        rowCount: 1,
        params: values,
      })),
    };
    const handlers = buildMarketplaceAccountProjectionHandlers(db as never);

    await handlers["marketplace.review-hold.placed"]!(
      event("marketplace.review-hold.placed", {
        orderId: "ord_1",
        heldDirections: ["buyer-to-seller", "seller-to-buyer"],
        lifecycleAt: "2026-05-10T00:00:00.000Z",
      }),
    );
    await handlers["marketplace.review-hold.released"]!(
      event("marketplace.review-hold.released", {
        orderId: "ord_1",
        heldDirections: [],
        lifecycleAt: "2026-05-12T00:00:00.000Z",
      }),
    );

    const holdUpdates = vi
      .mocked(db.query)
      .mock.calls.filter(([sql]) => sql.includes("UPDATE marketplace_account_reviews"));
    expect(holdUpdates.map(([, values]) => values)).toEqual([
      ["ord_1", ["buyer-to-seller", "seller-to-buyer"], "2026-05-10T00:00:00.000Z"],
      ["ord_1", [], "2026-05-12T00:00:00.000Z"],
    ]);
    const reputationRefreshes = vi
      .mocked(db.query)
      .mock.calls.filter(([sql]) => sql.includes("INSERT INTO marketplace_account_pages"));
    expect(reputationRefreshes).toHaveLength(2);
    expect(reputationRefreshes.every(([sql]) => sql.includes("AND held = false"))).toBe(true);
  });
});

describe("marketplace inventory supply projection", () => {
  it("mirrors hold anatomy and structured release reasons", async () => {
    const onInventoryItemChanged = vi.fn(async () => undefined);
    const db = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("RETURNING item_id") ? [{ item_id: "inv_1" }] : [],
      })),
    };
    const handlers = buildMarketplaceInventoryProjectionHandlers(db as never, { onInventoryItemChanged });

    await handlers["inventory.hold.placed"]!(
      event("inventory.hold.placed", {
        holdId: "hld_order_reservation_rsv_1",
        accountId: "acc_seller",
        itemId: "inv_1",
        quantity: 1,
        reason: "Ordering commitment",
        notes: null,
        purpose: "order",
        sourceRef: {
          orderId: "ord_1",
          reservationRequestId: "rsv_1",
        },
        expiresAt: null,
      }),
    );
    await handlers["inventory.hold.released"]!(
      event(
        "inventory.hold.released",
        {
          holdId: "hld_order_reservation_rsv_1",
          releasedAt: "2026-07-06T01:00:00.000Z",
          releaseReason: "order-cancelled",
        },
        "inventory.hold-hld_order_reservation_rsv_1",
      ),
    );

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("source_ref"), [
      "hld_order_reservation_rsv_1",
      "acc_seller",
      "inv_1",
      1,
      "order",
      JSON.stringify({
        orderId: "ord_1",
        reservationRequestId: "rsv_1",
      }),
      null,
      1,
      "2026-05-09T00:00:00.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("release_reason = $4"), [
      "hld_order_reservation_rsv_1",
      "released",
      "2026-07-06T01:00:00.000Z",
      "order-cancelled",
      "2026-05-09T00:00:00.000Z",
      1,
    ]);
    expect(onInventoryItemChanged).toHaveBeenCalledWith("inv_1");
  });

  it("maps legacy order hold reasons into the marketplace mirror", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildMarketplaceInventoryProjectionHandlers(db as never);

    await handlers["inventory.hold.placed"]!(
      event("inventory.hold.placed", {
        holdId: "hld_order_reservation_rsv_1",
        accountId: "acc_seller",
        itemId: "inv_1",
        quantity: 1,
        reason: "Ordering commitment",
        notes: null,
      }),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("marketplace_supply_holds"), [
      "hld_order_reservation_rsv_1",
      "acc_seller",
      "inv_1",
      1,
      "order",
      null,
      null,
      1,
      "2026-05-09T00:00:00.000Z",
    ]);
  });
});
