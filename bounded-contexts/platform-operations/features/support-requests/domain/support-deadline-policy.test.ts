import { describe, expect, it } from "vitest";
import { supportFlowCatalog } from "./flow-catalog";
import {
  decodeSupportDeadlinePolicyValue,
  resolveSupportFlowDeadlineHours,
  SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
  supportDeadlinePolicy,
} from "./support-deadline-policy";

describe("support deadline policy", () => {
  it("derives the launch value from the compiled flow catalog byte-for-byte", () => {
    for (const flow of supportFlowCatalog) {
      expect(SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE[flow.flowType]).toEqual({
        sellerResponseHours: flow.sellerResponseHours,
        supportReviewHours: flow.supportReviewHours,
      });
    }
  });

  it("decodes the launch value back to itself", () => {
    expect(decodeSupportDeadlinePolicyValue(JSON.parse(JSON.stringify(SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE)))).toEqual(
      SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
    );
  });

  it("accepts an in-bounds revision for a flow with a seller-response phase", () => {
    const revised = {
      ...SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
      "product-not-received": { sellerResponseHours: 72, supportReviewHours: 36 },
    };

    expect(decodeSupportDeadlinePolicyValue(revised)).toMatchObject({
      "product-not-received": { sellerResponseHours: 72, supportReviewHours: 36 },
    });
  });

  it("rejects seller response hours below the 4-hour floor", () => {
    const revised = {
      ...SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
      "product-not-received": { sellerResponseHours: 3, supportReviewHours: 24 },
    };

    expect(() => decodeSupportDeadlinePolicyValue(revised)).toThrow(/between 4 and 336/);
  });

  it("rejects support review hours above the 14-day ceiling", () => {
    const revised = {
      ...SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
      "product-not-received": { sellerResponseHours: 48, supportReviewHours: 337 },
    };

    expect(() => decodeSupportDeadlinePolicyValue(revised)).toThrow(/between 4 and 336/);
  });

  it("rejects a non-integer hour value", () => {
    const revised = {
      ...SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
      "product-not-received": { sellerResponseHours: 48.5, supportReviewHours: 24 },
    };

    expect(() => decodeSupportDeadlinePolicyValue(revised)).toThrow(/whole number of hours/);
  });

  it("rejects introducing a seller-response phase for a flow that structurally has none", () => {
    const revised = {
      ...SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
      "refund-status": { sellerResponseHours: 24, supportReviewHours: 24 },
    };

    expect(() => decodeSupportDeadlinePolicyValue(revised)).toThrow(/has no seller-response phase/);
  });

  it("rejects a value missing an entry for a catalog flow type", () => {
    const { "product-not-received": _omitted, ...revised } = SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE;

    expect(() => decodeSupportDeadlinePolicyValue(revised)).toThrow(/missing an entry for 'product-not-received'/);
  });

  it("rejects a non-object value", () => {
    expect(() => decodeSupportDeadlinePolicyValue("nope" as never)).toThrow(/must be an object/);
    expect(() => decodeSupportDeadlinePolicyValue(null as never)).toThrow(/must be an object/);
  });

  it("registers the policy with its dotted key and platform-operations as owner", () => {
    expect(supportDeadlinePolicy.policyKey).toBe("platform-operations.support-deadlines");
    expect(supportDeadlinePolicy.contextName).toBe("platform-operations");
  });

  it("resolves hours for a flow type from a policy value, falling back to launch defaults when absent", () => {
    const resolved = resolveSupportFlowDeadlineHours("product-not-received", {
      ...SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
      "product-not-received": { sellerResponseHours: 72, supportReviewHours: 36 },
    });
    expect(resolved).toEqual({ sellerResponseHours: 72, supportReviewHours: 36 });

    const fallback = resolveSupportFlowDeadlineHours("product-not-received", {} as never);
    expect(fallback).toEqual(SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE["product-not-received"]);
  });
});
