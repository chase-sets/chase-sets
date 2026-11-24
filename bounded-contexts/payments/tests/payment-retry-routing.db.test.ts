import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PaymentProcessorGateway } from "@chase-sets/payment-processing";
import {
  createAccountPaymentRoutes,
  type CreateAccountPaymentRequest,
  type PaymentsApiEnv,
} from "../features/payments/api/route";
import { buildPaymentProjectionHandlers } from "../features/payments/read-model/projection";
import { reservePaymentCreation } from "../features/payments/read-model/queries";
import { module as paymentsModule } from "../index";
import { createPaymentsServices } from "../support/runtime-support/services";

const at = "2026-11-24T00:00:00.000Z";
const source = { sourceContext: "checkout", sourceReferenceId: "chk_retry" };
const request = {
  orderIds: ["ord_retry_a", "ord_retry_b"],
  currencyCode: "usd",
  paymentMethodCategory: "card",
  marketplaceCheckoutFeeQuoteFingerprint: "original-quote",
  requestedBalanceCreditAmount: "20.00",
} satisfies CreateAccountPaymentRequest;

describe("Payment retry routing over Postgres", () => {
  let pools: Readonly<Record<"payments", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is required for Payment retry DB proof.");
    const urls = createMultiContextTestDatabaseUrls(url, ["payments"], "payment_retry_routing");
    await ensureMultiContextTestDatabases(url, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.payments;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(paymentsModule, pool);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function fixture(key: string, database = pool) {
    const accountId = `acc_retry_${key}`;
    const paymentId = `pay_retry_${key}`;
    const context = {
      tenantId: "tnt_payment_retry" as never,
      audit: { performedByUserId: "usr_payment_retry" as never, forAccountId: accountId as never },
    };
    const noSend = vi.fn(async (): Promise<never> => {
      throw new Error("Retry must not send to a provider.");
    });
    const resolveBalanceCredit = vi.fn(async (): Promise<never> => {
      throw new Error("Retry must not re-resolve a hold.");
    });
    const processorGateway: PaymentProcessorGateway = {
      getPublicConfiguration: () => ({
        processorName: "stripe",
        publishableKey: null,
        confirmationExperience: "processor-managed-form",
        dynamicPaymentMethods: true,
        sensitivePaymentDetailsHandledByProcessor: true,
      }),
      createCustomer: noSend,
      createSetupSession: noSend,
      retrieveSetupSessionResult: noSend,
      cancelSetupSession: noSend,
      retrieveSavedPaymentMethod: noSend,
      detachSavedPaymentMethod: noSend,
      createPaymentSession: noSend,
      cancelPayment: noSend,
      retrievePaymentResult: noSend,
      createRefund: noSend,
      parseWebhook: noSend,
    };
    const { payments } = createPaymentsServices(database, {
      processorGateway,
      balanceCreditResolver: { resolveBalanceCredit },
    });
    const app = new Hono<PaymentsApiEnv>();
    app.use("*", async (c, next) => {
      c.set("context", context);
      c.set("actor", {
        accountId,
        userId: "usr_payment_retry",
        tenantId: "tnt_payment_retry",
        sessionId: "ses_payment_retry",
        membershipId: "mbr_payment_retry",
        roleKey: "owner",
        permissions: ["orders.manage"],
      });
      await next();
    });
    app.route("/account", createAccountPaymentRoutes(payments));

    return {
      accountId,
      paymentId,
      noSend,
      resolveBalanceCredit,
      post: (body: CreateAccountPaymentRequest) =>
        app.request("/account/payments", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": `198.51.100.${key === "direct" ? 34 : key === "checkout" ? 35 : 36}`,
          },
          body: JSON.stringify(body),
        }),
      async record(source?: { sourceContext: string; sourceReferenceId: string }, project = true) {
        const writer = createPaymentsServices(pool).payments;
        const created = await writer.commandHandler({
          streamId: `payments.payment-${paymentId}`,
          context,
          command: {
            type: "CreatePayment",
            paymentId: paymentId as never,
            buyerAccountId: accountId as never,
            orderIds: [...request.orderIds] as never,
            currencyCode: "usd",
            paymentMethodCategory: "card",
            marketplaceCheckoutFeeQuoteFingerprint: request.marketplaceCheckoutFeeQuoteFingerprint,
            amount: "25.00",
            processorAmount: "15.00",
            balanceCreditAmount: "10.00",
            marketplaceSalesFeeAmount: "1.00",
            marketplaceCheckoutFeeAmount: "0.50",
            sellerNetAmount: "23.50",
            processorName: "stripe",
            processorPaymentKind: "payment-intent",
            processorPaymentReference: `pi_${paymentId}`,
            processorClientSecret: null,
            processorStatus: "requires_payment_method",
            createdAt: at,
            ...source,
          },
        });
        if (project) {
          await buildPaymentProjectionHandlers(pool)["payments.payment-created"]!(
            toTransportEvent(created.storedEvents[0]!),
          );
        }
      },
    };
  }

  it.each([
    { key: "direct", storedSource: undefined },
    { key: "checkout", storedSource: source },
  ])("payment-retry-routes-to-original: $key intent and applied-credit floor", async ({ key, storedSource }) => {
    const test = fixture(key);
    await test.record(storedSource);
    const body = { ...request, ...storedSource };
    for (const changed of [
      { currencyCode: "cad" },
      { paymentMethodCategory: "bank-account" },
      { savedCheckoutInstrumentId: "sci_changed" },
      { marketplaceCheckoutFeeQuoteFingerprint: "changed-quote" },
      { sourceContext: "checkout", sourceReferenceId: "chk_other" },
      { requestedBalanceCreditAmount: "0.00" },
      ...(storedSource ? [{ orderIds: ["ord_other"] }] : []),
    ]) {
      const refused = await test.post({ ...body, ...changed });
      expect(refused.status, JSON.stringify(changed)).toBe(400);
      await expect(refused.json()).resolves.toMatchObject({ error: { code: "active_payment_exists_for_order_set" } });
    }
    const matching = await test.post({ ...body, orderIds: [...request.orderIds].reverse() });
    expect(matching.status).toBe(201);
    await expect(matching.json()).resolves.toMatchObject({
      payment_id: test.paymentId,
      balance_credit_amount: "10.00",
    });
    expect(test.noSend).not.toHaveBeenCalled();
    expect(test.resolveBalanceCredit).not.toHaveBeenCalled();
  });

  it("payment-retry-routes-to-original: waits on a source-less active reservation, even before projection", async () => {
    let sawEmptyStream!: () => void;
    const emptyStreamRead = new Promise<void>((resolve) => {
      sawEmptyStream = resolve;
    });
    const observed: PgTransactionalPool = {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect();
        return {
          release: client.release.bind(client),
          async query<Row>(sql: string, values?: readonly unknown[]) {
            const result = await client.query<Row>(sql, values);
            if (values?.[0] === "payments.payment-pay_retry_waiting" && result.rows.length === 0) sawEmptyStream();
            return result;
          },
        };
      },
    };
    const test = fixture("waiting", observed);
    await reservePaymentCreation(pool, {
      paymentId: test.paymentId,
      buyerAccountId: test.accountId,
      orderIds: request.orderIds,
      createdAt: at,
    });
    const pending = test.post(request);
    const first = await Promise.race([emptyStreamRead.then(() => "read"), pending.then(() => "returned")]);
    expect(first).toBe("read");
    await test.record(undefined, false);
    const response = await pending;
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ payment_id: test.paymentId });
    expect(test.noSend).not.toHaveBeenCalled();
    expect(test.resolveBalanceCredit).not.toHaveBeenCalled();
  });
});
