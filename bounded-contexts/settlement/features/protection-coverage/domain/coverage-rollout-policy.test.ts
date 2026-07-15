import { describe, expect, it } from "vitest";
import {
  applicableReservationLimit,
  canReEnableFromRolledBack,
  coverageRolloutModes,
  decideCoverageAuthorization,
  platformCoverageRolloutSlos,
  preservesActiveReservations,
  stopsNewAuthorizations,
  type CoverageAuthorizationRequest,
  type CoverageRolloutConfig,
} from "./coverage-rollout-policy";

function config(overrides: Partial<CoverageRolloutConfig> = {}): CoverageRolloutConfig {
  return {
    mode: "general",
    maxReservationAmount: "100.00",
    currencyCode: "usd",
    authorizedOperatorAccountIds: ["acc_op1"],
    enabledPolicyCohorts: ["founding-sellers"],
    ...overrides,
  };
}

function request(overrides: Partial<CoverageAuthorizationRequest> = {}): CoverageAuthorizationRequest {
  return {
    operatorAccountId: "acc_op1",
    operatorIsAuthorizedInternal: true,
    policyCohort: null,
    requestedAmount: "40.00",
    currencyCode: "usd",
    ...overrides,
  };
}

describe("coverage rollout — authorization gate", () => {
  it("admits a within-limit request under general availability", () => {
    expect(decideCoverageAuthorization(config(), request())).toEqual({ allowed: true, appliedLimit: "100.00" });
  });

  it("refuses when disabled, paused, or rolled back — each with its own reason", () => {
    expect(decideCoverageAuthorization(config({ mode: "disabled" }), request())).toMatchObject({
      allowed: false,
      reason: "rollout-disabled",
    });
    expect(decideCoverageAuthorization(config({ mode: "paused" }), request())).toMatchObject({
      allowed: false,
      reason: "rollout-paused",
    });
    expect(decideCoverageAuthorization(config({ mode: "rolled-back" }), request())).toMatchObject({
      allowed: false,
      reason: "rollout-rolled-back",
    });
  });

  it("under internal-only, admits only allowlisted authorized operators", () => {
    const internal = config({ mode: "internal-only" });
    expect(decideCoverageAuthorization(internal, request()).allowed).toBe(true);
    expect(decideCoverageAuthorization(internal, request({ operatorIsAuthorizedInternal: false }))).toMatchObject({
      allowed: false,
      reason: "operator-not-authorized",
    });
    expect(decideCoverageAuthorization(internal, request({ operatorAccountId: "acc_other" }))).toMatchObject({
      allowed: false,
      reason: "operator-not-authorized",
    });
  });

  it("under cohort, admits an enabled policy cohort even for a non-allowlisted operator", () => {
    const cohort = config({ mode: "cohort" });
    expect(
      decideCoverageAuthorization(
        cohort,
        request({
          operatorAccountId: "acc_other",
          operatorIsAuthorizedInternal: false,
          policyCohort: "founding-sellers",
        }),
      ),
    ).toMatchObject({ allowed: true });
    expect(
      decideCoverageAuthorization(
        cohort,
        request({ operatorAccountId: "acc_other", operatorIsAuthorizedInternal: false, policyCohort: "random" }),
      ),
    ).toMatchObject({ allowed: false, reason: "cohort-not-enabled" });
  });

  it("enforces the global monetary limit and a tighter cohort limit", () => {
    expect(decideCoverageAuthorization(config(), request({ requestedAmount: "150.00" }))).toMatchObject({
      allowed: false,
      reason: "exceeds-monetary-limit",
    });
    const capped = config({
      mode: "cohort",
      cohortReservationLimits: { "founding-sellers": "50.00" },
    });
    expect(
      decideCoverageAuthorization(capped, request({ policyCohort: "founding-sellers", requestedAmount: "60.00" })),
    ).toMatchObject({ allowed: false, reason: "exceeds-monetary-limit" });
    expect(
      decideCoverageAuthorization(capped, request({ policyCohort: "founding-sellers", requestedAmount: "50.00" })),
    ).toMatchObject({ allowed: true, appliedLimit: "50.00" });
  });

  it("refuses an unconfigured currency and a non-positive amount", () => {
    expect(decideCoverageAuthorization(config(), request({ currencyCode: "eur" }))).toMatchObject({
      allowed: false,
      reason: "currency-not-configured",
    });
    expect(decideCoverageAuthorization(config(), request({ requestedAmount: "0.00" }))).toMatchObject({
      allowed: false,
      reason: "exceeds-monetary-limit",
    });
  });

  it("uses the global limit when no cohort limit is configured", () => {
    expect(applicableReservationLimit(config(), "founding-sellers")).toBe("100.00");
    expect(applicableReservationLimit(config(), null)).toBe("100.00");
  });
});

describe("coverage rollout — pause and rollback preserve active cases", () => {
  it("pause and rollback stop new authorizations", () => {
    expect(stopsNewAuthorizations(config({ mode: "paused" }))).toBe(true);
    expect(stopsNewAuthorizations(config({ mode: "rolled-back" }))).toBe(true);
    expect(stopsNewAuthorizations(config({ mode: "general" }))).toBe(false);
  });

  it("never invalidates active reservations in any mode", () => {
    for (const mode of coverageRolloutModes) {
      expect(preservesActiveReservations(config({ mode }))).toBe(true);
    }
  });

  it("re-enable from rolled-back requires a forward-repair reference", () => {
    expect(canReEnableFromRolledBack(config({ mode: "rolled-back" }))).toBe(false);
    expect(
      canReEnableFromRolledBack(config({ mode: "rolled-back", forwardRepairReference: "REPAIR-2026-07-15" })),
    ).toBe(true);
    // A pause is not a rollback and does not require forward-repair to lift.
    expect(canReEnableFromRolledBack(config({ mode: "paused", forwardRepairReference: "x" }))).toBe(false);
  });

  it("publishes SLOs and cross-context escalation ownership", () => {
    expect(platformCoverageRolloutSlos.escalationOwners).toMatchObject({
      coverageReservation: expect.any(String),
      refundExecution: expect.any(String),
      reverseLogistics: expect.any(String),
      caseAdjudication: expect.any(String),
    });
    expect(platformCoverageRolloutSlos.refundToReconciliationP95Hours).toBeGreaterThan(0);
  });
});
