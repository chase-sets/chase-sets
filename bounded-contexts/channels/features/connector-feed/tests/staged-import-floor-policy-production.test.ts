import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as nodeCrypto from "node:crypto";
import * as definition from "../domain/staged-import-policy";
import * as runtime from "@chase-sets/platform-policy/runtime";
import * as validation from "../../outbound-sync/domain/validation";
import * as policy from "../domain/staged-import-dispatch-policy";
import * as contracts from "../domain/contracts";
import * as oauth from "../../../support/request-support/connector-oauth";
import { evaluate } from "../../connector-client/tests/coordinator-mutation-support";
import { createStagedImportDispatchPolicyRoutes } from "../api/staged-import-dispatch-policy-routes";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { resolveStagedImportDispatchPolicy } from "../api/staged-import-dispatch-policy";
import { tcgplayerStagedImportDispatchPolicy } from "../domain/staged-import-policy";

describe("staged-import producer fresh transactional resolver controls", () => {
  it("publishes the domain declaration without exporting the resolver runtime through the server entrypoint", () => {
    const server = readFileSync(new URL("../../../server.ts", import.meta.url), "utf8");
    expect(server).toContain('from "./features/connector-feed/domain/staged-import-policy"');
    expect(server).not.toContain('from "./features/connector-feed/api/staged-import-dispatch-policy"');
  });
  function fixture(resolve = resolveStagedImportDispatchPolicy) {
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
      read: () => resolve(eventStore, db, at),
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
  it.each([false, true])("content-only fingerprint bypass=%s kills the revision-change witness", async (bypass) => {
    let resolve = resolveStagedImportDispatchPolicy;
    if (bypass) {
      const source = readFileSync(new URL("../api/staged-import-dispatch-policy.ts", import.meta.url), "utf8");
      const anchor = "selected.event_id,\n            value,";
      if (source.split(anchor).length !== 2) throw new Error("content-mutant-anchor-moved");
      const result = evaluate(source.replace(anchor, "selected.event_id,"), {
        "node:crypto": nodeCrypto,
        "../domain/staged-import-policy": definition,
        "@chase-sets/platform-policy/runtime": runtime,
        "../../outbound-sync/domain/validation": validation,
        "../domain/staged-import-dispatch-policy": policy,
        "../domain/contracts": contracts,
        "../../../support/request-support/connector-oauth": oauth,
      });
      resolve = result.resolveStagedImportDispatchPolicy as typeof resolveStagedImportDispatchPolicy;
    }
    const f = fixture(resolve);
    const first = await f.read();
    f.value({ minimumRequestStartIntervalSeconds: 61 });
    expect((await f.read()).revision !== first.revision).toBe(!bypass);
  });
  it("raw exception and credential sentinels never reach response, audit or structured logs", async () => {
    const query = vi.fn<PgTransactionalPool["query"]>().mockResolvedValue({ rows: [] });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = createStagedImportDispatchPolicyRoutes(
        async () => {
          throw new Error("SYNTHETIC_RESPONSE_SECRET");
        },
        { query },
      );
      const response = await app.request(
        `/tcgplayer-staged-import-dispatch-policy?reservationId=synthetic&requestNonce=${"a".repeat(32)}`,
        { headers: { authorization: "Bearer SYNTHETIC_CREDENTIAL_SECRET" } },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "unavailable" });
      expect(JSON.stringify(query.mock.calls)).not.toContain("SECRET");
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
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
