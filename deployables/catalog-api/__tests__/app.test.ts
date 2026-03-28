import { describe, expect, it } from "vitest";
import type { CatalogServices } from "@chase-sets/catalog-authoring";
import { buildCatalogApp } from "../src/app";

describe("catalog api host app", () => {
  it("mounts health and the catalog authoring API under /api/catalog", async () => {
    const app = buildCatalogApp({} as CatalogServices);

    const healthResponse = await app.fetch(new Request("http://catalog.test/health"));
    expect(healthResponse.status).toBe(200);

    const legacyResponse = await app.fetch(new Request("http://catalog.test/api/dimensions"));
    expect(legacyResponse.status).toBe(404);

    const authoringResponse = await app.fetch(new Request("http://catalog.test/api/catalog/dimensions"));
    expect(authoringResponse.status).toBe(401);
  });

  it("returns 403 when the actor lacks catalog read permission", async () => {
    const app = buildCatalogApp({} as CatalogServices, {
      resolveActor: async () => ({
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_1",
        membershipId: "mbr_1",
        roleKey: "viewer",
        permissions: [],
      }),
    });

    const response = await app.fetch(
      new Request("http://catalog.test/api/catalog/dimensions"),
    );

    expect(response.status).toBe(403);
  });

  it("allows catalog reads and writes for authorized actors", async () => {
    const app = buildCatalogApp(
      {
        dimensions: {
          listDimensions: async () => ({ items: [], total: 0 }),
          commandHandler: async () => ({
            version: 1,
            state: { status: "draft" },
          }),
        },
      } as unknown as CatalogServices,
      {
        resolveActor: async () => ({
          sessionId: "ses_1",
          tenantId: "tnt_identity",
          userId: "usr_1",
          accountId: "acc_1",
          membershipId: "mbr_1",
          roleKey: "owner",
          permissions: ["catalog.view", "catalog.manage"],
        }),
      },
    );

    const readResponse = await app.fetch(
      new Request("http://catalog.test/api/catalog/dimensions"),
    );
    expect(readResponse.status).toBe(200);

    const writeResponse = await app.fetch(
      new Request("http://catalog.test/api/catalog/dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dimensionId: "dim_test",
          key: "size",
          name: "Size",
          description: "Card size",
        }),
      }),
    );
    expect(writeResponse.status).toBe(201);
  });
});
