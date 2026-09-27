import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapContextDatabase,
  createProjectionAwarePool,
  createSubscriptionRunner,
  drainSubscriptionRunners,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { module as paymentsModule } from "@chase-sets/payments";
import { module as settlementModule } from "../../../../index";
import type { WalletServices } from "../../api/runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl) throw new Error("TEST_DATABASE_URL is required for seller capture credit database tests.");
const contextNames = ["payments", "settlement"] as const;
const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_seller" as never },
};
const credit: Parameters<WalletServices["creditSellerCapture"]>[0] = {
  accountId: "acc_seller" as never,
  paymentId: "pay_capture" as never,
  orderId: "ord_capture" as never,
  kind: "sale",
  amount: "20.00",
  currencyCode: "usd",
  postedAt: "2026-05-01T00:00:00.000Z",
};
const runContext = { ownerId: "seller-capture-test", fencingToken: "1", throwIfLeaseLost: () => undefined };

describe("seller capture credit real event store", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "seller_capture_credit");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    await bootstrapContextDatabase(settlementModule, pools.settlement);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function runtime() {
    const services = settlementModule.createServices(createProjectionAwarePool(pools.settlement), {});
    const subscription = settlementModule.buildSubscriptions!(services).find(
      (candidate) => candidate.projectionName === "settlement-payment-input-projection",
    );
    if (!subscription) throw new Error("Settlement payment-input subscription is missing.");
    return {
      wallets: services.wallets,
      subscription,
      runner: createSubscriptionRunner("settlement", pools.settlement, pools.payments, subscription),
    };
  }
  async function appendCapture() {
    const sellerPayouts = [
      {
        orderId: credit.orderId,
        sellerAccountId: credit.accountId,
        sellerItemNetAmount: "20.01",
        protectionAllowanceAmount: "0.01",
        protectionAmount: "0.01",
        protectionOverageAmount: "0.00",
        shippingAllowanceAmount: "3.00",
        sellerShippingPayoutAmount: "3.00",
        sellerPayoutAmount: "23.00",
      },
    ];
    const store = createPostgresEventStore({ pool: pools.payments });
    const events = await store.appendToStream({
      streamId: `payments.payment-${credit.paymentId}`,
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventId: "evt_capture_created" as never,
          eventType: "payments.payment-created",
          occurredAt: credit.postedAt as never,
          payload: {
            paymentId: credit.paymentId,
            buyerAccountId: "acc_buyer",
            orderIds: [credit.orderId],
            sellerPayouts,
            amount: "23.01",
            balanceCreditAmount: "0.00",
            processorAmount: "23.01",
            marketplaceSalesFeeAmount: "0.00",
            currencyCode: "usd",
            processorName: "stripe",
            processorPaymentReference: "pi_synthetic_capture",
            processorStatus: "requires_capture",
            createdAt: credit.postedAt,
          },
        },
        {
          eventId: "evt_capture_captured" as never,
          eventType: "payments.payment-captured",
          occurredAt: credit.postedAt as never,
          payload: {
            paymentId: credit.paymentId,
            buyerAccountId: "acc_buyer",
            balanceCreditAmount: "0.00",
            currencyCode: "usd",
            processorStatus: "succeeded",
            capturedAt: credit.postedAt,
            sellerPayouts,
          },
        },
      ],
    });
    return toTransportEvent(events[1]!);
  }
  async function debit(wallets: WalletServices, amount = "15.00") {
    await wallets.postEntry(
      {
        accountId: credit.accountId,
        ledgerEntryId: "led_capture_debit" as never,
        kind: "refund",
        direction: "debit",
        amount,
        fundsStatus: "available",
        allowNegativeBalance: true,
      },
      context,
    );
  }
  async function walletHistory() {
    return createPostgresEventStore({ pool: pools.settlement }).readStream({
      streamId: `settlement.wallet-${credit.accountId}`,
    });
  }

  it("seller capture credit survives balance changes and subscription reset", async () => {
    const first = runtime();
    const captured = await appendCapture();
    await drainSubscriptionRunners([first.runner], runContext);
    expect(first.runner.getStatus().poisonEventCount).toBe(0);
    const original = await first.wallets.loadWalletState(credit.accountId);
    expect(original.totalCreditedAmount).toBe("23.00");
    expect(original.entries.map((entry) => [entry.ledgerEntryId, entry.amount, entry.currencyCode])).toEqual([
      ["led_sale_pay_capture_ord_capture", "20.00", "usd"],
      ["led_shipping_allowance_pay_capture_ord_capture", "3.00", "usd"],
    ]);
    await debit(first.wallets);
    const before = await walletHistory();
    // Direct duplicate delivery bypasses the application ledger; reset then removes that ledger too.
    await first.subscription.handlers["payments.payment-captured"]!(captured);
    await first.runner.reset(runContext);
    const applications = await pools.settlement.query(
      "SELECT event_id FROM event_subscription_applications WHERE projection_key = $1",
      [first.runner.checkpointKey],
    );
    expect(applications.rows).toEqual([]);
    const rebooted = runtime();
    await drainSubscriptionRunners([rebooted.runner], runContext);
    expect(rebooted.runner.getStatus().poisonEventCount).toBe(0);
    expect(await walletHistory()).toEqual(before);
    const replayed = await rebooted.wallets.loadWalletState(credit.accountId);
    expect(replayed.totalCreditedAmount).toBe("23.00");
    expect(replayed.availableBalanceAmount).toBe("-15.00");
    expect(replayed.pendingBalanceAmount).toBe("23.00");
  });

  it("seller capture credit atomicity and legacy convergence: database rollback and concurrent delivery", async () => {
    const first = runtime();
    await debit(first.wallets);
    const before = await walletHistory();
    await pools.settlement.query(`CREATE FUNCTION reject_capture_offset() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.payload->>'ledgerEntryId' = 'led_sale_pay_capture_ord_capture' THEN
          RAISE EXCEPTION 'injected seller capture offset failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_capture_offset BEFORE INSERT ON event_store_events
      FOR EACH ROW EXECUTE FUNCTION reject_capture_offset();`);
    await expect(first.wallets.creditSellerCapture(credit, context)).rejects.toThrow();
    expect(await walletHistory()).toEqual(before);
    expect((await first.wallets.loadWalletState(credit.accountId)).totalCreditedAmount).toBe("0.00");
    await pools.settlement.query(
      "DROP TRIGGER reject_capture_offset ON event_store_events; DROP FUNCTION reject_capture_offset();",
    );
    const captured = await appendCapture();
    const second = runtime();
    await Promise.all([
      first.subscription.handlers["payments.payment-captured"]!(captured),
      second.subscription.handlers["payments.payment-captured"]!(captured),
    ]);
    const state = await first.wallets.loadWalletState(credit.accountId);
    expect(state.totalCreditedAmount).toBe("23.00");
    expect(state.availableBalanceAmount).toBe("0.00");
    expect(state.pendingBalanceAmount).toBe("8.00");
    expect(
      state.entries
        .filter((entry) => entry.direction === "credit")
        .map((entry) => entry.ledgerEntryId)
        .sort(),
    ).toEqual([
      "led_sale_pay_capture_ord_capture",
      "led_sale_pay_capture_ord_capture_pending",
      "led_shipping_allowance_pay_capture_ord_capture",
    ]);
    const complete = await walletHistory();
    await drainSubscriptionRunners([first.runner], runContext);
    expect(first.runner.getStatus().poisonEventCount).toBe(0);
    expect(await walletHistory()).toEqual(complete);
  });

  it("makes mismatched legacy evidence operator-visible without further money", async () => {
    const { wallets, runner } = runtime();
    await wallets.postEntry(
      {
        ...credit,
        ledgerEntryId: "led_sale_pay_capture_ord_capture" as never,
        direction: "credit",
        fundsStatus: "pending",
        amount: "19.99",
      },
      context,
    );
    const before = await walletHistory();
    await appendCapture();
    await drainSubscriptionRunners([runner], runContext);
    expect(runner.getStatus().poisonEventCount).toBe(1);
    const failure = await pools.settlement.query<{ error_message: string }>(
      "SELECT error_message FROM event_subscription_applications WHERE projection_key = $1 AND status = 'poison'",
      [runner.checkpointKey],
    );
    expect(failure.rows).toHaveLength(1);
    expect(failure.rows[0]!.error_message).toContain("led_sale_pay_capture_ord_capture");
    expect(failure.rows[0]!.error_message).toContain("operator review required");
    expect(await walletHistory()).toEqual(before);
  });
});
