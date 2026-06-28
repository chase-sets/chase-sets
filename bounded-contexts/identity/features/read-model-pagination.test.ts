import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { listApiKeys } from "./api-keys/read-model/queries";
import { listInvitations } from "./invitations/read-model/queries";
import { listMemberships } from "./memberships/read-model/queries";

describe("identity read-model pagination", () => {
  it.each([
    ["api keys", listApiKeys, "api_keys.updated_at DESC"],
    ["invitations", listInvitations, "invitations.updated_at DESC"],
    ["memberships", listMemberships, "memberships.updated_at DESC"],
  ])("parameterizes and clamps %s list pagination", async (_name, list, orderBy) => {
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

    await list(db, {
      status: "active",
      search: "identity",
      limit: 999_999,
      offset: "-1 UNION SELECT password" as unknown,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.values).toEqual(["active", "%identity%"]);
    expect(calls[1]?.sql).toContain(`ORDER BY ${orderBy}`);
    expect(calls[1]?.sql).toContain("LIMIT $3 OFFSET $4");
    expect(calls[1]?.sql).not.toContain("UNION SELECT");
    expect(calls[1]?.values).toEqual(["active", "%identity%", 500, 0]);
  });
});
