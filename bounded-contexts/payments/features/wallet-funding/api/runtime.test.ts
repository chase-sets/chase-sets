import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryFunction, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import type { PaymentProcessorGateway } from "@chase-sets/payment-processing";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { buildPaymentsApi } from "../../../api";
import { createPaymentsServices } from "../../../support/runtime-support/services";
import { quoteMarketplaceCheckoutFee } from "../../payments/api/marketplace-checkout-fee-policy";
import { createWalletFundingRuntime, type WalletFundingRuntimeDeps } from "./runtime";
import { defaultWalletFundingLimits, decodeWalletFundingLimits } from "./limits-policy";
import type { PrepaidRefundAuthority, PrepaidRefundReservation } from "./prepaid-refund-authority";
import { decideWalletFunding, initialWalletFundingState, type WalletFundingId } from "../domain/domain";

const context: EventStoreContext = {
  tenantId: "tnt_synthetic",
  audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
};
const at = "2026-09-27T00:00:00.000Z";
const fundingId: WalletFundingId = "wfp_synthetic";
const identity = {
  accountId: "acc_synthetic" as const,
  fundingId,
  refundId: "wfr_synthetic",
  amount: "2.00",
  currencyCode: "usd" as const,
};

function harness(options: Partial<WalletFundingRuntimeDeps> = {}) {
  const store = options.eventStore ?? createInMemoryEventStore().eventStore;
  const reservations = new Map<string, PrepaidRefundReservation>();
  const commits = new Set<string>();
  const releases = new Set<string>();
  const calls: string[] = [];
  const authority: PrepaidRefundAuthority = {
    reserve: vi.fn<PrepaidRefundAuthority["reserve"]>(async (input) => {
      calls.push("reserve");
      const reservation = reservations.get(input.refundId) ?? {
        ...input,
        reservationId: `synthetic:${input.refundId}`,
      };
      reservations.set(input.refundId, reservation);
      return { outcome: "reserved", reservation };
    }),
    commit: vi.fn<PrepaidRefundAuthority["commit"]>(async (input) => {
      calls.push("commit");
      commits.add(input.refundId);
      return { outcome: "committed" };
    }),
    release: vi.fn<PrepaidRefundAuthority["release"]>(async (input) => {
      calls.push("release");
      releases.add(input.refundId);
      return { outcome: "released" };
    }),
  };
  const query: PgQueryFunction = async <Row>(sql: string) => {
    const rows = sql.includes("COALESCE(sum")
      ? [{ amount: "0.00" }]
      : sql.includes("ORDER BY reconciled_at")
        ? [{ funding_id: fundingId }]
        : [];
    return { rows: rows as Row[] };
  };
  const pool: PgTransactionalPool = { query, connect: async () => ({ query, release: () => {} }) };
  const gateway: PaymentProcessorGateway = {
    ...createFakePaymentProcessorGateway(),
    createPaymentSession: vi.fn<PaymentProcessorGateway["createPaymentSession"]>(async () => ({
      processorName: "stripe",
      processorPaymentKind: "payment-intent",
      processorPaymentReference: "pi_synthetic",
      processorClientSecret: "synthetic-client-secret",
      processorRedirectUrl: null,
      processorStatus: "requires_confirmation",
    })),
    createRefund: vi.fn<PaymentProcessorGateway["createRefund"]>(async () => {
      calls.push("provider");
      return { processorName: "stripe", processorRefundReference: "re_synthetic", processorStatus: "succeeded" };
    }),
  };
  const runtime = createWalletFundingRuntime({
    eventStore: store,
    pool,
    processorGateway: gateway,
    prepaidRefundAuthority: authority,
    now: () => new Date(at),
    environment: { DEPLOYMENT_ENVIRONMENT: "test" },
    walletFundingEligibilityResolver: { resolve: async () => ({ goodStanding: true, paymentsTerms: "not-active" }) },
    ...options,
  });
  const quote = quoteMarketplaceCheckoutFee({
    orderAmount: "10.00",
    externalBasisAmount: "10.00",
    balanceCreditAmount: "0.00",
    paymentMethodCategory: "card",
  });
  async function captured() {
    await runtime.command(
      fundingId,
      {
        type: "Quote",
        quote: {
          fundingId,
          accountId: identity.accountId,
          requestedAmount: "10.00",
          feeAmount: quote.marketplace_checkout_fee_amount,
          grossAmount: quote.processor_amount,
          currencyCode: "usd",
          quoteFingerprint: quote.quote_fingerprint,
          quotedAt: at,
          savedInstrumentId: null,
        },
      },
      context,
    );
    await runtime.command(
      fundingId,
      { type: "RecordCreated", processorPaymentReference: "pi_synthetic", processorRedirectUrl: null },
      context,
    );
    await runtime.command(
      fundingId,
      { type: "ObserveFunding", outcome: "captured", processorPaymentReference: "pi_synthetic", at },
      context,
    );
  }
  return { runtime, store, pool, gateway, authority, reservations, commits, releases, calls, quote, captured };
}
const createInput = {
  fundingId,
  accountId: identity.accountId,
  requestedAmount: "10.00",
  currencyCode: "usd",
  paymentMethodCategory: "card",
};

describe("wallet-funding-fee-gross-up", () => {
  it("uses the unchanged checkout fingerprint and charges requested plus fee", async () => {
    const h = harness();
    const quoted = await h.runtime.create(createInput, context);
    expect(quoted.quote.quote_fingerprint).toBe(h.quote.quote_fingerprint);
    expect(h.gateway.createPaymentSession).not.toHaveBeenCalled();
    await h.runtime.create({ ...createInput, quoteFingerprint: h.quote.quote_fingerprint }, context);
    expect(h.gateway.createPaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: h.quote.processor_amount,
        orderIds: [],
        purpose: "wallet-funding",
        cardAuthentication: { requestThreeDSecure: "any", reasonCodes: ["wallet-funding"] },
      }),
    );
    expect(h.quote.processor_amount).not.toBe("10.00");
    expect(
      JSON.stringify(await h.store.readStream({ streamId: `payments.wallet-funding-${fundingId}` })),
    ).not.toContain("synthetic-client-secret");
  });
  it("rejects stale fingerprints without provider work", async () => {
    const h = harness();
    expect((await h.runtime.create({ ...createInput, quoteFingerprint: "stale" }, context)).outcome).toBe(
      "fee_quote_stale",
    );
    expect(h.gateway.createPaymentSession).not.toHaveBeenCalled();
  });
  it("rejects the no-fee gross mutant at the aggregate boundary", () => {
    expect(() =>
      decideWalletFunding(initialWalletFundingState, {
        type: "Quote",
        quote: {
          fundingId,
          accountId: identity.accountId,
          requestedAmount: "10.00",
          feeAmount: "0.61",
          grossAmount: "10.00",
          currencyCode: "usd",
          quoteFingerprint: "synthetic",
          quotedAt: at,
          savedInstrumentId: null,
        },
      }),
    ).toThrow("funding_gross_invalid");
  });
});

describe("wallet-funding-eligibility", () => {
  it.each([
    [{ requestedAmount: "4.99" }, "funding_below_minimum"],
    [{ requestedAmount: "500.01" }, "funding_above_maximum"],
    [{ currencyCode: "eur" }, "funding_currency_not_allowed"],
    [{ paymentMethodCategory: "bank-account" }, "funding_method_not_allowed"],
  ] as const)("refuses %j before processor work", async (patch, reason) => {
    const h = harness();
    await expect(
      h.runtime.create({ ...createInput, ...patch, quoteFingerprint: h.quote.quote_fingerprint }, context),
    ).rejects.toThrow(reason);
    expect(h.gateway.createPaymentSession).not.toHaveBeenCalled();
  });
  it.each(["not-active", "accepted", "unaccepted"] as const)(
    "evaluates the payments-terms result %s",
    async (paymentsTerms) => {
      const h = harness({
        walletFundingEligibilityResolver: { resolve: async () => ({ goodStanding: true, paymentsTerms }) },
      });
      const attempt = h.runtime.create({ ...createInput, quoteFingerprint: h.quote.quote_fingerprint }, context);
      if (paymentsTerms === "unaccepted") {
        await expect(attempt).rejects.toThrow("funding_payments_terms_required");
        expect(h.gateway.createPaymentSession).not.toHaveBeenCalled();
      } else {
        expect((await attempt).outcome).toBe("created");
        expect(h.gateway.createPaymentSession).toHaveBeenCalledOnce();
      }
    },
  );
  it("refuses suspended accounts and unapproved production", async () => {
    const suspended = harness({
      walletFundingEligibilityResolver: { resolve: async () => ({ goodStanding: false, paymentsTerms: "accepted" }) },
    });
    await expect(suspended.runtime.create(createInput, context)).rejects.toThrow(
      "funding_account_not_in_good_standing",
    );
    const production = harness({ environment: { DEPLOYMENT_ENVIRONMENT: "production" } });
    await expect(production.runtime.create(createInput, context)).rejects.toThrow("funding_production_not_approved");
  });
  it("closes policy values recursively, including the limits-bypass negative controls", () => {
    expect(decodeWalletFundingLimits(defaultWalletFundingLimits)).toEqual(defaultWalletFundingLimits);
    for (const value of [
      { ...defaultWalletFundingLimits, bypass: true },
      { ...defaultWalletFundingLimits, allowedMethods: ["card", "bank-account"] },
      { ...defaultWalletFundingLimits, allowedCurrencies: [{ code: "usd", bypass: true }] },
      { ...defaultWalletFundingLimits, minimumAmount: "0.00" },
      { ...defaultWalletFundingLimits, maximumAmount: "4.00" },
    ])
      expect(() => decodeWalletFundingLimits(value)).toThrow("funding_limits_invalid");
  });
});

describe("wallet-funding-refund-bounded (synthetic authority, not Settlement proof)", () => {
  it("durably reserves before one provider call, one fact and an idempotent commit across retries", async () => {
    const h = harness();
    await h.captured();
    vi.mocked(h.gateway.createRefund).mockImplementation(async () => {
      const op = (await h.runtime.stateFor(fundingId)).refunds[identity.refundId];
      expect(op.status).toBe("submitting");
      expect(op.reservationId).toBe("synthetic:wfr_synthetic");
      h.calls.push("provider");
      return { processorName: "stripe", processorRefundReference: "re_synthetic", processorStatus: "succeeded" };
    });
    const [a, b] = await Promise.all([h.runtime.refund(identity, context), h.runtime.refund(identity, context)]);
    await h.runtime.refund(identity, context);
    expect([a.status, b.status]).toContain("committed");
    expect(h.gateway.createRefund).toHaveBeenCalledOnce();
    expect(h.calls.indexOf("reserve")).toBeLessThan(h.calls.indexOf("provider"));
    expect(h.commits.size).toBe(1);
    expect(
      (await h.store.readStream({ streamId: `payments.wallet-funding-${fundingId}` })).filter(
        (e) => e.eventType === "payments.wallet-funding-refunded",
      ),
    ).toHaveLength(1);
    expect(h.releases.size).toBe(0);
  });
  it("refuses mismatched replay and principal over-refunds", async () => {
    const h = harness();
    await h.captured();
    await h.runtime.refund(identity, context);
    await expect(h.runtime.refund({ ...identity, amount: "3.00" }, context)).rejects.toThrow(
      "refund_identity_conflict",
    );
    await expect(h.runtime.refund({ ...identity, refundId: "wfr_other", amount: "9.00" }, context)).rejects.toThrow(
      "funding_refund_exceeds_requested",
    );
    expect(h.gateway.createRefund).toHaveBeenCalledOnce();
  });
  it.each(["default", "refused", "unavailable", "malformed"] as const)(
    "%s authority makes zero provider calls",
    async (mode) => {
      const synthetic: PrepaidRefundAuthority = {
        reserve: async (input) => {
          if (mode === "unavailable") throw new Error("synthetic transport failure with sensitive text");
          if (mode === "malformed")
            return { outcome: "reserved", reservation: { ...input, amount: "1.00", reservationId: "synthetic" } };
          return { outcome: "refused", reason: "insufficient-unspent" };
        },
        commit: async () => ({ outcome: "committed" }),
        release: async () => ({ outcome: "released" }),
      };
      const h = harness({ prepaidRefundAuthority: mode === "default" ? undefined : synthetic });
      await h.captured();
      const result = await h.runtime.refund(identity, context);
      expect(result.status).toBe("intent");
      expect(h.gateway.createRefund).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("sensitive");
    },
  );
  it("reserve-bypass negative control cannot claim provider submission", async () => {
    const h = harness();
    await h.captured();
    await h.runtime.command(fundingId, { type: "RequestRefund", identity, at }, context);
    const result = await h.runtime.command(
      fundingId,
      { type: "ClaimRefundSubmission", refundId: identity.refundId, at },
      context,
    );
    expect(result.newEvents).toHaveLength(0);
    expect(result.state.refunds[identity.refundId].status).toBe("intent");
    expect(h.gateway.createRefund).not.toHaveBeenCalled();
  });
  it.each(["pending", "unknown"] as const)(
    "%s keeps its reservation and recovery never blindly resubmits",
    async (status) => {
      const h = harness();
      await h.captured();
      vi.mocked(h.gateway.createRefund).mockResolvedValue({
        processorName: "stripe",
        processorRefundReference: "re_synthetic",
        processorStatus: status,
      });
      expect((await h.runtime.refund(identity, context)).status).toBe(status);
      await h.runtime.reconcile(context);
      await h.runtime.refund(identity, context);
      expect(h.gateway.createRefund).toHaveBeenCalledOnce();
      expect(h.commits.size).toBe(0);
      expect(h.releases.size).toBe(0);
    },
  );
  it("recovers after a transport ambiguity by exact refund lookup", async () => {
    const h = harness();
    await h.captured();
    vi.mocked(h.gateway.createRefund).mockRejectedValue(new Error("synthetic transport"));
    await h.runtime.refund(identity, context);
    h.gateway.retrieveWalletFundingRefund = vi.fn<NonNullable<PaymentProcessorGateway["retrieveWalletFundingRefund"]>>(
      async () => ({
        fundingId,
        refundId: identity.refundId,
        processorPaymentReference: "pi_synthetic",
        processorRefundReference: "re_synthetic",
        amount: "2.00",
        currencyCode: "usd",
        status: "succeeded",
      }),
    );
    await h.runtime.reconcile(context);
    expect((await h.runtime.stateFor(fundingId)).refunds[identity.refundId].status).toBe("committed");
    expect(h.gateway.createRefund).toHaveBeenCalledOnce();
    expect(h.releases.size).toBe(0);
  });
  it("delayed commit keeps durable success and retries only the authority", async () => {
    const h = harness();
    await h.captured();
    vi.mocked(h.authority.commit).mockRejectedValueOnce(new Error("synthetic unavailable"));
    expect((await h.runtime.refund(identity, context)).status).toBe("success-awaiting-commit");
    await h.runtime.reconcile(context);
    expect((await h.runtime.stateFor(fundingId)).refunds[identity.refundId].status).toBe("committed");
    expect(h.gateway.createRefund).toHaveBeenCalledOnce();
    expect(h.releases.size).toBe(0);
  });
  it.each(["failed", "cancelled"] as const)(
    "%s releases only after durable terminal evidence",
    async (processorStatus) => {
      const h = harness();
      await h.captured();
      vi.mocked(h.gateway.createRefund).mockResolvedValue({
        processorName: "stripe",
        processorRefundReference: "re_synthetic",
        processorStatus,
      });
      expect((await h.runtime.refund(identity, context)).status).toBe("released");
      await h.runtime.refund(identity, context);
      expect(h.releases.size).toBe(1);
      expect(h.gateway.createRefund).toHaveBeenCalledOnce();
      await expect(
        h.runtime.command(
          fundingId,
          {
            type: "ObserveRefund",
            observation: {
              refundId: identity.refundId,
              processorRefundReference: "re_synthetic",
              amount: "2.00",
              currencyCode: "usd",
              status: "succeeded",
              evidenceId: "synthetic-late-success",
              at,
            },
          },
          context,
        ),
      ).rejects.toThrow("refund_terminal_outcome_conflict");
    },
  );
  it("late pending cannot downgrade committed success", async () => {
    const h = harness();
    await h.captured();
    await h.runtime.refund(identity, context);
    await h.runtime.command(
      fundingId,
      {
        type: "ObserveRefund",
        observation: {
          refundId: identity.refundId,
          processorRefundReference: "re_synthetic",
          amount: "2.00",
          currencyCode: "usd",
          status: "pending",
          evidenceId: "synthetic-late-pending",
          at,
        },
      },
      context,
    );
    expect((await h.runtime.stateFor(fundingId)).refunds[identity.refundId].status).toBe("committed");
  });
  it.each(["reserved", "submitting", "success-awaiting-commit"] as const)(
    "recovers a crash before persisting %s without changing refund identity",
    async (phase) => {
      const memory = createInMemoryEventStore().eventStore;
      let injectCrash = false;
      const store: EventStore = {
        ...memory,
        appendToStream: async (input) => {
          if (
            injectCrash &&
            input.events.some(
              (event) =>
                event.eventType === "payments.wallet-funding-refund-operation-recorded" &&
                event.payload.status === phase,
            )
          ) {
            injectCrash = false;
            throw new Error("synthetic crash boundary");
          }
          return memory.appendToStream(input);
        },
      };
      const h = harness({ eventStore: store });
      await h.captured();
      injectCrash = true;
      await expect(h.runtime.refund(identity, context)).rejects.toThrow("synthetic crash boundary");
      const before = await h.runtime.stateFor(fundingId);
      expect(before.refunds[identity.refundId].amount).toBe("2.00");
      h.gateway.retrieveWalletFundingRefund = vi.fn<
        NonNullable<PaymentProcessorGateway["retrieveWalletFundingRefund"]>
      >(async () => ({
        fundingId,
        refundId: identity.refundId,
        processorPaymentReference: "pi_synthetic",
        processorRefundReference: "re_synthetic",
        amount: "2.00",
        currencyCode: "usd",
        status: "succeeded",
      }));
      const restarted = harness({
        eventStore: store,
        pool: h.pool,
        processorGateway: h.gateway,
        prepaidRefundAuthority: h.authority,
      });
      await restarted.runtime.reconcile(context);
      expect((await restarted.runtime.stateFor(fundingId)).refunds[identity.refundId].status).toBe("committed");
      expect(h.gateway.createRefund).toHaveBeenCalledOnce();
      expect(h.commits.size).toBe(1);
      expect(h.releases.size).toBe(0);
    },
  );
  it("elapsed months never release an unknown provider submission", async () => {
    const h = harness();
    await h.captured();
    vi.mocked(h.gateway.createRefund).mockRejectedValue(new Error("synthetic unknown outcome"));
    await h.runtime.refund(identity, context);
    const restarted = harness({
      eventStore: h.store,
      pool: h.pool,
      processorGateway: h.gateway,
      prepaidRefundAuthority: h.authority,
      now: () => new Date("2027-02-01T00:00:00Z"),
    });
    const result = await restarted.runtime.reconcile(context);
    expect(result.attention).toContainEqual({
      fundingId,
      refundId: identity.refundId,
      classification: "refund-provider-outcome-unknown",
    });
    expect(h.releases.size).toBe(0);
    expect(h.gateway.createRefund).toHaveBeenCalledOnce();
  });
  it("a crash after the submission claim never blindly submits or releases, including a wrong-refund lookup", async () => {
    const h = harness();
    await h.captured();
    await h.runtime.command(fundingId, { type: "RequestRefund", identity, at }, context);
    const reserved = await h.authority.reserve(identity);
    if (reserved.outcome !== "reserved") throw new Error("synthetic reservation required");
    await h.runtime.command(fundingId, { type: "ReserveRefund", reservation: reserved.reservation, at }, context);
    await h.runtime.command(fundingId, { type: "ClaimRefundSubmission", refundId: identity.refundId, at }, context);
    h.gateway.retrieveWalletFundingRefund = vi
      .fn<NonNullable<PaymentProcessorGateway["retrieveWalletFundingRefund"]>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        fundingId,
        refundId: "wfr_wrong",
        processorPaymentReference: "pi_synthetic",
        processorRefundReference: "re_wrong",
        amount: identity.amount,
        currencyCode: "usd",
        status: "succeeded",
      });
    for (let attempt = 0; attempt < 2; attempt++) {
      const recovery = await h.runtime.reconcile(context);
      expect(recovery.attention).toContainEqual({
        fundingId,
        refundId: identity.refundId,
        classification: "refund-provider-outcome-unknown",
      });
    }
    expect((await h.runtime.stateFor(fundingId)).refunds[identity.refundId].status).toBe("submitting");
    expect(h.gateway.createRefund).not.toHaveBeenCalled();
    expect(h.commits.size).toBe(0);
    expect(h.releases.size).toBe(0);
  });
  it("failure-awaiting-release retries only release after an authority outage", async () => {
    const h = harness();
    await h.captured();
    vi.mocked(h.gateway.createRefund).mockResolvedValue({
      processorName: "stripe",
      processorRefundReference: "re_synthetic",
      processorStatus: "failed",
    });
    vi.mocked(h.authority.release).mockRejectedValueOnce(new Error("synthetic outage"));
    expect((await h.runtime.refund(identity, context)).status).toBe("failure-awaiting-release");
    await h.runtime.reconcile(context);
    expect((await h.runtime.stateFor(fundingId)).refunds[identity.refundId].status).toBe("released");
    expect(h.gateway.createRefund).toHaveBeenCalledOnce();
    expect(h.releases.size).toBe(1);
  });
});

describe("wallet-funding-route-isolation", () => {
  it("does not expose a funding through order Payment detail and leaves checkout routes mounted", async () => {
    const h = harness();
    await h.captured();
    const services = { ...createPaymentsServices(h.pool, { processorGateway: h.gateway }), walletFunding: h.runtime };
    const app = new Hono<AuthenticatedApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        tenantId: "tnt_synthetic",
        accountId: "acc_synthetic",
        userId: "usr_synthetic",
        sessionId: "synthetic-session",
        membershipId: "synthetic-membership",
        roleKey: "owner",
        permissions: ["orders.view", "orders.manage"],
      });
      c.set("context", context);
      await next();
    });
    app.route("/", buildPaymentsApi(services));
    expect((await app.request(`/account/payments/${fundingId}`)).status).toBe(404);
    expect((await app.request("/account/wallet-fundings")).status).toBe(200);
    expect((await app.request("/account/marketplace-checkout-fee-policy")).status).toBe(200);
  });
  it("rejects a refund for another account before provider work", async () => {
    const h = harness();
    await h.captured();
    await expect(h.runtime.refund({ ...identity, accountId: "acc_other" }, context)).rejects.toThrow(
      "refund_identity_conflict",
    );
    expect(h.gateway.createRefund).not.toHaveBeenCalled();
  });
});

describe("wallet-funding-dispute-fraud-reconcile", () => {
  it("a retryable failed PaymentIntent does not release creation quota before definitive cancellation", async () => {
    const h = harness();
    await h.runtime.create({ ...createInput, quoteFingerprint: h.quote.quote_fingerprint }, context);
    const query = vi.spyOn(h.pool, "query");
    await h.runtime.processWebhook(
      {
        eventId: "evt_synthetic_failed",
        kind: "payment-failed",
        internalPaymentId: fundingId,
        processorName: "stripe",
        processorPaymentKind: "payment-intent",
        processorPaymentReference: "pi_synthetic",
        processorStatus: "requires_payment_method",
        failureCode: null,
        failureMessage: null,
        occurredAt: at,
      },
      context,
    );
    expect((await h.runtime.stateFor(fundingId)).status).toBe("failed");
    expect(query.mock.calls.some(([sql]) => sql.includes("SET released = true"))).toBe(false);
  });
  it("fails a stale pending funding only after definitive provider cancellation and releases its creation reservation", async () => {
    const h = harness();
    await h.runtime.create({ ...createInput, quoteFingerprint: h.quote.quote_fingerprint }, context);
    const result = {
      processorName: "stripe" as const,
      processorPaymentKind: "payment-intent" as const,
      processorPaymentReference: "pi_synthetic",
      processorStatus: "requires_confirmation",
      occurredAt: at,
    };
    h.gateway.retrievePaymentResult = vi.fn(async () => ({ ...result, outcome: "pending" as const }));
    h.gateway.cancelPayment = vi.fn(async () => ({
      ...result,
      outcome: "cancelled" as const,
      processorStatus: "canceled",
    }));
    const query = vi.spyOn(h.pool, "query");
    const restarted = harness({
      eventStore: h.store,
      pool: h.pool,
      processorGateway: h.gateway,
      prepaidRefundAuthority: h.authority,
      now: () => new Date("2026-09-29T00:00:00Z"),
    });
    await restarted.runtime.reconcile(context);
    expect((await restarted.runtime.stateFor(fundingId)).status).toBe("failed");
    expect(h.gateway.cancelPayment).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      "UPDATE payments_wallet_funding_creation_reservations SET released = true WHERE funding_id = $1",
      [fundingId],
    );
    expect(h.authority.release).not.toHaveBeenCalled();
  });
  it("refunding all requested principal reaches refunded without returning the fee", async () => {
    const h = harness();
    await h.captured();
    await h.runtime.refund({ ...identity, amount: "10.00" }, context);
    const state = await h.runtime.stateFor(fundingId);
    expect(state.status).toBe("refunded");
    expect(state.refundedAmount).toBe("10.00");
    expect(h.gateway.createRefund).toHaveBeenCalledWith(expect.objectContaining({ amount: "10.00" }));
  });
  it("preserves actual dispute principal/fee, won return, and one fraud warning", async () => {
    const h = harness();
    await h.captured();
    const dispute = {
      type: "RecordDispute" as const,
      disputeId: "dp_synthetic",
      amount: "10.00",
      feeAmount: "15.00",
      at,
    };
    await h.runtime.command(fundingId, { ...dispute, lifecycle: "opened" }, context);
    await h.runtime.command(fundingId, { ...dispute, lifecycle: "won" }, context);
    expect((await h.runtime.stateFor(fundingId)).status).toBe("captured");
    await h.runtime.command(fundingId, { ...dispute, disputeId: "dp_loss", lifecycle: "opened" }, context);
    await h.runtime.command(fundingId, { ...dispute, disputeId: "dp_loss", lifecycle: "lost" }, context);
    for (let i = 0; i < 2; i++)
      await h.runtime.command(fundingId, { type: "RecordFraudWarning", warningId: "issfr_synthetic", at }, context);
    const events = await h.store.readStream({ streamId: `payments.wallet-funding-${fundingId}` });
    expect(
      events.filter((e) => e.eventType === "payments.wallet-funding-dispute-recorded").map((e) => e.payload.lifecycle),
    ).toEqual(["opened", "won", "opened", "lost"]);
    expect(
      events
        .filter((e) => e.eventType === "payments.wallet-funding-dispute-recorded")
        .every((e) => e.payload.disputeFeeAmount === "15.00"),
    ).toBe(true);
    expect(events.filter((e) => e.eventType === "payments.wallet-funding-fraud-warning-recorded")).toHaveLength(1);
    expect(
      events.some((e) => e.eventType.startsWith("payments.payment-") || e.eventType.startsWith("payments.refund-")),
    ).toBe(false);
  });
});
