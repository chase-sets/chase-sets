import { describe, expect, it, vi } from "vitest";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import { supportFlowCatalog } from "./flow-catalog";
import {
  decodeSupportDeadlinePolicyValue,
  resolveSupportFlowDeadlineHours,
  SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
  supportDeadlinePolicy,
  supportDeadlinePublicPolicy,
} from "./support-deadline-policy";

const TUNABLE_HOUR_KEYS = ["sellerResponseHours", "supportReviewHours"];
const REVISED_NOT_RECEIVED_HOURS = { sellerResponseHours: 72, supportReviewHours: 36 };

/**
 * A stored document value with revised hours for one flow. Documents written
 * while the value still carried the compiled open window keep that key.
 */
function storedDocumentValue(shape: "hours-only" | "with-compiled-window") {
  return Object.fromEntries(
    supportFlowCatalog.map((flow) => {
      const hours =
        flow.flowType === "product-not-received"
          ? REVISED_NOT_RECEIVED_HOURS
          : SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE[flow.flowType];
      return [
        flow.flowType,
        shape === "with-compiled-window"
          ? { ...hours, postDeliveryOpenWindowDays: flow.postDeliveryOpenWindowDays }
          : hours,
      ];
    }),
  );
}

function policyDocumentsDb(values: readonly unknown[]) {
  const rows = values.map((value, index) => ({
    document_id: `pol_${index + 1}`,
    value,
    effective_from: "2026-04-01T00:00:00.000Z",
    effective_until: null,
  }));
  return { query: vi.fn(async () => ({ rows })) } as never;
}

describe("support deadline policy", () => {
  it("derives the launch value from the compiled flow catalog byte-for-byte", () => {
    for (const flow of supportFlowCatalog) {
      expect(SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE[flow.flowType]).toStrictEqual({
        sellerResponseHours: flow.sellerResponseHours,
        supportReviewHours: flow.supportReviewHours,
      });
    }
  });

  it("holds only the two tunable hours per flow in its default, schema summary and decoded value", () => {
    const decoded = decodeSupportDeadlinePolicyValue(JSON.parse(JSON.stringify(supportDeadlinePolicy.defaultValue)));
    const flowTypes = supportFlowCatalog.map((flow) => flow.flowType);

    expect(Object.keys(supportDeadlinePolicy.defaultValue)).toEqual(flowTypes);
    expect(Object.keys(decoded)).toEqual(flowTypes);
    for (const flowType of flowTypes) {
      expect(Object.keys(supportDeadlinePolicy.defaultValue[flowType])).toEqual(TUNABLE_HOUR_KEYS);
      expect(Object.keys(decoded[flowType])).toEqual(TUNABLE_HOUR_KEYS);
    }
    expect(supportDeadlinePolicy.schemaSummary).toBe(
      "{ [flowType]: { sellerResponseHours: integer 4-336 or null (structural), supportReviewHours: integer 4-336 } } for every support flow type",
    );
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

  it("decodes a stored document that carries the compiled open window without it", () => {
    const decoded = decodeSupportDeadlinePolicyValue(storedDocumentValue("with-compiled-window"));

    expect(decoded).toStrictEqual(storedDocumentValue("hours-only"));
    expect(decoded["product-not-received"]).toStrictEqual(REVISED_NOT_RECEIVED_HOURS);
  });

  it.each([
    ["a different number of days", "product-not-received", 31],
    ["no window where the flow has one", "product-not-received", null],
    ["a window where the flow has none", "refund-status", 30],
  ] as const)("rejects a stored open window with %s", (_case, flowType, postDeliveryOpenWindowDays) => {
    const stored = {
      ...SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
      [flowType]: { ...SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE[flowType], postDeliveryOpenWindowDays },
    };

    expect(() => decodeSupportDeadlinePolicyValue(stored)).toThrow(/compiled flow behavior/);
    expect(() => supportDeadlinePublicPolicy.decodeValue(stored)).toThrow(/compiled flow behavior/);
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
      "product-not-received": REVISED_NOT_RECEIVED_HOURS,
    });
    expect(resolved).toStrictEqual(REVISED_NOT_RECEIVED_HOURS);

    const fallback = resolveSupportFlowDeadlineHours("product-not-received", {} as never);
    expect(fallback).toStrictEqual(SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE["product-not-received"]);
  });
});

describe("support deadline public policy", () => {
  const at = "2026-05-01T00:00:00.000Z";

  it("is a view over the same policy rather than a second declaration", () => {
    expect(supportDeadlinePublicPolicy.policyKey).toBe(supportDeadlinePolicy.policyKey);
    expect(supportDeadlinePublicPolicy.contextName).toBe(supportDeadlinePolicy.contextName);
    expect(supportDeadlinePublicPolicy.schemaSummary).toBe(supportDeadlinePolicy.schemaSummary);
  });

  it("adds every flow's compiled open window beside its default hours", () => {
    for (const flow of supportFlowCatalog) {
      expect(supportDeadlinePublicPolicy.defaultValue[flow.flowType]).toStrictEqual({
        ...SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE[flow.flowType],
        postDeliveryOpenWindowDays: flow.postDeliveryOpenWindowDays,
      });
    }
    expect(supportDeadlinePublicPolicy.defaultValue["refund-status"].postDeliveryOpenWindowDays).toBeNull();
  });

  it("resolves the compiled open window beside the default hours when no document is stored", async () => {
    const resolver = createPolicyResolver({ db: policyDocumentsDb([]) });

    const resolved = await resolver.resolvePolicy(supportDeadlinePublicPolicy, { at });

    expect(resolved.source).toBe("fallback");
    expect(resolved.value["product-not-received"]).toStrictEqual({
      sellerResponseHours: 48,
      supportReviewHours: 24,
      postDeliveryOpenWindowDays: 30,
    });
  });

  it.each(["hours-only", "with-compiled-window"] as const)(
    "resolves the compiled open window beside the hours of a stored %s document",
    async (shape) => {
      const resolver = createPolicyResolver({ db: policyDocumentsDb([storedDocumentValue(shape)]) });

      const resolved = await resolver.resolvePolicy(supportDeadlinePublicPolicy, { at });

      expect(resolved.source).toBe("policy");
      expect(resolved.value["product-not-received"]).toStrictEqual({
        ...REVISED_NOT_RECEIVED_HOURS,
        postDeliveryOpenWindowDays: 30,
      });
    },
  );

  it.each(["hours-only", "with-compiled-window"] as const)(
    "decodes the value of an upcoming %s revision with the compiled open window",
    (shape) => {
      const upcoming = supportDeadlinePublicPolicy.decodeValue(storedDocumentValue(shape));

      expect(upcoming["product-not-received"]).toStrictEqual({
        ...REVISED_NOT_RECEIVED_HOURS,
        postDeliveryOpenWindowDays: 30,
      });
    },
  );

  it("leaves the editable policy resolving hours only from the same stored document", async () => {
    const resolver = createPolicyResolver({ db: policyDocumentsDb([storedDocumentValue("with-compiled-window")]) });

    const resolved = await resolver.resolvePolicy(supportDeadlinePolicy, { at });

    expect(resolved.value["product-not-received"]).toStrictEqual(REVISED_NOT_RECEIVED_HOURS);
  });
});
