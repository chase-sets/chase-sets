import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { scopeSyncBatchRoutes } from "./route";
import { createScopeSyncCountRuntime } from "./count-runtime";
import { ScopeSyncBatchStalePreviewError } from "../domain/batch";
import { heldSetExportContract } from "../domain/held-set-export";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { CountCaptureStopped } from "../../source-observations/api/providers/count-capture-transport";
import type { CountCaptureLifecycle } from "./count-capture-lifecycle";

const context: EventStoreContext = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
};
function countActor(roleKey: string): ResolvedActor {
  return {
    roleKey,
    permissions: ["catalog.manage", "catalog.view"],
    sessionId: "synthetic-session",
    tenantId: "tnt_test",
    userId: "usr_test",
    accountId: "acc_test",
    membershipId: "synthetic-membership",
  };
}

function app(services: Record<string, unknown>, actor?: ResolvedActor) {
  const routes = scopeSyncBatchRoutes(services as never);
  const root = new Hono<{ Variables: { context: EventStoreContext; actor: ResolvedActor | null } }>();
  root.use("*", async (c, next) => {
    c.set("context", context);
    c.set("actor", actor ?? null);
    await next();
  });
  root.route("/", routes);
  return root;
}

describe("Scope Sync Batch routes", () => {
  it("AC1 refuses missing Admin authority and cross-origin count approval without a send", async () => {
    const acquireCounts = vi.fn();
    const body = JSON.stringify({ quoteId: "00000000-0000-4000-8000-000000000001", fingerprint: "a".repeat(64) });
    const missing = await app({ acquireCounts }).request("/counts/acquire", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body,
    });
    expect(missing.status).toBe(401);
    const unauthorized = await app({ acquireCounts }, countActor("seller")).request("/counts/acquire", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body,
    });
    expect(unauthorized.status).toBe(403);
    const admin = countActor("platform-admin");
    const foreign = await app({ acquireCounts }, admin).request("/counts/acquire", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://foreign.invalid" },
      body,
    });
    expect(foreign.status).toBe(403);
    expect(acquireCounts).not.toHaveBeenCalled();
  });
  it("AC1 only a same-origin Admin can execute an exact count approval", async () => {
    const acquireCounts = vi.fn(async () => ({ state: "complete" }));
    const body = { quoteId: "00000000-0000-4000-8000-000000000001", fingerprint: "a".repeat(64) };
    const response = await app({ acquireCounts }, countActor("platform-admin")).request("/counts/acquire", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(acquireCounts).toHaveBeenCalledWith({ ...body, context });
  });
  it("forwards only the closed whole-quote admission and the opt-in preparation read", async () => {
    const acquireCounts = vi.fn(async () => ({ state: "complete" }));
    const getCountQuote = vi.fn(async () => ({ state: "quoted" }));
    const admin = app({ acquireCounts, getCountQuote }, countActor("platform-admin"));
    const body = { quoteId: "00000000-0000-4000-8000-000000000001", fingerprint: "a".repeat(64) };
    const post = (value: unknown) =>
      admin.request("/counts/acquire", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify(value),
      });
    expect((await post({ ...body, admission: "whole-quote" })).status).toBe(200);
    expect(acquireCounts).toHaveBeenCalledExactlyOnceWith({ ...body, admission: "whole-quote", context });
    for (const admission of ["partial", "WHOLE-QUOTE", null, true])
      expect((await post({ ...body, admission })).status, String(admission)).toBe(400);
    expect(acquireCounts).toHaveBeenCalledOnce();

    expect((await admin.request(`/counts/quote/${body.quoteId}`)).status).toBe(200);
    expect((await admin.request(`/counts/quote/${body.quoteId}?view=preparation`)).status).toBe(200);
    expect(getCountQuote.mock.calls).toEqual([
      [{ quoteId: body.quoteId, context }],
      [{ quoteId: body.quoteId, view: "preparation", context }],
    ]);
    for (const query of ["view=debits", "view=preparation&page=2", "cursor=1"])
      expect((await admin.request(`/counts/quote/${body.quoteId}?${query}`)).status, query).toBe(400);
    expect(getCountQuote).toHaveBeenCalledTimes(2);
  });
  it("serves the preparation read only in staging through the count runtime", async () => {
    const quoteId = "00000000-0000-4000-8000-000000000001";
    const quote = { quoteId, state: "quoted" };
    const counts = (environment: string) => {
      const store = {
        loadQuote: vi.fn(async () => quote),
        retainedQuote: vi.fn(async () => quote),
        preparationView: vi.fn(async () => ({ ...quote, view: "preparation" })),
      };
      const runtime = createScopeSyncCountRuntime({
        pool: {} as never,
        store: store as never,
        environment,
        accountRevision: "runtime",
        profiles: {} as never,
        adapterOptions: {},
      });
      return { store, admin: app(runtime, countActor("platform-admin")) };
    };

    const staging = counts("staging");
    const prepared = await staging.admin.request(`/counts/quote/${quoteId}?view=preparation`);
    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toEqual({ ...quote, view: "preparation" });
    expect(staging.store.preparationView).toHaveBeenCalledExactlyOnceWith(quote);

    for (const environment of ["production", "test", "local", "", "Staging"]) {
      const f = counts(environment);
      const refused = await f.admin.request(`/counts/quote/${quoteId}?view=preparation`);
      expect(refused.status, environment).toBe(409);
      expect(await refused.json(), environment).toMatchObject({ error: { code: "count-acquisition-refused" } });
      expect(f.store.loadQuote, environment).not.toHaveBeenCalled();
      expect(f.store.preparationView, environment).not.toHaveBeenCalled();
    }

    const production = counts("production");
    const ordinary = await production.admin.request(`/counts/quote/${quoteId}`);
    expect(ordinary.status).toBe(200);
    expect(await ordinary.json()).toEqual(quote);
    expect(production.store.retainedQuote).toHaveBeenCalledExactlyOnceWith(quote);
    expect(production.store.preparationView).not.toHaveBeenCalled();
  });
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

describe("count-capture steps", () => {
  const stagingAdmin = "https://admin.staging.chasesets.com";
  const base = `${stagingAdmin}/scope-sync-batches`;
  function captureApp(
    capture: Readonly<Record<keyof CountCaptureLifecycle, unknown>> | null,
    actor: ResolvedActor | null = countActor("platform-admin"),
  ) {
    const root = new Hono<{ Variables: { context: EventStoreContext; actor: ResolvedActor | null } }>();
    root.use("*", async (c, next) => {
      c.set("context", context);
      c.set("actor", actor);
      await next();
    });
    root.route("/scope-sync-batches", scopeSyncBatchRoutes({} as never, capture as CountCaptureLifecycle | null));
    return root;
  }
  const lifecycle = () => ({
    baseline: vi.fn(async () => ({ providerSends: 0 })),
    initialNotice: vi.fn(async () => ({ notice: { fingerprint: "a".repeat(64) } })),
    usage: vi.fn(async () => ({ usage: { state: "skipped" } })),
  });
  const post = (
    root: ReturnType<typeof captureApp>,
    path: string,
    body: unknown,
    headers: Record<string, string> = { "x-catalog-count-capture": "1" },
  ) =>
    root.request(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: stagingAdmin, ...headers },
      body: JSON.stringify(body),
    });
  const baselineBody = { scopeRecordId: "scope-synthetic-op01", authority: { dispatchId: "synthetic-dispatch" } };

  it("reaches each handler with the authenticated session, uncacheable", async () => {
    const capture = lifecycle();
    const root = captureApp(capture);
    const responses = [
      await post(root, "/count-capture/baseline", baselineBody),
      await post(root, "/count-capture/initial-notice", {}),
      await post(root, "/count-capture/usage", {}),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(responses.every((response) => response.headers.get("cache-control") === "no-store")).toBe(true);
    await expect(responses[0]!.json()).resolves.toEqual({ providerSends: 0 });
    const session = expect.objectContaining({
      actor: countActor("platform-admin"),
      context,
      request: expect.any(Request),
    });
    expect(capture.baseline).toHaveBeenCalledExactlyOnceWith(session, baselineBody);
    expect(capture.initialNotice).toHaveBeenCalledExactlyOnceWith(session);
    expect(capture.usage).toHaveBeenCalledExactlyOnceWith(session);
  });

  it("leaves unmarked capture paths unrouted, exactly as before", async () => {
    const capture = lifecycle();
    const root = captureApp(capture);
    const unrouted = await root.request(`${base}/not-a-route/at-all`, { method: "POST" });
    for (const path of ["/count-capture/baseline", "/count-capture/initial-notice", "/count-capture/usage"]) {
      const response = await post(root, path, path.endsWith("baseline") ? baselineBody : {}, {});
      expect(response.status).toBe(unrouted.status);
      expect(await response.text()).toBe(await unrouted.clone().text());
    }
    expect(unrouted.status).toBe(404);
    expect(Object.values(capture).every((handler) => handler.mock.calls.length === 0)).toBe(true);
  });

  const refusals: Record<string, Readonly<{ headers?: Record<string, string>; body: unknown }>> = {
    "a malformed marker": { headers: { "x-catalog-count-capture": "true" }, body: baselineBody },
    "an absent capture composition": { body: baselineBody },
    "an open body": { body: { ...baselineBody, runId: "client-supplied" } },
    "a handler refusal": { body: baselineBody },
  };
  it.each(Object.keys(refusals))("refuses %s with one support-safe 409", async (name) => {
    const { headers, body } = refusals[name]!;
    const capture = lifecycle();
    if (name === "a handler refusal") capture.baseline.mockRejectedValueOnce(new CountCaptureStopped());
    const root = captureApp(name === "an absent capture composition" ? null : capture);
    const response = await post(root, "/count-capture/baseline", body, headers);
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: { code: "capture-stopped" } });
    if (name !== "a handler refusal") expect(capture.baseline).not.toHaveBeenCalled();
  });

  it("mirrors the count access guard before any handler runs", async () => {
    const capture = lifecycle();
    expect((await post(captureApp(capture, null), "/count-capture/usage", {})).status).toBe(401);
    expect((await post(captureApp(capture, countActor("seller")), "/count-capture/usage", {})).status).toBe(403);
    const foreign = await post(
      captureApp(capture),
      "/count-capture/usage",
      {},
      {
        "x-catalog-count-capture": "1",
        origin: "https://foreign.invalid",
      },
    );
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("cache-control")).toBe("no-store");
    expect(capture.usage).not.toHaveBeenCalled();
  });
});
