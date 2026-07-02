import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { InventoryApiEnv } from "../../../api";
import { inventoryImportBatchRoutes } from "./route";
import type { InventoryImportBatchServices } from "./runtime";

describe("inventory import batch routes", () => {
  it("downloads the account native CSV template as an attachment", async () => {
    const getNativeCsvTemplate = vi.fn(async () => "catalogItemId,storageLocationId\ncat_example,loc_1");
    const getNativeCsvExport = vi.fn();
    const app = new Hono<InventoryApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        accountId: "acc_1",
        permissions: ["inventory.view"],
      });
      c.set("context", {} as EventStoreContext);
      await next();
    });
    app.route(
      "/",
      inventoryImportBatchRoutes({
        getNativeCsvTemplate,
        getNativeCsvExport,
      } as unknown as InventoryImportBatchServices),
    );

    const response = await app.request("/templates/native-csv");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="chase-sets-native-inventory-template.csv"',
    );
    expect(await response.text()).toContain("loc_1");
    expect(getNativeCsvTemplate).toHaveBeenCalledWith({ accountId: "acc_1" });
  });

  it("downloads the account current inventory native CSV export as an attachment", async () => {
    const getNativeCsvExport = vi.fn(async () => "catalogItemId,storageLocationId,totalQuantity\ncat_1,loc_1,4");
    const app = new Hono<InventoryApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        accountId: "acc_1",
        permissions: ["inventory.view"],
      });
      c.set("context", {} as EventStoreContext);
      await next();
    });
    app.route(
      "/",
      inventoryImportBatchRoutes({
        getNativeCsvExport,
      } as unknown as InventoryImportBatchServices),
    );

    const response = await app.request("/exports/native-csv");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="chase-sets-native-inventory-export.csv"',
    );
    expect(await response.text()).toContain("cat_1");
    expect(getNativeCsvExport).toHaveBeenCalledWith({ accountId: "acc_1" });
  });
});
