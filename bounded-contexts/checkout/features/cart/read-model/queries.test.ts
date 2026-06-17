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
  product_summary: string | null;
  status: string;
  seller_slug: string | null;
  seller_display_name: string | null;
  seller_average_rating: string | null;
  seller_review_count: number | null;
}>;

/**
 * In-memory fake `PgQueryable` that interprets the `listCartLines` SQL: it
 * joins cart line pages against the seller-options table applying the
 * `status = 'active'` filter, maps `available_quantity := listing_quantity_cap`,
 * and orders cheapest-first — mirroring the LATERAL aggregate so the join
 * semantics (active-only, price-ascending, empty -> []) are actually exercised.
 */
class CartReadModelDb implements PgQueryable {
  constructor(
    private readonly lines: readonly CartLinePage[],
    private readonly options: readonly SellerOption[],
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
          .filter((option) => option.product_id === line.product_id && option.status === "active")
          .sort(
            (left, right) =>
              Number(left.price_amount) - Number(right.price_amount) || left.listing_id.localeCompare(right.listing_id),
          )
          .map((option) => ({
            listing_id: option.listing_id,
            seller_account_id: option.seller_account_id,
            seller_slug: option.seller_slug,
            seller_display_name: option.seller_display_name,
            seller_average_rating: option.seller_average_rating,
            seller_review_count: option.seller_review_count ?? 0,
            price_amount: option.price_amount,
            available_quantity: option.listing_quantity_cap,
            product_summary: option.product_summary,
          })),
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
    // available_quantity is sourced from listing_quantity_cap for this wave.
    expect(row?.seller_options[0]).toMatchObject({
      listing_id: "lst_locked",
      price_amount: "25.00",
      available_quantity: 3,
      seller_review_count: 0,
    });
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

  it("builds the LATERAL join against the active seller-options projection", async () => {
    const db = new CartReadModelDb([line()], []);

    await listCartLines(db, "acc_buyer");

    expect(db.lastSql).toContain("LEFT JOIN LATERAL");
    expect(db.lastSql).toContain("FROM checkout_marketplace_seller_options o");
    expect(db.lastSql).toContain("o.product_id = line.product_id");
    expect(db.lastSql).toContain("o.status = 'active'");
    expect(db.lastSql).toContain("ORDER BY o.price_amount ASC");
    // available_quantity must be sourced from the listing quantity cap this wave.
    expect(db.lastSql).toContain("'available_quantity', o.listing_quantity_cap");
    // numeric columns must be cast to text to match the row type.
    expect(db.lastSql).toContain("o.price_amount::text");
    expect(db.lastSql).toContain("o.seller_average_rating::text");
    expect(db.lastSql).toContain("'[]'::json");
  });
});
