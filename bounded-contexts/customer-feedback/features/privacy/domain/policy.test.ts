import { describe, expect, it } from "vitest";
import {
  customerFeedbackPrivacyCapabilities,
  customerFeedbackPrivacyPolicyVersion,
  customerFeedbackRetentionSchedule,
  privacyPermission,
  normalizePrivacyReason,
  retentionRule,
} from "./policy";

describe("Customer Feedback privacy policy", () => {
  it("publishes one versioned retention decision for every data class", () => {
    expect(customerFeedbackPrivacyPolicyVersion).toBe("customer-feedback-privacy.v1");
    expect(new Set(customerFeedbackRetentionSchedule.map((rule) => rule.dataClass)).size).toBe(
      customerFeedbackRetentionSchedule.length,
    );
    expect(retentionRule("response-content")).toMatchObject({ duration: "P365D", action: "redact" });
    expect(retentionRule("export-artifacts")).toMatchObject({ duration: "PT24H", action: "delete" });
    expect(retentionRule("structural-audit")).toMatchObject({ duration: "P2555D", action: "retain" });
  });

  it("keeps sensitive capabilities separate and naturally named", () => {
    expect(customerFeedbackPrivacyCapabilities).toEqual([
      "view-comments",
      "export-sensitive-feedback",
      "follow-up",
      "redact-feedback",
      "manage-feedback-holds",
      "audit-feedback-privacy",
    ]);
    expect(privacyPermission("redact-feedback")).toBe("customer-feedback.privacy.redact-feedback");
    expect(normalizePrivacyReason("Customer-Request")).toBe("customer-request");
    expect(() => normalizePrivacyReason("customer@example.com")).toThrow("content-free codes");
  });
});
