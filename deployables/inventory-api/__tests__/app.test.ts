import { describe, expect, it } from "vitest";
import { module as inventoryModule } from "@chase-sets/inventory";
import { buildInventoryApp } from "../src/app";

describe("inventory api host app", () => {
  it("mounts health and the inventory API under /api/inventory", async () => {
    const app = buildInventoryApp({} as ReturnType<typeof inventoryModule.createServices>);

    const healthResponse = await app.fetch(new Request("http://inventory.test/health"));
    expect(healthResponse.status).toBe(200);

    const legacyResponse = await app.fetch(new Request("http://inventory.test/api/records"));
    expect(legacyResponse.status).toBe(404);

    const inventoryResponse = await app.fetch(
      new Request("http://inventory.test/api/inventory/records"),
    );
    expect(inventoryResponse.status).toBe(401);
  });

  it("returns 403 when the actor lacks inventory read permission", async () => {
    const app = buildInventoryApp({} as ReturnType<typeof inventoryModule.createServices>, {
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
      new Request("http://inventory.test/api/inventory/records"),
    );

    expect(response.status).toBe(403);
  });

  it("allows inventory reads and writes for authorized actors", async () => {
    const app = buildInventoryApp(
      {
        records: {
          listRecords: async () => ({ items: [], total: 0 }),
          getRecord: async () => null,
          createRecord: async () => ({ recordId: "inv_1", version: 1 }),
          adjustRecord: async () => ({ recordId: "inv_1", version: 2 }),
        },
        holds: {
          createHold: async () => ({ holdId: "hld_1", version: 1 }),
          releaseHold: async () => ({ holdId: "hld_1", version: 2 }),
        },
        storageLocations: {
          listStorageLocations: async () => [],
          createStorageLocation: async () => ({
            storageLocationId: "loc_1",
            version: 1,
          }),
          updateStorageLocation: async () => ({
            storageLocationId: "loc_1",
            version: 2,
          }),
        },
        projectors: [],
      } as unknown as ReturnType<typeof inventoryModule.createServices>,
      {
        resolveActor: async () => ({
          sessionId: "ses_1",
          tenantId: "tnt_identity",
          userId: "usr_1",
          accountId: "acc_1",
          membershipId: "mbr_1",
          roleKey: "owner",
          permissions: ["inventory.view", "inventory.manage"],
        }),
      },
    );

    const readResponse = await app.fetch(
      new Request("http://inventory.test/api/inventory/records"),
    );
    expect(readResponse.status).toBe(200);

    const writeResponse = await app.fetch(
      new Request("http://inventory.test/api/inventory/storage-locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "North shelf",
          shipFromCode: "CHI-WH-1",
        }),
      }),
    );
    expect(writeResponse.status).toBe(201);
  });
});
