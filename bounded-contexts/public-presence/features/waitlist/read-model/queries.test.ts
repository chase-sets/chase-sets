import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getWaitlistReferralSummary, listWaitlistSignups } from "./queries";

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

  it("counts only signups referred by the given signup id", async () => {
    const db: PgQueryable = {
      query: vi.fn(async () => ({ rows: [{ referral_count: "2" }], rowCount: 1 })),
    };

    const summary = await getWaitlistReferralSummary(db, "wls_abc123");

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("WHERE referred_by_signup_id = $1"), ["wls_abc123"]);
    expect(summary).toEqual({ referralCount: 2, referralGoal: 3 });
  });

  it("returns a zero referral count when no signups reference the referral code", async () => {
    const db: PgQueryable = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    };

    const summary = await getWaitlistReferralSummary(db, "wls_unknown");

    expect(summary.referralCount).toBe(0);
  });
});
