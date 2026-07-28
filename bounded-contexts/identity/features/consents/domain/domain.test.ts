import { describe, expect, it } from "vitest";
import { ConsentSubjectScopeError, ConsentVersionNotConsentActivatableError } from "./consent-bundle";
import { decideConsent, evolveConsent, initialConsentState } from "./domain";

describe("consent domain", () => {
  it("records a consent entry", () => {
    const recorded = decideConsent(initialConsentState, {
      type: "RecordConsent",
      consentId: "cns_test" as never,
      subjectType: "user",
      userId: "usr_test" as never,
      accountId: "acc_test" as never,
      policyKey: "marketing-email",
      policyVersion: "v1",
      recordedAt: "2026-03-28T00:00:00.000Z",
    });
    const state = recorded.reduce(evolveConsent, initialConsentState);

    expect(state.policyKey).toBe("marketing-email");
    expect(state.policyVersion).toBe("v1");
  });

  it("carries the bundle admission rules into the decider itself, so no path can skip them", () => {
    const command = {
      type: "RecordConsent",
      consentId: "cns_test",
      userId: "usr_test",
      accountId: "acc_test",
      policyKey: "terms-of-service",
      policyVersion: "v1",
      recordedAt: "2026-03-28T00:00:00.000Z",
    } as const;

    // The shipped artifact is not consent-activatable...
    expect(() => decideConsent(initialConsentState, { ...command, subjectType: "user" } as never)).toThrow(
      ConsentVersionNotConsentActivatableError,
    );
    // ...and the subject rule is decided before the corpus is even consulted.
    expect(() => decideConsent(initialConsentState, { ...command, subjectType: "account" } as never)).toThrow(
      ConsentSubjectScopeError,
    );
  });

  it("withdraws a recorded consent while retaining its policy record", () => {
    const recorded = decideConsent(initialConsentState, {
      type: "RecordConsent",
      consentId: "cns_test" as never,
      subjectType: "user",
      userId: "usr_test" as never,
      accountId: "acc_test" as never,
      policyKey: "marketing-email",
      policyVersion: "v1",
      recordedAt: "2026-03-28T00:00:00.000Z",
    });
    const recordedState = recorded.reduce(evolveConsent, initialConsentState);

    const withdrawn = decideConsent(recordedState, {
      type: "WithdrawConsent",
      withdrawnAt: "2026-04-02T00:00:00.000Z",
    });
    const withdrawnState = withdrawn.reduce(evolveConsent, recordedState);

    expect(withdrawn).toEqual([
      {
        type: "identity.consent.withdrawn",
        data: {
          consentId: "cns_test",
          subjectType: "user",
          userId: "usr_test",
          accountId: "acc_test",
          policyKey: "marketing-email",
          policyVersion: "v1",
          withdrawnAt: "2026-04-02T00:00:00.000Z",
        },
      },
    ]);
    expect(withdrawnState).toMatchObject({
      id: "cns_test",
      policyKey: "marketing-email",
      policyVersion: "v1",
      status: "withdrawn",
      withdrawnAt: "2026-04-02T00:00:00.000Z",
    });
  });
});
