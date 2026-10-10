import { describe, expect, it, vi } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  resolveStagedImportDispatchPolicy,
  tcgplayerStagedImportDispatchPolicy,
} from "../api/staged-import-dispatch-policy";

describe("staged-import producer fresh transactional resolver controls", () => {
  function fixture() {
    let value: unknown = { minimumRequestStartIntervalSeconds: 60 };
    let present = true;
    let history: string | null = "synthetic-history-event";
    const at = "2026-10-09T00:00:00.000Z";
    const query = vi.fn<PgTransactionalPool["query"]>(async (sql: string) => {
      if (sql.startsWith("LOCK TABLE")) return { rows: [] };
      if (sql.includes("AS event_id")) return { rows: [{ event_id: history }] };
      return {
        rows: present
          ? [
              {
                document_id: "synthetic-document",
                policy_key: tcgplayerStagedImportDispatchPolicy.policyKey,
                context_name: "channels",
                schema_summary: tcgplayerStagedImportDispatchPolicy.schemaSummary,
                status: "active",
                value,
                effective_from: "2026-01-01T00:00:00Z",
                effective_until: null,
                created_at: at,
                updated_at: at,
              },
            ]
          : [],
      };
    });
    const db: PgTransactionalPool = {
      query,
      connect: async () => {
        throw new Error("unexpected-transaction-owner");
      },
    };
    const eventStore = createPostgresEventStore({ pool: db });
    return {
      query,
      read: () => resolveStagedImportDispatchPolicy(eventStore, db, at),
      value: (next: unknown) => {
        value = next;
      },
      absent: () => {
        present = false;
      },
      history: (next: string | null) => {
        history = next;
      },
    };
  }
  it("declares v1/default60, locks before each fresh read and fingerprints value-only and history changes", async () => {
    const f = fixture();
    expect(tcgplayerStagedImportDispatchPolicy.defaultValue).toEqual({ minimumRequestStartIntervalSeconds: 60 });
    expect(tcgplayerStagedImportDispatchPolicy.schemaSummary).toContain("TcgplayerStagedImportDispatchPolicy/v1");
    const first = await f.read();
    f.value({ minimumRequestStartIntervalSeconds: 61 });
    const second = await f.read();
    expect(second.revision).not.toBe(first.revision);
    expect(second.value.minimumRequestStartIntervalSeconds).toBe(61);
    f.history("synthetic-history-event-2");
    expect((await f.read()).revision).not.toBe(second.revision);
    expect(
      f.query.mock.calls.filter(([sql]) => sql === "LOCK TABLE platform_policy_documents IN SHARE MODE"),
    ).toHaveLength(3);
    expect(f.query.mock.calls[0][0]).toBe("LOCK TABLE platform_policy_documents IN SHARE MODE");
  });
  it("missing producer, missing history and recursively malformed policy refuse rather than fallback", async () => {
    const absent = fixture();
    absent.absent();
    await expect(absent.read()).rejects.toThrow("staged-import-policy-unavailable");
    const missing = fixture();
    missing.history(null);
    await expect(missing.read()).rejects.toThrow("staged-import-policy-unavailable");
    const malformed = fixture();
    malformed.value({ minimumRequestStartIntervalSeconds: 60, unit: "minutes" });
    await expect(malformed.read()).rejects.toThrow("staged-import-policy-unavailable");
  });
});
