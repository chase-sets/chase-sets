import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  bootstrapPostWriteTokenStore,
  createPostgresPostWriteTokenStore,
  platformPostWriteTokenStoreSchemaSql,
} from "./post-write-token-store";

const payload = {
  receipt: {
    observedAtMs: 1_234,
    sources: [
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: "42",
        eventIds: ["evt_marketplace_listing"],
      },
    ],
  },
  handoff: {
    kind: "marketplace.listing.publish",
    expectation: "resource-present",
    surface: "account-listing",
  },
} as const;

function createRecordingDb(
  options: Readonly<{
    insertRowCounts?: readonly number[];
    selectRows?: readonly Record<string, unknown>[];
  }> = {},
) {
  const calls: Array<Readonly<{ sql: string; params?: readonly unknown[] }>> = [];
  let insertIndex = 0;
  const db: PgQueryable = {
    query: async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });

      if (sql.includes("INSERT INTO platform_post_write_tokens")) {
        const rowCount = options.insertRowCounts?.[insertIndex] ?? 1;
        insertIndex += 1;
        return { rows: [], rowCount };
      }

      if (sql.includes("SELECT payload")) {
        return { rows: [...(options.selectRows ?? [])], rowCount: options.selectRows?.length ?? 0 };
      }

      return { rows: [], rowCount: 0 };
    },
  };

  return { db, calls };
}

describe("postgres post-write token store", () => {
  it("bootstraps the additive compact token table", async () => {
    const { db, calls } = createRecordingDb();

    await bootstrapPostWriteTokenStore(db);

    expect(calls[0].sql).toBe(platformPostWriteTokenStoreSchemaSql);
    expect(calls[0].sql).toContain("CREATE TABLE IF NOT EXISTS platform_post_write_tokens");
    expect(calls[0].sql).toContain("CREATE INDEX IF NOT EXISTS platform_post_write_tokens_expires_at_idx");
  });

  it("stores validated payloads behind opaque compact identifiers with expiry", async () => {
    const { db, calls } = createRecordingDb({ insertRowCounts: [0, 1] });
    const store = createPostgresPostWriteTokenStore(db, {
      tokenFactory: (() => {
        const tokens = ["pwt_duplicate000000000", "pwt_unique0000000000000"];
        return () => tokens.shift() ?? "pwt_unique0000000000000";
      })(),
    });

    const token = await store.storePostWriteToken(payload, { nowMs: 1_000, ttlMs: 120_000 });

    expect(token).toBe("pwt_unique0000000000000");
    expect(calls.some((call) => call.sql.includes("DELETE FROM platform_post_write_tokens"))).toBe(true);
    const insertCalls = calls.filter((call) => call.sql.includes("INSERT INTO platform_post_write_tokens"));
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[1].params).toEqual([
      "pwt_unique0000000000000",
      JSON.stringify(payload),
      "1970-01-01T00:00:01.000Z",
      "1970-01-01T00:02:01.000Z",
    ]);
  });

  it("resolves valid payloads and ignores unsafe or malformed records", async () => {
    const valid = createRecordingDb({ selectRows: [{ payload }] });
    const validStore = createPostgresPostWriteTokenStore(valid.db);

    await expect(validStore.resolvePostWriteToken("pwt_valid0000000000000")).resolves.toEqual(payload);

    const malformed = createRecordingDb({ selectRows: [{ payload: { accountId: "acc_1" } }] });
    const malformedStore = createPostgresPostWriteTokenStore(malformed.db);

    await expect(malformedStore.resolvePostWriteToken("pwt_valid0000000000000")).resolves.toBeNull();
    await expect(malformedStore.resolvePostWriteToken("https://example.com/account/acc_1")).resolves.toBeNull();
    expect(malformed.calls.filter((call) => call.sql.includes("SELECT payload"))).toHaveLength(1);
  });

  it("auto-bootstraps once when requested", async () => {
    const { db, calls } = createRecordingDb({ selectRows: [{ payload }] });
    const store = createPostgresPostWriteTokenStore(db, {
      autoBootstrap: true,
      tokenFactory: () => "pwt_unique0000000000000",
    });

    await store.storePostWriteToken(payload, { nowMs: 1_000, ttlMs: 120_000 });
    await store.resolvePostWriteToken("pwt_unique0000000000000");

    expect(calls.filter((call) => call.sql === platformPostWriteTokenStoreSchemaSql)).toHaveLength(1);
  });
});
