import { describe, expect, it } from "vitest";
import { buildPolicyDocumentProjectionHandlers } from "./projection";

describe("platform policy document projection", () => {
  it("inserts the current page and a history row on create, and invokes the invalidation hook", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const invalidated: string[] = [];
    const handlers = buildPolicyDocumentProjectionHandlers(
      {
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params: params ?? [] });
          return { rows: [] };
        },
      } as never,
      { onPolicyRevised: (policyKey) => invalidated.push(policyKey) },
    );

    await handlers["platform-policy.document.created"]?.({
      id: "evt_created",
      data: {
        documentId: "pol_1",
        policyKey: "settlement.clearance-window",
        contextName: "settlement",
        schemaSummary: "{ holdDays: integer }",
        status: "active",
        value: { holdDays: 2 },
        effectiveFrom: "2026-04-30T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "usr_admin",
      },
      timing: { recordedAt: "2026-04-30T00:00:01.000Z" },
      audit: { performedByUserId: "usr_admin" },
    } as never);

    expect(calls[0]?.sql).toContain("INSERT INTO platform_policy_documents");
    expect(calls[0]?.params).toEqual([
      "pol_1",
      "settlement.clearance-window",
      "settlement",
      "{ holdDays: integer }",
      "active",
      JSON.stringify({ holdDays: 2 }),
      "2026-04-30T00:00:00.000Z",
      null,
      "2026-04-30T00:00:01.000Z",
    ]);
    expect(calls[1]?.sql).toContain("INSERT INTO platform_policy_document_history");
    expect(calls[1]?.params).toEqual([
      "pol_1",
      "settlement.clearance-window",
      "evt_created",
      "created",
      "usr_admin",
      "active",
      JSON.stringify({ holdDays: 2 }),
      "2026-04-30T00:00:00.000Z",
      null,
      "2026-04-30T00:00:01.000Z",
    ]);
    expect(invalidated).toEqual(["settlement.clearance-window"]);
  });

  it("updates the current page and appends history on revise, and invokes the invalidation hook", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const invalidated: string[] = [];
    const handlers = buildPolicyDocumentProjectionHandlers(
      {
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params: params ?? [] });
          return { rows: [] };
        },
      } as never,
      { onPolicyRevised: (policyKey) => invalidated.push(policyKey) },
    );

    await handlers["platform-policy.document.revised"]?.({
      id: "evt_revised",
      data: {
        documentId: "pol_1",
        policyKey: "settlement.clearance-window",
        status: "inactive",
        value: { holdDays: 5 },
        effectiveFrom: "2026-06-01T00:00:00.000Z",
        effectiveUntil: "2026-12-01T00:00:00.000Z",
        actorUserId: "usr_admin_2",
      },
      timing: { recordedAt: "2026-06-01T00:00:01.000Z" },
      audit: { performedByUserId: "usr_admin_2" },
    } as never);

    expect(calls[0]?.sql).toContain("UPDATE platform_policy_documents");
    expect(calls[0]?.params).toEqual([
      "pol_1",
      "inactive",
      JSON.stringify({ holdDays: 5 }),
      "2026-06-01T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z",
      "2026-06-01T00:00:01.000Z",
    ]);
    expect(calls[1]?.sql).toContain("INSERT INTO platform_policy_document_history");
    expect(invalidated).toEqual(["settlement.clearance-window"]);
  });

  it("falls back to the event's audit actor when the payload omits actorUserId", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handlers = buildPolicyDocumentProjectionHandlers({
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    } as never);

    await handlers["platform-policy.document.revised"]?.({
      id: "evt_legacy",
      data: {
        documentId: "pol_1",
        policyKey: "settlement.clearance-window",
        status: "active",
        value: { holdDays: 5 },
        effectiveFrom: "2026-06-01T00:00:00.000Z",
        effectiveUntil: null,
      },
      timing: { recordedAt: "2026-06-01T00:00:01.000Z" },
      audit: { performedByUserId: "usr_replay" },
    } as never);

    expect(calls[1]?.params).toContain("usr_replay");
  });
});
