import catalogManifest from "@chase-sets/catalog/context";
import { afterEach, expect, it, vi } from "vitest";
import { admin, adminPath, deniedOrigins, mounted, mint, operator, snapshot, unpair } from "./fixture";
import { database, describeDb } from "./db-fixture";

afterEach(() => vi.useRealTimers());

describeDb("mounted operator grant mint authority", () => {
  const db = database("operator_grant_mint");

  it("mints a hash-only grant for an Identity-shaped actor", async () => {
    const response = await admin(mounted(catalogManifest, db()));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ grant: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), idleExpiresAt: expect.any(String) });
    const rows = (
      await db().query("SELECT token_hash, creator_user_id, creator_membership_id FROM catalog_operator_session_grants")
    ).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(body.grant);
  });

  it.each([
    ["anonymous", null, 401],
    ["wrong role", operator({ roleKey: "account-admin" }), 403],
    ["view only", operator({ permissions: ["catalog.view"] }), 403],
    ["missing step-up", operator({ authenticatedAt: null }), 400],
  ] as const)("refuses %s without minting", async (_name, actor, status) => {
    const before = await snapshot(db());
    const response = await admin(mounted(catalogManifest, db(), { actor }), "POST", adminPath + "/grant");
    expect(response.status).toBe(status);
    expect(await snapshot(db())).toEqual(before);
  });

  it("rejects mutation origins before writes", async () => {
    const app = mounted(catalogManifest, db());
    const before = await snapshot(db());
    for (const headers of deniedOrigins) {
      const response = await admin(app, "POST", adminPath + "/grant", headers);
      expect(response.status).toBe(403);
    }
    expect(await snapshot(db())).toEqual(before);
  });

  it("unpairs a minted grant and keeps the public route idempotently invalid", async () => {
    const app = mounted(catalogManifest, db());
    const grant = await mint(app);
    expect(await (await unpair(app, grant)).json()).toEqual({ outcome: "revoked" });
    expect((await unpair(app, grant)).status).toBe(401);
  });
});
