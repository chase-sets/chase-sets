import { describe, expect, it } from "vitest";
import { decidePolicyDocument, evolvePolicyDocument, initialPolicyDocumentState } from "./domain";

describe("platform policy document aggregate", () => {
  it("creates a document and rejects duplicate creation", () => {
    const [event] = decidePolicyDocument(initialPolicyDocumentState, {
      type: "CreatePolicyDocument",
      documentId: "pol_1",
      policyKey: "settlement.clearance-window",
      contextName: "settlement",
      schemaSummary: "{ holdDays: integer }",
      status: "active",
      value: { holdDays: 2 },
      effectiveFrom: "2026-04-30T00:00:00.000Z",
      effectiveUntil: null,
      actorUserId: "usr_admin",
    });
    const state = evolvePolicyDocument(initialPolicyDocumentState, event!);

    expect(state).toMatchObject({
      documentId: "pol_1",
      policyKey: "settlement.clearance-window",
      status: "active",
      value: { holdDays: 2 },
    });

    expect(() =>
      decidePolicyDocument(state, {
        type: "CreatePolicyDocument",
        documentId: "pol_1",
        policyKey: "settlement.clearance-window",
        contextName: "settlement",
        schemaSummary: "{ holdDays: integer }",
        status: "active",
        value: { holdDays: 2 },
        effectiveFrom: "2026-04-30T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "usr_admin",
      }),
    ).toThrow("Policy document has already been created.");
  });

  it("rejects revising before creation", () => {
    expect(() =>
      decidePolicyDocument(initialPolicyDocumentState, {
        type: "RevisePolicyDocument",
        status: "active",
        value: { holdDays: 3 },
        effectiveFrom: "2026-04-30T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "usr_admin",
      }),
    ).toThrow("Policy document must be created before it can be revised.");
  });

  it("revises value, status, and effective window while keeping the document id and policy key", () => {
    const [created] = decidePolicyDocument(initialPolicyDocumentState, {
      type: "CreatePolicyDocument",
      documentId: "pol_2",
      policyKey: "settlement.clearance-window",
      contextName: "settlement",
      schemaSummary: "{ holdDays: integer }",
      status: "active",
      value: { holdDays: 2 },
      effectiveFrom: "2026-04-30T00:00:00.000Z",
      effectiveUntil: null,
      actorUserId: "usr_admin",
    });
    const createdState = evolvePolicyDocument(initialPolicyDocumentState, created!);

    const [revised] = decidePolicyDocument(createdState, {
      type: "RevisePolicyDocument",
      status: "inactive",
      value: { holdDays: 5 },
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      effectiveUntil: "2026-12-01T00:00:00.000Z",
      actorUserId: "usr_admin_2",
    });
    const revisedState = evolvePolicyDocument(createdState, revised!);

    expect(revised).toMatchObject({
      type: "platform-policy.document.revised",
      data: {
        documentId: "pol_2",
        policyKey: "settlement.clearance-window",
        status: "inactive",
        value: { holdDays: 5 },
        effectiveFrom: "2026-06-01T00:00:00.000Z",
        effectiveUntil: "2026-12-01T00:00:00.000Z",
        actorUserId: "usr_admin_2",
      },
    });
    expect(revisedState).toMatchObject({
      documentId: "pol_2",
      policyKey: "settlement.clearance-window",
      status: "inactive",
      value: { holdDays: 5 },
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      effectiveUntil: "2026-12-01T00:00:00.000Z",
    });
  });

  it("rejects an effective-until at or before effective-from", () => {
    expect(() =>
      decidePolicyDocument(initialPolicyDocumentState, {
        type: "CreatePolicyDocument",
        documentId: "pol_3",
        policyKey: "settlement.clearance-window",
        contextName: "settlement",
        schemaSummary: "{ holdDays: integer }",
        status: "active",
        value: { holdDays: 2 },
        effectiveFrom: "2026-04-30T00:00:00.000Z",
        effectiveUntil: "2026-04-30T00:00:00.000Z",
        actorUserId: "usr_admin",
      }),
    ).toThrow("Policy effective-until must be after effective-from.");
  });

  it("rejects a blank policy key", () => {
    expect(() =>
      decidePolicyDocument(initialPolicyDocumentState, {
        type: "CreatePolicyDocument",
        documentId: "pol_4",
        policyKey: "   ",
        contextName: "settlement",
        schemaSummary: "{ holdDays: integer }",
        status: "active",
        value: { holdDays: 2 },
        effectiveFrom: "2026-04-30T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "usr_admin",
      }),
    ).toThrow("Policy key is required.");
  });
});
