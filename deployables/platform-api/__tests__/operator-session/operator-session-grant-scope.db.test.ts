import catalogManifest from "@chase-sets/catalog/context";
import { afterEach, expect, it, vi } from "vitest";
import { adminPath, base, mounted, mint, publicPath, snapshot, unpair } from "./fixture";
import { database, describeDb } from "./db-fixture";

afterEach(() => vi.useRealTimers());

describeDb("public bearer grant scope", () => {
  const db = database("operator_grant_scope");

  it("bearer authorizes only public unpair and does not expose removed custody routes", async () => {
    const app = mounted(catalogManifest, db());
    const grant = await mint(app);
    const bearerOnlyApp = mounted(catalogManifest, db(), { actor: null });
    for (const path of [adminPath, adminPath + "/grant", publicPath + "/tcgplayer"]) {
      const response = await bearerOnlyApp.request(base + path, { headers: { authorization: "Bearer " + grant } });
      expect([404, 405]).toContain(response.status);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const before = await snapshot(db());
    const revoked = await unpair(app, grant);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ outcome: "revoked" });
    expect((await unpair(app, grant)).status).toBe(401);
    expect((await snapshot(db())).grants[0]!.revoked_at).not.toBeNull();
    expect((await snapshot(db())).grants[0]!.last_used_at).toEqual(before.grants[0]!.last_used_at);
  });

  it("empty public unpair body and invalid bearer are rejected without durable changes", async () => {
    const app = mounted(catalogManifest, db());
    const grant = await mint(app);
    const before = await snapshot(db());
    const body = await app.request(base + publicPath + "/grant", {
      method: "DELETE",
      headers: { authorization: "Bearer " + grant, "content-type": "application/json" },
      body: "{}",
    });
    expect(body.status).toBe(400);
    expect((await unpair(app, "x".repeat(43))).status).toBe(401);
    expect((await snapshot(db())).grants).toEqual(before.grants);
  });
});
