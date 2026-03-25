import { describe, expect, it } from "vitest";
import { buildMarketplaceApp } from "../src/app";
import type { DiscoveryServices } from "../../../bounded-contexts/discovery";

describe("marketplace api host app", () => {
  it("mounts health and the discovery API under /api/marketplace", async () => {
    const app = buildMarketplaceApp({
      db: {
        query: async (sql: string) => {
          if (sql.includes("COUNT(*)")) {
            return { rows: [{ count: "0" }] };
          }

          return { rows: [] };
        },
      },
    } as DiscoveryServices);

    const healthResponse = await app.fetch(new Request("http://marketplace.test/health"));
    expect(healthResponse.status).toBe(200);

    const legacyResponse = await app.fetch(new Request("http://marketplace.test/api/items"));
    expect(legacyResponse.status).toBe(404);

    const discoveryResponse = await app.fetch(new Request("http://marketplace.test/api/marketplace/items"));
    expect(discoveryResponse.status).toBe(200);
  });
});
