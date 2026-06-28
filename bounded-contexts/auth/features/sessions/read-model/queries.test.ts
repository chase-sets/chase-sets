import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { listSessions } from "./queries";

describe("session read-model queries", () => {
  it("parameterizes and clamps caller pagination", async () => {
    const calls: Array<Readonly<{ sql: string; values: readonly unknown[] }>> = [];
    const db: PgQueryable = {
      query: async <QueryRow>(sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        return {
          rows: (sql.includes("COUNT(*)") ? [{ count: "0" }] : []) as QueryRow[],
          rowCount: sql.includes("COUNT(*)") ? 1 : 0,
        };
      },
    };

    await listSessions(db, {
      status: "active",
      search: "session",
      limit: "1; DROP TABLE identity_sessions" as unknown,
      offset: 100_000,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.values).toEqual(["active", "%session%"]);
    expect(calls[1]?.sql).toContain("LIMIT $3 OFFSET $4");
    expect(calls[1]?.sql).not.toContain("DROP TABLE");
    expect(calls[1]?.values).toEqual(["active", "%session%", 50, 10_000]);
  });
});
