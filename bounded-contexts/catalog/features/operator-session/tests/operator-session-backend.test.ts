import { expect, it, vi } from "vitest";
import { withPgTransaction, type PgPoolClient, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { withOperatorSessionBackend } from "../api/operation";

function failingBackend() {
  const statements: string[] = [];
  const release = vi.fn();
  const client: PgPoolClient = {
    async query<Row>(sql: string) {
      statements.push(sql);
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true } as Row] };
      if (sql === "synthetic failure") throw new Error("synthetic driver failure");
      return { rows: [] as Row[] };
    },
    release,
  };
  const pool: PgTransactionalPool = { query: client.query, connect: async () => client };
  return { pool, release, statements };
}

it("rolls back a poisoned backend before preserving the caller's fixed failure", async () => {
  const fake = failingBackend();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const failure = new Error("scope-observations-unavailable");
  try {
    await expect(
      withOperatorSessionBackend(fake.pool, async (bound) => {
        try {
          await withPgTransaction(bound, (transaction) => transaction.query("synthetic failure"));
        } catch {
          await expect(bound.query("SELECT forbidden after failure")).rejects.toMatchObject({
            code: "custody-unavailable",
          });
          expect(fake.statements).toContain("ROLLBACK");
          throw failure;
        }
      }),
    ).rejects.toBe(failure);
    expect(fake.statements).not.toContain("SELECT forbidden after failure");
    expect(fake.release).toHaveBeenCalledWith(expect.objectContaining({ code: "custody-unavailable" }));
  } finally {
    warn.mockRestore();
  }
});

it("never returns success after a swallowed backend failure", async () => {
  const fake = failingBackend();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(
      withOperatorSessionBackend(fake.pool, async (bound) => {
        await bound.query("synthetic failure").catch(() => undefined);
        return "not a success";
      }),
    ).rejects.toMatchObject({ code: "custody-unavailable" });
    expect(fake.release).toHaveBeenCalledWith(expect.objectContaining({ code: "custody-unavailable" }));
  } finally {
    warn.mockRestore();
  }
});
