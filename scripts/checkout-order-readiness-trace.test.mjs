import { describe, expect, it } from "vitest";
import {
  CHECKOUT_ORDER_READINESS_TRACE_VERSION,
  DEFAULT_WINDOW_MINUTES,
  REQUIRED_CONFIRM_TEXT,
  assertReadOnlySql,
  assertRedactedTraceEvidence,
  buildWakeInterestDiagnostics,
  buildCheckoutOrderReadinessTraceEvidence,
  classifyStalledLeg,
  contextDatabaseEnvName,
  parseCheckoutOrderReadinessTraceArgs,
  renderTraceStepSummary,
  runCheckoutOrderReadinessTrace,
  summarizeWakeClaimDiagnostics,
  summarizeWakeFailureDiagnostics,
  validateCheckoutOrderReadinessTraceOptions,
} from "./checkout-order-readiness-trace.mjs";

const baseEnv = {
  PLATFORM_CONTROL_DATABASE_URL: "postgresql://control:secret@staging-db.example/control?sslmode=require",
  DATABASE_URL_CHECKOUT: "postgresql://checkout:secret@staging-db.example/checkout?sslmode=require",
  DATABASE_URL_ORDERING: "postgresql://ordering:secret@staging-db.example/ordering?sslmode=require",
  DATABASE_URL_INVENTORY: "postgresql://inventory:secret@staging-db.example/inventory?sslmode=require",
  DATABASE_URL_PAYMENTS: "postgresql://payments:secret@staging-db.example/payments?sslmode=require",
};

const observedAtUtc = "2026-06-26T12:00:00.000Z";

function validOptions(overrides = {}) {
  return {
    environment: "staging",
    checkoutSessionId: "chk_test_123",
    observedAtUtc,
    windowMinutes: 30,
    confirm: REQUIRED_CONFIRM_TEXT,
    outPath: "artifacts/trace.json",
    checkedAt: "2026-06-26T12:00:01.000Z",
    controlDatabaseUrl: baseEnv.PLATFORM_CONTROL_DATABASE_URL,
    contextDatabaseUrls: {
      checkout: baseEnv.DATABASE_URL_CHECKOUT,
      ordering: baseEnv.DATABASE_URL_ORDERING,
      inventory: baseEnv.DATABASE_URL_INVENTORY,
      payments: baseEnv.DATABASE_URL_PAYMENTS,
    },
    ...overrides,
  };
}

function traceInput(overrides = {}) {
  return {
    checkedAt: "2026-06-26T12:00:01.000Z",
    observedAtUtc,
    windowMinutes: 30,
    checkoutSessionId: "chk_test_123",
    checkout: {
      present: true,
      sourceType: "buy-now",
      orderIds: ["ord_1"],
      paymentIdPresence: false,
      orderWriteCommitPositions: [
        { sourceContextName: "ordering", maxGlobalPosition: "41", eventIds: ["evt_1", "evt_2"] },
      ],
      createdAt: "2026-06-26T11:50:00.000Z",
      updatedAt: "2026-06-26T11:59:00.000Z",
    },
    ordering: {
      orderRows: {
        rowCount: 1,
        statusCounts: { "pending-payment": 1 },
        sourceTypeCounts: { "buy-now": 1 },
        maxUpdatedAgeMsAtObservedAt: 60_000,
      },
      events: {
        eventTypeCounts: {
          "ordering.order.created": 1,
          "ordering.order.pending-payment-recorded": 1,
        },
        eventTypeWindowCounts: {
          "ordering.order.created": 1,
          "ordering.order.pending-payment-recorded": 1,
        },
        minGlobalPosition: "40",
        maxGlobalPosition: "41",
      },
      pendingPaymentRecorded: {
        exists: true,
        count: 1,
        maxGlobalPosition: "41",
        lastRecordedAt: "2026-06-26T11:58:00.000Z",
        lastRecordedAgeMsAtObservedAt: 120_000,
      },
    },
    inventory: {
      reservations: {
        rowCount: 1,
        statusCounts: { confirmed: 1 },
        holdPresentCount: 1,
        activeHoldPresentCount: 1,
        releasedCount: 0,
        maxUpdatedAgeMsAtObservedAt: 90_000,
      },
    },
    payments: {
      orderInputs: {
        rowCount: 1,
        byOrderIdCount: 1,
        byCheckoutSourceCount: 0,
        statusCounts: { "pending-payment": 1 },
        maxUpdatedAt: "2026-06-26T11:59:00.000Z",
        maxUpdatedAgeMsAtObservedAt: 60_000,
        staleRelativeToPendingPayment: false,
      },
      paymentsByCheckoutSource: {
        rowCount: 0,
        statusCounts: {},
        processorStatusCounts: {},
        maxUpdatedAgeMsAtObservedAt: null,
      },
    },
    projectionState: {
      traces: [],
      missingCheckpointCount: 0,
      staleOrBehindCount: 0,
      wakeStateCounts: { queued: 1 },
    },
    relayCursors: {
      cursors: [],
      missingCount: 0,
      behindCount: 0,
    },
    ...overrides,
  };
}

describe("checkout order-readiness trace arguments", () => {
  it("parses workflow inputs from environment and clamps the window", () => {
    const options = parseCheckoutOrderReadinessTraceArgs([], {
      ...baseEnv,
      TRACE_CHECKOUT_SESSION_ID: "chk_123",
      TRACE_OBSERVED_AT_UTC: observedAtUtc,
      TRACE_WINDOW_MINUTES: "9999",
      TRACE_CONFIRM: REQUIRED_CONFIRM_TEXT,
      WORKER_WAKE_DISABLED_PROJECTIONS: "inventory:inventory-order-reservation-workflow",
    });

    expect(options.checkoutSessionId).toBe("chk_123");
    expect(options.windowMinutes).toBe(240);
    expect(options.workerWakeDisabledProjections).toEqual(["inventory:inventory-order-reservation-workflow"]);
    expect(options.contextDatabaseUrls.checkout).toBe(baseEnv.DATABASE_URL_CHECKOUT);
    expect(validateCheckoutOrderReadinessTraceOptions(options)).toEqual([]);
  });

  it("defaults the diagnostic window and maps context env names", () => {
    const options = parseCheckoutOrderReadinessTraceArgs([], baseEnv);

    expect(options.windowMinutes).toBe(DEFAULT_WINDOW_MINUTES);
    expect(contextDatabaseEnvName("public-presence")).toBe("DATABASE_URL_PUBLIC_PRESENCE");
  });

  it("fails closed for production, bad confirmation text, and missing database URLs", () => {
    const errors = validateCheckoutOrderReadinessTraceOptions(
      validOptions({
        environment: "production",
        confirm: "please run",
        controlDatabaseUrl: null,
        contextDatabaseUrls: {},
      }),
    );

    expect(errors.some((error) => error.includes("production is refused"))).toBe(true);
    expect(errors.some((error) => error.includes(REQUIRED_CONFIRM_TEXT))).toBe(true);
    expect(errors.some((error) => error.includes("PLATFORM_CONTROL_DATABASE_URL"))).toBe(true);
    expect(errors.some((error) => error.includes("DATABASE_URL_CHECKOUT"))).toBe(true);
  });

  it("rejects non-UTC observed timestamps", () => {
    const errors = validateCheckoutOrderReadinessTraceOptions(
      validOptions({ observedAtUtc: "2026-06-26T12:00:00-05:00" }),
    );

    expect(errors).toContain("--observed-at-utc must be an ISO UTC timestamp.");
  });
});

describe("read-only SQL guard", () => {
  it("allows selects and CTEs", () => {
    expect(assertReadOnlySql("SELECT COUNT(*) FROM event_store_events")).toContain("SELECT");
    expect(assertReadOnlySql("WITH rows AS (SELECT 1) SELECT * FROM rows")).toContain("WITH");
  });

  it("rejects writes and multi-statement text", () => {
    expect(() => assertReadOnlySql("UPDATE checkout_session_pages SET payment_id = null")).toThrow(/read/i);
    expect(() => assertReadOnlySql("SELECT 1; SELECT 2")).toThrow(/single/);
    expect(() => assertReadOnlySql("DELETE FROM payments_order_inputs")).toThrow(/SELECT/);
  });
});

describe("checkout order-readiness stalled-leg classification", () => {
  it("routes missing pending-payment-recorded to the ordering/inventory workflow", () => {
    expect(
      classifyStalledLeg({
        pendingPaymentRecorded: false,
        paymentsInputPresentForAllOrders: false,
        paymentsInputAllPendingPayment: false,
        stalePaymentInput: false,
      }).stalledLeg,
    ).toBe("ordering-inventory-reservation-workflow-blockage");
  });

  it("routes missing or stale payments input to Payments projection/wake", () => {
    expect(
      classifyStalledLeg({
        pendingPaymentRecorded: true,
        paymentsInputPresentForAllOrders: false,
        paymentsInputAllPendingPayment: false,
        stalePaymentInput: false,
      }).stalledLeg,
    ).toBe("payments-projection-wake-blockage");
    expect(
      classifyStalledLeg({
        pendingPaymentRecorded: true,
        paymentsInputPresentForAllOrders: true,
        paymentsInputAllPendingPayment: false,
        stalePaymentInput: true,
      }).stalledLeg,
    ).toBe("payments-projection-wake-blockage");
  });

  it("routes present pending-payment inputs to checkout retry/handoff", () => {
    expect(
      classifyStalledLeg({
        pendingPaymentRecorded: true,
        paymentsInputPresentForAllOrders: true,
        paymentsInputAllPendingPayment: true,
        stalePaymentInput: false,
      }).stalledLeg,
    ).toBe("checkout-retry-handoff-bug");
  });
});

describe("checkout order-readiness evidence", () => {
  it("builds a redacted checkout retry/handoff artifact", () => {
    const evidence = buildCheckoutOrderReadinessTraceEvidence(traceInput());

    expect(evidence.schemaVersion).toBe(CHECKOUT_ORDER_READINESS_TRACE_VERSION);
    expect(evidence.checkoutSession.referenceFingerprint).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(evidence.checkoutSession.orderIdCount).toBe(1);
    expect(evidence.checkoutSession.orderWriteCommitPositions).toMatchObject({
      entryCount: 1,
      sourceContextCounts: { ordering: 1 },
      eventIdCount: 2,
      maxGlobalPosition: "41",
    });
    expect(evidence.wakeInterestDiagnostics).toMatchObject({
      sourceContextName: "ordering",
      eventType: "ordering.order.created",
      targetContextName: "inventory",
      projectionName: "inventory-order-reservation-workflow",
      checkpointKey: "inventory-order-reservation-workflow:ordering:v1",
      interestPresent: true,
      disabledByWorkerWakeDisabledProjections: false,
    });
    expect(evidence.decision.stalledLeg).toBe("checkout-retry-handoff-bug");
    expect(assertRedactedTraceEvidence(evidence)).toEqual([]);
    expect(JSON.stringify(evidence)).not.toContain("chk_test_123");
    expect(JSON.stringify(evidence)).not.toContain("ord_1");
  });

  it("summarizes missing payments inputs without exposing identifiers", () => {
    const evidence = buildCheckoutOrderReadinessTraceEvidence(
      traceInput({
        payments: {
          ...traceInput().payments,
          orderInputs: {
            ...traceInput().payments.orderInputs,
            rowCount: 0,
            byOrderIdCount: 0,
            statusCounts: {},
            staleRelativeToPendingPayment: true,
          },
        },
      }),
    );
    const summary = renderTraceStepSummary(evidence);

    expect(evidence.decision.stalledLeg).toBe("payments-projection-wake-blockage");
    expect(evidence.payments.orderInputs.missingOrderInputCount).toBe(1);
    expect(summary).toContain("Payments projection/wake blockage");
    expect(summary).toContain("Wake interest");
    expect(assertRedactedTraceEvidence({ summary })).toEqual([]);
  });

  it("reports whether the Ordering to Inventory wake interest is disabled by worker env", () => {
    expect(
      buildWakeInterestDiagnostics({
        disabledProjectionKeys: ["inventory:inventory-order-reservation-workflow"],
        manifestInterest: { interestPresent: true },
      }),
    ).toMatchObject({
      interestPresent: true,
      disabledProjectionKey: "inventory:inventory-order-reservation-workflow",
      disabledByWorkerWakeDisabledProjections: true,
    });

    expect(
      buildWakeInterestDiagnostics({
        disabledProjectionKeys: [],
        manifestInterest: { interestPresent: false },
      }),
    ).toMatchObject({
      interestPresent: false,
      disabledByWorkerWakeDisabledProjections: false,
    });
  });

  it("summarizes failed wake diagnostics without exposing raw errors", () => {
    const diagnostics = summarizeWakeFailureDiagnostics(
      [
        {
          attempt_count: 3,
          required_position: "73",
          next_eligible_at: "2026-06-26T11:59:30.000Z",
          updated_at: "2026-06-26T11:59:45.000Z",
          last_error: {
            reason: "projection-run-failed",
            message: "canceling statement due to statement timeout",
            workerId: "worker-a",
            checkpointPosition: "19",
            requiredPosition: "73",
            blockedStreamCount: 2,
            poisonEventCount: 1,
          },
        },
        {
          attempt_count: 4,
          required_position: "74",
          next_eligible_at: "2026-06-26T11:59:40.000Z",
          updated_at: "2026-06-26T11:59:50.000Z",
          last_error: JSON.stringify({
            reason: "checkpoint-not-ready",
            message: "postgresql://u:p@host/db should never leave staging",
            workerId: "worker-b",
          }),
        },
        {
          attempt_count: 5,
          required_position: "75",
          next_eligible_at: "2026-06-26T11:59:45.000Z",
          updated_at: "2026-06-26T11:59:55.000Z",
          last_error: {
            reason: "projection-run-failed",
            message: "Inventory item inv_01KXYZ987654321 not found for reservation rsv_01KXYZ987654321.",
          },
        },
      ],
      observedAtUtc,
    );

    expect(diagnostics).toMatchObject({
      sampleCount: 3,
      maxAttemptCount: 5,
      maxRequiredPosition: "75",
      reasonCounts: {
        "checkpoint-not-ready": 1,
        "projection-run-failed": 2,
      },
      messageCategoryCounts: {
        "message-present": 1,
        "message-redacted-sensitive": 1,
        "statement-timeout": 1,
      },
      messageSampleCounts: {
        "canceling-statement-due-to-statement-timeout": 1,
        "inventory-item-id-not-found-for-reservation-id": 1,
        "redacted-sensitive-message": 1,
      },
      workerIdPresentCount: 2,
      checkpointPositionMax: "19",
      requiredPositionFromErrorMax: "73",
      blockedStreamCountMax: 2,
      poisonEventCountMax: 1,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("canceling statement");
    expect(JSON.stringify(diagnostics)).not.toContain("worker-a");
    expect(JSON.stringify(diagnostics)).not.toContain("inv_01KXYZ987654321");
    expect(JSON.stringify(diagnostics)).not.toContain("rsv_01KXYZ987654321");
    expect(assertRedactedTraceEvidence({ diagnostics })).toEqual([]);
  });

  it("summarizes claimed wake diagnostics without exposing owners", () => {
    const diagnostics = summarizeWakeClaimDiagnostics(
      [
        {
          attempt_count: 5,
          required_position: "73",
          claimed_required_position: "73",
          claimed_until: "2026-06-26T12:00:30.000Z",
          stale_at_observed_at: false,
          next_eligible_at: "2026-06-26T11:59:00.000Z",
          updated_at: "2026-06-26T11:59:45.000Z",
        },
        {
          attempt_count: 6,
          required_position: "74",
          claimed_required_position: "74",
          claimed_until: "2026-06-26T11:59:50.000Z",
          stale_at_observed_at: true,
          next_eligible_at: "2026-06-26T11:58:00.000Z",
          updated_at: "2026-06-26T11:59:50.000Z",
        },
      ],
      observedAtUtc,
    );

    expect(diagnostics).toMatchObject({
      sampleCount: 2,
      maxAttemptCount: 6,
      maxRequiredPosition: "74",
      maxClaimedRequiredPosition: "74",
      staleAtObservedCount: 1,
      soonestClaimExpiresInMsAtObservedAt: 0,
      oldestNextEligibleAgeMsAtObservedAt: 120_000,
      newestUpdatedAgeMsAtObservedAt: 10_000,
    });
    expect(assertRedactedTraceEvidence({ diagnostics })).toEqual([]);
  });

  it("fails closed when evidence contains common sensitive values", () => {
    expect(assertRedactedTraceEvidence({ value: "buyer@example.com" })).toEqual(["buyer@example.com"]);
    expect(assertRedactedTraceEvidence({ value: "https://example.com/checkout/payments/pay_1234" })).toEqual([
      "https://example.com/checkout/payments/pay_1234",
      "pay_1234",
    ]);
    expect(() =>
      buildCheckoutOrderReadinessTraceEvidence(
        traceInput({
          projectionState: { traces: [{ leak: "postgresql://u:p@host/db" }], missingCheckpointCount: 0 },
        }),
      ),
    ).toThrow(/leaked sensitive values/);
  });
});

describe("checkout order-readiness trace orchestration", () => {
  it("collects from injected dependencies without database access", async () => {
    const calls = [];
    const evidence = await runCheckoutOrderReadinessTrace(validOptions(), {
      fetchCheckoutSession: async (checkoutSessionId) => {
        calls.push(["checkout", checkoutSessionId]);
        return traceInput().checkout;
      },
      fetchOrderingFacts: async (orderIds) => {
        calls.push(["ordering", orderIds.length]);
        return traceInput().ordering;
      },
      fetchInventoryFacts: async (orderIds) => {
        calls.push(["inventory", orderIds.length]);
        return traceInput().inventory;
      },
      fetchPaymentsFacts: async (orderIds, checkoutSessionId) => {
        calls.push(["payments", orderIds.length, checkoutSessionId]);
        return traceInput().payments;
      },
      fetchProjectionState: async (projectionTraces) => {
        calls.push(["projection", projectionTraces.length]);
        return traceInput().projectionState;
      },
      fetchRelayCursors: async (sourceContexts) => {
        calls.push(["relay", sourceContexts.join(",")]);
        return traceInput().relayCursors;
      },
    });

    expect(evidence.decision.stalledLeg).toBe("checkout-retry-handoff-bug");
    expect(calls).toEqual([
      ["checkout", "chk_test_123"],
      ["ordering", 1],
      ["inventory", 1],
      ["payments", 1, "chk_test_123"],
      ["projection", 3],
      ["relay", "ordering,inventory"],
    ]);
    expect(assertRedactedTraceEvidence(evidence)).toEqual([]);
  });
});
