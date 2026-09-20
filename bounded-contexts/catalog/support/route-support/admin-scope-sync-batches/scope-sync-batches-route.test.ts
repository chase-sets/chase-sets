import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "./scope-sync-batches-route";

const { api, createCatalogRequestApiClient } = vi.hoisted(() => {
  const api = {
    resolveHeldSetExport: vi.fn(),
    previewScopeSyncBatch: vi.fn(),
    confirmScopeSyncBatch: vi.fn(),
    cancelScopeSyncBatch: vi.fn(),
    resumeScopeSyncBatch: vi.fn(),
    retryScopeSyncBatchUnit: vi.fn(),
  };
  return { api, createCatalogRequestApiClient: vi.fn(() => api) };
});

vi.mock("../../request-support/api-client", () => ({ createCatalogRequestApiClient }));

describe("Scope Sync Batch admin action callers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards only the bounded held-set file to the authenticated Catalog API", async () => {
    const resolution = { resolved: [], unresolved: [], totals: { rows: 0 } };
    api.resolveHeldSetExport.mockResolvedValue(resolution);
    const form = new FormData();
    form.set("intent", "resolve-held-sets");
    form.set("file", new File(["Product Line,Set Name\nMagic,Time Spiral"], "held.csv"));

    await expect(run(form)).resolves.toEqual({ heldSetResolution: resolution, preview: null, error: null });
    expect(api.resolveHeldSetExport).toHaveBeenCalledWith(expect.any(File));
  });

  it("closes the held-set form and refuses nested unknown fields before forwarding", async () => {
    const form = new FormData();
    form.set("intent", "resolve-held-sets");
    form.set("file", new File(["Product Line,Set Name"], "held.csv"));
    form.set("metadata", JSON.stringify({ nested: { unknown: true } }));

    await expect(run(form)).resolves.toMatchObject({
      heldSetResolution: null,
      preview: null,
      error: "Held-set upload contains unsupported fields.",
    });
    expect(api.resolveHeldSetExport).not.toHaveBeenCalled();
  });

  it("keeps preview and confirmation on the existing explicit-id path", async () => {
    api.previewScopeSyncBatch.mockResolvedValue({ planFingerprint: "fingerprint" });
    const preview = await action({
      request: formRequest({ intent: "preview", selectionMode: "ids", scopeRecordIds: "scope-1,scope-2" }),
      params: {},
      context: {},
      url: new URL("http://admin.test/catalog/scopes/sync-batches"),
      pattern: "/catalog/scopes/sync-batches",
    });
    expect(preview).toMatchObject({
      preview: { planFingerprint: "fingerprint" },
      heldSetResolution: null,
      error: null,
    });
    expect(api.previewScopeSyncBatch).toHaveBeenCalledWith(
      expect.objectContaining({ selection: { mode: "ids", scopeRecordIds: ["scope-1", "scope-2"] } }),
    );

    api.confirmScopeSyncBatch.mockResolvedValue({ batchId: "batch-1" });
    const confirm = await action({
      request: formRequest({
        intent: "confirm",
        selectionMode: "ids",
        scopeRecordIds: "scope-1,scope-2",
        planFingerprint: "fingerprint",
      }),
      params: {},
      context: {},
      url: new URL("http://admin.test/catalog/scopes/sync-batches"),
      pattern: "/catalog/scopes/sync-batches",
    });
    expect(confirm).toBeInstanceOf(Response);
    expect((confirm as Response).status).toBe(302);
    expect(api.confirmScopeSyncBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: { mode: "ids", scopeRecordIds: ["scope-1", "scope-2"] },
        planFingerprint: "fingerprint",
      }),
    );
  });

  it.each([
    ["cancel", "cancelScopeSyncBatch"],
    ["resume", "resumeScopeSyncBatch"],
  ] as const)("preserves the %s caller", async (intent, method) => {
    const request = formRequest({ intent, batchId: "batch-1" });
    const result = await action({
      request,
      params: {},
      context: {},
      url: new URL(request.url),
      pattern: "/catalog/scopes/sync-batches",
    });
    expect(result).toBeInstanceOf(Response);
    expect(api[method]).toHaveBeenCalledWith("batch-1");
  });

  it("preserves the failed-unit retry caller", async () => {
    const result = await action({
      request: formRequest({ intent: "retry-unit", batchId: "batch-1", scopeRecordId: "scope-1" }),
      params: {},
      context: {},
      url: new URL("http://admin.test/catalog/scopes/sync-batches"),
      pattern: "/catalog/scopes/sync-batches",
    });
    expect(result).toBeInstanceOf(Response);
    expect(api.retryScopeSyncBatchUnit).toHaveBeenCalledWith("batch-1", "scope-1");
  });
});

function run(form: FormData) {
  const request = new Request("http://admin.test/catalog/scopes/sync-batches", { method: "POST", body: form });
  return action({
    request,
    params: {},
    context: {},
    url: new URL(request.url),
    pattern: "/catalog/scopes/sync-batches",
  });
}

function formRequest(values: Readonly<Record<string, string>>): Request {
  return new Request("http://admin.test/catalog/scopes/sync-batches", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
}
