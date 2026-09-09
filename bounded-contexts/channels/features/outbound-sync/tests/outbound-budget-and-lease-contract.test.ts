import { describe, expect, it } from "vitest";
import {
  OUTBOUND_OPERATION_BUDGET_FALLBACK,
  OUTBOUND_OPERATION_BUDGET_POLICY_FALLBACK,
  decodeOutboundOperationBudgetPolicy,
  resolveOutboundOperationBudget,
} from "../domain/policy";
import {
  OUTBOUND_CLAIM_LEASE_MAX_MS,
  OUTBOUND_CLAIM_LEASE_MIN_MS,
  assertOutboundClaimLeaseMs,
} from "../domain/validation";

describe("outbound-per-provider-budget-and-fairness", () => {
  it("keeps valid identities, overrides, and the compiled fallback as separate contracts", () => {
    expect(
      resolveOutboundOperationBudget(OUTBOUND_OPERATION_BUDGET_POLICY_FALLBACK, {
        providerKey: "synthetic-a",
        environment: "sandbox",
      }).budget,
    ).toEqual(OUTBOUND_OPERATION_BUDGET_FALLBACK);

    const policy = decodeOutboundOperationBudgetPolicy({
      incidentMultiplier: 1,
      providers: {
        "synthetic-drill:sandbox": { maxRequestsPerWindow: 10_000, windowMs: 900_000 },
        "synthetic-neighbor:sandbox": { maxRequestsPerWindow: 23, maxInFlightPerConnection: 2 },
      },
    });
    expect(
      resolveOutboundOperationBudget(policy, { providerKey: "synthetic-drill", environment: "sandbox" }).budget,
    ).toEqual({ ...OUTBOUND_OPERATION_BUDGET_FALLBACK, maxRequestsPerWindow: 10_000, windowMs: 900_000 });
    expect(
      resolveOutboundOperationBudget(policy, { providerKey: "synthetic-neighbor", environment: "sandbox" }).budget,
    ).toEqual({ ...OUTBOUND_OPERATION_BUDGET_FALLBACK, maxRequestsPerWindow: 23, maxInFlightPerConnection: 2 });
    expect(OUTBOUND_OPERATION_BUDGET_FALLBACK).toEqual({
      maxRequestsPerWindow: 60,
      windowMs: 60_000,
      maxInFlightPerConnection: 4,
      maxAttempts: 5,
      baseBackoffMs: 1_000,
      maxBackoffMs: 300_000,
    });
  });

  it("recursively rejects unknown keys and invalid values", () => {
    expect(() =>
      decodeOutboundOperationBudgetPolicy({ incidentMultiplier: 1, providers: {}, unknown: true } as never),
    ).toThrow(/unknown/);
    expect(() =>
      decodeOutboundOperationBudgetPolicy({
        incidentMultiplier: 1,
        providers: { "synthetic:sandbox": { maxRequestsPerWindow: 0 } },
      }),
    ).toThrow(/maxRequestsPerWindow/);
    expect(() =>
      decodeOutboundOperationBudgetPolicy({
        incidentMultiplier: 1,
        providers: { "synthetic:sandbox": { nested: true } },
      } as never),
    ).toThrow(/unknown/);
    expect(() =>
      decodeOutboundOperationBudgetPolicy({
        incidentMultiplier: 1,
        providers: { "synthetic:sandbox": { maxBackoffMs: 999 } },
      }),
    ).toThrow(/at least baseBackoffMs/);
  });
});

describe("outbound claimed lease validation", () => {
  it("accepts both inclusive bounds and refuses omitted, noninteger, and out-of-range callers", () => {
    expect(() => assertOutboundClaimLeaseMs(OUTBOUND_CLAIM_LEASE_MIN_MS)).not.toThrow();
    expect(() => assertOutboundClaimLeaseMs(OUTBOUND_CLAIM_LEASE_MAX_MS)).not.toThrow();
    for (const candidate of [undefined, null, 59_999, 7_200_001, 60_000.5, "1800000"]) {
      expect(() => assertOutboundClaimLeaseMs(candidate)).toThrow(/leaseMs/);
    }
  });
});
