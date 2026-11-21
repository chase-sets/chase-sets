import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, PaymentId } from "@chase-sets/primitives/typed-ids";
import { module as settlementModule } from "../../settlement/index";
import { createSettlementBalanceCreditResolver, createSettlementWalletSpendHoldPort } from "../../settlement/server";
import { module as paymentsModule } from "../index";
import type { BalanceCreditResolver } from "../features/payments/api/balance-credit-resolver";
import { createPaymentTransactionRunner } from "../features/payments/api/webhook-transaction";
import {
  lockMarkedPaymentCreationReservation,
  recordReservationHoldIntent,
  reservePaymentCreation,
} from "../features/payments/read-model/queries";
import { createPaymentsServices } from "../support/runtime-support/services";

const contexts = ["payments", "settlement"] as const;
const accountId = "acc_reservation_sweep_buyer" as AccountId;
const context: EventStoreContext = {
  tenantId: "tnt_reservation_sweep" as never,
  audit: { performedByUserId: "usr_reservation_sweep" as never, forAccountId: accountId },
};
const databaseUrl = process.env.TEST_DATABASE_URL;

function signal() {
  let send!: () => void;
  const received = new Promise<void>((resolve) => {
    send = resolve;
  });
  return { send, received };
}

describe("Payment reservation sweep against separate Payments and Settlement stores", () => {
  let pools: Readonly<Record<(typeof contexts)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for the reservation sweep DB proof.");
    const urls = createMultiContextTestDatabaseUrls(databaseUrl, contexts, "payment_reservation_sweep");
    await ensureMultiContextTestDatabases(databaseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    await bootstrapContextDatabase(settlementModule, pools.settlement);
    await wallets().postEntry(
      {
        accountId,
        ledgerEntryId: "led_reservation_sweep_credit" as never,
        kind: "adjustment",
        direction: "credit",
        fundsStatus: "available",
        amount: "50.00",
      },
      context,
    );
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function wallets() {
    return settlementModule.createServices(pools.settlement, {}).wallets;
  }

  function walletResolver(writePool = pools.settlement) {
    return createSettlementBalanceCreditResolver(pools.settlement, {
      walletSpendHolds: createSettlementWalletSpendHoldPort(writePool),
    });
  }

  function scan(resolver: BalanceCreditResolver = walletResolver(), pool = pools.payments, limit?: number) {
    // No provider gateway is installed. An unexpected lookup fails the test.
    return createPaymentsServices(pool, { balanceCreditResolver: resolver }).payments.scanPaymentsNeedingReconciliation(
      { limit },
      context,
    );
  }

  async function reserve(id: string, options: { legacy?: boolean; young?: boolean; noIntent?: boolean } = {}) {
    const paymentId = `pay_${id}` as PaymentId;
    await reservePaymentCreation(pools.payments, {
      paymentId,
      buyerAccountId: accountId,
      orderIds: [`ord_${id}`],
      createdAt: new Date(Date.now() - (options.young ? 0 : 30 * 60_000)).toISOString(),
    });
    if (!options.legacy) {
      // The follow-up creator will write this marker; the current creator stays legacy.
      await pools.payments.query(
        "UPDATE payments_payment_creation_reservations SET creation_protocol = 'record-before-send' WHERE payment_id = $1",
        [paymentId],
      );
      if (!options.noIntent) {
        expect(await recordReservationHoldIntent(pools.payments, { paymentId })).toBe(true);
      }
    }
    return paymentId;
  }

  async function reservation(paymentId: PaymentId) {
    const { rows } = await pools.payments.query<{
      status: string;
      release_pending: boolean | null;
      release_failures: number;
      hold_intent_at: Date | null;
    }>(
      `SELECT status, release_pending, release_failures, hold_intent_at
       FROM payments_payment_creation_reservations WHERE payment_id = $1`,
      [paymentId],
    );
    return rows[0]!;
  }

  function place(paymentId: PaymentId, opts: { legacy?: boolean; writePool?: PgTransactionalPool } = {}) {
    return walletResolver(opts.writePool).placeSpendHold(
      {
        paymentId,
        buyerAccountId: accountId,
        currencyCode: "usd",
        requestedAmount: "10.00",
        ...(opts.legacy ? {} : { expiresAt: null }),
      },
      context,
    );
  }

  async function walletEvents() {
    const history = await createPostgresEventStore({ pool: pools.settlement }).readStream({
      streamId: `settlement.wallet-${accountId}`,
    });
    return history.map((event) => event.eventType);
  }

  function transactions() {
    return createPaymentTransactionRunner(pools.payments, createPostgresEventStore({ pool: pools.payments }));
  }

  function creationAppend(paymentId: PaymentId): AppendToStreamInput {
    return {
      streamId: `payments.payment-${paymentId}`,
      expectedVersion: "no_stream",
      events: [{ eventType: "payments.payment-created", payload: { paymentId } }],
      context,
    };
  }

  function observeTransactions(
    beforeQuery: (sql: string) => void | Promise<void>,
    afterQuery?: (sql: string) => void,
    pool = pools.payments,
  ): PgTransactionalPool {
    return {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect();
        return {
          release: client.release.bind(client),
          async query<Row>(sql: string, params?: readonly unknown[]) {
            await beforeQuery(sql);
            const result = await client.query<Row>(sql, params);
            afterQuery?.(sql);
            return result;
          },
        };
      },
    };
  }

  it("reservation-sweep-ignores-legacy", async () => {
    const legacy = await reserve("legacy", { legacy: true });
    await place(legacy, { legacy: true });
    const before = await walletEvents();
    const unknown = "pay_legacy_zero" as PaymentId;
    expect(
      await wallets().placeSpendHold(
        { accountId, holdId: `hold_balance_credit_${unknown}`, paymentId: unknown, amount: "0.00" },
        context,
      ),
    ).toMatchObject({ heldAmount: "0.00" });
    await walletResolver().releaseSpendHold(
      { paymentId: unknown, buyerAccountId: accountId, reason: "payment-cancelled" },
      context,
    );
    expect(await recordReservationHoldIntent(pools.payments, { paymentId: legacy })).toBe(false);

    await scan();
    expect(await reservation(legacy)).toMatchObject({ status: "active", release_pending: null, hold_intent_at: null });
    expect(await walletEvents()).toEqual(before);
    const wallet = await wallets().loadWalletState(accountId);
    expect(wallet.heldBalanceAmount).toBe("10.00");
    const hold = wallet.spendHolds[0]!;
    expect(hold.status).toBe("active");
    expect(Date.parse(hold.expiresAt!) - Date.parse(hold.placedAt)).toBe(72 * 60 * 60_000);
  });

  it("reservation-sweep-releases-once", async () => {
    const stale = await reserve("stale");
    const young = await reserve("young", { young: true });
    const created = await reserve("created");
    const noIntent = await reserve("nointent", { noIntent: true });
    await transactions()((tx) => tx.eventStore.appendToStream(creationAppend(created)));
    for (const paymentId of [stale, young, created]) await place(paymentId);

    await Promise.all([scan(), scan()]);
    await scan();
    expect(await reservation(stale)).toMatchObject({ status: "failed", release_pending: null, release_failures: 0 });
    expect(await reservation(noIntent)).toMatchObject({ status: "failed", release_pending: null });
    for (const id of [young, created]) expect((await reservation(id)).status).toBe("active");
    expect((await walletEvents()).filter((type) => type.includes("spend-hold-release"))).toHaveLength(1);
    expect((await walletEvents()).filter((type) => type.includes("spend-hold-retired"))).toHaveLength(0);
    expect((await wallets().loadWalletState(accountId)).heldBalanceAmount).toBe("20.00");
  });

  it("reservation-sweep-releases-once: rechecks a stream appended between selection and the lock", async () => {
    const paymentId = await reserve("append_race");
    await place(paymentId);
    const lockRequested = signal();
    const pool = observeTransactions((sql) => {
      if (sql.includes("FOR UPDATE")) lockRequested.send();
    });
    const creator = await pools.payments.connect();
    let sweep: ReturnType<typeof scan> | undefined;
    try {
      await creator.query("BEGIN");
      expect((await lockMarkedPaymentCreationReservation(creator, paymentId))?.status).toBe("active");
      sweep = scan(walletResolver(), pool, 1);
      expect(await Promise.race([lockRequested.received.then(() => true), sweep.then(() => false)])).toBe(true);
      const store = createPostgresEventStore({ pool: pools.payments });
      await store.appendToStreamInTransaction(creator, creationAppend(paymentId));
      await creator.query("COMMIT");
    } catch (error) {
      await creator.query("ROLLBACK");
      throw error;
    } finally {
      creator.release();
      await sweep;
    }
    expect((await reservation(paymentId)).status).toBe("active");
    expect((await wallets().loadWalletState(accountId)).heldBalanceAmount).toBe("10.00");
  });

  it.each(["place", "retire"] as const)(
    "reservation-sweep-fences-late-hold: %s wins the wallet CAS",
    async (winner) => {
      const paymentId = await reserve(`wallet_race_${winner}`);
      const appendStarted = signal();
      const resumeAppend = signal();
      let firstAppend = true;
      const delayedWallet = observeTransactions(
        async (sql) => {
          if (firstAppend && sql.includes("INSERT INTO event_store_streams")) {
            firstAppend = false;
            appendStarted.send();
            await resumeAppend.received;
          }
        },
        undefined,
        pools.settlement,
      );
      const delayed =
        winner === "place" ? scan(walletResolver(delayedWallet)) : place(paymentId, { writePool: delayedWallet });
      try {
        expect(await Promise.race([appendStarted.received.then(() => true), delayed.then(() => false)])).toBe(true);
        if (winner === "place") expect(await place(paymentId)).toEqual({ heldAmount: "10.00" });
        else await scan();
      } finally {
        resumeAppend.send();
        await delayed;
      }
      if (winner === "retire") expect(await delayed).toEqual({ heldAmount: "0.00" });
      expect(await reservation(paymentId)).toMatchObject({ status: "failed", release_pending: null });
      expect((await wallets().loadWalletState(accountId)).heldBalanceAmount).toBe("0.00");
      expect((await walletEvents()).filter((type) => type.startsWith("settlement.wallet.spend-hold-"))).toEqual(
        winner === "place"
          ? ["settlement.wallet.spend-hold-placed", "settlement.wallet.spend-hold-released"]
          : ["settlement.wallet.spend-hold-retired.v1"],
      );
    },
  );

  it("reservation-sweep-fences-late-hold and replays a lost cleanup acknowledgement", async () => {
    const paymentId = await reserve("late");
    let acknowledging = false;
    const lostAck = observeTransactions((sql) => {
      if (sql.includes("SET release_pending = CASE")) acknowledging = true;
      if (sql === "COMMIT" && acknowledging) throw new Error("lost acknowledgement");
    });
    await expect(scan(walletResolver(), lostAck)).rejects.toThrow("lost acknowledgement");
    expect(await reservation(paymentId)).toMatchObject({ status: "failed", release_pending: true });
    expect(await recordReservationHoldIntent(pools.payments, { paymentId })).toBe(false);
    expect(await place(paymentId)).toEqual({ heldAmount: "0.00" });
    await scan();
    await scan();
    expect((await reservation(paymentId)).release_pending).toBeNull();
    expect((await walletEvents()).filter((type) => type === "settlement.wallet.spend-hold-retired.v1")).toHaveLength(1);
    expect((await wallets().loadWalletState(accountId)).heldBalanceAmount).toBe("0.00");
    expect(await place("pay_other" as PaymentId)).toEqual({ heldAmount: "10.00" });
  });

  it("reservation-sweep-release-failure-retries", async () => {
    const paymentId = await reserve("retries");
    await place(paymentId);
    const resolver = walletResolver();
    const retireSpendHold = vi
      .fn(resolver.retireSpendHold)
      .mockRejectedValueOnce(new Error("wallet unavailable"))
      .mockResolvedValueOnce("unwired")
      .mockRejectedValueOnce(new Error("wallet unavailable"))
      .mockResolvedValueOnce("unwired");

    for (const attempts of [1, 2, 3, 4]) {
      const result = await scan({ ...resolver, retireSpendHold });
      expect(result.attention_items.map((item) => item.payment_id)).toEqual(attempts < 3 ? [] : [paymentId]);
      expect(await reservation(paymentId)).toMatchObject({
        release_pending: true,
        release_failures: Math.min(attempts, 3),
      });
      expect((await wallets().loadWalletState(accountId)).heldBalanceAmount).toBe("10.00");
    }
    expect((await scan({ ...resolver, retireSpendHold })).attention).toBe(0);
    await scan({ ...resolver, retireSpendHold });
    expect(retireSpendHold).toHaveBeenCalledTimes(5);
    expect((await reservation(paymentId)).release_pending).toBeNull();
    expect((await wallets().loadWalletState(accountId)).heldBalanceAmount).toBe("0.00");
  });

  it.each(["before", "after"] as const)("reservation-sweep-commits-before-wallet: loss %s commit", async (when) => {
    const paymentId = await reserve(`loss_${when}`);
    await place(paymentId);
    const resolver = walletResolver();
    const retireSpendHold = vi.fn(resolver.retireSpendHold);
    let fencing = false;
    const loss = observeTransactions(
      (sql) => {
        if (sql.includes("SET status = 'failed', release_pending")) fencing = true;
        if (fencing && sql === "COMMIT" && when === "before") throw new Error("lost before commit");
      },
      (sql) => {
        if (fencing && sql === "COMMIT" && when === "after") throw new Error("lost after commit");
      },
    );
    await expect(scan({ ...resolver, retireSpendHold }, loss)).rejects.toThrow(`lost ${when} commit`);
    expect(retireSpendHold).not.toHaveBeenCalled();
    expect(await reservation(paymentId)).toMatchObject({
      status: when === "before" ? "active" : "failed",
      release_pending: when === "after" ? true : null,
    });
    expect((await wallets().loadWalletState(accountId)).heldBalanceAmount).toBe("10.00");
    await scan({ ...resolver, retireSpendHold });
    await scan({ ...resolver, retireSpendHold });
    expect(retireSpendHold).toHaveBeenCalledTimes(1);
    expect((await reservation(paymentId)).release_pending).toBeNull();
    expect((await wallets().loadWalletState(accountId)).heldBalanceAmount).toBe("0.00");
  });
});
