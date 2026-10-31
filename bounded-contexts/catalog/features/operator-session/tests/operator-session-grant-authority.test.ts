import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { OperatorAuthorityDecision } from "@chase-sets/auth-context";
import { createOperatorSessionGrants } from "../api/grants";

const bearer = "A".repeat(43);
const hash = createHash("sha256").update(bearer, "ascii").digest();

function pool(valid = true) {
  const state = { authorityRevocations: 0, renewals: 0 };
  const client: PgPoolClient = {
    async query<Row>(sql: string, values: readonly unknown[] = []): Promise<{ rows: Row[] }> {
      if (sql.startsWith("SELECT pg_try_advisory_lock")) return { rows: [{ locked: true } as Row] };
      if (sql.startsWith("SELECT pg_advisory_unlock")) return { rows: [{ unlocked: true } as Row] };
      if (valid && sql.includes("SELECT id, creator_user_id, creator_membership_id"))
        return {
          rows: [{ id: "grant_1", creator_user_id: "usr_creator", creator_membership_id: "mbr_creator" } as Row],
        };
      if (sql.includes("revoke_reason = 'authority-lost'")) {
        state.authorityRevocations++;
        return { rows: [] };
      }
      if (sql.includes("SET last_used_at")) {
        state.renewals++;
        return { rows: [{ id: "grant_1" } as Row] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const value: PgTransactionalPool = { query: client.query, connect: async () => client };
  return { value, state };
}

const request = () =>
  new Request("https://extension.example/observation", { headers: { authorization: `Bearer ${bearer}` } });

function grantedDecisionWithRole(roleKey: string): Extract<OperatorAuthorityDecision, { kind: "granted" }> {
  const decision: Extract<OperatorAuthorityDecision, { kind: "granted" }> = {
    kind: "granted",
    membershipId: "mbr_creator",
    roleKey: "platform-admin",
    rolePermissions: ["catalog.manage"],
  };
  Object.defineProperty(decision, "roleKey", { value: roleKey });
  return decision;
}

it("renews a grant when the live creator authority is granted", async () => {
  const fake = pool(true);
  const forGrantCreator = vi.fn(async () => ({
    kind: "granted" as const,
    membershipId: "mbr_creator",
    roleKey: "platform-admin" as const,
    rolePermissions: ["catalog.manage"],
  }));
  const services = createOperatorSessionGrants(fake.value, { forActor: vi.fn(), forGrantCreator });

  await expect(services.authorizeObservationGrant(request())).resolves.toEqual({
    grantId: "grant_1",
    creatorUserId: "usr_creator",
    creatorMembershipId: "mbr_creator",
  });
  expect(forGrantCreator).toHaveBeenCalledWith({ userId: "usr_creator", membershipId: "mbr_creator" });
  expect(fake.state.renewals).toBe(1);
  expect(fake.state.authorityRevocations).toBe(0);
});

it.each([
  ["a denied non-admin authority", { kind: "denied", reason: "not-platform-admin" }],
  [
    "missing catalog.manage",
    { kind: "granted", membershipId: "mbr_creator", roleKey: "platform-admin", rolePermissions: [] },
  ],
  ["a granted non-platform-admin authority", grantedDecisionWithRole("owner")],
] as const satisfies readonly [string, OperatorAuthorityDecision][])(
  "revokes when the authority decision has %s",
  async (_label, decision) => {
    const fake = pool(true);
    const forGrantCreator = vi.fn(async (): Promise<OperatorAuthorityDecision> => decision);
    const services = createOperatorSessionGrants(fake.value, { forActor: vi.fn(), forGrantCreator });

    await expect(services.authorizeObservationGrant(request())).rejects.toMatchObject({
      code: "authority-lost",
      status: 403,
    });
    expect(fake.state.authorityRevocations).toBe(1);
    expect(fake.state.renewals).toBe(0);
  },
);

it("revokes the grant in a committed transaction when the creator authority is denied", async () => {
  const fake = pool(true);
  const forGrantCreator = vi.fn(async () => ({ kind: "denied" as const, reason: "inactive" as const }));
  const services = createOperatorSessionGrants(fake.value, { forActor: vi.fn(), forGrantCreator });

  await expect(services.authorizeObservationGrant(request())).rejects.toMatchObject({
    code: "authority-lost",
    status: 403,
  });
  expect(forGrantCreator).toHaveBeenCalledWith({ userId: "usr_creator", membershipId: "mbr_creator" });
  expect(fake.state.authorityRevocations).toBe(1);
  expect(fake.state.renewals).toBe(0);
});

it.each(["absent", "throwing"] as const)("fails closed and revokes when the creator authority is %s", async (kind) => {
  const fake = pool(true);
  const catalogOperatorAuthority =
    kind === "absent"
      ? undefined
      : {
          forActor: vi.fn(),
          forGrantCreator: vi.fn(async () => {
            throw new Error("authority-unavailable");
          }),
        };
  const services = createOperatorSessionGrants(fake.value, catalogOperatorAuthority);

  await expect(services.authorizeObservationGrant(request())).rejects.toMatchObject({
    code: "authority-lost",
    status: 403,
  });
  expect(fake.state.authorityRevocations).toBe(1);
  expect(fake.state.renewals).toBe(0);
});

it.each([
  ["unknown", "grant-invalid"],
  ["revoked", "grant-invalid"],
  ["expired", "grant-invalid"],
] as const)("returns 401 for a %s grant before reading creator authority", async (_label, code) => {
  const fake = pool(false);
  const forGrantCreator = vi.fn(async () => ({
    kind: "granted" as const,
    membershipId: "mbr_creator",
    roleKey: "platform-admin" as const,
    rolePermissions: ["catalog.manage"],
  }));
  const services = createOperatorSessionGrants(fake.value, { forActor: vi.fn(), forGrantCreator });
  await expect(services.authorizeObservationGrant(request())).rejects.toMatchObject({ code, status: 401 });
  expect(forGrantCreator).not.toHaveBeenCalled();
});
