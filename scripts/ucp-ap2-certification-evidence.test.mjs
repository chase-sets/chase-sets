import { describe, expect, it } from "vitest";
import {
  REQUIRED_UCP_AP2_CHECKS,
  UCP_AP2_CERTIFICATION_SCHEMA,
  validateUcpAp2CertificationEvidence,
} from "./ucp-ap2-certification-evidence.mjs";

function approvedRecord() {
  return {
    schemaVersion: UCP_AP2_CERTIFICATION_SCHEMA,
    environment: "staging",
    releaseCommit: "a".repeat(40),
    ucpVersion: "2026-04-08",
    ap2Version: "0.2",
    enabledModes: ["human-present"],
    checks: Object.fromEntries(
      REQUIRED_UCP_AP2_CHECKS.map((check) => [check, { passed: true, evidenceReference: `AP2-${check}` }]),
    ),
    supportReview: { approved: true, evidenceReference: "AP2-SUPPORT-REVIEW" },
    financeReview: { approved: true, evidenceReference: "AP2-FINANCE-REVIEW" },
    certificationDecision: "approved",
    publicMarketingClaimsEnabled: false,
  };
}

describe("UCP AP2 certification evidence", () => {
  it("accepts a complete redacted direct-mode certification record", () => {
    expect(validateUcpAp2CertificationEvidence(approvedRecord())).toEqual([]);
  });

  it("rejects autonomous mode and incomplete provider proof", () => {
    const record = approvedRecord();
    record.enabledModes = ["human-not-present"];
    record.checks.validMandateHeadlessSpt.passed = false;

    expect(validateUcpAp2CertificationEvidence(record)).toEqual(
      expect.arrayContaining([
        "enabledModes must contain only human-present.",
        "checks.validMandateHeadlessSpt is not approved.",
      ]),
    );
  });

  it("rejects secrets, payment tokens, and marketing enablement", () => {
    const record = approvedRecord();
    record.checks.profileDiscovery.evidenceReference = "spt_sensitive";
    record.publicMarketingClaimsEnabled = true;

    expect(validateUcpAp2CertificationEvidence(record)).toEqual(
      expect.arrayContaining([
        "Certification evidence contains payment, credential, key, or personal data.",
        "publicMarketingClaimsEnabled must remain false until the separate marketing gate is approved.",
      ]),
    );
  });
});
