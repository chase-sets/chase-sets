import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "./scope-sync-batches-route";
import { heldSetExportContract } from "../../../features/scope-sync-batches/domain/held-set-export";

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

  it("accepts an exact 16777216-byte counted file stream", async () => {
    const resolution = { resolved: [], unresolved: [], totals: { rows: 0 } };
    api.resolveHeldSetExport.mockResolvedValue(resolution);
    const counted = countedAdminRequest([new Uint8Array(heldSetExportContract.maxBytes), multipartFooter]);

    await expect(runRequest(counted.request)).resolves.toEqual({
      heldSetResolution: resolution,
      preview: null,
      error: null,
    });
    expect(api.resolveHeldSetExport).toHaveBeenCalledOnce();
    expect(api.resolveHeldSetExport.mock.calls[0]![0]).toBeInstanceOf(File);
    expect((api.resolveHeldSetExport.mock.calls[0]![0] as File).size).toBe(heldSetExportContract.maxBytes);
    expect(counted.cancelled()).toBe(false);
  });

  it("cancels on file byte 16777217 before another read or API entry", async () => {
    const counted = countedAdminRequest([
      new Uint8Array(heldSetExportContract.maxBytes),
      concatBytes(new Uint8Array([120]), multipartFooter),
      new Uint8Array([99]),
    ]);

    await expect(runRequest(counted.request)).resolves.toMatchObject({
      heldSetResolution: null,
      preview: null,
      error: "Held-set export exceeds 16777216 bytes.",
    });
    expect(counted.emitted()).toBe(3);
    expect(counted.cancelled()).toBe(true);
    expect(api.resolveHeldSetExport).not.toHaveBeenCalled();
  });

  it("cancels an undeclared endless multipart stream before API entry", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(pulls === 1 ? multipartPrefix : new Uint8Array(1_048_576));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const request = multipartRequest(body);

    await expect(runRequest(request)).resolves.toMatchObject({
      heldSetResolution: null,
      preview: null,
      error: expect.stringContaining("exceeds"),
    });
    expect(pulls).toBeLessThanOrEqual(19);
    expect(cancelled).toBe(true);
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
  return runRequest(request);
}

function runRequest(request: Request) {
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

const multipartPrefix = new TextEncoder().encode(
  '--bounded\r\nContent-Disposition: form-data; name="intent"\r\n\r\nresolve-held-sets\r\n--bounded\r\nContent-Disposition: form-data; name="file"; filename="held.csv"\r\nContent-Type: text/csv\r\n\r\n',
);
const multipartFooter = new TextEncoder().encode("\r\n--bounded--\r\n");

function countedAdminRequest(fileAndFooterChunks: readonly Uint8Array[]) {
  const chunks = [multipartPrefix, ...fileAndFooterChunks];
  let emitted = 0;
  let wasCancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[emitted];
        if (!chunk) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        wasCancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { request: multipartRequest(body), emitted: () => emitted, cancelled: () => wasCancelled };
}

function multipartRequest(body: ReadableStream<Uint8Array>) {
  return new Request("http://admin.test/catalog/scopes/sync-batches", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=bounded" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function concatBytes(left: Uint8Array, right: Uint8Array) {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}
