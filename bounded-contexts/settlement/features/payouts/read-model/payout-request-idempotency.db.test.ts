import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresEventStore,
  type PgPoolClient,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as settlementModule } from "../../../index";
import {
  findPayoutRequestIdempotency,
  releaseUncommittedPayoutRequestIdempotency,
  reservePayoutRequestIdempotency,
} from "./queries";

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

  function reserve(payoutId: string, key = "key-1", amount = "40.00", db: PgQueryable = pool) {
    return reservePayoutRequestIdempotency(db, {
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
    const second = await reserve("pyo_second", "key-1", "41.00");
    expect(second.reserved).toBe(false);
    expect(second.payout_id).toBe("pyo_first");
    expect(second.requested_amount).toBe("40.00");

    const looked = await findPayoutRequestIdempotency(pool, accountId, "key-1");
    expect(looked?.payout_id).toBe("pyo_first");
    expect(looked?.requested_amount).toBe("40.00");
  });

  it("selects exactly one winner when duplicates race concurrently", async () => {
    const winnerClient = await pool.connect();
    const loserClient = await pool.connect();
    let winnerTransactionOpen = false;
    let loserTransactionOpen = false;

    try {
      await winnerClient.query("BEGIN");
      winnerTransactionOpen = true;
      await loserClient.query("BEGIN");
      loserTransactionOpen = true;

      const winnerTransaction = await winnerClient.query<{ transaction_id: string }>(
        "SELECT pg_current_xact_id()::text AS transaction_id",
      );
      const loserBackend = await loserClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const winner = await reserve("pyo_race_winner", "race-key", "40.00", winnerClient);

      // The loser takes its statement snapshot while the winner is still
      // uncommitted, then waits on the winner's transaction during unique-key
      // conflict detection. Observing that exact PostgreSQL wait is the barrier:
      // only then may the winner commit. No scheduler luck or sleep is involved.
      const loserResult = reserve("pyo_race_loser", "race-key", "40.00", loserClient);
      await waitForTransactionConflict(pool, loserBackend.rows[0]!.pid, winnerTransaction.rows[0]!.transaction_id);

      await winnerClient.query("COMMIT");
      winnerTransactionOpen = false;
      const loser = await loserResult;
      await loserClient.query("COMMIT");
      loserTransactionOpen = false;

      const remainingLosers = await Promise.all(
        Array.from({ length: 6 }, (_, index) => reserve(`pyo_race_${index + 2}`, "race-key")),
      );
      const results = [winner, loser, ...remainingLosers];
      expect(winner).toMatchObject({ reserved: true, payout_id: "pyo_race_winner" });
      expect(loser).toMatchObject({
        reserved: false,
        payout_id: "pyo_race_winner",
        requested_amount: "40.00",
        currency_code: "usd",
      });

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
    } finally {
      await rollbackIfOpen(winnerClient, winnerTransactionOpen);
      await rollbackIfOpen(loserClient, loserTransactionOpen);
      winnerClient.release();
      loserClient.release();
    }
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

  it("releases only the exact owner while an absent stream is proven", async () => {
    await reserve("pyo_owner", "cleanup-key");

    await expect(
      releaseUncommittedPayoutRequestIdempotency(pool, {
        accountId,
        idempotencyKey: "cleanup-key",
        payoutId: "pyo_competing_owner",
      }),
    ).resolves.toBe(false);
    await expect(findPayoutRequestIdempotency(pool, accountId, "cleanup-key")).resolves.toMatchObject({
      payout_id: "pyo_owner",
    });

    await expect(
      releaseUncommittedPayoutRequestIdempotency(pool, {
        accountId,
        idempotencyKey: "cleanup-key",
        payoutId: "pyo_owner",
      }),
    ).resolves.toBe(true);
    await expect(findPayoutRequestIdempotency(pool, accountId, "cleanup-key")).resolves.toBeNull();
  });

  it("retains the reservation when the payout stream exists after an ambiguous append outcome", async () => {
    await reserve("pyo_appended", "appended-key");
    const eventStore = createPostgresEventStore({ pool });
    await eventStore.appendToStream({
      streamId: "settlement.payout-pyo_appended",
      expectedVersion: "no_stream",
      context: {
        tenantId: "tnt_payout_request_idempotency" as never,
        audit: { performedByUserId: "usr_payout_request_idempotency" as never, forAccountId: accountId as never },
      },
      events: [
        {
          eventType: "settlement.payout.requested",
          payload: { payoutId: "pyo_appended", accountId, requestedAt: createdAt },
        },
      ],
    });

    await expect(
      releaseUncommittedPayoutRequestIdempotency(pool, {
        accountId,
        idempotencyKey: "appended-key",
        payoutId: "pyo_appended",
      }),
    ).resolves.toBe(false);
    await expect(findPayoutRequestIdempotency(pool, accountId, "appended-key")).resolves.toMatchObject({
      payout_id: "pyo_appended",
    });
  });
});

async function waitForTransactionConflict(
  db: PgQueryable,
  backendPid: number,
  blockingTransactionId: string,
): Promise<void> {
  for (let observation = 0; observation < 100; observation += 1) {
    const result = await db.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_locks
         WHERE pid = $1
           AND locktype = 'transactionid'
           AND transactionid::text = $2
           AND NOT granted
       ) AS waiting`,
      [backendPid, blockingTransactionId],
    );
    if (result.rows[0]?.waiting) return;
  }
  throw new Error("Concurrent reservation did not reach the transaction-conflict barrier.");
}

async function rollbackIfOpen(client: PgPoolClient, transactionOpen: boolean): Promise<void> {
  if (transactionOpen) await client.query("ROLLBACK");
}
