import catalogManifest from "@chase-sets/catalog/context";
import { createHash } from "node:crypto";
import { module as catalogModule } from "@chase-sets/catalog";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { admin, adminPath, deniedOrigins, mint, mounted, operator, snapshot, transport, unpair } from "./fixture";
import { database, describeDb } from "./db-fixture";

afterEach(() => vi.useRealTimers());
describeDb("mounted operator grant mint authority", () => {
  const db = database("operator_grant_mint");
  it.each([false, true])("upgrades the registered v1 grant schema with retained rows=%s", async (retained) => {
    const migrationId = "20261013_catalog_operator_session_grant_creator_ids_text_v2";
    const migration = catalogModule.schemaMigrations?.find((entry) => entry.migrationId === migrationId);
    expect(migration, "forward creator-id migration is registered").toBeDefined();
    await db().query("DROP TABLE catalog_operator_session_grants");
    await db().query("DELETE FROM bounded_context_schema_migrations WHERE migration_id = ANY($1::text[])", [
      ["20261002_catalog_operator_session_grants_v1", migrationId],
    ]);
    await bootstrapContextDatabase(
      { ...catalogModule, schemaMigrations: catalogModule.schemaMigrations?.filter((entry) => entry !== migration) },
      db(),
    );
    if (retained) {
      await db().query(`INSERT INTO catalog_operator_session_grants
        VALUES ('00000000-0000-4000-8000-000000000001', decode(repeat('ab', 32), 'hex'),
          '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000004',
          clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '30 days', NULL, NULL)`);
    }
    const before = await snapshot(db());
    await bootstrapContextDatabase(catalogModule, db());
    const after = await snapshot(db());
    expect(after.grants.map(({ row_version: _version, ...row }) => row)).toEqual(
      before.grants.map(({ row_version: _version, ...row }) => row),
    );
    expect(
      (
        await db().query(`SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'catalog_operator_session_grants'
        AND column_name IN ('creator_user_id', 'creator_membership_id')`)
      ).rows,
    ).toEqual([
      { data_type: "text", is_nullable: "NO" },
      { data_type: "text", is_nullable: "NO" },
    ]);
    expect(
      (
        await db().query("SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1", [
          migrationId,
        ])
      ).rows,
    ).toEqual([{ migration_id: migrationId }]);
    expect(
      (
        await db().query(`SELECT indisvalid, indisunique FROM pg_index
      WHERE indexrelid = 'catalog_operator_session_one_unrevoked'::regclass`)
      ).rows,
    ).toEqual([{ indisvalid: true, indisunique: true }]);
    await mint(mounted(catalogManifest, db()));
    await expect(
      db().query(`INSERT INTO catalog_operator_session_grants
      SELECT gen_random_uuid(), decode(repeat('cd', 32), 'hex'), creator_user_id, creator_membership_id,
        created_at, last_used_at, idle_expires_at, NULL, NULL FROM catalog_operator_session_grants
      WHERE revoked_at IS NULL`),
    ).rejects.toMatchObject({ code: "23505" });
    for (const column of ["creator_user_id", "creator_membership_id"]) {
      for (const value of ["x", "x".repeat(128)]) {
        await db().query(`UPDATE catalog_operator_session_grants SET ${column} = $1`, [value]);
      }
      for (const value of ["", "x".repeat(129)]) {
        await expect(
          db().query(`UPDATE catalog_operator_session_grants SET ${column} = $1`, [value]),
        ).rejects.toMatchObject({ code: "23514" });
      }
      await expect(db().query(`UPDATE catalog_operator_session_grants SET ${column} = NULL`)).rejects.toMatchObject({
        code: "23502",
      });
    }
    await bootstrapContextDatabase(catalogModule, db());
    expect(
      (
        await db().query("SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1", [
          migrationId,
        ])
      ).rows,
    ).toHaveLength(1);
    const migrated = await snapshot(db());
    // A lost acknowledgement after DDL but before the ledger INSERT must be recoverable.
    await db().query("DELETE FROM bounded_context_schema_migrations WHERE migration_id = $1", [migrationId]);
    await bootstrapContextDatabase(catalogModule, db());
    expect((await snapshot(db())).grants.map(({ row_version: _version, ...row }) => row)).toEqual(
      migrated.grants.map(({ row_version: _version, ...row }) => row),
    );
    expect(
      (
        await db().query("SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1", [
          migrationId,
        ])
      ).rows,
    ).toHaveLength(1);
  });
  it("mints for Identity-shaped user and membership ids with an idle expiry", async () => {
    const actor = operator();
    expect(actor.userId).toMatch(/^usr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(actor.membershipId).toMatch(/^mbr_[0-9A-HJKMNP-TV-Z]{26}$/);
    const response = await admin(mounted(catalogManifest, db(), { actor }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      grant: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      idleExpiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });
  it("warns once with only the SQLSTATE and operation while returning a custody 503", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const wire = transport(db());
      wire.controls.before = async (sql) => {
        if (sql.includes("INSERT INTO catalog_operator_session_grants")) {
          throw Object.assign(new Error("synthetic-token cookie hash SQL values"), {
            code: "22P02",
            detail: "synthetic-sensitive-session-material",
          });
        }
      };
      const response = await admin(mounted(catalogManifest, wire.pool));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "custody-unavailable" });
      expect(warn.mock.calls).toEqual([[JSON.stringify({ operation: "operator-session.query", sqlstate: "22P02" })]]);
    } finally {
      warn.mockRestore();
    }
  });
  it.each([
    ["anonymous", null, 401],
    ["wrong role", operator({ roleKey: "account-admin" }), 403],
    ["view only", operator({ permissions: ["catalog.view"] }), 403],
    ["missing step-up", operator({ authenticatedAt: null }), 400],
    ["malformed step-up", operator({ authenticatedAt: "not-a-date" }), 400],
  ] as const)("refuses %s without minting", async (_name, actor, status) => {
    const before = await snapshot(db());
    const response = await admin(mounted(catalogManifest, db(), { actor }));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    if (status === 400) expect(await response.json()).toEqual({ code: "step_up_required" });
    expect(await snapshot(db())).toEqual(before);
  });
  it.each([
    [-600_001, 400],
    [-600_000, 200],
    [0, 200],
    [1, 400],
  ] as const)("enforces the exact ten-minute/future boundary at %i ms", async (offset, status) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-10-02T12:00:00.000Z");
    vi.setSystemTime(now);
    const actor = operator({ authenticatedAt: new Date(now.getTime() + offset).toISOString() });
    for (const method of ["POST", "DELETE"]) {
      const response = await admin(
        mounted(catalogManifest, db(), { actor }),
        method,
        method === "POST" ? adminPath + "/grant" : adminPath,
      );
      expect(response.status).toBe(status);
    }
  });
  it.each(deniedOrigins)("rejects mutation Origin/fetch metadata %# without writes", async (headers) => {
    const app = mounted(catalogManifest, db());
    await mint(app);
    const before = await snapshot(db());
    for (const [method, path] of [
      ["POST", adminPath + "/grant"],
      ["DELETE", adminPath],
    ]) {
      const response = await admin(app, method, path, headers);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "forbidden" });
    }
    expect(await snapshot(db())).toEqual(before);
  });
  it("stores only a unique hash with creator identity and DB-time instants", async () => {
    const wire = transport(db());
    wire.controls.now = new Date("2026-12-01T02:03:04.005Z");
    const app = mounted(catalogManifest, wire.pool);
    const grant = await mint(app);
    const rows = (
      await db().query("SELECT *, idle_expires_at - created_at AS lifetime FROM catalog_operator_session_grants")
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      token_hash: createHash("sha256").update(grant).digest(),
      creator_user_id: operator().userId,
      creator_membership_id: operator().membershipId,
      revoked_at: null,
      revoke_reason: null,
      lifetime: { days: 30 },
      created_at: wire.controls.now,
      last_used_at: wire.controls.now,
      idle_expires_at: new Date("2026-12-31T02:03:04.005Z"),
    });
    expect(rows[0]!.last_used_at).toEqual(rows[0]!.created_at);
    expect(JSON.stringify(rows)).not.toContain(grant);
    const response = await admin(app, "GET", adminPath, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      revision: 0,
      storedAt: null,
      browserExpiresAt: null,
      custodyAvailable: true,
      grant: {
        active: true,
        createdAt: expect.any(String),
        idleExpiresAt: expect.any(String),
        lastUsedAt: expect.any(String),
      },
    });
  });
  it.each([
    ["equal creation instants", "2026-12-01T02:03:04.005Z", "2026-12-31T02:03:04.005Z"],
    ["a backward DB-clock transition", "2026-12-01T02:03:03.005Z", "2026-12-31T02:03:03.005Z"],
  ])("metadata prefers the unrevoked replacement with %s", async (_name, replacementTime, expiry) => {
    const wire = transport(db());
    const predecessorTime = new Date("2026-12-01T02:03:04.005Z");
    wire.controls.now = predecessorTime;
    const app = mounted(catalogManifest, wire.pool);
    await mint(app);
    await db().query("UPDATE catalog_operator_session_grants SET id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'");
    wire.controls.now = new Date(replacementTime);
    await mint(app);
    await db().query(
      "UPDATE catalog_operator_session_grants SET id = '00000000-0000-4000-8000-000000000001' WHERE revoked_at IS NULL",
    );
    const before = await snapshot(db());
    expect(before.grants).toHaveLength(2);
    expect(before.grants[0]).toMatchObject({
      created_at: wire.controls.now,
      last_used_at: wire.controls.now,
      idle_expires_at: new Date(expiry),
      revoked_at: null,
    });
    expect(before.grants[1]).toMatchObject({
      created_at: predecessorTime,
      revoked_at: wire.controls.now,
      revoke_reason: "replaced",
    });
    const expected = {
      revision: 0,
      storedAt: null,
      browserExpiresAt: null,
      custodyAvailable: true,
      grant: {
        active: true,
        createdAt: replacementTime,
        idleExpiresAt: expiry,
        lastUsedAt: replacementTime,
      },
    };
    const active = await admin(app, "GET", adminPath, {});
    expect(active.status).toBe(200);
    expect(active.headers.get("cache-control")).toBe("no-store");
    expect(await active.json()).toEqual(expected);
    expect(await snapshot(db())).toEqual(before);

    wire.controls.now = new Date(expiry);
    const expired = await admin(app, "GET", adminPath, {});
    expect(expired.status).toBe(200);
    expect(await expired.json()).toEqual({ ...expected, grant: { ...expected.grant, active: false } });
    expect(await snapshot(db())).toEqual(before);
  });
  it("metadata retains inactive historical fallback when every grant is revoked", async () => {
    const wire = transport(db());
    wire.controls.now = new Date("2026-12-01T02:03:04.005Z");
    const app = mounted(catalogManifest, wire.pool);
    const absent = await admin(app, "GET", adminPath, {});
    expect((await absent.json()).grant).toBeNull();
    await mint(app);
    wire.controls.now = new Date("2026-12-01T02:03:03.005Z");
    const replacement = await mint(app);
    expect((await unpair(app, replacement)).status).toBe(200);
    const before = await snapshot(db());
    expect(before.grants).toHaveLength(2);
    expect(before.grants.every((grant) => grant.revoked_at !== null)).toBe(true);
    const response = await admin(app, "GET", adminPath, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).grant).toEqual({
      active: false,
      createdAt: "2026-12-01T02:03:04.005Z",
      idleExpiresAt: "2026-12-31T02:03:04.005Z",
      lastUsedAt: "2026-12-01T02:03:04.005Z",
    });
    expect(await snapshot(db())).toEqual(before);
  });
  it("GET requires platform-admin/catalog.view but not recent authentication", async () => {
    expect(
      (
        await admin(
          mounted(catalogManifest, db(), { actor: operator({ authenticatedAt: null }) }),
          "GET",
          adminPath,
          {},
        )
      ).status,
    ).toBe(200);
    for (const actor of [operator({ roleKey: "account-admin" }), operator({ permissions: ["catalog.manage"] })]) {
      expect((await admin(mounted(catalogManifest, db(), { actor }), "GET", adminPath, {})).status).toBe(403);
    }
  });
  it("concurrent two-replica mint replaces even an expired unrevoked grant", async () => {
    const first = mounted(catalogManifest, db());
    await mint(first);
    await db().query(
      "UPDATE catalog_operator_session_grants SET idle_expires_at = clock_timestamp() - interval '1 second'",
    );
    const [a, b] = await Promise.all([mint(first), mint(mounted(catalogManifest, db()))]);
    expect(a).not.toBe(b);
    const rows = (await db().query("SELECT revoked_at, revoke_reason FROM catalog_operator_session_grants")).rows;
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(1);
    expect(rows.filter((row) => row.revoke_reason === "replaced")).toHaveLength(2);
    await expect(
      db().query(`INSERT INTO catalog_operator_session_grants
      SELECT gen_random_uuid(), decode(repeat('ab', 32), 'hex'), creator_user_id, creator_membership_id,
        created_at, last_used_at, idle_expires_at, NULL, NULL FROM catalog_operator_session_grants WHERE revoked_at IS NULL`),
    ).rejects.toThrow();
  });
});
