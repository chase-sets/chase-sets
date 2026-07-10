import { describe, expect, it } from "vitest";
import {
  findOverlappingActivePolicyDocument,
  getPolicyDocument,
  listActivePolicyDocuments,
  listPolicyDocumentHistory,
  listPolicyRegistry,
} from "./queries";

function fakeDb(handler: (sql: string, params: readonly unknown[]) => { rows: unknown[] }) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const db = {
    query: async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return handler(sql, params ?? []);
    },
  };
  return { db: db as never, calls };
}

describe("listActivePolicyDocuments", () => {
  it("selects active documents for a policy key ordered newest-window-first", async () => {
    const { db, calls } = fakeDb(() => ({ rows: [{ document_id: "pol_1" }] }));

    const rows = await listActivePolicyDocuments(db, "settlement.clearance-window");

    expect(calls[0]?.sql).toContain("WHERE policy_key = $1");
    expect(calls[0]?.sql).toContain("status = 'active'");
    expect(calls[0]?.sql).toContain("ORDER BY effective_from DESC");
    expect(calls[0]?.params).toEqual(["settlement.clearance-window"]);
    expect(rows).toEqual([{ document_id: "pol_1" }]);
  });
});

describe("getPolicyDocument", () => {
  it("returns null when no row matches", async () => {
    const { db } = fakeDb(() => ({ rows: [] }));

    expect(await getPolicyDocument(db, "pol_missing")).toBeNull();
  });

  it("attaches history to the current row", async () => {
    const { db } = fakeDb((sql) => {
      if (sql.includes("FROM platform_policy_document_history")) {
        return { rows: [{ history_id: "1", event_id: "evt_1" }] };
      }
      return { rows: [{ document_id: "pol_1" }] };
    });

    const document = await getPolicyDocument(db, "pol_1");

    expect(document).toMatchObject({
      document_id: "pol_1",
      history: [{ history_id: "1", event_id: "evt_1" }],
    });
  });
});

describe("listPolicyDocumentHistory", () => {
  it("orders newest first by recorded_at then history_id", async () => {
    const { db, calls } = fakeDb(() => ({ rows: [] }));

    await listPolicyDocumentHistory(db, "pol_1");

    expect(calls[0]?.sql).toContain("ORDER BY recorded_at DESC, history_id DESC");
    expect(calls[0]?.params).toEqual(["pol_1"]);
  });
});

describe("findOverlappingActivePolicyDocument", () => {
  it("excludes the given document id and scopes to the policy key", async () => {
    const { db, calls } = fakeDb(() => ({ rows: [{ document_id: "pol_existing" }] }));

    const overlap = await findOverlappingActivePolicyDocument(db, {
      policyKey: "settlement.clearance-window",
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      effectiveUntil: null,
      excludeDocumentId: "pol_1",
    });

    expect(calls[0]?.sql).toContain("tstzrange");
    expect(calls[0]?.params).toEqual(["settlement.clearance-window", "2026-06-01T00:00:00.000Z", null, "pol_1"]);
    expect(overlap).toEqual({ document_id: "pol_existing" });
  });
});

describe("listPolicyRegistry", () => {
  it("selects one row per policy key, derived from whatever documents exist", async () => {
    const { db, calls } = fakeDb(() => ({
      rows: [{ policy_key: "settlement.clearance-window", context_name: "settlement" }],
    }));

    const registry = await listPolicyRegistry(db);

    expect(calls[0]?.sql).toContain("DISTINCT ON (policy_key)");
    expect(registry).toEqual([{ policy_key: "settlement.clearance-window", context_name: "settlement" }]);
  });
});
