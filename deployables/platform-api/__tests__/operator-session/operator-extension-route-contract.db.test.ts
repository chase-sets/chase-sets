import catalogManifest from "@chase-sets/catalog/context";
import { expect, it } from "vitest";
import { admin, adminPath, mint, mounted, publicPath, unpair } from "./fixture";
import { database, describeDb } from "./db-fixture";

describeDb("operator-extension-route-contract: mounted pairing surface", () => {
  const db = database("operator_extension_route");

  it("mounts metadata, mint, and bearer unpair without a server-side provider session", async () => {
    const app = mounted(catalogManifest, db());
    const metadataBefore = await admin(app, "GET", adminPath);
    expect(metadataBefore.status).toBe(200);
    expect(await metadataBefore.json()).toMatchObject({ custodyAvailable: false, grant: null });

    const grant = await mint(app);
    const metadataAfter = await admin(app, "GET", adminPath);
    expect(await metadataAfter.json()).toMatchObject({ custodyAvailable: false, grant: { active: true } });

    const response = await unpair(app, grant);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "revoked" });
    expect(await (await admin(app, "DELETE", adminPath)).json()).toEqual({ outcome: "revoked" });
    expect(publicPath).toBe("/api/public/catalog/operator-session");
  });
});
