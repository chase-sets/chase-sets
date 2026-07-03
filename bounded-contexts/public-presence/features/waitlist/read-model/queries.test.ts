import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { listWaitlistSignups } from "./queries";

describe("waitlist read-model queries", () => {
  it("escapes LIKE metacharacters in email search text", async () => {
    const db: PgQueryable = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("COUNT(*)") ? [{ count: "0" }] : [],
        rowCount: sql.includes("COUNT(*)") ? 1 : 0,
      })),
    };

    await listWaitlistSignups(db, {
      search: "buyer_%@example.test",
      limit: 25,
      offset: 0,
    });

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("LOWER(email) LIKE $1 ESCAPE '\\'"), [
      "%buyer\\_\\%@example.test%",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("LIMIT $2 OFFSET $3"), [
      "%buyer\\_\\%@example.test%",
      25,
      0,
    ]);
  });
});
