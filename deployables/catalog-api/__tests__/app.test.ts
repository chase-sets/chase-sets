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
});
