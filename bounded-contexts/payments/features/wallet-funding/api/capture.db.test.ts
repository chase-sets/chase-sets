import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createStripePaymentProcessorGateway } from "@chase-sets/stripe-payments";
import { module as paymentsModule } from "../../../index";
import { createPaymentsServices } from "../../../support/runtime-support/services";
import { createPaymentProcessorWebhookRoutes } from "../../payments/api/route";
import { quoteMarketplaceCheckoutFee } from "../../payments/api/marketplace-checkout-fee-policy";
import type { WalletFundingId } from "../domain/domain";
import { buildWalletFundingProjectionHandlers } from "../read-model/projection";
import { walletFundingSchemaMigrations } from "../read-model/schema";
import type { PrepaidRefundAuthority } from "./prepaid-refund-authority";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for wallet-funding-capture-once DB proof.");
const context: EventStoreContext = {
  tenantId: "tnt_identity",
  audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
};
const quote = quoteMarketplaceCheckoutFee({
  orderAmount: "10.00",
  externalBasisAmount: "10.00",
  balanceCreditAmount: "0.00",
  paymentMethodCategory: "card",
});
const secret = "whsec_synthetic_wallet_funding_db";

describe("wallet-funding-capture-once", () => {
  let pools: Readonly<Record<"payments", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl, ["payments"], "wallet_funding_7812");
    await ensureMultiContextTestDatabases(databaseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(paymentsModule, pools.payments);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });
  function services(prepaidRefundAuthority?: PrepaidRefundAuthority) {
    const stripe = createStripePaymentProcessorGateway({
      secretKey: "sk_test_synthetic",
      publishableKey: "pk_test_synthetic",
      webhookSecret: secret,
    });
    return createPaymentsServices(pools.payments, {
      prepaidRefundAuthority,
      processorGateway: {
        ...createFakePaymentProcessorGateway(),
        parseWebhook: stripe.parseWebhook,
        createRefund: async () => ({
          processorName: "stripe",
          processorRefundReference: "re_synthetic_db",
          processorStatus: "succeeded",
        }),
        createPaymentSession: async (input) => ({
          processorName: "stripe",
          processorPaymentKind: "payment-intent",
          processorPaymentReference: `pi_synthetic_${input.paymentId}`,
          processorClientSecret: null,
          processorRedirectUrl: null,
          processorStatus: "requires_confirmation",
        }),
      },
      walletFundingEligibilityResolver: { resolve: async () => ({ goodStanding: true, paymentsTerms: "not-active" }) },
    });
  }
  async function create(runtime: ReturnType<typeof services>, fundingId: WalletFundingId) {
    return runtime.walletFunding.create(
      {
        fundingId,
        accountId: "acc_synthetic",
        requestedAmount: "10.00",
        currencyCode: "usd",
        paymentMethodCategory: "card",
        quoteFingerprint: quote.quote_fingerprint,
      },
      context,
    );
  }
  async function captured(runtime: ReturnType<typeof services>, fundingId: WalletFundingId) {
    await create(runtime, fundingId);
    await runtime.walletFunding.command(
      fundingId,
      {
        type: "ObserveFunding",
        outcome: "captured",
        processorPaymentReference: `pi_synthetic_${fundingId}`,
        at: new Date().toISOString(),
      },
      context,
    );
  }
  async function project(fundingId: WalletFundingId) {
    const store = createPostgresEventStore({ pool: pools.payments });
    const handlers = buildWalletFundingProjectionHandlers(pools.payments);
    const events = await store.readStream({ streamId: `payments.wallet-funding-${fundingId}` });
    for (const event of events) await handlers[event.eventType](toTransportEvent(event));
  }
  it("sweep-filter mutant selects a refused refund which the real bounded sweep excludes", async () => {
    const runtime = services();
    const fundingId: WalletFundingId = "wfp_synthetic_sweep";
    await captured(runtime, fundingId);
    await runtime.walletFunding.refund(
      { fundingId, accountId: "acc_synthetic", refundId: "wfr_synthetic_refused", amount: "10.00" },
      context,
    );
    await project(fundingId);
    const query = vi.spyOn(pools.payments, "query");
    try {
      expect((await runtime.walletFunding.reconcile(context)).checked).toBe(0);
      const sql = query.mock.calls.find(([sql]) => sql.includes("ORDER BY reconciled_at"))?.[0];
      expect(sql).toBeDefined();
      const mutant = sql!.replace("'committed', 'released', 'refused'", "'committed', 'released'");
      expect(mutant).not.toBe(sql);
      expect((await pools.payments.query(sql!)).rows).toEqual([]);
      expect((await pools.payments.query(mutant)).rows).toEqual([{ funding_id: fundingId }]);
      await pools.payments.query(
        `UPDATE payments_wallet_funding_pages SET state = jsonb_set(state, '{refunds,wfr_synthetic_refused,status}', '"intent"'::jsonb) WHERE funding_id = $1`,
        [fundingId],
      );
      expect((await pools.payments.query(sql!)).rows).toEqual([]);
    } finally {
      query.mockRestore();
    }
  });
  it("ledgered migration and replay converge old refused-intent projections without changing economics or reservations", async () => {
    const runtime = services();
    const fundingId: WalletFundingId = "wfp_synthetic_migration";
    await captured(runtime, fundingId);
    await runtime.walletFunding.refund(
      { fundingId, accountId: "acc_synthetic", refundId: "wfr_synthetic_old", amount: "10.00" },
      context,
    );
    await project(fundingId);
    const before = (await runtime.walletFunding.list("acc_synthetic"))[0].state;
    const migration = walletFundingSchemaMigrations.find(
      (entry) => entry.migrationId === "20260927_payments_wallet_funding_terminal_refusal_attention",
    )!;
    await pools.payments.query(
      `UPDATE payments_wallet_funding_pages SET state = jsonb_set(state - 'refundAttention', '{refunds,wfr_synthetic_old,status}', '"intent"'::jsonb) WHERE funding_id = $1`,
      [fundingId],
    );
    await pools.payments.query("DELETE FROM bounded_context_schema_migrations WHERE migration_id = $1", [
      migration.migrationId,
    ]);
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    for (const statement of migration.statements) await pools.payments.query(statement);
    expect((await runtime.walletFunding.list("acc_synthetic"))[0].state).toEqual(before);
    expect(
      (
        await pools.payments.query(
          "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1",
          [migration.migrationId],
        )
      ).rows,
    ).toEqual([{ migration_id: migration.migrationId }]);
    expect(
      (
        await pools.payments.query(
          "SELECT released FROM payments_wallet_funding_creation_reservations WHERE funding_id = $1",
          [fundingId],
        )
      ).rows,
    ).toEqual([{ released: false }]);
  });
  it.each(["terminal-conflict", "unknown-identity"] as const)(
    "signed %s webhook persists one attention before 200 and survives inbox replay/restart and projection replay",
    async (scenario) => {
      const authority: PrepaidRefundAuthority = {
        reserve: vi.fn(async (identity) => ({
          outcome: "reserved",
          reservation: { ...identity, reservationId: "synthetic-db-reservation" },
        })),
        commit: vi.fn(async () => ({ outcome: "committed" })),
        release: vi.fn(async () => ({ outcome: "released" })),
      };
      const runtime = services(authority);
      const fundingId: WalletFundingId = "wfp_synthetic_attention";
      await captured(runtime, fundingId);
      if (scenario === "terminal-conflict")
        await runtime.walletFunding.refund(
          { fundingId, accountId: "acc_synthetic", refundId: "wfr_synthetic_db", amount: "2.00" },
          context,
        );
      await project(fundingId);
      const before = await runtime.walletFunding.stateFor(fundingId);
      const commitCalls = vi.mocked(authority.commit).mock.calls.length;
      const timestamp = Math.floor(Date.now() / 1000);
      const raw = JSON.stringify({
        id: "evt_synthetic_refund_attention",
        type: "refund.updated",
        created: timestamp,
        data: {
          object: {
            id: "re_synthetic_db",
            payment_intent: `pi_synthetic_${fundingId}`,
            amount: 200,
            currency: "usd",
            status: scenario === "terminal-conflict" ? "failed" : "succeeded",
            metadata:
              scenario === "terminal-conflict"
                ? { payment_id: fundingId, refund_id: "wfr_synthetic_db", purpose: "wallet-funding" }
                : {},
          },
        },
      });
      const signature = `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`;
      const reason = scenario === "terminal-conflict" ? "refund_terminal_outcome_conflict" : "unknown-refund-identity";
      for (let replay = 0; replay < 2; replay++) {
        const restarted = services(authority);
        const route = createPaymentProcessorWebhookRoutes({
          ...restarted.payments,
          processWebhook: async (input, context) => {
            const result = await restarted.payments.processWebhook(input, context);
            const durable = await services(authority).walletFunding.stateFor(fundingId);
            expect(durable.refundAttention).toHaveLength(1);
            expect(durable.refundAttention[0].reason).toBe(reason);
            expect({ ...durable, refundAttention: [] }).toEqual(before);
            return result;
          },
        });
        const response = await route.request("/webhooks", {
          method: "POST",
          headers: { "stripe-signature": signature, "content-type": "application/json" },
          body: raw,
        });
        expect(response.status).toBe(200);
      }
      for (let replay = 0; replay < 2; replay++) await project(fundingId);
      const visible = (await runtime.walletFunding.list("acc_synthetic"))[0].state;
      expect(visible.refundAttention).toEqual((await runtime.walletFunding.stateFor(fundingId)).refundAttention);
      expect({ ...visible, refundAttention: [] }).toEqual(before);
      expect(
        (await pools.payments.query("SELECT provider_event_id FROM payments_provider_webhook_events")).rows,
      ).toHaveLength(1);
      expect(
        (
          await pools.payments.query(
            "SELECT event_id FROM event_store_events WHERE event_type = 'payments.wallet-funding-refund-attention-recorded'",
          )
        ).rows,
      ).toHaveLength(1);
      expect(authority.commit).toHaveBeenCalledTimes(commitCalls);
      expect(authority.release).not.toHaveBeenCalled();
    },
  );
  it("signed metadata-only funding capture uses one inbox row and fact, no Payment row or order fact, across two funding attempts", async () => {
    const runtime = services();
    await create(runtime, "wfp_synthetic_a");
    await create(runtime, "wfp_synthetic_b");
    expect(
      (await pools.payments.query("SELECT funding_id FROM payments_wallet_funding_creation_reservations")).rows,
    ).toHaveLength(2);
    expect((await pools.payments.query("SELECT payment_id FROM payments_payment_pages")).rows).toHaveLength(0);
    const timestamp = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify({
      id: "evt_synthetic_funding_capture",
      type: "payment_intent.succeeded",
      created: timestamp,
      data: {
        object: {
          id: "pi_synthetic_wfp_synthetic_a",
          status: "succeeded",
          amount: Number(quote.processor_amount) * 100,
          currency: "usd",
          metadata: { payment_id: "wfp_synthetic_a", purpose: "wallet-funding" },
        },
      },
    });
    const signature = `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`;
    const route = createPaymentProcessorWebhookRoutes(runtime.payments);
    for (let replay = 0; replay < 2; replay++) {
      const response = await route.request("/webhooks", {
        method: "POST",
        headers: { "stripe-signature": signature, "content-type": "application/json" },
        body: raw,
      });
      expect(response.status).toBe(200);
    }
    expect(
      (await pools.payments.query("SELECT provider_event_id FROM payments_provider_webhook_events")).rows,
    ).toHaveLength(1);
    const facts = await pools.payments.query<{ event_type: string; payload: Record<string, unknown> }>(
      "SELECT event_type, payload FROM event_store_events",
    );
    const captures = facts.rows.filter((row) => row.event_type === "payments.wallet-funding-captured");
    expect(captures).toHaveLength(1);
    expect(captures[0].payload).toMatchObject({
      requestedAmount: "10.00",
      feeAmount: quote.marketplace_checkout_fee_amount,
      grossAmount: quote.processor_amount,
    });
    expect(facts.rows.some((row) => row.event_type.startsWith("payments.payment-"))).toBe(false);
    expect((await pools.payments.query("SELECT * FROM notification_outbox")).rows).toHaveLength(0);
  });
  it("shared-reservation mutant prevents the required second funding", async () => {
    const runtime = services();
    await create(runtime, "wfp_synthetic_a");
    await pools.payments.query(
      "CREATE UNIQUE INDEX synthetic_shared_reservation_mutant ON payments_wallet_funding_creation_reservations (account_id)",
    );
    await expect(create(runtime, "wfp_synthetic_b")).rejects.toMatchObject({ code: "23505" });
  });
});
