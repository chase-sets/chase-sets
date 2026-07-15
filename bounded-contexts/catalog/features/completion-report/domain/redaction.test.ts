import { describe, expect, it } from "vitest";
import { SupportSafetyError, assertSupportSafe, findSupportSafetyViolations } from "./redaction";
import { reconcileProductionCatalogCompletion } from "./reconcile";
import { renderCompletionSummary } from "./summary";
import { completeManifest } from "./__fixtures__/manifest";

describe("support-safety redaction", () => {
  it("passes a reconciled report and its rendered summary", () => {
    const report = reconcileProductionCatalogCompletion(completeManifest(), {
      generatedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(findSupportSafetyViolations(report)).toEqual([]);
    expect(findSupportSafetyViolations(renderCompletionSummary(report))).toEqual([]);
    expect(() => assertSupportSafe(report)).not.toThrow();
  });

  it("rejects a full provider URL", () => {
    const violations = findSupportSafetyViolations({ note: "fetched https://api.scrydex.com/v1/cards?page=2" });
    expect(violations.map((violation) => violation.rule)).toContain("full-url");
  });

  it("rejects a bearer token and a stripe-style secret", () => {
    expect(findSupportSafetyViolations("Bearer abc123").map((violation) => violation.rule)).toContain("bearer-token");
    expect(findSupportSafetyViolations("sk_live_abcdef123").map((violation) => violation.rule)).toContain(
      "stripe-style-secret",
    );
  });

  it("rejects account and actor identity keys", () => {
    const violations = findSupportSafetyViolations({ forAccountId: "acct_123456", performedByUserId: "u-1" });
    const rules = violations.map((violation) => violation.rule);
    expect(rules).toContain("account-or-actor-identity");
    expect(rules).toContain("account-id-token");
  });

  it("rejects raw provider payload keys and reports their path", () => {
    const violations = findSupportSafetyViolations({ providerUsage: [{ sourcePayload: {} }] });
    expect(violations[0]?.path).toBe("providerUsage[0].sourcePayload");
    expect(violations[0]?.rule).toBe("raw-provider-payload");
  });

  it("assertSupportSafe throws SupportSafetyError with every violation", () => {
    try {
      assertSupportSafe({ href: "https://provider.example/x", secret: "value" });
      expect.unreachable("expected a support-safety error");
    } catch (error) {
      expect(error).toBeInstanceOf(SupportSafetyError);
      expect((error as SupportSafetyError).violations.length).toBeGreaterThanOrEqual(2);
    }
  });
});
