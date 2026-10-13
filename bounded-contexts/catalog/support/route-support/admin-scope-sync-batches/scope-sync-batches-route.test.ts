import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "./scope-sync-batches-route";
import { heldSetExportContract } from "../../../features/scope-sync-batches/domain/held-set-export";

const { api, createCatalogRequestApiClient } = vi.hoisted(() => {
  const api = {
    resolveHeldSetExport: vi.fn(),
    previewScopeSyncBatch: vi.fn(),
    captureScopeSyncBatchPreview: vi.fn(),
    readScopeSyncBatchPreConfirm: vi.fn(),
    quoteScopeSyncCounts: vi.fn(),
    acquireScopeSyncCounts: vi.fn(),
    confirmScopeSyncBatch: vi.fn(),
    cancelScopeSyncBatch: vi.fn(),
    resumeScopeSyncBatch: vi.fn(),
    retryScopeSyncBatchUnit: vi.fn(),
  };
  return { api, createCatalogRequestApiClient: vi.fn(() => api) };
});

vi.mock("../../request-support/api-client", () => ({ createCatalogRequestApiClient }));

describe("Scope Sync Batch admin action callers", () => {
  it("forwards an explicit capture preview through the ordinary Admin form without falling back", async () => {
    api.captureScopeSyncBatchPreview.mockResolvedValue({ planFingerprint: "a".repeat(64) });
    const response = await runRequest(
      formRequest({
        intent: "preview",
        countCapture: "1",
        selectionMode: "ids",
        scopeRecordIds: "synthetic-op01",
      }),
    );
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("cache-control")).toBe("no-store");
    expect(await (response as Response).json()).toMatchObject({ preview: { planFingerprint: "a".repeat(64) } });
    expect(api.captureScopeSyncBatchPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: { mode: "ids", scopeRecordIds: ["synthetic-op01"] },
      }),
    );
    expect(api.previewScopeSyncBatch).not.toHaveBeenCalled();
    expect(api.confirmScopeSyncBatch).not.toHaveBeenCalled();
  });
  it("forwards pre-confirm observation with the original fingerprint and no confirmation capability", async () => {
    const observation = { currentFingerprint: "a".repeat(64), eligible: true, effectsCapability: false };
    api.readScopeSyncBatchPreConfirm.mockResolvedValue(observation);
    const response = await runRequest(
      formRequest({
        intent: "pre-confirm-planner-read",
        countCapture: "1",
        selectionMode: "ids",
        scopeRecordIds: "synthetic-op01",
        planFingerprint: "a".repeat(64),
      }),
    );
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("cache-control")).toBe("no-store");
    expect(await (response as Response).json()).toMatchObject({ capturePreConfirm: observation });
    expect(api.readScopeSyncBatchPreConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        planFingerprint: "a".repeat(64),
        selection: { mode: "ids", scopeRecordIds: ["synthetic-op01"] },
      }),
    );
    expect(api.confirmScopeSyncBatch).not.toHaveBeenCalled();
    expect(api.previewScopeSyncBatch).not.toHaveBeenCalled();
  });
  it.each(["confirm", "cancel", "resume", "retry-unit", "count-quote", "count-acquire"])(
    "refuses capture-marked %s until its own lifecycle boundary is composed",
    async (intent) => {
      const response = await runRequest(formRequest({ intent, countCapture: "1", batchId: "synthetic" }));
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(409);
      expect((response as Response).headers.get("cache-control")).toBe("no-store");
      expect(await (response as Response).json()).toMatchObject({ error: "capture-stopped" });
      for (const method of Object.values(api)) expect(method).not.toHaveBeenCalled();
    },
  );
  it.each(["", "0", "true", "synthetic-run"])("refuses invalid capture marker %j without API work", async (marker) => {
    const response = await runRequest(formRequest({ intent: "preview", countCapture: marker }));
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(409);
    for (const method of Object.values(api)) expect(method).not.toHaveBeenCalled();
  });
  it("does not reflect captured API failures and never retries through ordinary preview", async () => {
    api.captureScopeSyncBatchPreview.mockRejectedValueOnce(new Error("synthetic-private-marker"));
    const response = await runRequest(formRequest({ intent: "preview", countCapture: "1" }));
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(409);
    expect(await (response as Response).text()).not.toContain("synthetic-private-marker");
    expect(api.captureScopeSyncBatchPreview).toHaveBeenCalledOnce();
    expect(api.previewScopeSyncBatch).not.toHaveBeenCalled();
  });
  it("refuses an unmarked pre-confirm or duplicate marker before API work", async () => {
    for (const body of ["intent=pre-confirm-planner-read", "intent=preview&countCapture=1&countCapture=1"]) {
      const response = await runRequest(
        new Request("http://admin.test/catalog/scopes/sync-batches", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        }),
      );
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(409);
      expect((response as Response).headers.get("cache-control")).toBe("no-store");
    }
    for (const method of Object.values(api)) expect(method).not.toHaveBeenCalled();
  });
  it.each(["ids", "matching-scope"])(
    "AC1 forwards %s/held-set selection to an I/O-free count quote, not confirmation",
    async (mode) => {
      api.quoteScopeSyncCounts.mockResolvedValue({ plannedCredits: 2, cap: 1 });
      const form = new FormData();
      form.set("intent", "count-quote");
      form.set("selectionMode", mode);
      form.set("scopeRecordIds", "scope-b,scope-a");
      form.set("productDomain", "one-piece");
      form.set("scopeKind", "set");
      form.set("languageCode", "en");
      form.set("countCap", "1");
      await expect(
        runRequest(formRequest(Object.fromEntries(form.entries()) as Record<string, string>)),
      ).resolves.toMatchObject({ countQuote: { plannedCredits: 2, cap: 1 } });
      expect(api.quoteScopeSyncCounts).toHaveBeenCalledWith({
        cap: 1,
        selection:
          mode === "ids"
            ? { mode, scopeRecordIds: ["scope-b", "scope-a"] }
            : { mode, query: { productDomain: "one-piece", scopeKind: "set", languageCode: "en" } },
      });
      expect(api.confirmScopeSyncBatch).not.toHaveBeenCalled();
      expect(api.previewScopeSyncBatch).not.toHaveBeenCalled();
    },
  );
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
