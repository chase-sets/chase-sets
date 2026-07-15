import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  getCampaignChannelAttribution,
  getCampaignQualityMetrics,
  getWaitlistReferralSummary,
  getWaitlistSignupCount,
  getWaitlistMetrics,
  listWaitlistSignups,
} from "./queries";

describe("waitlist read-model queries", () => {
  it("escapes LIKE metacharacters in email search text", async () => {
    const db: PgQueryable = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("COUNT(*) AS count") ? [{ count: "0" }] : [],
        rowCount: sql.includes("COUNT(*) AS count") ? 1 : 0,
      })),
    };

    await listWaitlistSignups(db, {
      search: "buyer_%@example.test",
      limit: 25,
      offset: 0,
    });

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("LOWER(email) LIKE $1 ESCAPE '\\'"), [
      "%buyer\\_\\%@example.test%",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("LIMIT $2 OFFSET $3"), [
      "%buyer\\_\\%@example.test%",
      25,
      0,
    ]);
  });

  it("defaults to ordering by recency and switches to referral rank on request", async () => {
    const db: PgQueryable = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("COUNT(*) AS count") ? [{ count: "0" }] : [],
        rowCount: sql.includes("COUNT(*) AS count") ? 1 : 0,
      })),
    };

    await listWaitlistSignups(db, { limit: 10, offset: 0 });
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("ORDER BY updated_at DESC, signup_id DESC"),
      expect.anything(),
    );

    await listWaitlistSignups(db, { limit: 10, offset: 0, sort: "referrals" });
    expect(db.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("ORDER BY referral_count DESC, updated_at DESC, signup_id DESC"),
      expect.anything(),
    );
  });

  it("counts only signups referred by the given signup id and reports its queue standing", async () => {
    // Three-signup queue: abc123 signed up last but referred both others, so
    // the policy (10 places per counted referral) moves it to the front.
    const queueRows = [
      { signup_id: "wls_first", submitted_at: "2026-07-01T00:00:00.000Z", referral_count: "0" },
      { signup_id: "wls_second", submitted_at: "2026-07-01T00:01:00.000Z", referral_count: "0" },
      { signup_id: "wls_abc123", submitted_at: "2026-07-01T00:02:00.000Z", referral_count: "2" },
    ];
    const db: PgQueryable = {
      query: vi.fn(async (sql: string) =>
        sql.includes("WHERE referred_by_signup_id = $1")
          ? { rows: [{ referral_count: "2" }], rowCount: 1 }
          : { rows: queueRows, rowCount: queueRows.length },
      ),
    };

    const summary = await getWaitlistReferralSummary(db, "wls_abc123");

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("WHERE referred_by_signup_id = $1"), ["wls_abc123"]);
    expect(summary).toEqual({
      referralCount: 2,
      referralGoal: 3,
      queuePosition: 1,
      totalSignups: 3,
      positionsAdvanced: 2,
    });
  });

  it("returns a zero count and a pending (null) queue position when the signup is not visible yet", async () => {
    const db: PgQueryable = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    };

    const summary = await getWaitlistReferralSummary(db, "wls_unknown");

    expect(summary.referralCount).toBe(0);
    expect(summary.queuePosition).toBeNull();
    expect(summary.positionsAdvanced).toBe(0);
  });

  it("counts every waitlist signup with a single query", async () => {
    const db: PgQueryable = {
      query: vi.fn(async () => ({ rows: [{ count: "142" }], rowCount: 1 })),
    };

    const count = await getWaitlistSignupCount(db);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("SELECT COUNT(*) AS count"));
    expect(count).toBe(142);
  });

  it("counts admitted signups against the active invite-wave capacities", async () => {
    const db: PgQueryable = {
      query: vi.fn(async () => ({
        rows: [
          {
            total_count: "850",
            buy_count: "300",
            sell_count: "250",
            both_count: "300",
            wave_1_admitted_count: "100",
            wave_2_admitted_count: "225",
            wave_3_admitted_count: "0",
          },
        ],
        rowCount: 1,
      })),
    };

    const metrics = await getWaitlistMetrics(db, [
      { waveNumber: 1, inviteCount: 100 },
      { waveNumber: 2, inviteCount: 250 },
      { waveNumber: 3, inviteCount: 500 },
    ]);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("admitted_wave = 1"));
    expect(metrics.wave_fill).toEqual([
      { waveNumber: 1, admittedCount: 100, capacity: 100 },
      { waveNumber: 2, admittedCount: 225, capacity: 250 },
      { waveNumber: 3, admittedCount: 0, capacity: 500 },
    ]);
  });

  it("computes campaign quality metrics from totals, inventory distribution, and per-game queries", async () => {
    const totalsRow = {
      total_signups: "120",
      seller_signup_count: "40",
      qualified_seller_count: "30",
      store_link_count: "10",
    };
    const inventoryRows = [
      { inventory_size: "under_100", count: "12" },
      { inventory_size: "500_to_2000", count: "8" },
    ];
    const gameCounts = [10, 5, 0, 3, 7]; // pokemon, magic-the-gathering, yu-gi-oh, disney-lorcana, one-piece-card-game
    let call = 0;
    const db: PgQueryable = {
      query: vi.fn(async () => {
        call += 1;
        if (call === 1) return { rows: [totalsRow], rowCount: 1 };
        if (call === 2) return { rows: inventoryRows, rowCount: inventoryRows.length };
        const count = gameCounts[call - 3] ?? 0;
        return { rows: [{ count: String(count) }], rowCount: 1 };
      }),
    };

    const metrics = await getCampaignQualityMetrics(db);

    expect(metrics.totalSignups).toBe(120);
    expect(metrics.sellerSignupCount).toBe(40);
    expect(metrics.qualifiedSellerCount).toBe(30);
    expect(metrics.storeLinkCount).toBe(10);
    expect(metrics.storeLinkPercent).toBe(25);
    expect(metrics.inventorySizeDistribution).toEqual({
      under_100: 12,
      "100_to_500": 0,
      "500_to_2000": 8,
      "2000_plus": 0,
    });
    expect(metrics.qualifiedSellersByGame).toEqual({
      pokemon: 10,
      "magic-the-gathering": 5,
      "yu-gi-oh": 0,
      "disney-lorcana": 3,
      "one-piece-card-game": 7,
    });
  });

  it("returns zero store-link percent when there are no seller signups", async () => {
    const db: PgQueryable = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("total_signups")) {
          return {
            rows: [
              { total_signups: "5", seller_signup_count: "0", qualified_seller_count: "0", store_link_count: "0" },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("GROUP BY inventory_size")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ count: "0" }], rowCount: 1 };
      }),
    };

    const metrics = await getCampaignQualityMetrics(db);

    expect(metrics.storeLinkPercent).toBe(0);
  });

  it("groups channel attribution by UTM source/medium/campaign, ordered by signup volume", async () => {
    const rows = [
      {
        utm_source: "twitter",
        utm_medium: "social",
        utm_campaign: "wave1",
        signup_count: "40",
        seller_signup_count: "10",
        qualified_seller_count: "6",
      },
      {
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
        signup_count: "5",
        seller_signup_count: "1",
        qualified_seller_count: "0",
      },
    ];
    const db: PgQueryable = {
      query: vi.fn(async () => ({ rows, rowCount: rows.length })),
    };

    const attribution = await getCampaignChannelAttribution(db, 10);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("GROUP BY utm_source, utm_medium, utm_campaign"),
      [10],
    );
    expect(attribution).toEqual([
      {
        utm_source: "twitter",
        utm_medium: "social",
        utm_campaign: "wave1",
        signup_count: 40,
        seller_signup_count: 10,
        qualified_seller_count: 6,
      },
      {
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
        signup_count: 5,
        seller_signup_count: 1,
        qualified_seller_count: 0,
      },
    ]);
  });

  it("clamps the channel attribution limit to a sane range", async () => {
    const db: PgQueryable = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    };

    await getCampaignChannelAttribution(db, 1000);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [100]);

    await getCampaignChannelAttribution(db, 0);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [1]);
  });
});
