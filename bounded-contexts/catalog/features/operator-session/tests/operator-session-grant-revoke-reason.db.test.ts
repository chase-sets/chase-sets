import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { module as catalogModule } from "../../../index";
import { createOperatorSessionGrants } from "../api/grants";
import { describeDb, useOperatorSessionDatabase } from "./db-fixture";

describeDb("operator session revoke reasons", () => {
  const db = useOperatorSessionDatabase("operator_grant_revoke_reason");

  it("accepts authority-lost on fresh bootstrap and remains inert on rerun", async () => {
    const pool = db();
    await bootstrapContextDatabase(catalogModule, pool);
    const first = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'catalog_operator_session_grants'::regclass
          AND conname = 'catalog_operator_session_grants_revoke_reason_check'`,
    );
    expect(first.rows[0]?.definition).toContain("authority-lost");
    await bootstrapContextDatabase(catalogModule, pool);
    const second = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'catalog_operator_session_grants'::regclass
          AND conname = 'catalog_operator_session_grants_revoke_reason_check'`,
    );
    expect(second.rows).toEqual(first.rows);
  });

  it("applies the widening migration to an original schema and records an inert rerun", async () => {
    const pool = db();
    await pool.query(
      "ALTER TABLE catalog_operator_session_grants DROP CONSTRAINT catalog_operator_session_grants_revoke_reason_check",
    );
    await pool.query(
      `ALTER TABLE catalog_operator_session_grants
         ADD CONSTRAINT catalog_operator_session_grants_revoke_reason_check
         CHECK (revoke_reason IN ('replaced', 'disconnect', 'unpair'))`,
    );
    await pool.query("DELETE FROM bounded_context_schema_migrations WHERE migration_id = $1", [
      "20261024_catalog_operator_session_grant_authority_lost_revoke_reason_v3",
    ]);

    const insertAuthorityLost = () =>
      pool.query(
        `INSERT INTO catalog_operator_session_grants
          (id, token_hash, creator_user_id, creator_membership_id, created_at, last_used_at, idle_expires_at, revoked_at, revoke_reason)
         VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '30 days', clock_timestamp(), 'authority-lost')`,
        ["00000000-0000-0000-0000-000000000001", Buffer.alloc(32, 1), "usr_creator", "mbr_creator"],
      );
    await expect(insertAuthorityLost()).rejects.toMatchObject({ code: "23514" });

    await bootstrapContextDatabase(catalogModule, pool);
    const widened = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'catalog_operator_session_grants'::regclass
          AND conname = 'catalog_operator_session_grants_revoke_reason_check'`,
    );
    expect(widened.rows[0]?.definition).toContain("authority-lost");
    await expect(insertAuthorityLost()).resolves.toBeDefined();
    const ledger = await pool.query<{ migration_id: string }>(
      "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1",
      ["20261024_catalog_operator_session_grant_authority_lost_revoke_reason_v3"],
    );
    expect(ledger.rows).toHaveLength(1);

    await bootstrapContextDatabase(catalogModule, pool);
    const rerun = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'catalog_operator_session_grants'::regclass
          AND conname = 'catalog_operator_session_grants_revoke_reason_check'`,
    );
    expect(rerun.rows).toEqual(widened.rows);
    expect(
      (
        await pool.query("SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1", [
          "20261024_catalog_operator_session_grant_authority_lost_revoke_reason_v3",
        ])
      ).rows,
    ).toHaveLength(1);
  });

  it("renews granted creator authority and commits authority-loss revocation before refusal", async () => {
    const pool = db();
    const bearer = "B".repeat(43);
    const hash = createHash("sha256").update(bearer, "ascii").digest();
    const grantId = "00000000-0000-0000-0000-000000000010";
    await pool.query(
      `INSERT INTO catalog_operator_session_grants
        (id, token_hash, creator_user_id, creator_membership_id, created_at, last_used_at, idle_expires_at)
       VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '30 days')`,
      [grantId, hash, "usr_creator", "mbr_creator"],
    );
    const request = () =>
      new Request("https://extension.example/observation", { headers: { authorization: `Bearer ${bearer}` } });
    const before = await pool.query<{ idle_expires_at: Date }>(
      "SELECT idle_expires_at FROM catalog_operator_session_grants WHERE id = $1",
      [grantId],
    );
    const granted = createOperatorSessionGrants(pool, {
      forActor: async () => ({
        kind: "granted" as const,
        membershipId: "mbr_creator",
        roleKey: "platform-admin" as const,
        rolePermissions: ["catalog.manage"],
      }),
      forGrantCreator: async () => ({
        kind: "granted" as const,
        membershipId: "mbr_creator",
        roleKey: "platform-admin" as const,
        rolePermissions: ["catalog.manage"],
      }),
    });
    await expect(granted.authorizeObservationGrant(request())).resolves.toEqual({
      grantId,
      creatorUserId: "usr_creator",
      creatorMembershipId: "mbr_creator",
    });
    const renewed = await pool.query<{ idle_expires_at: Date }>(
      "SELECT idle_expires_at FROM catalog_operator_session_grants WHERE id = $1",
      [grantId],
    );
    expect(renewed.rows[0]!.idle_expires_at.getTime()).toBeGreaterThan(before.rows[0]!.idle_expires_at.getTime());

    const denied = createOperatorSessionGrants(pool, {
      forActor: async () => ({
        kind: "granted" as const,
        membershipId: "mbr_creator",
        roleKey: "platform-admin" as const,
        rolePermissions: ["catalog.manage"],
      }),
      forGrantCreator: async () => ({ kind: "denied" as const, reason: "inactive" as const }),
    });
    await expect(denied.authorizeObservationGrant(request())).rejects.toMatchObject({
      code: "authority-lost",
      status: 403,
    });
    const revoked = await pool.query<{ revoked_at: Date | null; revoke_reason: string | null }>(
      "SELECT revoked_at, revoke_reason FROM catalog_operator_session_grants WHERE id = $1",
      [grantId],
    );
    expect(revoked.rows[0]).toMatchObject({ revoke_reason: "authority-lost" });
    expect(revoked.rows[0]!.revoked_at).not.toBeNull();

    const revokedAuthority = vi.fn(async () => ({
      kind: "granted" as const,
      membershipId: "mbr_creator",
      roleKey: "platform-admin" as const,
      rolePermissions: ["catalog.manage"],
    }));
    const revokedServices = createOperatorSessionGrants(pool, {
      forActor: vi.fn(),
      forGrantCreator: revokedAuthority,
    });
    await expect(revokedServices.authorizeObservationGrant(request())).rejects.toMatchObject({
      code: "grant-invalid",
      status: 401,
    });
    expect(revokedAuthority).not.toHaveBeenCalled();

    const expiredBearer = "C".repeat(43);
    const expiredHash = createHash("sha256").update(expiredBearer, "ascii").digest();
    const expiredId = "00000000-0000-0000-0000-000000000011";
    await pool.query(
      `INSERT INTO catalog_operator_session_grants
        (id, token_hash, creator_user_id, creator_membership_id, created_at, last_used_at, idle_expires_at)
       VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp(), clock_timestamp() - interval '1 second')`,
      [expiredId, expiredHash, "usr_creator", "mbr_creator"],
    );
    const expiredAuthority = vi.fn(async () => ({
      kind: "granted" as const,
      membershipId: "mbr_creator",
      roleKey: "platform-admin" as const,
      rolePermissions: ["catalog.manage"],
    }));
    const expired = createOperatorSessionGrants(pool, { forActor: vi.fn(), forGrantCreator: expiredAuthority });
    await expect(
      expired.authorizeObservationGrant(
        new Request("https://extension.example/observation", {
          headers: { authorization: `Bearer ${expiredBearer}` },
        }),
      ),
    ).rejects.toMatchObject({ code: "grant-invalid", status: 401 });
    expect(expiredAuthority).not.toHaveBeenCalled();
  });
});
