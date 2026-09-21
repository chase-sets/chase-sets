import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { scopeSyncBatchRoutes } from "./route";
import { ScopeSyncBatchStalePreviewError } from "../domain/batch";
import { heldSetExportContract } from "../domain/held-set-export";

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
  it("resolves one closed multipart file without logging or retaining its body", async () => {
    const resolveHeldSets = vi.fn().mockResolvedValue({ resolved: [], unresolved: [], totals: {} });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const form = new FormData();
    form.set("file", new File(["Product Line,Set Name\nMagic,Time Spiral"], "held.csv", { type: "text/csv" }));

    const response = await app({ resolveHeldSets }).request("/resolve-held-sets", { method: "POST", body: form });

    expect(response.status).toBe(200);
    expect(resolveHeldSets).toHaveBeenCalledWith({ bytes: expect.any(Uint8Array), context });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it("refuses declared oversize and unknown multipart fields before resolution", async () => {
    const resolveHeldSets = vi.fn();
    const oversize = await app({ resolveHeldSets }).request("/resolve-held-sets", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=bounded",
        "content-length": "18874369",
      },
      body: "",
    });
    expect(oversize.status).toBe(413);

    const form = new FormData();
    form.set("file", new File(["Product Line,Set Name\nMagic,Time Spiral"], "held.csv"));
    form.set("metadata", JSON.stringify({ nested: { unknown: true } }));
    const unknown = await app({ resolveHeldSets }).request("/resolve-held-sets", { method: "POST", body: form });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "invalid-upload" } });
    expect(resolveHeldSets).not.toHaveBeenCalled();
  });

  it("accepts an exact 16777216-byte counted file stream", async () => {
    const resolveHeldSets = vi.fn().mockResolvedValue({ resolved: [], unresolved: [], totals: {} });
    const counted = countedFileRequest("http://local/resolve-held-sets", [
      new Uint8Array(heldSetExportContract.maxBytes),
      multipartFooter,
    ]);

    const response = await app({ resolveHeldSets }).request(counted.request);

    expect(response.status).toBe(200);
    expect(resolveHeldSets).toHaveBeenCalledOnce();
    expect(resolveHeldSets.mock.calls[0]![0].bytes).toHaveLength(heldSetExportContract.maxBytes);
    expect(counted.cancelled()).toBe(false);
  });

  it("cancels on file byte 16777217 before another read or resolution", async () => {
    const resolveHeldSets = vi.fn();
    const counted = countedFileRequest("http://local/resolve-held-sets", [
      new Uint8Array(heldSetExportContract.maxBytes),
      concatBytes(new Uint8Array([120]), multipartFooter),
      new Uint8Array([99]),
    ]);

    const response = await app({ resolveHeldSets }).request(counted.request);

    expect(response.status).toBe(413);
    expect(counted.emitted()).toBe(3);
    expect(counted.cancelled()).toBe(true);
    expect(resolveHeldSets).not.toHaveBeenCalled();
  });

  it("bounds an undeclared endless upload stream before resolution", async () => {
    const resolveHeldSets = vi.fn();
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
    const request = new Request("http://local/resolve-held-sets", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=bounded" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await app({ resolveHeldSets }).request(request);
    expect(response.status).toBe(413);
    expect(pulls).toBeLessThanOrEqual(19);
    expect(cancelled).toBe(true);
    expect(resolveHeldSets).not.toHaveBeenCalled();
  });

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

const multipartPrefix = new TextEncoder().encode(
  '--bounded\r\nContent-Disposition: form-data; name="file"; filename="held.csv"\r\nContent-Type: text/csv\r\n\r\n',
);
const multipartFooter = new TextEncoder().encode("\r\n--bounded--\r\n");

function countedFileRequest(url: string, fileAndFooterChunks: readonly Uint8Array[]) {
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
  return {
    request: new Request(url, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=bounded" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
    emitted: () => emitted,
    cancelled: () => wasCancelled,
  };
}

function concatBytes(left: Uint8Array, right: Uint8Array) {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}
