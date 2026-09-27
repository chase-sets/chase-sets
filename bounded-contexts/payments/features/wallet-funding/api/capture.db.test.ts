import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createStripePaymentProcessorGateway } from "@chase-sets/stripe-payments";
import { module as paymentsModule } from "../../../index";
import { createPaymentsServices } from "../../../support/runtime-support/services";
import { createPaymentProcessorWebhookRoutes } from "../../payments/api/route";
import { quoteMarketplaceCheckoutFee } from "../../payments/api/marketplace-checkout-fee-policy";
import type { WalletFundingId } from "../domain/domain";

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
  function services() {
    const stripe = createStripePaymentProcessorGateway({
      secretKey: "sk_test_synthetic",
      publishableKey: "pk_test_synthetic",
      webhookSecret: secret,
    });
    return createPaymentsServices(pools.payments, {
      processorGateway: {
        ...createFakePaymentProcessorGateway(),
        parseWebhook: stripe.parseWebhook,
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
