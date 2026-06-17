import { describe, expect, it } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { listCartLines } from "./queries";

type CartLinePage = Readonly<{
  buyer_account_id: string;
  line_id: string;
  product_id: string;
  fulfillment_mode: string;
  locked_listing_id: string | null;
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
  status: string;
  seller_slug: string | null;
  seller_display_name: string | null;
  seller_average_rating: string | null;
  seller_review_count: number | null;
}>;

type SellerAccount = Readonly<{
  account_id: string;
  display_name: string;
  slug: string;
}>;

function holdsAccurateAvailableQuantity(option: SellerOption): number {
  return Math.min(
    option.listing_quantity_cap,
    Math.max((option.supply_total_quantity ?? 0) - (option.active_held_quantity ?? 0), 0),
  );
}

/**
 * In-memory fake `PgQueryable` that interprets the `listCartLines` SQL: it
 * joins cart line pages against the seller-options table applying the
 * `status = 'active'` filter, computes the holds-accurate
 * `available_quantity = LEAST(listing_quantity_cap, GREATEST(supply - holds, 0))`,
 * LEFT JOINs the identity-maintained `checkout_seller_accounts` table by
 * `seller_account_id` to resolve `seller_display_name` / `seller_slug`
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

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.lastSql = sql;
    const buyerAccountId = String(values[0]);
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
              holdsAccurateAvailableQuantity(option) > 0,
          )
          .sort(
            (left, right) =>
              Number(left.price_amount) - Number(right.price_amount) || left.listing_id.localeCompare(right.listing_id),
          )
          .map((option) => {
            const account = this.accounts.find((entry) => entry.account_id === option.seller_account_id);
            return {
              listing_id: option.listing_id,
              seller_account_id: option.seller_account_id,
              // COALESCE(seller.slug, o.seller_slug): join table wins, then denormalized column.
              seller_slug: account?.slug ?? option.seller_slug,
              seller_display_name: account?.display_name ?? option.seller_display_name,
              seller_average_rating: option.seller_average_rating,
              seller_review_count: option.seller_review_count ?? 0,
              price_amount: option.price_amount,
              available_quantity: holdsAccurateAvailableQuantity(option),
              product_summary: option.product_summary,
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
    availability_state: "available",
    updated_at: "2026-06-16T00:00:00.000Z",
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
    status: "active",
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
    });
  });

  it("computes holds-accurate available_quantity as LEAST(cap, GREATEST(supply - holds, 0))", async () => {
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

  it("excludes listings whose active holds meet or exceed supply (not falsely ready)", async () => {
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
        // Supply not yet projected: NULL counters -> available 0 -> excluded (fail-safe).
        option({
          listing_id: "lst_unknown_supply",
          listing_quantity_cap: 5,
          supply_total_quantity: null,
          active_held_quantity: null,
        }),
      ],
    );

    const [row] = await listCartLines(db, "acc_buyer");

    expect(row?.seller_options.map((sellerOption) => sellerOption.listing_id)).toEqual(["lst_ready"]);
    expect(row?.seller_options[0]).toMatchObject({ listing_id: "lst_ready", available_quantity: 3 });
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

  it("yields empty options when a product has no active listings", async () => {
    const db = new CartReadModelDb([line({ product_id: "prd_empty" })], [option({ product_id: "prd_other" })]);

    const [row] = await listCartLines(db, "acc_buyer");

    expect(row?.seller_options).toEqual([]);
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
    expect(db.lastSql).toContain("FROM checkout_marketplace_seller_options o");
    // Seller identity (display name / slug) is resolved through the identity-maintained
    // seller-accounts join table, with the denormalized columns as a fallback.
    expect(db.lastSql).toContain("LEFT JOIN checkout_seller_accounts seller");
    expect(db.lastSql).toContain("seller.account_id = o.seller_account_id");
    expect(db.lastSql).toContain("COALESCE(seller.slug, o.seller_slug)");
    expect(db.lastSql).toContain("COALESCE(seller.display_name, o.seller_display_name)");
    expect(db.lastSql).toContain("o.product_id = line.product_id");
    expect(db.lastSql).toContain("o.status = 'active'");
    expect(db.lastSql).toContain("ORDER BY o.price_amount ASC");
    // available_quantity must be holds-accurate: capped by the listing quantity
    // cap and reduced by active holds against the inventory supply.
    expect(db.lastSql).toContain(
      "GREATEST(COALESCE(o.supply_total_quantity, 0) - COALESCE(o.active_held_quantity, 0), 0)",
    );
    expect(db.lastSql).toContain("LEAST(");
    expect(db.lastSql).toContain("o.listing_quantity_cap");
    // Sold-out / fully-held listings (available_quantity not > 0) are excluded.
    expect(db.lastSql).toContain(") > 0");
    // numeric columns must be cast to text to match the row type.
    expect(db.lastSql).toContain("o.price_amount::text");
    expect(db.lastSql).toContain("o.seller_average_rating::text");
    expect(db.lastSql).toContain("'[]'::json");
  });
});
