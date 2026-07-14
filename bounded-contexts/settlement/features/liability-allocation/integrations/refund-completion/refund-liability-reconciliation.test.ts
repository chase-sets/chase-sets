import { describe, expect, it, vi } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildSettlementPaymentInputProjectionHandlers } from "../../../wallets/integrations/payment-source/payment-source-projection";
import type { ProtectionCoverageSettlementPort } from "../../api/ports";

type QueryRouter = (text: string, values?: readonly unknown[]) => Record<string, unknown>[] | undefined;

function createDb(router: QueryRouter = () => undefined) {
  const queryMock = vi.fn(async (text: string, values?: readonly unknown[]) => ({
    rows: (router(text, values) ?? []) as never[],
  }));
  const db: PgQueryable = {
    query: async <Row = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PgQueryResult<Row>> => queryMock(text, values) as unknown as PgQueryResult<Row>,
  };
  return { db, queryMock };
}

function createWallets() {
  const postEntry = vi.fn(async (_params: Record<string, unknown>, _context?: unknown) => undefined);
  return { wallets: { postEntry } as never, postEntry };
}

function createCoverage(coverageRow: Record<string, unknown> | null) {
  const settle = vi.fn(async (_input: Record<string, unknown>, _context?: unknown) => ({
    outcome: "applied" as const,
    coverageId: "cov_1",
  }));
  const reserve = vi.fn(async (_input: Record<string, unknown>, _context?: unknown) => ({
    outcome: "reserved" as const,
    coverageId: "cov_1",
    currencyCode: "usd",
    reservedAmount: "40.00",
    rejectionReason: null,
  }));
  const getCoverage = vi.fn(async (_coverageId: string) => coverageRow as never);
  const protectionCoverage = { settle, reserve, getCoverage } as unknown as ProtectionCoverageSettlementPort;
  return { protectionCoverage, settle, reserve, getCoverage };
}

function transportEvent(type: string, data: Record<string, unknown>, streamVersion = 5) {
  return {
    id: "evt_refund",
    type,
    streamId: "payments.payment-pay_1",
    streamVersion,
    globalPosition: "1",
    tenantId: "tnt_test",
    data,
    metadata: {},
    audit: { performedByUserId: "usr_test", forAccountId: "acc_buyer" },
    trace: {},
    timing: { occurredAt: "2026-05-01T00:00:00.000Z", recordedAt: "2026-05-01T00:00:00.000Z" },
  } as never;
}

const sellerPayouts = [
  {
    orderId: "ord_1",
    sellerAccountId: "acc_seller",
    sellerItemNetAmount: "40.00",
    shippingAllowanceAmount: "0.00",
    sellerShippingPayoutAmount: "0.00",
    sellerPayoutAmount: "40.00",
    protectionAmount: "0.00",
    protectionAllowanceAmount: "0.00",
    protectionOverageAmount: "0.00",
  },
];

function allocationRow(overrides: Record<string, unknown> = {}) {
  return {
    refund_id: "rfd_1",
    remedy_id: "rmd_1",
    coverage_id: "cov_1",
    seller_funded_amount: "0.00",
    platform_funded_amount: "40.00",
    currency_code: "usd",
    funding_kind: "platform-funded",
    reconciliation_status: "authorized",
    completed_refund_amount: null,
    last_stream_version: 3,
    ...overrides,
  };
}

function reservedCoverageRow(overrides: Record<string, unknown> = {}) {
  return {
    coverage_id: "cov_1",
    remedy_id: "rmd_1",
    support_request_id: "sup_1",
    currency_code: "usd",
    reserved_amount: "40.00",
    consumed_amount: "0.00",
    released_amount: "0.00",
    status: "reserved",
    refund_id: null,
    policy_version: "coverage-policy-2026-07",
    reason_code: null,
    reserved_at: "2026-04-30T00:00:00.000Z",
    terminal_at: null,
    updated_at: "2026-04-30T00:00:00.000Z",
    ...overrides,
  };
}

function refundedEvent(overrides: Record<string, unknown> = {}) {
  return transportEvent("payments.payment-refunded", {
    paymentId: "pay_1",
    refundId: "rfd_1",
    amount: "40.00",
    currencyCode: "usd",
    processorStatus: "refunded",
    refundedAt: "2026-05-01T00:10:00.000Z",
    sellerPayouts,
    ...overrides,
  });
}

describe("allocation-aware refund liability reconciliation", () => {
  it("posts no seller debit and consumes the reserved coverage for a fully platform-funded refund", async () => {
    const { db, queryMock } = createDb((text) =>
      text.includes("FROM settlement_refund_liability_allocations") && text.includes("SELECT")
        ? [allocationRow()]
        : undefined,
    );
    const { wallets, postEntry } = createWallets();
    const { protectionCoverage, settle } = createCoverage(reservedCoverageRow());
    const handlers = buildSettlementPaymentInputProjectionHandlers(db, wallets, protectionCoverage);

    await handlers["payments.payment-refunded"]!(refundedEvent());

    expect(postEntry).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![0]).toMatchObject({
      coverageId: "cov_1",
      refundId: "rfd_1",
      platformFundedAmount: "40.00",
      sellerFundedAmount: "0.00",
    });
    expect(
      queryMock.mock.calls.some(
        (call) =>
          String(call[0]).includes("settlement_refund_liability_allocations") &&
          String(call[0]).includes("'reconciled'"),
      ),
    ).toBe(true);
  });

  it("debits exactly the seller portion and consumes exactly the platform portion for a split refund", async () => {
    const { db } = createDb((text) =>
      text.includes("FROM settlement_refund_liability_allocations") && text.includes("SELECT")
        ? [
            allocationRow({
              seller_funded_amount: "15.00",
              platform_funded_amount: "25.00",
              funding_kind: "split",
            }),
          ]
        : undefined,
    );
    const { wallets, postEntry } = createWallets();
    const { protectionCoverage, settle } = createCoverage(reservedCoverageRow({ reserved_amount: "25.00" }));
    const handlers = buildSettlementPaymentInputProjectionHandlers(db, wallets, protectionCoverage);

    await handlers["payments.payment-refunded"]!(refundedEvent());

    expect(postEntry).toHaveBeenCalledTimes(1);
    expect(postEntry.mock.calls[0]![0]).toMatchObject({ kind: "refund", direction: "debit", amount: "15.00" });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![0]).toMatchObject({ platformFundedAmount: "25.00", sellerFundedAmount: "15.00" });
  });

  it("preserves the legacy seller debit when the refund carries no authorized allocation", async () => {
    const { db } = createDb(() => undefined); // no allocation row recorded
    const { wallets, postEntry } = createWallets();
    const { protectionCoverage, settle } = createCoverage(null);
    const handlers = buildSettlementPaymentInputProjectionHandlers(db, wallets, protectionCoverage);

    await handlers["payments.payment-refunded"]!(refundedEvent());

    expect(settle).not.toHaveBeenCalled();
    expect(postEntry).toHaveBeenCalledTimes(1);
    expect(postEntry.mock.calls[0]![0]).toMatchObject({ kind: "refund", direction: "debit", amount: "40.00" });
  });

  it("quarantines a platform-funded refund whose reservation does not match, with no posting", async () => {
    const { db, queryMock } = createDb((text) =>
      text.includes("FROM settlement_refund_liability_allocations") && text.includes("SELECT")
        ? [allocationRow()]
        : undefined,
    );
    const { wallets, postEntry } = createWallets();
    const { protectionCoverage, settle } = createCoverage(reservedCoverageRow({ reserved_amount: "30.00" }));
    const handlers = buildSettlementPaymentInputProjectionHandlers(db, wallets, protectionCoverage);

    await handlers["payments.payment-refunded"]!(refundedEvent());

    expect(postEntry).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(
      queryMock.mock.calls.some(
        (call) =>
          String(call[0]).includes("settlement_refund_liability_allocations") &&
          String(call[0]).includes("'quarantined'") &&
          (call[1] as unknown[] | undefined)?.includes("reservation-mismatch"),
      ),
    ).toBe(true);
  });

  it("is idempotent when the coverage is already settled against the same refund", async () => {
    const { db } = createDb((text) =>
      text.includes("FROM settlement_refund_liability_allocations") && text.includes("SELECT")
        ? [allocationRow()]
        : undefined,
    );
    const { wallets } = createWallets();
    const { protectionCoverage, settle } = createCoverage(
      reservedCoverageRow({ status: "settled", refund_id: "rfd_1", consumed_amount: "40.00" }),
    );
    const handlers = buildSettlementPaymentInputProjectionHandlers(db, wallets, protectionCoverage);

    await handlers["payments.payment-refunded"]!(refundedEvent());

    expect(settle).not.toHaveBeenCalled();
  });

  it("records the authorized allocation from a refund-requested causation fact", async () => {
    const { db, queryMock } = createDb(() => undefined);
    const { wallets } = createWallets();
    const { protectionCoverage } = createCoverage(null);
    const handlers = buildSettlementPaymentInputProjectionHandlers(db, wallets, protectionCoverage);

    await handlers["payments.refund-requested"]!(
      transportEvent("payments.refund-requested", {
        refundId: "rfd_1",
        paymentId: "pay_1",
        orderIds: ["ord_1"],
        amount: "40.00",
        currencyCode: "usd",
        reason: "platform-coverage",
        processorName: "stripe",
        requestedAt: "2026-05-01T00:00:00.000Z",
        causation: {
          remedyId: "rmd_1",
          coverageId: "cov_1",
          allocation: {
            sellerFundedAmount: "0.00",
            platformFundedAmount: "40.00",
            currencyCode: "usd",
            fundingKind: "platform-funded",
          },
        },
      }),
    );

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO settlement_refund_liability_allocations"),
      expect.arrayContaining(["rfd_1" as never, "rmd_1" as never, "cov_1" as never, "platform-funded" as never]),
    );
  });
});
