import { expect, it, vi } from "vitest";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "@chase-sets/catalog";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function validGrantPool() {
  const state = { revocations: 0 };
  const client: PgPoolClient = {
    async query<Row>(sql: string): Promise<{ rows: Row[] }> {
      if (sql.startsWith("SELECT pg_try_advisory_lock")) return { rows: [{ locked: true } as Row] };
      if (sql.startsWith("SELECT pg_advisory_unlock")) return { rows: [{ unlocked: true } as Row] };
      if (sql.includes("SELECT id, creator_user_id, creator_membership_id")) {
        return {
          rows: [{ id: "grant_1", creator_user_id: "usr_creator", creator_membership_id: "mbr_creator" } as Row],
        };
      }
      if (sql.includes("revoke_reason = 'authority-lost'")) {
        state.revocations++;
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const value: PgTransactionalPool = { query: client.query, connect: async () => client };
  return { value, state };
}

it("omits Catalog creator authority and fails closed without calling a port", async () => {
  const source = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
  expect(source).not.toContain("catalogOperatorAuthority");

  const fake = validGrantPool();
  const bearer = "W".repeat(43);
  const services = catalogModule.createServices(fake.value, {}).operatorSession;
  await expect(
    services.authorizeObservationGrant(
      new Request("https://extension.example/observation", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
    ),
  ).rejects.toMatchObject({ code: "authority-lost", status: 403 });
  expect(fake.state.revocations).toBe(1);
});
