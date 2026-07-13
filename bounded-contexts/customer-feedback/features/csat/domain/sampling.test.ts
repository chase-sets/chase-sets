import { describe, expect, it } from "vitest";
import type { CsatOutcomeFactV1 } from "./outcome-fact";
import { decideCsatSampling, type CsatSamplingPolicyV1 } from "./sampling";
import { transactionalCsatV1 } from "./survey";

const fact: CsatOutcomeFactV1 = {
  factSchemaVersion: 1,
  outcomeCode: "checkout.completed",
  sourceContext: "checkout",
  subjectAccountId: "acc_subject",
  subjectKind: "buyer",
  subject: { entityType: "checkout-session", entityId: "chk_source" },
  outcomeOccurredAt: "2026-07-13T10:00:00.000Z",
  idempotencyKey: "checkout.completed:chk_source",
};

function policy(overrides: Partial<CsatSamplingPolicyV1> = {}): CsatSamplingPolicyV1 {
  return {
    policySchemaVersion: 1,
    policyId: "checkout-csat.v1",
    outcomeCode: "checkout.completed",
    surveyVersion: transactionalCsatV1.id,
    issuanceEnabled: true,
    sampleRate: 0.5,
    cohortKey: "checkout-completion",
    perSubjectCooldown: "P30D",
    invitationTtl: "P7D",
    dependsOnBetaCohorts: false,
    ...overrides,
  };
}

describe("CSAT sampling", () => {
  it("persists a deterministic, explainable decision", () => {
    const first = decideCsatSampling(policy(), fact);
    const replay = decideCsatSampling(policy(), fact);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      policySchemaVersion: 1,
      policyId: "checkout-csat.v1",
      algorithmVersion: "fnv1a-32.v1",
      cohortKey: "checkout-completion",
      sampleRate: 0.5,
    });
    expect(first.bucket).toBeGreaterThanOrEqual(0);
    expect(first.bucket).toBeLessThan(1);
  });

  it("uses the explicit kill switch independently of sample rate", () => {
    expect(decideCsatSampling(policy({ issuanceEnabled: false, sampleRate: 1 }), fact)).toMatchObject({
      included: false,
      reason: "issuance-disabled",
      sampleRate: 1,
    });
    expect(decideCsatSampling(policy({ issuanceEnabled: true, sampleRate: 0 }), fact)).toMatchObject({
      included: false,
      reason: "sampled-out",
      sampleRate: 0,
    });
  });

  it("rejects invalid rates and unsupported duration units", () => {
    expect(() => decideCsatSampling(policy({ sampleRate: 1.1 }), fact)).toThrow("between 0 and 1");
    expect(() => decideCsatSampling(policy({ perSubjectCooldown: "P1M" }), fact)).toThrow(
      "Unsupported ISO-8601 duration",
    );
  });
});
