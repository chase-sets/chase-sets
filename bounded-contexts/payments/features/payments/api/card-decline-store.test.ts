import { afterEach, describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createCardDeclineStore } from "./card-decline-store";

describe("card decline configured admission", () => {
  afterEach(() => vi.unstubAllEnvs());
  const now = Date.parse("2026-10-04T00:00:00Z");
  function database(count: number) {
    const query = vi.fn(async () => ({ rows: [{ decline_count: count, reset_at: new Date(now + 5000) }] }));
    return {
      query,
      connect: vi.fn(async () => {
        throw new Error("No admission transaction expected.");
      }),
    } satisfies PgTransactionalPool;
  }
  it("retains the five-decline default and configured max without exposing a fingerprint", async () => {
    const db = database(4);
    expect(await createCardDeclineStore(db, { now: () => now }).check("synthetic_fingerprint")).toBeNull();
    vi.stubEnv("CHASE_SETS_RATE_LIMIT_PAYMENTS_CARD_DECLINE_FINGERPRINT_MAX", "4");
    expect(await createCardDeclineStore(db, { now: () => now }).check("synthetic_fingerprint")).toEqual({
      retryAfterSeconds: 5,
    });
    expect(JSON.stringify(db.query.mock.calls)).not.toContain("synthetic_fingerprint");
    expect(db.connect).not.toHaveBeenCalled();
  });
  it.each(["CHASE_SETS_RATE_LIMITS_DISABLED", "CHASE_SETS_RATE_LIMIT_PAYMENTS_CARD_DECLINE_FINGERPRINT_DISABLED"])(
    "retains %s and unknown-fingerprint bypass without a database read",
    async (key) => {
      const db = database(5);
      const normal = createCardDeclineStore(db);
      expect(await normal.check(null)).toBeNull();
      expect(await normal.check(" ")).toBeNull();
      vi.stubEnv(key, "true");
      expect(await createCardDeclineStore(db).check("synthetic_fingerprint")).toBeNull();
      expect(db.query).not.toHaveBeenCalled();
    },
  );
});
