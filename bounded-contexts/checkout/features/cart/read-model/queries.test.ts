import { describe, expect, it } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { CART_SELLER_OPTIONS_PER_LINE_LIMIT, listCartLines } from "./queries";

type CartLinePage = Readonly<{
  buyer_account_id: string;
  line_id: string;
  product_id: string;
  fulfillment_mode: string;
  locked_listing_id: string | null;
  selected_listing_id: string | null;
  selected_listing_seller_account_id: string | null;
  selected_listing_seller_display_name: string | null;
  selected_listing_seller_slug: string | null;
  selected_listing_price_amount: string | null;
  selected_listing_snapshot_source: string | null;
  selected_listing_snapshot_captured_at: string | null;
  availability_state: string;
  updated_at: string;
}>;

type SellerOption = Readonly<{
  listing_id: string;
  seller_account_id: string | null;
  product_id: string;
  price_amount: string;
  listing_quantity_cap: number;
  supply_total_quantity: number | null;
  active_held_quantity: number | null;
  product_summary: string | null;
  product_measure_snapshot: Readonly<Record<string, unknown>> | null;
  status: string;
  at_capacity: boolean;
  seller_slug: string | null;
  seller_display_name: string | null;
  seller_average_rating: string | null;
  seller_review_count: number | null;
}>;

type SellerAccount = Readonly<{
  account_id: string;
  display_name: string;
  slug: string;
  average_rating?: string | null;
  review_count?: number | null;
}>;

function holdsAccurateAvailableQuantity(option: SellerOption): number {
  return Math.min(
    option.listing_quantity_cap,
    Math.max((option.supply_total_quantity ?? option.listing_quantity_cap) - (option.active_held_quantity ?? 0), 0),
  );
}

/**
 * In-memory fake `PgQueryable` that interprets the `listCartLines` SQL: it
 * joins cart line pages against the seller-options table applying the
 * `status = 'active' AND at_capacity = false` filter (m127 #4883 -- an
 * at-capacity seller's listing drops the same way an inactive one does),
 * computes the holds-accurate
 * `available_quantity = LEAST(listing_quantity_cap, GREATEST(COALESCE(supply, cap) - holds, 0))`,
 * LEFT JOINs the identity/reputation-maintained `checkout_seller_accounts`
 * table by `seller_account_id` to resolve `seller_display_name` / `seller_slug`
 * and the reputation counters `seller_average_rating` / `seller_review_count`
 * (falling back to the denormalized option columns when no account row exists),
 * excludes options whose available quantity is not `> 0`, and orders
 * cheapest-first — mirroring the LATERAL aggregate so the join semantics
 * (active-only, holds-accurate availability, sold-out exclusion, seller-identity
 * resolution, price-ascending, empty -> []) are actually exercised.
 */
class CartReadModelDb implements PgQueryable {
  constructor(
    private readonly lines: readonly CartLinePage[],
    private readonly options: readonly SellerOption[],
    private readonly accounts: readonly SellerAccount[] = [],
  ) {}

  public lastSql = "";
  public lastValues: readonly unknown[] = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.lastSql = sql;
    this.lastValues = values;
    const buyerAccountId = String(values[0]);
    const sellerOptionsLimit = Number(values[1]);
    const rows = this.lines
      .filter((line) => line.buyer_account_id === buyerAccountId)
      .sort(
        (left, right) => right.updated_at.localeCompare(left.updated_at) || left.line_id.localeCompare(right.line_id),
      )
      .map((line) => ({
        ...line,
        seller_options: this.options
          .filter(
            (option) =>
              option.product_id === line.product_id &&
              option.status === "active" &&
              !option.at_capacity &&
              holdsAccurateAvailableQuantity(option) > 0,
          )
          .sort(
            (left, right) =>
              Number(left.price_amount) - Number(right.price_amount) || left.listing_id.localeCompare(right.listing_id),
          )
          .slice(0, Number.isFinite(sellerOptionsLimit) ? sellerOptionsLimit : this.options.length)
          .map((option) => {
            const account = this.accounts.find((entry) => entry.account_id === option.seller_account_id);
            return {
              listing_id: option.listing_id,
              seller_account_id: option.seller_account_id,
              // COALESCE(seller.slug, o.seller_slug): join table wins, then denormalized column.
              seller_slug: account?.slug ?? option.seller_slug,
              seller_display_name: account?.display_name ?? option.seller_display_name,
              // COALESCE(seller.average_rating, o.seller_average_rating): the
              // reputation-maintained join column wins, then the denormalized fallback.
              seller_average_rating: account?.average_rating ?? option.seller_average_rating,
              seller_review_count: account?.review_count ?? option.seller_review_count ?? 0,
              price_amount: option.price_amount,
              available_quantity: holdsAccurateAvailableQuantity(option),
              product_summary: option.product_summary,
              product_measure_snapshot: option.product_measure_snapshot,
            };
          }),
      }));

    return { rows: rows as Row[], rowCount: rows.length };
  }
}

function line(overrides: Partial<CartLinePage> = {}): CartLinePage {
  return {
    buyer_account_id: "acc_buyer",
    line_id: "cli_1",
    product_id: "prd_1",
    fulfillment_mode: "locked-listing",
    locked_listing_id: "lst_locked",
    selected_listing_id: null,
    selected_listing_seller_account_id: null,
    selected_listing_seller_display_name: null,
    selected_listing_seller_slug: null,
    selected_listing_price_amount: null,
    selected_listing_snapshot_source: null,
    selected_listing_snapshot_captured_at: null,
    availability_state: "available",
    updated_at: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function productMeasureSnapshot(overrides: Partial<Readonly<Record<string, unknown>>> = {}) {
  return {
    catalogItemId: "cat_1",
    productId: "prd_1",
    selectedOptions: [],
    measureVersion: "pm_test_raw_v1",
    unitLengthInches: 3.5,
    unitWidthInches: 2.5,
    unitHeightInches: 0.02,
    unitWeightOunces: 0.08,
    physicalFlags: ["raw-card"],
    stackBehavior: "stackable-thickness",
    source: "profile",
    confidence: "measured",
    ...overrides,
  };
}

function option(overrides: Partial<SellerOption> = {}): SellerOption {
  return {
    listing_id: "lst_locked",
    seller_account_id: null,
    product_id: "prd_1",
    price_amount: "25.00",
    listing_quantity_cap: 3,
    // Ample supply with no holds by default so the quantity cap is the binding
    // constraint; individual cases override supply/holds to exercise the formula.
    supply_total_quantity: 100,
    active_held_quantity: 0,
    product_summary: "Raw",
    product_measure_snapshot: productMeasureSnapshot(),
    status: "active",
    at_capacity: false,
    seller_slug: null,
    seller_display_name: null,
    seller_average_rating: null,
    seller_review_count: null,
    ...overrides,
  };
}

describe("listCartLines seller_options join", () => {
  it("joins active seller options into each cart line cheapest-first", async () => {
    const db = new CartReadModelDb(
      [line()],
      [
        option({ listing_id: "lst_high", price_amount: "30.00", listing_quantity_cap: 2 }),
        option({ listing_id: "lst_locked", price_amount: "25.00", listing_quantity_cap: 3 }),
      ],
    );

    const [row] = await listCartLines(db, "acc_buyer");

    expect(row?.seller_options.map((sellerOption) => sellerOption.listing_id)).toEqual(["lst_locked", "lst_high"]);
    // available_quantity is capped by listing_quantity_cap when supply is ample.
    expect(row?.seller_options[0]).toMatchObject({
      listing_id: "lst_locked",
      price_amount: "25.00",
      available_quantity: 3,
      seller_review_count: 0,
      product_measure_snapshot: productMeasureSnapshot(),
    });
  });

  it("computes holds-accurate available_quantity as LEAST(cap, GREATEST(COALESCE(supply, cap) - holds, 0))", async () => {
    const db = new CartReadModelDb(
      [line()],
      [
        // Supply minus holds (8 - 3 = 5) is below the cap (10) -> available 5.
        option({
          listing_id: "lst_supply_bound",
          listing_quantity_cap: 10,
          supply_total_quantity: 8,
          active_held_quantity: 3,
        }),
        // Cap (2) is below supply minus holds (20 - 1 = 19) -> available 2.
        option({
          listing_id: "lst_cap_bound",
          price_amount: "30.00",
          listing_quantity_cap: 2,
          supply_total_quantity: 20,
          active_held_quantity: 1,
        }),
      ],
    );

    const [row] = await listCartLines(db, "acc_buyer");

    expect(row?.seller_options).toEqual([
      expect.objectContaining({ listing_id: "lst_supply_bound", available_quantity: 5 }),
      expect.objectContaining({ listing_id: "lst_cap_bound", available_quantity: 2 }),
    ]);
  });

  it("excludes listings whose active holds meet or exceed projected supply (not falsely ready)", async () => {
    const db = new CartReadModelDb(
      [line()],
      [
        option({ listing_id: "lst_ready", listing_quantity_cap: 5, supply_total_quantity: 5, active_held_quantity: 2 }),
        // Fully held: holds (4) >= supply (4) -> available 0 -> excluded.
        option({
          listing_id: "lst_fully_held",
          listing_quantity_cap: 5,
          supply_total_quantity: 4,
          active_held_quantity: 4,
        }),
        // Sold out: zero supply -> available 0 -> excluded.
        option({
          listing_id: "lst_sold_out",
          listing_quantity_cap: 5,
          supply_total_quantity: 0,
          active_held_quantity: 0,
        }),
        // Inventory supply is not projected yet, but holds already consume the
        // listing cap -> available 0 -> excluded.
        option({
          listing_id: "lst_pending_supply_fully_held",
          listing_quantity_cap: 5,
          supply_total_quantity: null,
          active_held_quantity: 5,
        }),
      ],
    );

    const [row] = await listCartLines(db, "acc_buyer");

    expect(row?.seller_options.map((sellerOption) => sellerOption.listing_id)).toEqual(["lst_ready"]);
    expect(row?.seller_options[0]).toMatchObject({ listing_id: "lst_ready", available_quantity: 3 });
  });

  it("uses the active marketplace listing cap while inventory supply counters are not projected yet", async () => {
    const db = new CartReadModelDb(
      [line()],
      [
        option({
          listing_id: "lst_active_waiting_projection",
          listing_quantity_cap: 1,
          supply_total_quantity: null,
          active_held_quantity: null,
        }),
      ],
    );

    const [row] = await listCartLines(db, "acc_buyer");

    expect(row?.seller_options).toEqual([
      expect.objectContaining({
        listing_id: "lst_active_waiting_projection",
        available_quantity: 1,
      }),
    ]);
  });

  it("excludes non-active listings (seller-unavailable / withdrawn / paused / draft)", async () => {
    const db = new CartReadModelDb(
      [line()],
      [
        option({ listing_id: "lst_active", status: "active" }),
        option({ listing_id: "lst_gone", status: "seller-unavailable" }),
        option({ listing_id: "lst_withdrawn", status: "withdrawn" }),
        option({ listing_id: "lst_paused", status: "paused" }),
        option({ listing_id: "lst_draft", status: "draft" }),
      ],
    );

    const [row] = await listCartLines(db, "acc_buyer");

    expect(row?.seller_options.map((sellerOption) => sellerOption.listing_id)).toEqual(["lst_active"]);
  });

  it("excludes at-capacity listings from candidates, including the locked listing (m127 #4883)", async () => {
    const db = new CartReadModelDb(
      [line({ locked_listing_id: "lst_at_capacity" })],
      [
        option({ listing_id: "lst_at_capacity", at_capacity: true }),
        option({ listing_id: "lst_open", price_amount: "30.00", at_capacity: false }),
      ],
    );

    const [row] = await listCartLines(db, "acc_buyer");

    // The locked listing is absent from `seller_options` entirely -- the
    // same shape a withdrawn/gone listing produces, which
    // `selectedCartReadinessListing` (readiness.ts) already interprets as
    // "locked listing gone" and flags the line unavailable before order
    // creation, with zero changes needed to readiness itself.
    expect(row?.seller_options.map((sellerOption) => sellerOption.listing_id)).toEqual(["lst_open"]);
  });

  it("yields empty options when a product has no active listings", async () => {
    const db = new CartReadModelDb([line({ product_id: "prd_empty" })], [option({ product_id: "prd_other" })]);

    const [row] = await listCartLines(db, "acc_buyer");

    expect(row?.seller_options).toEqual([]);
  });

  it("bounds seller options per cart line to the documented top-N price candidates", async () => {
    const options = Array.from({ length: CART_SELLER_OPTIONS_PER_LINE_LIMIT + 3 }, (_, index) =>
      option({
        listing_id: `lst_${String(index).padStart(2, "0")}`,
        price_amount: String(index + 1).padStart(2, "0") + ".00",
      }),
    );
    const db = new CartReadModelDb([line()], options);

    const [row] = await listCartLines(db, "acc_buyer");

    expect(row?.seller_options).toHaveLength(CART_SELLER_OPTIONS_PER_LINE_LIMIT);
    expect(row?.seller_options.at(0)).toMatchObject({ listing_id: "lst_00", price_amount: "01.00" });
    expect(row?.seller_options.at(-1)).toMatchObject({
      listing_id: `lst_${String(CART_SELLER_OPTIONS_PER_LINE_LIMIT - 1).padStart(2, "0")}`,
      price_amount: String(CART_SELLER_OPTIONS_PER_LINE_LIMIT).padStart(2, "0") + ".00",
    });
  });

  it("exposes selected listing snapshot fields independently of current seller options", async () => {
    const db = new CartReadModelDb(
      [
        line({
          product_id: "prd_empty",
          locked_listing_id: "lst_snapshot",
          selected_listing_id: "lst_snapshot",
          selected_listing_seller_account_id: "acc_snapshot",
          selected_listing_seller_display_name: "Snapshot Seller",
          selected_listing_seller_slug: "snapshot-seller",
          selected_listing_price_amount: "42.00",
          selected_listing_snapshot_source: "discovery.item-detail.add-to-cart",
          selected_listing_snapshot_captured_at: "2026-06-18T00:00:00.000Z",
        }),
      ],
      [option({ product_id: "prd_other" })],
    );

    const [row] = await listCartLines(db, "acc_buyer");

    expect(row).toMatchObject({
      locked_listing_id: "lst_snapshot",
      selected_listing_id: "lst_snapshot",
      selected_listing_seller_account_id: "acc_snapshot",
      selected_listing_seller_display_name: "Snapshot Seller",
      selected_listing_seller_slug: "snapshot-seller",
      selected_listing_price_amount: "42.00",
      selected_listing_snapshot_source: "discovery.item-detail.add-to-cart",
      selected_listing_snapshot_captured_at: "2026-06-18T00:00:00.000Z",
      seller_options: [],
    });
  });

  it("carries seller display name and slug resolved from the identity seller-accounts join", async () => {
    const db = new CartReadModelDb(
      [line()],
      [option({ listing_id: "lst_locked", seller_account_id: "acc_seller", price_amount: "25.00" })],
      [{ account_id: "acc_seller", display_name: "Card Vault", slug: "card-vault-acc-seller" }],
    );

    const [row] = await listCartLines(db, "acc_buyer");

    expect(row?.seller_options[0]).toMatchObject({
      listing_id: "lst_locked",
      seller_account_id: "acc_seller",
      seller_display_name: "Card Vault",
      seller_slug: "card-vault-acc-seller",
    });
  });

  it("carries seller average rating and review count resolved from the seller-accounts join", async () => {
    const db = new CartReadModelDb(
      [line()],
      [option({ listing_id: "lst_locked", seller_account_id: "acc_seller", price_amount: "25.00" })],
      [
        {
          account_id: "acc_seller",
          display_name: "Card Vault",
          slug: "card-vault-acc-seller",
          average_rating: "4.90",
          review_count: 12,
        },
      ],
    );

    const [row] = await listCartLines(db, "acc_buyer");

    expect(row?.seller_options[0]).toMatchObject({
      seller_account_id: "acc_seller",
      seller_average_rating: "4.90",
      seller_review_count: 12,
    });
  });

  it("yields a null rating and zero review count for a seller with no reviews yet", async () => {
    const db = new CartReadModelDb(
      [line()],
      [option({ listing_id: "lst_locked", seller_account_id: "acc_seller", price_amount: "25.00" })],
      [
        {
          account_id: "acc_seller",
          display_name: "New Seller",
          slug: "new-seller-acc-seller",
          average_rating: null,
          review_count: 0,
        },
      ],
    );

    const [row] = await listCartLines(db, "acc_buyer");

    expect(row?.seller_options[0]).toMatchObject({
      seller_average_rating: null,
      seller_review_count: 0,
    });
  });

  it("leaves seller display name and slug null when no identity account row exists yet", async () => {
    const db = new CartReadModelDb(
      [line()],
      [option({ listing_id: "lst_locked", seller_account_id: "acc_unknown", price_amount: "25.00" })],
      [],
    );

    const [row] = await listCartLines(db, "acc_buyer");

    expect(row?.seller_options[0]).toMatchObject({
      seller_account_id: "acc_unknown",
      seller_display_name: null,
      seller_slug: null,
    });
  });

  it("builds the LATERAL join against the active seller-options projection", async () => {
    const db = new CartReadModelDb([line()], []);

    await listCartLines(db, "acc_buyer");

    expect(db.lastSql).toContain("LEFT JOIN LATERAL");
    expect(db.lastValues).toEqual(["acc_buyer", CART_SELLER_OPTIONS_PER_LINE_LIMIT]);
    expect(db.lastSql).toContain("FROM checkout_marketplace_seller_options option");
    // Seller identity (display name / slug) is resolved through the identity-maintained
    // seller-accounts join table, with the denormalized columns as a fallback.
    expect(db.lastSql).toContain("LEFT JOIN checkout_seller_accounts seller");
    expect(db.lastSql).toContain("seller.account_id = o.seller_account_id");
    expect(db.lastSql).toContain("COALESCE(seller.slug, o.seller_slug)");
    expect(db.lastSql).toContain("COALESCE(seller.display_name, o.seller_display_name)");
    // Seller reputation (average rating / review count) is resolved through the
    // same seller-accounts join table, with the denormalized columns as fallback.
    expect(db.lastSql).toContain("COALESCE(seller.average_rating, o.seller_average_rating)::text");
    expect(db.lastSql).toContain("COALESCE(seller.review_count, o.seller_review_count, 0)");
    expect(db.lastSql).toContain("line.selected_listing_id");
    expect(db.lastSql).toContain("line.selected_listing_price_amount::text AS selected_listing_price_amount");
    expect(db.lastSql).toContain(
      "line.selected_listing_snapshot_captured_at::text AS selected_listing_snapshot_captured_at",
    );
    expect(db.lastSql).toContain("option.product_id = line.product_id");
    expect(db.lastSql).toContain("option.status = 'active'");
    expect(db.lastSql).toContain("ORDER BY option.price_amount ASC, option.listing_id ASC");
    expect(db.lastSql).toContain("LIMIT $2");
    // available_quantity must be holds-accurate: capped by the listing quantity
    // cap, reduced by active holds, and backed by the marketplace cap while
    // inventory supply counters are still catching up.
    expect(db.lastSql).toContain(
      "COALESCE(o.supply_total_quantity, o.listing_quantity_cap) - COALESCE(o.active_held_quantity, 0)",
    );
    expect(db.lastSql).toContain("LEAST(");
    expect(db.lastSql).toContain("o.listing_quantity_cap");
    // Sold-out / fully-held listings (available_quantity not > 0) are excluded.
    expect(db.lastSql).toContain(") > 0");
    // numeric columns must be cast to text to match the row type.
    expect(db.lastSql).toContain("o.price_amount::text");
    expect(db.lastSql).toContain("'[]'::json");
  });
});
