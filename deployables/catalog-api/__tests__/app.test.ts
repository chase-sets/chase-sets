import { describe, expect, it } from "vitest";
import { buildCatalogApp } from "../src/app";
import type { CatalogServices } from "../src/infrastructure/wiring";

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
