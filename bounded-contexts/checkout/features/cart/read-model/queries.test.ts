import { describe, expect, it } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { CART_SELLER_OPTIONS_PER_LINE_LIMIT, listCartLines, listOwnCartLines } from "./queries";

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

type CartClaim = Readonly<{
  source_owner_key: string;
  account_id: string;
}>;

type SellerAccount = Readonly<{
  account_id: string;
  display_name: string;
  slug: string;
  average_rating?: string | null;
  review_count?: number | null;
}>;

// COLLATE "C" is byte ordering; JS string comparison matches it for these keys.
function compareOwnerKeyBytes(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
 *
 * It also interprets the requested-owner expansion: the primary owner key, the
 * claimed source keys of an `acc_` owner when claim expansion is on, and the
 * optional presented key, deduplicated to the strongest precedence before
 * ranking. Winner selection and output order are modelled separately, because
 * they are different orderings: the winner is the strongest precedence, then the
 * newest row, then the byte-smallest source owner (`COLLATE "C"`), while output
 * puts the Account union ahead of presented-only rows.
 *
 * This interpreter is a shape check, not the oracle. Selection and ordering are
 * proved against real PostgreSQL in `seller-options-readiness.db.test.ts`.
 */
class CartReadModelDb implements PgQueryable {
  constructor(
    private readonly lines: readonly CartLinePage[],
    private readonly options: readonly SellerOption[],
    private readonly accounts: readonly SellerAccount[] = [],
    private readonly claims: readonly CartClaim[] = [],
  ) {}

  public lastSql = "";
  public lastValues: readonly unknown[] = [];
  public queryCount = 0;

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.lastSql = sql;
    this.lastValues = values;
    this.queryCount += 1;
    const ownerKey = String(values[0]);
    const presentedAnonymousCartId = values[1] === null || values[1] === undefined ? null : String(values[1]);
    const sellerOptionsLimit = Number(values[2]);
    const includeClaimedOwners = Boolean(values[3]);
    const candidateOwners: Array<{ ownerId: string; precedence: number }> = [{ ownerId: ownerKey, precedence: 0 }];

    if (includeClaimedOwners && ownerKey.startsWith("acc_")) {
      for (const claim of this.claims) {
        if (claim.account_id === ownerKey) {
          candidateOwners.push({ ownerId: claim.source_owner_key, precedence: 1 });
        }
      }
    }
    if (presentedAnonymousCartId) {
      candidateOwners.push({ ownerId: presentedAnonymousCartId, precedence: 2 });
    }

    // MIN(owner_precedence) GROUP BY owner_id: one requested owner per key.
    const requestedOwners = new Map<string, number>();
    for (const candidate of candidateOwners) {
      const existing = requestedOwners.get(candidate.ownerId);
      requestedOwners.set(
        candidate.ownerId,
        existing === undefined ? candidate.precedence : Math.min(existing, candidate.precedence),
      );
    }
    const precedenceOf = (line: CartLinePage) => requestedOwners.get(line.buyer_account_id) ?? Number.MAX_SAFE_INTEGER;
    const outputGroupOf = (line: CartLinePage) => (precedenceOf(line) <= 1 ? 0 : 1);
    const seenLineIds = new Set<string>();
    const rows = this.lines
      .filter((line) => requestedOwners.has(line.buyer_account_id))
      .slice()
      // ROW_NUMBER() OVER (PARTITION BY line_id ORDER BY owner_precedence ASC,
      // updated_at DESC, owner_id COLLATE "C" ASC)
      .sort(
        (left, right) =>
          precedenceOf(left) - precedenceOf(right) ||
          right.updated_at.localeCompare(left.updated_at) ||
          compareOwnerKeyBytes(left.buyer_account_id, right.buyer_account_id),
      )
      .filter((line) => {
        if (seenLineIds.has(line.line_id)) {
          return false;
        }
        seenLineIds.add(line.line_id);
        return true;
      })
      // ORDER BY owner_output_group ASC, updated_at DESC, line_id ASC
      .sort(
        (left, right) =>
          outputGroupOf(left) - outputGroupOf(right) ||
          right.updated_at.localeCompare(left.updated_at) ||
          left.line_id.localeCompare(right.line_id),
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
  it("resolves Account plus presented anonymous lines in one query with Account whole-row precedence", async () => {
    const accountWinner = line({
      buyer_account_id: "acc_buyer",
      line_id: "cli_shared",
      product_id: "prd_account",
      locked_listing_id: "lst_account",
      updated_at: "2026-06-10T00:00:00.000Z",
    });
    const anonymousLoser = line({
      buyer_account_id: "anon_cart",
      line_id: "cli_shared",
      product_id: "prd_anonymous",
      locked_listing_id: "lst_anonymous",
      updated_at: "2026-06-20T00:00:00.000Z",
    });
    const accountOnly = line({
      line_id: "cli_account",
      product_id: "prd_same",
      updated_at: "2026-06-11T00:00:00.000Z",
    });
    const anonymousOnly = line({
      buyer_account_id: "anon_cart",
      line_id: "cli_anonymous",
      product_id: "prd_same",
      updated_at: "2026-06-30T00:00:00.000Z",
    });
    const db = new CartReadModelDb([anonymousOnly, anonymousLoser, accountWinner, accountOnly], []);

    const rows = await listCartLines(db, "acc_buyer", "anon_cart");

    expect(db.queryCount).toBe(1);
    expect(db.lastValues).toEqual(["acc_buyer", "anon_cart", CART_SELLER_OPTIONS_PER_LINE_LIMIT, true]);
    expect(rows.map((row) => row.line_id)).toEqual(["cli_account", "cli_shared", "cli_anonymous"]);
    expect(rows.find((row) => row.line_id === "cli_shared")).toMatchObject({
      buyer_account_id: "acc_buyer",
      product_id: "prd_account",
      locked_listing_id: "lst_account",
    });
    expect(rows.filter((row) => row.product_id === "prd_same")).toHaveLength(2);
  });

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
    expect(db.lastValues).toEqual(["acc_buyer", null, CART_SELLER_OPTIONS_PER_LINE_LIMIT, true]);
    expect(db.lastSql).toContain("WITH requested_owners AS");
    // Requested owners are deduplicated to one row per key before ranking, so a
    // key that is both claimed and presented cannot multiply rows.
    expect(db.lastSql).toContain("MIN(candidate_owner.owner_precedence) AS owner_precedence");
    expect(db.lastSql).toContain("GROUP BY candidate_owner.owner_id");
    expect(db.lastSql).toContain("FROM checkout_cart_claims AS claim");
    expect(db.lastSql).toContain("starts_with($1::text, 'acc_')");
    expect(db.lastSql).toContain("claim.account_id = $1::text");
    expect(db.lastSql).toContain("PARTITION BY cart_line.line_id");
    expect(db.lastSql).toContain("requested_owner.owner_precedence ASC");
    expect(db.lastSql).toContain("cart_line.updated_at DESC");
    expect(db.lastSql).toContain('requested_owner.owner_id COLLATE "C" ASC');
    expect(db.lastSql).toContain("WHERE ranked_line.owner_line_rank = 1");
    expect(db.lastSql).toContain("CASE WHEN ranked_line.owner_precedence <= 1 THEN 0 ELSE 1 END AS owner_output_group");
    expect(db.lastSql).toContain("ORDER BY line.owner_output_group ASC, line.updated_at DESC, line.line_id ASC");
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
    expect(db.lastSql).toContain("COALESCE(seller.rating_count, o.seller_review_count, 0)");
    expect(db.lastSql).toContain("line.selected_listing_id");
    expect(db.lastSql).toContain("line.selected_listing_price_amount::text AS selected_listing_price_amount");
    expect(db.lastSql).toContain(
      "line.selected_listing_snapshot_captured_at::text AS selected_listing_snapshot_captured_at",
    );
    expect(db.lastSql).toContain("option.product_id = line.product_id");
    expect(db.lastSql).toContain("option.status = 'active'");
    expect(db.lastSql).toContain("ORDER BY option.price_amount ASC, option.listing_id ASC");
    expect(db.lastSql).toContain("LIMIT $3");
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

describe("listCartLines claimed-key expansion", () => {
  const account = "acc_buyer";
  const claimedA = "anon_cart_a";
  const claimedB = "anon_cart_b";
  const presented = "anon_presented";
  const claims: readonly CartClaim[] = [
    { source_owner_key: claimedA, account_id: account },
    { source_owner_key: claimedB, account_id: account },
  ];

  it("resolves own, claimed and presented owners in one query and keeps the Account union first", async () => {
    const own = line({ line_id: "cli_own", updated_at: "2026-06-10T00:00:00.000Z" });
    const claimed = line({
      buyer_account_id: claimedA,
      line_id: "cli_claimed",
      updated_at: "2026-06-20T00:00:00.000Z",
    });
    const presentedOnly = line({
      buyer_account_id: presented,
      line_id: "cli_presented",
      updated_at: "2026-06-30T00:00:00.000Z",
    });
    const db = new CartReadModelDb([presentedOnly, own, claimed], [], [], claims);

    const rows = await listCartLines(db, account, presented);

    expect(db.queryCount).toBe(1);
    expect(db.lastValues).toEqual([account, presented, CART_SELLER_OPTIONS_PER_LINE_LIMIT, true]);
    // Account union (own + claimed) ordered updated_at DESC, then presented-only.
    expect(rows.map((row) => row.line_id)).toEqual(["cli_claimed", "cli_own", "cli_presented"]);
    expect(rows.map((row) => row.buyer_account_id)).toEqual([claimedA, account, presented]);
  });

  it("keeps the Account's own whole row when a line id is duplicated onto a claimed stream", async () => {
    const accountWinner = line({
      buyer_account_id: account,
      line_id: "cli_shared",
      product_id: "prd_account",
      locked_listing_id: "lst_account",
      updated_at: "2026-06-01T00:00:00.000Z",
    });
    const claimedLoser = line({
      buyer_account_id: claimedA,
      line_id: "cli_shared",
      product_id: "prd_claimed",
      locked_listing_id: "lst_claimed",
      updated_at: "2026-06-25T00:00:00.000Z",
    });
    const db = new CartReadModelDb([claimedLoser, accountWinner], [], [], claims);

    const rows = await listCartLines(db, account);

    // Newest does not beat the Account's own row: precedence is ranked first.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      buyer_account_id: account,
      product_id: "prd_account",
      locked_listing_id: "lst_account",
    });
  });

  it("picks the newest claimed row for a divergent duplicate and never mixes columns", async () => {
    const stale = line({
      buyer_account_id: claimedA,
      line_id: "cli_shared",
      product_id: "prd_stale",
      locked_listing_id: "lst_stale",
      quantity: 1,
      updated_at: "2026-06-10T00:00:00.000Z",
    } as Partial<CartLinePage>);
    const newest = line({
      buyer_account_id: claimedB,
      line_id: "cli_shared",
      product_id: "prd_newest",
      locked_listing_id: "lst_newest",
      updated_at: "2026-06-28T00:00:00.000Z",
    });
    const db = new CartReadModelDb([stale, newest], [], [], claims);

    const rows = await listCartLines(db, account);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      buyer_account_id: claimedB,
      product_id: "prd_newest",
      locked_listing_id: "lst_newest",
    });
  });

  it("breaks a claimed timestamp tie on the smallest source owner key", async () => {
    const tieB = line({
      buyer_account_id: claimedB,
      line_id: "cli_shared",
      product_id: "prd_b",
      updated_at: "2026-06-20T00:00:00.000Z",
    });
    const tieA = line({
      buyer_account_id: claimedA,
      line_id: "cli_shared",
      product_id: "prd_a",
      updated_at: "2026-06-20T00:00:00.000Z",
    });
    const db = new CartReadModelDb([tieB, tieA], [], [], claims);

    const rows = await listCartLines(db, account);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ buyer_account_id: claimedA, product_id: "prd_a" });
  });

  it("includes a key that is both claimed and presented exactly once, inside the Account union", async () => {
    const overlap = line({
      buyer_account_id: claimedA,
      line_id: "cli_overlap",
      updated_at: "2026-06-05T00:00:00.000Z",
    });
    const own = line({ line_id: "cli_own", updated_at: "2026-06-06T00:00:00.000Z" });
    const db = new CartReadModelDb([overlap, own], [], [], claims);

    const rows = await listCartLines(db, account, claimedA);

    expect(rows.map((row) => row.line_id)).toEqual(["cli_own", "cli_overlap"]);
    expect(rows.filter((row) => row.line_id === "cli_overlap")).toHaveLength(1);
  });

  it("keeps multiple claimed devices and distinct product lines separate", async () => {
    const deviceA = line({ buyer_account_id: claimedA, line_id: "cli_a", updated_at: "2026-06-10T00:00:00.000Z" });
    const deviceB = line({ buyer_account_id: claimedB, line_id: "cli_b", updated_at: "2026-06-11T00:00:00.000Z" });
    const ownSameProduct = line({ line_id: "cli_own", updated_at: "2026-06-12T00:00:00.000Z" });
    const db = new CartReadModelDb([deviceA, deviceB, ownSameProduct], [], [], claims);

    const rows = await listCartLines(db, account);

    // Same product on three streams with distinct line ids stays three rows.
    expect(rows.map((row) => row.line_id)).toEqual(["cli_own", "cli_b", "cli_a"]);
    expect(rows.every((row) => row.product_id === "prd_1")).toBe(true);
  });

  it("confines claimed keys to the Account that holds them", async () => {
    const claimedLine = line({ buyer_account_id: claimedA, line_id: "cli_claimed" });
    const db = new CartReadModelDb([claimedLine], [], [], claims);

    expect(await listCartLines(db, "acc_unrelated")).toEqual([]);
  });

  it("never expands claimed keys for an anonymous primary owner", async () => {
    const anonymousOwn = line({ buyer_account_id: claimedA, line_id: "cli_claimed" });
    const otherAnonymous = line({ buyer_account_id: claimedB, line_id: "cli_other" });
    const db = new CartReadModelDb(
      [anonymousOwn, otherAnonymous],
      [],
      [],
      [{ source_owner_key: claimedB, account_id: claimedA }],
    );

    const rows = await listCartLines(db, claimedA);

    expect(rows.map((row) => row.line_id)).toEqual(["cli_claimed"]);
  });

  it("returns the shipped rows and order for a zero-claim Account, with and without a presented key", async () => {
    const accountWinner = line({
      buyer_account_id: "acc_buyer",
      line_id: "cli_shared",
      product_id: "prd_account",
      locked_listing_id: "lst_account",
      updated_at: "2026-06-10T00:00:00.000Z",
    });
    const anonymousLoser = line({
      buyer_account_id: "anon_cart",
      line_id: "cli_shared",
      product_id: "prd_anonymous",
      locked_listing_id: "lst_anonymous",
      updated_at: "2026-06-20T00:00:00.000Z",
    });
    const accountOnly = line({ line_id: "cli_account", updated_at: "2026-06-11T00:00:00.000Z" });
    const anonymousOnly = line({
      buyer_account_id: "anon_cart",
      line_id: "cli_anonymous",
      updated_at: "2026-06-30T00:00:00.000Z",
    });
    const rowsFor = (dbClaims: readonly CartClaim[]) =>
      new CartReadModelDb([anonymousOnly, anonymousLoser, accountWinner, accountOnly], [], [], dbClaims);

    expect((await listCartLines(rowsFor([]), "acc_buyer", "anon_cart")).map((row) => row.line_id)).toEqual([
      "cli_account",
      "cli_shared",
      "cli_anonymous",
    ]);
    expect((await listCartLines(rowsFor([]), "acc_buyer")).map((row) => row.line_id)).toEqual([
      "cli_account",
      "cli_shared",
    ]);
    // Claims held by a different Account change nothing here.
    expect(
      (
        await listCartLines(
          rowsFor([{ source_owner_key: "anon_cart", account_id: "acc_other" }]),
          "acc_buyer",
          "anon_cart",
        )
      ).map((row) => row.line_id),
    ).toEqual(["cli_account", "cli_shared", "cli_anonymous"]);
  });

  it("preserves the full seller-option enrichment for a claimed winning row", async () => {
    const claimedLine = line({ buyer_account_id: claimedA, line_id: "cli_claimed", product_id: "prd_1" });
    const db = new CartReadModelDb(
      [claimedLine],
      [
        option({ listing_id: "lst_high", price_amount: "30.00", seller_account_id: "acc_seller" }),
        option({ listing_id: "lst_cheap", price_amount: "20.00", seller_account_id: "acc_seller" }),
        option({ listing_id: "lst_gone", price_amount: "1.00", status: "withdrawn" }),
        option({ listing_id: "lst_full", price_amount: "2.00", supply_total_quantity: 0 }),
      ],
      [
        {
          account_id: "acc_seller",
          display_name: "Card Vault",
          slug: "card-vault",
          average_rating: "4.90",
          review_count: 12,
        },
      ],
      claims,
    );

    const [row] = await listCartLines(db, account);

    expect(row?.buyer_account_id).toBe(claimedA);
    expect(row?.seller_options.map((sellerOption) => sellerOption.listing_id)).toEqual(["lst_cheap", "lst_high"]);
    expect(row?.seller_options[0]).toMatchObject({
      seller_display_name: "Card Vault",
      seller_slug: "card-vault",
      seller_average_rating: "4.90",
      seller_review_count: 12,
      available_quantity: 3,
    });
  });
});

describe("listOwnCartLines", () => {
  const account = "acc_buyer";
  const claimed = "anon_cart_a";
  const claims: readonly CartClaim[] = [{ source_owner_key: claimed, account_id: account }];

  it("resolves only the supplied owner's own lines, with claim expansion off and no presented key", async () => {
    const own = line({ line_id: "cli_own" });
    const claimedLine = line({ buyer_account_id: claimed, line_id: "cli_claimed" });
    const db = new CartReadModelDb([own, claimedLine], [], [], claims);

    const rows = await listOwnCartLines(db, account);

    expect(rows.map((row) => row.line_id)).toEqual(["cli_own"]);
    expect(db.lastValues).toEqual([account, null, CART_SELLER_OPTIONS_PER_LINE_LIMIT, false]);
    expect(db.queryCount).toBe(1);
  });

  it("shares the seller-option enrichment with the union resolver", async () => {
    const db = new CartReadModelDb(
      [line()],
      [
        option({ listing_id: "lst_high", price_amount: "30.00" }),
        option({ listing_id: "lst_locked", price_amount: "25.00" }),
      ],
      [],
      claims,
    );

    const [row] = await listOwnCartLines(db, account);

    expect(row?.seller_options.map((sellerOption) => sellerOption.listing_id)).toEqual(["lst_locked", "lst_high"]);
  });

  it("resolves an anonymous owner's own lines unchanged", async () => {
    const anonymousLine = line({ buyer_account_id: claimed, line_id: "cli_claimed" });
    const db = new CartReadModelDb([anonymousLine, line({ line_id: "cli_own" })], [], [], claims);

    expect((await listOwnCartLines(db, claimed)).map((row) => row.line_id)).toEqual(["cli_claimed"]);
  });
});
