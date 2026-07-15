import { describe, expect, it } from "vitest";
import {
  availableProtectionAmount,
  decideProtectionCoverage,
  evolveProtectionCoverage,
  initialProtectionReserveState,
  protectionReserveStreamId,
  type ExpireProtectionCoverageCommand,
  type ProtectionCoverageCommand,
  type ProtectionCoverageEvent,
  type ProtectionReserveState,
  type RecordProtectionRecoveryCommand,
  type ReleaseProtectionCoverageCommand,
  type ReserveProtectionCoverageCommand,
  type SettleProtectionCoverageCommand,
} from "./protection-coverage";

const OCCURRED = "2026-07-14T00:00:00.000Z";

function apply(state: ProtectionReserveState, command: ProtectionCoverageCommand): ProtectionReserveState {
  return decideProtectionCoverage(state, command).reduce(evolveProtectionCoverage, state);
}

function decide(state: ProtectionReserveState, command: ProtectionCoverageCommand): readonly ProtectionCoverageEvent[] {
  return decideProtectionCoverage(state, command);
}

function reserveCommand(overrides: Partial<ReserveProtectionCoverageCommand> = {}): ReserveProtectionCoverageCommand {
  return {
    type: "ReserveProtectionCoverage",
    coverageId: "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    remedyId: "rmd_01JZ6DKP7S7Z4AZ5N5E6K7M8NA",
    supportRequestId: "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8NB",
    requestedAmount: "40.00",
    currencyCode: "usd",
    policyVersion: "coverage-policy-2026-07",
    reasonCode: "fault-indeterminate",
    idempotencyKey: "coverage-reserve:cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    causationId: null,
    occurredAt: OCCURRED,
    fundedAmount: "100.00",
    ...overrides,
  };
}

function settleCommand(overrides: Partial<SettleProtectionCoverageCommand> = {}): SettleProtectionCoverageCommand {
  return {
    type: "SettleProtectionCoverage",
    coverageId: "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    refundId: "rfd_01JZ6DKP7S7Z4AZ5N5E6K7M8NC",
    platformFundedAmount: "40.00",
    sellerFundedAmount: "0.00",
    currencyCode: "usd",
    policyVersion: "coverage-policy-2026-07",
    idempotencyKey: "coverage-settle:cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    causationId: "evt-reserved",
    occurredAt: "2026-07-14T01:00:00.000Z",
    ...overrides,
  };
}

function releaseCommand(overrides: Partial<ReleaseProtectionCoverageCommand> = {}): ReleaseProtectionCoverageCommand {
  return {
    type: "ReleaseProtectionCoverage",
    coverageId: "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    releaseReason: "case-cancelled",
    policyVersion: "coverage-policy-2026-07",
    idempotencyKey: "coverage-release:cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    causationId: null,
    occurredAt: "2026-07-14T02:00:00.000Z",
    ...overrides,
  };
}

function expireCommand(overrides: Partial<ExpireProtectionCoverageCommand> = {}): ExpireProtectionCoverageCommand {
  return {
    type: "ExpireProtectionCoverage",
    coverageId: "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    policyVersion: "coverage-policy-2026-07",
    idempotencyKey: "coverage-expire:cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    causationId: null,
    deadline: "2026-07-21T00:00:00.000Z",
    occurredAt: "2026-07-21T00:00:01.000Z",
    ...overrides,
  };
}

function recoveryCommand(overrides: Partial<RecordProtectionRecoveryCommand> = {}): RecordProtectionRecoveryCommand {
  return {
    type: "RecordProtectionRecovery",
    coverageId: "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    remedyId: "rmd_01JZ6DKP7S7Z4AZ5N5E6K7M8NA",
    recoveredItemId: "rcv_1",
    returnShipmentId: "rsh_1",
    recoveryId: "recovery-1",
    recoveryType: "carrier-claim",
    grossAmount: "42.00",
    costAmount: "5.25",
    currencyCode: "usd",
    policyVersion: "coverage-policy-2026-07",
    evidenceReferences: ["claim-1"],
    causationId: "evt-value-reported",
    occurredAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("protection coverage — reservation", () => {
  it("reserves against available funds and subtracts from availability", () => {
    const events = decide(initialProtectionReserveState, reserveCommand());
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("settlement.protection-coverage.reserved.v1");
    expect(events[0]?.data).toMatchObject({
      coverageId: "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
      reservedAmount: "40.00",
      currencyCode: "usd",
      remedyId: "rmd_01JZ6DKP7S7Z4AZ5N5E6K7M8NA",
      policyVersion: "coverage-policy-2026-07",
      factSchemaVersion: 1,
    });

    const state = apply(initialProtectionReserveState, reserveCommand());
    expect(state.outstandingReservedAmount).toBe("40.00");
    expect(state.currencyCode).toBe("usd");
    expect(availableProtectionAmount("100.00", state)).toBe("60.00");
  });

  it("rejects a request that exceeds available protection funds", () => {
    const events = decide(initialProtectionReserveState, reserveCommand({ requestedAmount: "150.00" }));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("settlement.protection-coverage.rejected.v1");
    expect(events[0]?.data).toMatchObject({ reasonCode: "insufficient-reserve", requestedAmount: "150.00" });
    // A rejection is audit-only and never moves the ledger.
    const state = apply(initialProtectionReserveState, reserveCommand({ requestedAmount: "150.00" }));
    expect(state.outstandingReservedAmount).toBe("0.00");
  });

  it("rejects a currency that disagrees with the established pool currency", () => {
    const usdState = apply(initialProtectionReserveState, reserveCommand());
    const events = decide(
      usdState,
      reserveCommand({ coverageId: "cov_02", remedyId: "rmd_02", currencyCode: "eur", fundedAmount: "100.00" }),
    );
    expect(events[0]?.type).toBe("settlement.protection-coverage.rejected.v1");
    expect(events[0]?.data).toMatchObject({ reasonCode: "currency-mismatch" });
  });

  it("rejects a request above the policy limit", () => {
    const events = decide(initialProtectionReserveState, reserveCommand({ policyLimitAmount: "25.00" }));
    expect(events[0]?.data).toMatchObject({ reasonCode: "policy-limit-exceeded" });
  });

  it("treats an identical retry of the same coverage id as an idempotent no-op", () => {
    const state = apply(initialProtectionReserveState, reserveCommand());
    expect(decide(state, reserveCommand())).toEqual([]);
    // Re-applying does not double-count the reservation.
    const twice = apply(state, reserveCommand());
    expect(twice.outstandingReservedAmount).toBe("40.00");
  });

  it("rejects semantic reuse of a coverage id under different terms", () => {
    const state = apply(initialProtectionReserveState, reserveCommand());
    const events = decide(state, reserveCommand({ requestedAmount: "41.00" }));
    expect(events[0]?.type).toBe("settlement.protection-coverage.rejected.v1");
    expect(events[0]?.data).toMatchObject({ reasonCode: "conflicting-terms" });
  });

  it("serializes concurrent reservations so they cannot overdraw", () => {
    // Two reservations of 60 each fit the 100 pool in isolation, but not together.
    // The pool stream folds them in order; the second sees the first's reservation.
    const first = apply(initialProtectionReserveState, reserveCommand({ requestedAmount: "60.00" }));
    const secondEvents = decide(
      first,
      reserveCommand({ coverageId: "cov_02", remedyId: "rmd_02", requestedAmount: "60.00" }),
    );
    expect(secondEvents[0]?.type).toBe("settlement.protection-coverage.rejected.v1");
    expect(secondEvents[0]?.data).toMatchObject({ reasonCode: "insufficient-reserve" });
  });

  it("rejects a zero or negative requested amount", () => {
    expect(() => decide(initialProtectionReserveState, reserveCommand({ requestedAmount: "0.00" }))).toThrow();
  });
});

describe("protection coverage — settlement", () => {
  const reserved = apply(initialProtectionReserveState, reserveCommand());

  it("consumes exactly the reserved amount for a fully platform-funded refund", () => {
    const events = decide(reserved, settleCommand());
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("settlement.protection-coverage.settled.v1");
    expect(events[0]?.data).toMatchObject({
      coverageId: "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
      refundId: "rfd_01JZ6DKP7S7Z4AZ5N5E6K7M8NC",
      allocation: { platformFundedAmount: "40.00", sellerFundedAmount: "0.00", fundingKind: "platform-funded" },
    });

    const settled = apply(reserved, settleCommand());
    expect(settled.outstandingReservedAmount).toBe("0.00");
    expect(settled.consumedAmount).toBe("40.00");
    expect(settled.reservations["cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9"]?.status).toBe("settled");
    // Consumed funds stay subtracted from availability permanently.
    expect(availableProtectionAmount("100.00", settled)).toBe("60.00");
  });

  it("consumes only the platform allocation of a split refund", () => {
    // A split remedy reserves only the platform portion (40); the seller portion (60)
    // never touches the reserve.
    const events = decide(reserved, settleCommand({ platformFundedAmount: "40.00", sellerFundedAmount: "60.00" }));
    expect(events[0]?.data).toMatchObject({
      allocation: { platformFundedAmount: "40.00", sellerFundedAmount: "60.00", fundingKind: "split" },
    });
    const settled = apply(reserved, settleCommand({ platformFundedAmount: "40.00", sellerFundedAmount: "60.00" }));
    expect(settled.consumedAmount).toBe("40.00");
  });

  it("is idempotent for a redelivered settle against the same refund", () => {
    const settled = apply(reserved, settleCommand());
    expect(decide(settled, settleCommand())).toEqual([]);
  });

  it("refuses a second settle against a different refund", () => {
    const settled = apply(reserved, settleCommand());
    expect(() => decide(settled, settleCommand({ refundId: "rfd_other" }))).toThrow(
      /already settled against a different refund/,
    );
  });

  it("refuses to settle a coverage that was never reserved", () => {
    expect(() => decide(initialProtectionReserveState, settleCommand())).toThrow(/never reserved/);
  });

  it("refuses to consume more or less than the reserved amount", () => {
    expect(() => decide(reserved, settleCommand({ platformFundedAmount: "41.00" }))).toThrow(
      /must equal the reserved amount/,
    );
    expect(() =>
      decide(reserved, settleCommand({ platformFundedAmount: "39.00", sellerFundedAmount: "1.00" })),
    ).toThrow(/must equal the reserved amount/);
  });
});

describe("protection coverage — release and expiry", () => {
  const reserved = apply(initialProtectionReserveState, reserveCommand());

  it("releases a reserved coverage once and returns the funds to availability", () => {
    const events = decide(reserved, releaseCommand());
    expect(events[0]?.type).toBe("settlement.protection-coverage.released.v1");
    expect(events[0]?.data).toMatchObject({ releasedAmount: "40.00", reasonCode: "case-cancelled" });

    const released = apply(reserved, releaseCommand());
    expect(released.outstandingReservedAmount).toBe("0.00");
    expect(released.releasedAmount).toBe("40.00");
    expect(availableProtectionAmount("100.00", released)).toBe("100.00");
    // A subsequent reservation can draw the returned funds.
    const reReserve = decide(
      released,
      reserveCommand({ coverageId: "cov_02", remedyId: "rmd_02", requestedAmount: "100.00" }),
    );
    expect(reReserve[0]?.type).toBe("settlement.protection-coverage.reserved.v1");
  });

  it("releases exactly once", () => {
    const released = apply(reserved, releaseCommand());
    expect(decide(released, releaseCommand())).toEqual([]);
  });

  it("refuses to release a settled coverage", () => {
    const settled = apply(reserved, settleCommand());
    expect(() => decide(settled, releaseCommand())).toThrow(/Only a reserved protection coverage can be released/);
  });

  it("refuses to reject an unknown release reason", () => {
    expect(() => decide(reserved, releaseCommand({ releaseReason: "whatever" as never }))).toThrow(
      /Unknown protection coverage release reason/,
    );
  });

  it("expires only at or after the policy deadline", () => {
    expect(() => decide(reserved, expireCommand({ occurredAt: "2026-07-20T23:59:59.000Z" }))).toThrow(
      /cannot expire before its policy deadline/,
    );
    const events = decide(reserved, expireCommand());
    expect(events[0]?.type).toBe("settlement.protection-coverage.expired.v1");
    const expired = apply(reserved, expireCommand());
    expect(expired.reservations["cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9"]?.status).toBe("expired");
    expect(expired.outstandingReservedAmount).toBe("0.00");
    expect(expired.releasedAmount).toBe("40.00");
  });
});

describe("protection coverage — replay and stream identity", () => {
  it("folds deterministically: replaying the full lifecycle reproduces state", () => {
    const events: ProtectionCoverageEvent[] = [...decide(initialProtectionReserveState, reserveCommand())];
    const afterReserve = events.reduce(evolveProtectionCoverage, initialProtectionReserveState);
    const settleEvents = decide(afterReserve, settleCommand());
    const all = [...events, ...settleEvents];

    const once = all.reduce(evolveProtectionCoverage, initialProtectionReserveState);
    const twice = all.reduce(evolveProtectionCoverage, initialProtectionReserveState);
    expect(once).toEqual(twice);
    expect(once.consumedAmount).toBe("40.00");
    expect(once.outstandingReservedAmount).toBe("0.00");
  });

  it("scopes the pool stream by currency", () => {
    expect(protectionReserveStreamId("usd")).toBe("settlement.protection-reserve-usd");
    expect(protectionReserveStreamId("USD")).toBe("settlement.protection-reserve-usd");
  });
});

describe("protection coverage — recovered value", () => {
  const settled = apply(apply(initialProtectionReserveState, reserveCommand()), settleCommand());

  it("posts gross and cost against settled coverage and replenishes net pool availability", () => {
    const events = decide(settled, recoveryCommand());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "settlement.protection-coverage.recovery-posted.v1",
      data: {
        grossAmount: "42.00",
        costAmount: "5.25",
        netAmount: "36.75",
        coverageId: "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
      },
    });

    const recovered = apply(settled, recoveryCommand());
    expect(recovered.recoveredGrossAmount).toBe("42.00");
    expect(recovered.recoveryCostAmount).toBe("5.25");
    expect(recovered.recoveredNetAmount).toBe("36.75");
    expect(availableProtectionAmount("100.00", recovered)).toBe("96.75");
  });

  it("is idempotent by recovery id and rejects semantic reuse", () => {
    const recovered = apply(settled, recoveryCommand());
    expect(decide(recovered, recoveryCommand())).toEqual([]);
    expect(() => decide(recovered, recoveryCommand({ grossAmount: "43.00" }))).toThrow(/Recovery id was reused/);
  });

  it("rejects value before coverage settles or for a different remedy", () => {
    const reserved = apply(initialProtectionReserveState, reserveCommand());
    expect(() => decide(reserved, recoveryCommand())).toThrow(/settled coverage/);
    expect(() => decide(settled, recoveryCommand({ remedyId: "rmd_other" }))).toThrow(/originating remedy/);
  });
});
