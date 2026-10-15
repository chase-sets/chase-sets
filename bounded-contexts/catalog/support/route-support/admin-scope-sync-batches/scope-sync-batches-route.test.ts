import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "./scope-sync-batches-route";
import { heldSetExportContract } from "../../../features/scope-sync-batches/domain/held-set-export";
import { Hono } from "hono";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { scopeSyncBatchRoutes } from "../../../features/scope-sync-batches/api/route";
import {
  captureActor,
  captureAuthority,
  captureContext,
  captureScope,
  createCaptureLifecycleFixture,
} from "../../../features/scope-sync-batches/tests/count-capture-session-fixture";
import { createCatalogApiClient } from "../../shell-support/api/client";

const { api, createCatalogRequestApiClient } = vi.hoisted(() => {
  const api = {
    resolveHeldSetExport: vi.fn(),
    previewScopeSyncBatch: vi.fn(),
    quoteScopeSyncCounts: vi.fn(),
    acquireScopeSyncCounts: vi.fn(),
    confirmScopeSyncBatch: vi.fn(),
    cancelScopeSyncBatch: vi.fn(),
    resumeScopeSyncBatch: vi.fn(),
    retryScopeSyncBatchUnit: vi.fn(),
    captureScopeSyncCountBaseline: vi.fn(),
    captureScopeSyncCountInitialNotice: vi.fn(),
    captureScopeSyncCountUsage: vi.fn(),
  };
  return { api, createCatalogRequestApiClient: vi.fn(() => api) };
});

vi.mock("../../request-support/api-client", () => ({ createCatalogRequestApiClient }));

describe("Scope Sync Batch admin action callers", () => {
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

describe("count-capture intents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  const stagingAdmin = "https://admin.staging.chasesets.com";
  const captureForm = (entries: readonly (readonly [string, string])[]) =>
    runRequest(
      new Request(`${stagingAdmin}/catalog/scopes/sync-batches`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: stagingAdmin },
        body: new URLSearchParams(entries.map(([key, value]) => [key, value])),
      }),
    );
  const baselineFields = [
    ["intent", "capture-baseline"],
    ["countCapture", "1"],
    ["scopeRecordId", captureScope],
    ["authority", JSON.stringify(captureAuthority())],
  ] as const;

  it("reaches the real API handlers through the typed client", async () => {
    const f = createCaptureLifecycleFixture();
    const root = new Hono<{ Variables: { context: EventStoreContext; actor: ResolvedActor | null } }>();
    root.use("*", async (c, next) => {
      c.set("context", captureContext);
      c.set("actor", captureActor());
      await next();
    });
    root.route("/api/catalog/scope-sync-batches", scopeSyncBatchRoutes({} as never, f.lifecycle));
    const client = createCatalogApiClient({
      baseUrl: `${stagingAdmin}/api/catalog`,
      headers: { origin: stagingAdmin, "sec-fetch-site": "same-origin" },
      fetch: async (input, init) => root.request(input instanceof Request ? input : String(input), init),
    });
    const responses: Response[] = [];
    for (const entries of [
      baselineFields,
      [
        ["intent", "capture-initial-notice"],
        ["countCapture", "1"],
      ],
      [
        ["intent", "capture-usage"],
        ["countCapture", "1"],
      ],
    ] as const) {
      createCatalogRequestApiClient.mockReturnValueOnce(client as never);
      responses.push((await captureForm(entries)) as Response);
    }
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(responses.every((response) => response.headers.get("cache-control") === "no-store")).toBe(true);
    const [baseline, notice, usage] = await Promise.all(responses.map((response) => response.json()));
    expect(baseline).toMatchObject({ providerSends: 0, baseline: { selection: { scopeRecordId: captureScope } } });
    expect(notice).toMatchObject({ notice: { body: { kind: "initial" } } });
    expect(usage).toEqual({ usage: expect.objectContaining({ state: "skipped" }) });
    expect(f.memory.history.at(-1)?.payload).toMatchObject({
      status: "open",
      phases: ["baseline", "bootstrap"],
      request: null,
      notice: { fingerprint: notice.notice.fingerprint },
    });
    expect(f.usage.fetch).not.toHaveBeenCalled();
  });

  it("forwards each closed step to its typed client method", async () => {
    api.captureScopeSyncCountBaseline.mockResolvedValueOnce({ providerSends: 0 });
    api.captureScopeSyncCountInitialNotice.mockResolvedValueOnce({ notice: {} });
    api.captureScopeSyncCountUsage.mockResolvedValueOnce({ usage: {} });
    await captureForm(baselineFields);
    await captureForm([
      ["intent", "capture-initial-notice"],
      ["countCapture", "1"],
    ]);
    await captureForm([
      ["intent", "capture-usage"],
      ["countCapture", "1"],
    ]);
    expect(api.captureScopeSyncCountBaseline).toHaveBeenCalledExactlyOnceWith({
      scopeRecordId: captureScope,
      authority: captureAuthority(),
    });
    expect(api.captureScopeSyncCountInitialNotice).toHaveBeenCalledExactlyOnceWith();
    expect(api.captureScopeSyncCountUsage).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    [
      "a malformed marker",
      [
        ["intent", "capture-usage"],
        ["countCapture", "true"],
      ],
    ],
    [
      "an unknown capture intent",
      [
        ["intent", "count-quote"],
        ["countCapture", "1"],
      ],
    ],
    [
      "an extra field",
      [
        ["intent", "capture-usage"],
        ["countCapture", "1"],
        ["runId", "client-supplied"],
      ],
    ],
    [
      "a duplicate field",
      [
        ["intent", "capture-usage"],
        ["countCapture", "1"],
        ["countCapture", "1"],
      ],
    ],
    ["a missing field", baselineFields.filter(([key]) => key !== "authority")],
    ["an unparseable envelope", [...baselineFields.slice(0, 3), ["authority", "{"]]],
    [
      "an oversized envelope",
      [...baselineFields.slice(0, 3), ["authority", JSON.stringify({ x: "x".repeat(16_384) })]],
    ],
  ] as const)("refuses %s with one uncacheable capture-stopped", async (_name, entries) => {
    const response = (await captureForm(entries)) as Response;
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      preview: null,
      heldSetResolution: null,
      error: "capture-stopped",
    });
    expect(api.captureScopeSyncCountBaseline).not.toHaveBeenCalled();
    expect(api.captureScopeSyncCountUsage).not.toHaveBeenCalled();
    expect(api.quoteScopeSyncCounts).not.toHaveBeenCalled();
  });

  it.each(["capture-baseline", "capture-initial-notice", "capture-usage"])(
    "without the marker, %s behaves exactly as an unknown command did before",
    async (intent) => {
      await expect(runRequest(formRequest({ intent }))).resolves.toEqual({
        preview: null,
        heldSetResolution: null,
        error: "Batch id is required.",
      });
      expect(Object.values(api).every((method) => method.mock.calls.length === 0)).toBe(true);
    },
  );
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
