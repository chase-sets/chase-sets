import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { scopeSyncBatchRoutes } from "./route";
import { ScopeSyncBatchStalePreviewError } from "../domain/batch";

const context: EventStoreContext = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
};

function app(services: Record<string, unknown>) {
  const routes = scopeSyncBatchRoutes(services as never);
  const root = new Hono<{ Variables: { context: EventStoreContext } }>();
  root.use("*", async (c, next) => {
    c.set("context", context);
    await next();
  });
  root.route("/", routes);
  return root;
}

describe("Scope Sync Batch routes", () => {
  it("previews server-resolved matching scope without browser pagination", async () => {
    const preview = vi.fn().mockResolvedValue({ status: "ready", planFingerprint: "fingerprint" });
    const response = await app({ preview }).request("/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: { mode: "matching-scope", query: { productDomain: "pokemon" } } }),
    });
    expect(response.status).toBe(200);
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({ context, selection: { mode: "matching-scope", query: expect.any(Object) } }),
    );
  });

  it("fails confirm closed with the current preview when evidence is stale", async () => {
    const currentPreview = { planFingerprint: "current", confirmAllowed: true } as never;
    const confirm = vi.fn().mockRejectedValue(new ScopeSyncBatchStalePreviewError(currentPreview));
    const response = await app({ confirm }).request("/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: { mode: "ids", scopeRecordIds: ["scope-1"] }, planFingerprint: "old" }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "scope_sync_batch_stale_preview" },
      currentPreview: { planFingerprint: "current" },
    });
  });

  it("exposes cancel, resume, and failed-unit retry snapshots", async () => {
    const cancel = vi.fn().mockResolvedValue({ batchId: "batch-1", status: "cancelled" });
    const resume = vi.fn().mockResolvedValue({ batchId: "batch-1", status: "queued" });
    const retryUnit = vi.fn().mockResolvedValue({ batchId: "batch-1", status: "queued" });
    const routes = app({ cancel, resume, retryUnit });
    expect((await routes.request("/batch-1/cancel", { method: "POST" })).status).toBe(200);
    expect((await routes.request("/batch-1/resume", { method: "POST" })).status).toBe(200);
    expect((await routes.request("/batch-1/units/scope-1/retry", { method: "POST" })).status).toBe(200);
    expect(retryUnit).toHaveBeenCalledWith(expect.objectContaining({ scopeRecordId: "scope-1" }));
  });
});
