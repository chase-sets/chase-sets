import { describe, expect, it, vi } from "vitest";
import { buildPaymentsSupportRefundEffectHandlers } from "./support-refund-effect-projection";

function baseEvent() {
  return {
    tenantId: "tnt_test",
    streamId: "support.support-request-sup_01ABC",
    streamVersion: 3,
    eventId: "evt_1",
    globalPosition: "1",
    timing: {
      occurredAt: "2026-05-31T14:00:00.000Z",
      recordedAt: "2026-05-31T14:00:00.000Z",
    },
    audit: {
      performedByUserId: "usr_test",
      forAccountId: "acc_buyer",
    },
    trace: null,
  };
}

describe("payments support refund effect projection", () => {
  it("records a concrete support refund effect id for launch evidence", async () => {
    const issueRefund = vi.fn(async () => ({ refundId: "rfd_1", version: 1 }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM payments_payment_pages")) {
          return { rows: [{ payment_id: "pay_1" }] };
        }
        if (sql.includes("FROM payments_order_inputs")) {
          return { rows: [{ order_id: "ord_1", total_amount: "12.00" }] };
        }
        if (sql.includes("INSERT INTO payments_support_refund_effects")) {
          return { rowCount: 1, rows: [{ support_request_id: "sup_01ABC", refund_id: "rfd_support" }] };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const handlers = buildPaymentsSupportRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["support.support-request.resolved"]?.({
      ...baseEvent(),
      type: "support.support-request.resolved",
      data: {
        supportRequestId: "sup_01ABC",
        orderId: "ord_1",
        resolution: {
          resolutionType: "partial-refund",
          refundAmount: "1.00",
          summary: "Controlled support refund.",
          resolvedAt: "2026-05-31T14:00:00.000Z",
        },
      },
    } as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("refund_effect_id"), [
      "sup_01ABC",
      "sre_01ABC",
      "ord_1",
      "pay_1",
      expect.any(String),
      "partial-refund",
      "1.00",
      "2026-05-31T14:00:00.000Z",
    ]);
    expect(issueRefund).toHaveBeenCalledWith(
      expect.objectContaining({ refundId: "rfd_support", paymentId: "pay_1", amount: "1.00" }),
      expect.objectContaining({ tenantId: "tnt_test" }),
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'refund-requested'"),
      expect.arrayContaining(["sup_01ABC", "pay_1", "rfd_1"]),
    );
  });

  it.each(["full-refund", "cancel-order"] as const)(
    "issues %s refunds immediately at resolution time, unchanged by the return-for-refund gate",
    async (resolutionType) => {
      const issueRefund = vi.fn(async () => ({ refundId: "rfd_1", version: 1 }));
      const db = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM payments_payment_pages")) {
            return { rows: [{ payment_id: "pay_1" }] };
          }
          if (sql.includes("FROM payments_order_inputs")) {
            return { rows: [{ order_id: "ord_1", total_amount: "12.00" }] };
          }
          if (sql.includes("INSERT INTO payments_support_refund_effects")) {
            return { rowCount: 1, rows: [{ support_request_id: "sup_01ABC", refund_id: "rfd_support" }] };
          }
          return { rows: [], rowCount: 0 };
        }),
      };
      const handlers = buildPaymentsSupportRefundEffectHandlers(db as never, { issueRefund } as never);

      await handlers["support.support-request.resolved"]?.({
        ...baseEvent(),
        type: "support.support-request.resolved",
        data: {
          supportRequestId: "sup_01ABC",
          orderId: "ord_1",
          resolution: {
            resolutionType,
            refundAmount: null,
            summary: "Immediate resolution.",
            resolvedAt: "2026-05-31T14:00:00.000Z",
          },
        },
      } as never);

      expect(issueRefund).toHaveBeenCalledTimes(1);
      const insertCall = db.query.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO payments_support_refund_effects"),
      );
      expect(insertCall?.[0]).not.toContain("awaiting-return");
    },
  );

  it("gates a return-for-refund resolution: records a pending-return effect without issuing a refund", async () => {
    const issueRefund = vi.fn(async () => ({ refundId: "rfd_1", version: 1 }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM payments_payment_pages")) {
          return { rows: [{ payment_id: "pay_1" }] };
        }
        if (sql.includes("FROM payments_order_inputs")) {
          return { rows: [{ order_id: "ord_1", total_amount: "12.00" }] };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const handlers = buildPaymentsSupportRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["support.support-request.resolved"]?.({
      ...baseEvent(),
      type: "support.support-request.resolved",
      data: {
        supportRequestId: "sup_01ABC",
        orderId: "ord_1",
        resolution: {
          resolutionType: "return-for-refund",
          refundAmount: null,
          summary: "Seller accepted the return.",
          resolvedAt: "2026-05-31T14:00:00.000Z",
        },
      },
    } as never);

    expect(issueRefund).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO payments_support_refund_effects[\s\S]*'awaiting-return'/),
      ["sup_01ABC", "sre_01ABC", "ord_1", "pay_1", "12.00", "2026-05-31T14:00:00.000Z"],
    );
  });

  it("moves the pending effect to return-received when the return is recorded as delivered", async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const handlers = buildPaymentsSupportRefundEffectHandlers(db as never, { issueRefund: vi.fn() } as never);

    await handlers["support.support-request.return-delivered"]?.({
      ...baseEvent(),
      type: "support.support-request.return-delivered",
      data: {
        supportRequestId: "sup_01ABC",
        deliveredAt: "2026-06-01T00:00:00.000Z",
        returnRefundReleaseDueAt: "2026-06-06T00:00:00.000Z",
      },
    } as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = 'return-received'"), [
      "sup_01ABC",
      "2026-06-01T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
    ]);
  });

  it("moves the pending effect to return-condition-disputed when the seller disputes within the window", async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const handlers = buildPaymentsSupportRefundEffectHandlers(db as never, { issueRefund: vi.fn() } as never);

    await handlers["support.support-request.return-condition-disputed"]?.({
      ...baseEvent(),
      type: "support.support-request.return-condition-disputed",
      data: {
        supportRequestId: "sup_01ABC",
        disputedAt: "2026-06-02T00:00:00.000Z",
      },
    } as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = 'return-condition-disputed'"), [
      "sup_01ABC",
      "2026-06-02T00:00:00.000Z",
    ]);
  });

  it("issues the refund when the return refund releases, re-deriving the amount against live payment state", async () => {
    const issueRefund = vi.fn(async () => ({ refundId: "rfd_1", version: 1 }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT requested_amount")) {
          return { rows: [{ requested_amount: "12.00", resolution_type: "return-for-refund" }] };
        }
        if (sql.includes("FROM payments_payment_pages")) {
          return {
            rows: [{ payment_id: "pay_1", order_refund_caps: [], order_refunded_amounts: [] }],
          };
        }
        if (sql.includes("FROM payments_order_inputs")) {
          return { rows: [{ order_id: "ord_1", total_amount: "12.00" }] };
        }
        if (sql.includes("UPDATE payments_support_refund_effects") && sql.includes("status = 'processing'")) {
          return { rowCount: 1, rows: [{ refund_id: "rfd_claim" }] };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const handlers = buildPaymentsSupportRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["support.support-request.return-refund-released"]?.({
      ...baseEvent(),
      type: "support.support-request.return-refund-released",
      data: {
        supportRequestId: "sup_01ABC",
        orderId: "ord_1",
        releasedAt: "2026-06-06T00:00:00.000Z",
      },
    } as never);

    expect(issueRefund).toHaveBeenCalledWith(
      expect.objectContaining({ refundId: "rfd_claim", paymentId: "pay_1", amount: "12.00" }),
      expect.objectContaining({ tenantId: "tnt_test" }),
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'refund-requested'"),
      expect.arrayContaining(["sup_01ABC", "pay_1", "rfd_1"]),
    );
  });

  it("skips the return refund release when nothing is pending (idempotent replay)", async () => {
    const issueRefund = vi.fn(async () => ({ refundId: "rfd_1", version: 1 }));
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const handlers = buildPaymentsSupportRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["support.support-request.return-refund-released"]?.({
      ...baseEvent(),
      type: "support.support-request.return-refund-released",
      data: {
        supportRequestId: "sup_01ABC",
        orderId: "ord_1",
        releasedAt: "2026-06-06T00:00:00.000Z",
      },
    } as never);

    expect(issueRefund).not.toHaveBeenCalled();
  });

  function platformCoverageReleasedFact(
    overrides: Partial<{
      coverageId: string | null;
      refundAmount: string;
      allocation: Record<string, unknown>;
    }> = {},
  ) {
    return {
      ...baseEvent(),
      type: "support.support-request.refund-released.v1",
      data: {
        factSchemaVersion: 1,
        supportRequestId: "sup_01ABC",
        remedyId: "rmd_01ABC",
        idempotencyKey: "idem_release_1",
        causationId: "fct_trigger",
        policyVersion: "policy_1",
        occurredAt: "2026-06-06T00:00:00.000Z",
        coverageId: overrides.coverageId === undefined ? "cov_1" : overrides.coverageId,
        refundAmount: overrides.refundAmount ?? "12.00",
        currencyCode: "usd",
        allocation: overrides.allocation ?? {
          sellerFundedAmount: "0.00",
          platformFundedAmount: "12.00",
          currencyCode: "usd",
          fundingKind: "platform-funded",
        },
        refundTrigger: "immediate",
      },
    };
  }

  it("executes a platform-coverage remedy refund carrying remedy and allocation causation", async () => {
    const issueRefund = vi.fn(async () => ({ refundId: "rfd_final", version: 1 }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT order_id, payment_id, status")) {
          return { rows: [{ order_id: "ord_1", payment_id: "pay_1", status: "awaiting-return" }] };
        }
        if (sql.includes("FROM payments_payment_pages")) {
          return { rows: [{ payment_id: "pay_1", order_refund_caps: [], order_refunded_amounts: [] }] };
        }
        if (sql.includes("FROM payments_order_inputs")) {
          return { rows: [{ order_id: "ord_1", total_amount: "12.00" }] };
        }
        if (sql.includes("status = 'processing'")) {
          return { rowCount: 1, rows: [{ order_id: "ord_1", payment_id: "pay_1", refund_id: "rfd_01ABC" }] };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const handlers = buildPaymentsSupportRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["support.support-request.refund-released.v1"]?.(platformCoverageReleasedFact() as never);

    expect(issueRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        refundId: "rfd_01ABC",
        paymentId: "pay_1",
        amount: "12.00",
        causation: expect.objectContaining({
          remedyId: "rmd_01ABC",
          coverageId: "cov_1",
          refundTrigger: "immediate",
          refundTriggerEvidenceRef: "fct_trigger",
          allocation: expect.objectContaining({ fundingKind: "platform-funded", platformFundedAmount: "12.00" }),
        }),
      }),
      expect.objectContaining({ tenantId: "tnt_test" }),
    );
  });

  it("rejects a platform-funded release that lacks the approved coverage reference", async () => {
    const issueRefund = vi.fn(async () => ({ refundId: "rfd_final", version: 1 }));
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const handlers = buildPaymentsSupportRefundEffectHandlers(db as never, { issueRefund } as never);

    await expect(
      handlers["support.support-request.refund-released.v1"]?.(
        platformCoverageReleasedFact({ coverageId: null }) as never,
      ),
    ).rejects.toThrow("A platform-funded remedy fact requires a coverageId.");
    expect(issueRefund).not.toHaveBeenCalled();
  });

  it("routes a remedy release to manual review when the authorized amount exceeds the remaining refundable balance", async () => {
    const issueRefund = vi.fn(async () => ({ refundId: "rfd_final", version: 1 }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT order_id, payment_id, status")) {
          return { rows: [{ order_id: "ord_1", payment_id: "pay_1", status: "awaiting-return" }] };
        }
        if (sql.includes("FROM payments_payment_pages")) {
          return {
            rows: [
              {
                payment_id: "pay_1",
                order_refund_caps: [],
                order_refunded_amounts: [{ orderId: "ord_1", amount: "7.00" }],
              },
            ],
          };
        }
        if (sql.includes("FROM payments_order_inputs")) {
          return { rows: [{ order_id: "ord_1", total_amount: "12.00" }] };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const handlers = buildPaymentsSupportRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["support.support-request.refund-released.v1"]?.(platformCoverageReleasedFact() as never);

    expect(issueRefund).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'manual-review'"),
      expect.arrayContaining(["sup_01ABC"]),
    );
  });

  it("no-ops a remedy release replay once the refund is already processing", async () => {
    const issueRefund = vi.fn(async () => ({ refundId: "rfd_final", version: 1 }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT order_id, payment_id, status")) {
          return { rows: [{ order_id: "ord_1", payment_id: "pay_1", status: "processing" }] };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const handlers = buildPaymentsSupportRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["support.support-request.refund-released.v1"]?.(platformCoverageReleasedFact() as never);

    expect(issueRefund).not.toHaveBeenCalled();
  });

  it("no-ops a remedy release with no captured-payment-backed effect registered", async () => {
    const issueRefund = vi.fn(async () => ({ refundId: "rfd_final", version: 1 }));
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const handlers = buildPaymentsSupportRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["support.support-request.refund-released.v1"]?.(platformCoverageReleasedFact() as never);

    expect(issueRefund).not.toHaveBeenCalled();
  });
});
