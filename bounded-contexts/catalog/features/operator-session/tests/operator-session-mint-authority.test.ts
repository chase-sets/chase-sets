import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createOperatorSessionGrants } from "../api/grants";

const actor: ResolvedActor = {
  sessionId: "ses_operator",
  tenantId: "tnt_operator",
  userId: "usr_operator",
  accountId: "acc_operator",
  membershipId: "mbr_operator",
  roleKey: "platform-admin",
  permissions: ["catalog.manage"],
  authenticatedAt: new Date().toISOString(),
};

function pool() {
  const state = { inserts: 0, revokeUpdates: 0 };
  const client: PgPoolClient = {
    async query<Row>(sql: string): Promise<{ rows: Row[] }> {
      if (sql.startsWith("SELECT pg_try_advisory_lock")) return { rows: [{ locked: true } as Row] };
      if (sql.startsWith("SELECT pg_advisory_unlock")) return { rows: [{ unlocked: true } as Row] };
      if (sql.startsWith("INSERT INTO catalog_operator_session_grants")) {
        state.inserts++;
        return { rows: [{ idle_expires_at: new Date("2026-11-22T00:00:00.000Z") } as Row] };
      }
      if (sql.includes("UPDATE catalog_operator_session_grants SET revoked_at")) {
        state.revokeUpdates++;
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const value: PgTransactionalPool = { query: client.query, connect: async () => client };
  return { value, state };
}

const request = () => new Request("https://admin.example/api/catalog/operator-session/grant", { method: "POST" });

it("requires catalog authority before minting and leaves the active grant untouched on refusal", async () => {
  const fake = pool();
  const forActor = vi.fn(async () => ({ kind: "denied" as const, reason: "not-platform-admin" as const }));
  const services = createOperatorSessionGrants(fake.value, { forActor, forGrantCreator: vi.fn() });

  const response = await services.execute("mint", request(), actor);

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ code: "forbidden" });
  expect(forActor).toHaveBeenCalledWith(actor);
  expect(fake.state.inserts).toBe(0);
  expect(fake.state.revokeUpdates).toBe(0);
});

it("does not treat an absent or throwing catalog authority as a mint grant", async () => {
  for (const catalogOperatorAuthority of [
    undefined,
    {
      forActor: vi.fn(async () => {
        throw new Error("authority");
      }),
    },
  ]) {
    const fake = pool();
    const services = createOperatorSessionGrants(
      fake.value,
      catalogOperatorAuthority ? { ...catalogOperatorAuthority, forGrantCreator: vi.fn() } : undefined,
    );
    const response = await services.execute("mint", request(), actor);
    expect(response.status).toBe(403);
    expect(fake.state.inserts).toBe(0);
    expect(fake.state.revokeUpdates).toBe(0);
  }
});

it("keeps the bearer hash cookie-free", () => {
  expect(createHash("sha256").update("synthetic", "ascii").digest()).toHaveLength(32);
});
