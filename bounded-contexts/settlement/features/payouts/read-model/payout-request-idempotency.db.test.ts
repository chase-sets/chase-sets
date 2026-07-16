import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as settlementModule } from "../../../index";
import { findPayoutRequestIdempotency, reservePayoutRequestIdempotency } from "./queries";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["settlement"] as const;

const accountId = "acc_seller_idem";
const createdAt = "2026-07-10T00:00:00.000Z";

describeDb("settlement payout-request idempotency reservation (single-winner claim)", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "payout_request_idempotency",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.settlement;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ settlement: pool });
    await pool.query(settlementModule.schemaSql);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  function reserve(payoutId: string, key = "key-1", amount = "40.00") {
    return reservePayoutRequestIdempotency(pool, {
      accountId,
      idempotencyKey: key,
      payoutId,
      requestedAmount: amount,
      currencyCode: "usd",
      createdAt,
    });
  }

  it("lets the first request win the key and replays the winner's payout to every later duplicate", async () => {
    const first = await reserve("pyo_first");
    expect(first.reserved).toBe(true);
    expect(first.payout_id).toBe("pyo_first");

    // A redelivered submit with the same key must NOT claim a new payout — it
    // reports the original as the winner so the runtime replays it.
    const second = await reserve("pyo_second");
    expect(second.reserved).toBe(false);
    expect(second.payout_id).toBe("pyo_first");

    const looked = await findPayoutRequestIdempotency(pool, accountId, "key-1");
    expect(looked?.payout_id).toBe("pyo_first");
    expect(looked?.requested_amount).toBe("40.00");
  });

  it("selects exactly one winner when duplicates race concurrently", async () => {
    const candidates = Array.from({ length: 8 }, (_, index) => `pyo_race_${index}`);
    const results = await Promise.all(candidates.map((payoutId) => reserve(payoutId, "race-key")));

    const winners = results.filter((result) => result.reserved);
    expect(winners).toHaveLength(1);

    // Every participant — winner and losers — must agree on the single winning
    // payout id, so no caller can proceed to debit a second payout.
    const winningPayoutId = winners[0]!.payout_id;
    for (const result of results) {
      expect(result.payout_id).toBe(winningPayoutId);
    }

    const looked = await findPayoutRequestIdempotency(pool, accountId, "race-key");
    expect(looked?.payout_id).toBe(winningPayoutId);
  });

  it("scopes the key per account and per key value", async () => {
    await reserve("pyo_a", "shared-key");

    // Same key value, different account → independent claim.
    const otherAccount = await reservePayoutRequestIdempotency(pool, {
      accountId: "acc_other",
      idempotencyKey: "shared-key",
      payoutId: "pyo_b",
      requestedAmount: "40.00",
      currencyCode: "usd",
      createdAt,
    });
    expect(otherAccount.reserved).toBe(true);
    expect(otherAccount.payout_id).toBe("pyo_b");

    // Same account, different key → independent claim.
    const otherKey = await reserve("pyo_c", "different-key");
    expect(otherKey.reserved).toBe(true);
    expect(otherKey.payout_id).toBe("pyo_c");
  });
});
