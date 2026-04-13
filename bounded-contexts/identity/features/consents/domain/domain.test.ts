import { describe, expect, it } from "vitest";
import { decideConsent, evolveConsent, initialConsentState } from "./domain";

describe("consent domain", () => {
  it("records a consent entry", () => {
    const recorded = decideConsent(initialConsentState, {
      type: "RecordConsent",
      consentId: "cns_test" as never,
      subjectType: "user",
      userId: "usr_test" as never,
      accountId: "acc_test" as never,
      policyKey: "terms-of-service",
      policyVersion: "v1",
      recordedAt: "2026-03-28T00:00:00.000Z",
    });
    const state = recorded.reduce(evolveConsent, initialConsentState);

    expect(state.policyKey).toBe("terms-of-service");
    expect(state.policyVersion).toBe("v1");
  });
});
