import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { InventoryApiEnv } from "../../../api";
import { inventoryImportBatchRoutes } from "./route";
import type { InventoryImportBatchServices, InventoryImportBatchJob } from "./runtime";

describe("inventory import batch routes", () => {
  const authority: EventStoreContext = { tenantId: "tnt_synthetic", audit: {
    performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic",
  } };
  function privateApp(services: Partial<InventoryImportBatchServices>, context = authority) {
    const app = new Hono<InventoryApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: context.audit.forAccountId, permissions: ["inventory.manage"] });
      c.set("context", context);
      await next();
    });
    app.route("/", inventoryImportBatchRoutes(services as InventoryImportBatchServices));
    return app;
  }

  it.each(["account", "user", "tenant"])("issue-7169-c3-upload-recovery: %s mismatch hides both job and SSE", async (kind) => {
    const context = { ...authority, audit: { ...authority.audit } };
    if (kind === "account") context.audit.forAccountId = "acc_other";
    if (kind === "user") context.audit.performedByUserId = "usr_other";
    if (kind === "tenant") context.tenantId = "tnt_other";
    const job = { payload: { accountId: authority.audit.forAccountId }, eventContext: authority } as InventoryImportBatchJob;
    const listImportBatchJobEvents = vi.fn();
    const app = privateApp({ getImportBatchJob: async () => job, listImportBatchJobEvents }, context);
    expect((await app.request("/jobs/job_synthetic")).status).toBe(404);
    expect((await app.request("/jobs/job_synthetic/events")).status).toBe(404);
    expect(listImportBatchJobEvents).not.toHaveBeenCalled();
  });

  it("rejects malformed UTF-8 before calling the create owner", async () => {
    const enqueueCreateBatchJob = vi.fn();
    const form = new FormData();
    form.set("file", new File([new Uint8Array([0xc3, 0x28])], "private-synthetic.csv"));
    const response = await privateApp({ enqueueCreateBatchJob }).request("/", {
      method: "POST", body: form, headers: { "Inventory-Mutation-Attempt": "a7b08aac-e3b5-45d6-93c2-13a9139e92b6" },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-synthetic");
    expect(enqueueCreateBatchJob).not.toHaveBeenCalled();
  });

  it("forwards a bounded row page and refuses invalid pages", async () => {
    const getBatch = vi.fn(async () => ({ batch_id: "imb_synthetic", rows: [] }));
    const app = privateApp({ getBatch } as unknown as Partial<InventoryImportBatchServices>);
    expect((await app.request("/imb_synthetic?limit=100&offset=10000")).status).toBe(200);
    expect(getBatch).toHaveBeenCalledWith("imb_synthetic", "acc_synthetic", { limit: 100, offset: 10000 });
    expect((await app.request("/imb_synthetic?limit=101")).status).toBe(400);
    expect((await app.request("/imb_synthetic?offset=NaN")).status).toBe(400);
  });
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

  it("resolves a review row through the authenticated account", async () => {
    const resolveRow = vi.fn(async () => ({ batch_id: "imb_1", rows: [] }));
    const app = new Hono<InventoryApiEnv>();
    const context = {} as EventStoreContext;
    app.use("*", async (c, next) => {
      c.set("actor", {
        accountId: "acc_1",
        permissions: ["inventory.manage"],
      });
      c.set("context", context);
      await next();
    });
    app.route(
      "/",
      inventoryImportBatchRoutes({
        resolveRow,
      } as unknown as InventoryImportBatchServices),
    );

    const response = await app.request("/imb_1/rows/imr_1/resolve", {
      method: "POST",
      body: JSON.stringify({
        catalogItemId: "cat_active",
        selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
        storageLocationId: "loc_active",
      }),
      headers: {
        "content-type": "application/json",
      },
    });

    expect(response.status).toBe(200);
    expect(resolveRow).toHaveBeenCalledWith(
      {
        accountId: "acc_1",
        batchId: "imb_1",
        rowId: "imr_1",
        catalogItemId: "cat_active",
        selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
        storageLocationId: "loc_active",
      },
      context,
    );
  });
});
