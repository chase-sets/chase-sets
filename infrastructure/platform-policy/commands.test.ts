import { describe, expect, it } from "vitest";
import { buildCreatePolicyDocumentCommand, buildRevisePolicyDocumentCommand } from "./commands";
import { definePolicy } from "./define-policy";

const holdDaysPolicy = definePolicy({
  policyKey: "settlement.clearance-window",
  contextName: "settlement",
  schemaSummary: "{ holdDays: integer 0-14 }",
  defaultValue: { holdDays: 2 },
  decodeValue: (raw) => {
    const value = raw as { holdDays?: unknown };
    if (typeof value.holdDays !== "number" || value.holdDays < 0 || value.holdDays > 14) {
      throw new Error("holdDays must be an integer between 0 and 14.");
    }
    return { holdDays: value.holdDays };
  },
});

describe("buildCreatePolicyDocumentCommand", () => {
  it("stamps the definition's policy metadata onto the command", () => {
    const command = buildCreatePolicyDocumentCommand(holdDaysPolicy, {
      documentId: "pol_1",
      value: { holdDays: 3 },
      status: "active",
      effectiveFrom: "2026-04-30T00:00:00.000Z",
      effectiveUntil: null,
      actorUserId: "usr_admin",
    });

    expect(command).toEqual({
      type: "CreatePolicyDocument",
      documentId: "pol_1",
      policyKey: "settlement.clearance-window",
      contextName: "settlement",
      schemaSummary: "{ holdDays: integer 0-14 }",
      status: "active",
      value: { holdDays: 3 },
      effectiveFrom: "2026-04-30T00:00:00.000Z",
      effectiveUntil: null,
      actorUserId: "usr_admin",
    });
  });

  it("rejects a value the definition's decodeValue rejects", () => {
    expect(() =>
      buildCreatePolicyDocumentCommand(holdDaysPolicy, {
        documentId: "pol_1",
        value: { holdDays: 99 } as never,
        status: "active",
        effectiveFrom: "2026-04-30T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "usr_admin",
      }),
    ).toThrow("holdDays must be an integer between 0 and 14.");
  });
});

describe("buildRevisePolicyDocumentCommand", () => {
  it("builds a revise command without a policy key or document id (the aggregate already has both)", () => {
    const command = buildRevisePolicyDocumentCommand(holdDaysPolicy, {
      value: { holdDays: 7 },
      status: "active",
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      effectiveUntil: null,
      actorUserId: "usr_admin",
    });

    expect(command).toEqual({
      type: "RevisePolicyDocument",
      status: "active",
      value: { holdDays: 7 },
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      effectiveUntil: null,
      actorUserId: "usr_admin",
    });
  });
});
