import catalogManifest from "@chase-sets/catalog/context";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  admin,
  adminPath,
  deniedOrigins,
  database,
  describeDb,
  mint,
  mounted,
  operator,
  snapshot,
  transport,
} from "./fixture";

afterEach(() => vi.useRealTimers());
describeDb("mounted operator grant mint authority", () => {
  const db = database("operator_grant_mint");
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
