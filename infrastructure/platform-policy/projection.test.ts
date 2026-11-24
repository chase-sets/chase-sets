import { describe, expect, it } from "vitest";
import { buildPolicyDocumentProjectionHandlers } from "./projection";

/** Collapses whitespace so an assertion reads as one SQL clause, whatever the statement's layout. */
function normalizeSql(sql: string | undefined): string {
  return (sql ?? "").replace(/\s+/g, " ").trim();
}

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
      streamVersion: 1,
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
      1,
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
      streamVersion: 4,
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
      4,
    ]);
    expect(calls[1]?.sql).toContain("INSERT INTO platform_policy_document_history");
    expect(invalidated).toEqual(["settlement.clearance-window"]);
  });

  it("writes a created document only over a row that holds an earlier stream version", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handlers = buildPolicyDocumentProjectionHandlers({
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    } as never);

    await handlers["platform-policy.document.created"]?.({
      id: "evt_created",
      streamVersion: 1,
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

    const sql = normalizeSql(calls[0]?.sql);
    expect(sql).toContain("updated_at, stream_version ) VALUES ( $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $9, $10 )");
    expect(sql).toContain("stream_version = EXCLUDED.stream_version");
    expect(sql.endsWith("WHERE platform_policy_documents.stream_version < EXCLUDED.stream_version")).toBe(true);
    expect(calls[0]?.params.at(-1)).toBe(1);
  });

  it("writes a revision only over a row that holds an earlier stream version", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handlers = buildPolicyDocumentProjectionHandlers({
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    } as never);

    await handlers["platform-policy.document.revised"]?.({
      id: "evt_revised",
      streamVersion: 7,
      data: {
        documentId: "pol_1",
        policyKey: "settlement.clearance-window",
        status: "active",
        value: { holdDays: 5 },
        effectiveFrom: "2026-06-01T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "usr_admin_2",
      },
      timing: { recordedAt: "2026-06-01T00:00:01.000Z" },
      audit: { performedByUserId: "usr_admin_2" },
    } as never);

    const sql = normalizeSql(calls[0]?.sql);
    expect(sql).toContain("updated_at = $6, stream_version = $7 WHERE");
    expect(sql.endsWith("WHERE document_id = $1 AND stream_version < $7")).toBe(true);
    expect(calls[0]?.params).toHaveLength(7);
    expect(calls[0]?.params.at(-1)).toBe(7);
  });

  it("keeps the history write and the invalidation hook outside the stream version comparison", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const invalidated: string[] = [];
    const handlers = buildPolicyDocumentProjectionHandlers(
      {
        // Reports no written row, as the guarded statement does for an event the row already holds.
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params: params ?? [] });
          return { rows: [], rowCount: 0 };
        },
      } as never,
      { onPolicyRevised: (policyKey) => invalidated.push(policyKey) },
    );

    await handlers["platform-policy.document.revised"]?.({
      id: "evt_replayed",
      streamVersion: 2,
      data: {
        documentId: "pol_1",
        policyKey: "settlement.clearance-window",
        status: "active",
        value: { holdDays: 5 },
        effectiveFrom: "2026-06-01T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "usr_admin_2",
      },
      timing: { recordedAt: "2026-06-01T00:00:01.000Z" },
      audit: { performedByUserId: "usr_admin_2" },
    } as never);

    const history = normalizeSql(calls[1]?.sql);
    expect(history).toContain("INSERT INTO platform_policy_document_history");
    expect(history).toContain("ON CONFLICT (event_id) DO UPDATE");
    expect(history).not.toContain("stream_version");
    expect(calls[1]?.params).toContain("evt_replayed");
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
