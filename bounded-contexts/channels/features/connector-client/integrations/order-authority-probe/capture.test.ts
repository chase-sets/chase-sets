import { createHash, webcrypto } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const source = path.dirname(fileURLToPath(import.meta.url));
// The preparation CLI is JavaScript, loaded exactly as its operator entrypoint.
const packaging = await import(new URL("./package.mjs", import.meta.url).href);
const scratch = path.resolve(source, "../../../../../../artifacts/8838/tests");
const SENTINEL = "SYNTHETIC_PII_SENTINEL_8838";
const ORDER = `${SENTINEL}/order ?#`;
const lookup = { seller: { sellerKey: `${SENTINEL}_seller` }, [SENTINEL]: { cookie: SENTINEL } };
const BUCKETS = ["Shipped - In Transit", "Shipped - Delivered", "Completed - Paid", "Canceled"];
const list = {
  totalOrders: 1,
  orders: [{ orderNumber: ORDER, buyerName: SENTINEL, orderStatus: "Ready to Ship", orderDate: "2029-12-31" }],
};
const detail = {
  orderNumber: ORDER,
  status: "Shipped - In Transit",
  buyerName: SENTINEL,
  shippingAddress: { recipientName: SENTINEL, [SENTINEL]: SENTINEL },
  products: [{ name: SENTINEL, [SENTINEL]: SENTINEL }],
  [SENTINEL]: SENTINEL,
};
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => JSON.stringify(value);
type Kind = "lookup" | "list" | "detail";
type Reply = { ok: boolean; code?: string; receipt?: Record<string, unknown> };
type Sender = { id: string; url: string; origin: string; frameId: number };
type Listener = (message: unknown, sender: Sender, respond: (reply: Reply) => void) => boolean;
type Observation = { kind: Kind; url: string; options: RequestInit; at: number };
type Fixture = {
  body?: string;
  status?: number;
  contentType?: string;
  opaque?: boolean;
  stall?: boolean;
  endless?: boolean;
  error?: boolean;
};

let out: string;
let preparation: {
  extensionId: string;
  head: string;
  packageDirectory: string;
  profileDirectory: string;
  launchCommand: string;
};
let server: Server;
let loopback: string;
const fixtures = new Map<string, Fixture>();
const wire: { host?: string; cookie?: string; authorization?: string; marker?: string }[] = [];
let fixtureSequence = 0;

beforeAll(async () => {
  mkdirSync(scratch, { recursive: true });
  const parent = mkdtempSync(path.join(scratch, "synthetic-emitted-"));
  out = path.join(parent, "run");
  preparation = packaging.prepare({ out, cadenceMs: 1, cadenceSource: packaging.AUTHORITY, synthetic: true });
  server = createServer((request, response) => {
    wire.push({
      host: request.headers.host,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      marker: request.headers["x-synthetic-transport"] as string | undefined,
    });
    const fixture = fixtures.get(request.url ?? "");
    if (!fixture) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(fixture.status ?? 200, { "Content-Type": fixture.contentType ?? "application/json" });
    response.end(fixture.body ?? "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("synthetic loopback unavailable");
  loopback = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

function harness(
  options: {
    storage?: Record<string, unknown>;
    cadenceMs?: number;
    config?: Record<string, unknown>;
    responses?: Partial<Record<Kind, Fixture | Fixture[]>>;
    tamper?: string;
    missing?: string;
    workerSource?: string;
  } = {},
) {
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  let listener: Listener;
  const storage = options.storage ?? {};
  const retained: unknown[] = [];
  const observations: Observation[] = [];
  const timers = new Map<number, () => void>();
  const origin = `chrome-extension://${preparation.extensionId}`;
  const sender = { id: preparation.extensionId, url: `${origin}/capture.html`, origin, frameId: 0 };
  const config = JSON.parse(readFileSync(path.join(preparation.packageDirectory, "capture-config.json"), "utf8"));
  if (options.cadenceMs !== undefined) config.cadenceMs = options.cadenceMs;
  Object.assign(config, options.config);
  let timerSequence = 0;
  const chrome = {
    runtime: {
      id: preparation.extensionId,
      getURL: (file: string) => `${origin}/${file}`,
      onMessage: {
        addListener: (candidate: Listener) => {
          listener = candidate;
        },
      },
    },
    storage: {
      local: {
        setAccessLevel: async (value: unknown) => {
          retained.push(structuredClone(value));
        },
        get: async () => structuredClone(storage),
        set: async (value: Record<string, unknown>) => {
          Object.assign(storage, structuredClone(value));
          retained.push(structuredClone(value));
        },
      },
    },
  };
  const localFetch = async (target: string, request: RequestInit = {}) => {
    if (target.startsWith(`${origin}/`)) {
      const file = target.slice(origin.length + 1);
      if (file === options.missing) return new Response("", { status: 404 });
      if (file === "capture-config.json") return new Response(encode(config));
      if (!["manifest.json", "worker.js", "helper.js", "capture.html"].includes(file))
        throw new Error("synthetic local path refused");
      return new Response(
        file === options.tamper
          ? "SYNTHETIC_TAMPER"
          : readFileSync(path.join(preparation.packageDirectory, file), "utf8"),
      );
    }
    const url = new URL(target);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash)
      throw new Error("synthetic provider boundary refused");
    let kind: Kind;
    if (target === "https://sp-api.tcgplayer.com/account/auth-detail?api-version=1.0" && request.method === "GET")
      kind = "lookup";
    else if (
      target === "https://order-management-api.tcgplayer.com/orders/search?api-version=2.0" &&
      request.method === "POST"
    )
      kind = "list";
    else if (
      url.host === "order-management-api.tcgplayer.com" &&
      url.pathname.startsWith("/orders/") &&
      url.search === "?api-version=2.0" &&
      request.method === "GET"
    )
      kind = "detail";
    else throw new Error("synthetic provider boundary refused");
    observations.push({ kind, url: target, options: request, at: now });
    const configured = options.responses?.[kind];
    const fixture = (Array.isArray(configured)
      ? configured[observations.filter((item) => item.kind === kind).length - 1]
      : configured) ?? {
      body: encode(
        { lookup, list, detail: { ...detail, orderNumber: decodeURIComponent(url.pathname.slice(8)) } }[kind],
      ),
    };
    if (fixture.error) throw new Error(SENTINEL);
    if (fixture.opaque) return { type: "opaqueredirect", status: 0, redirected: false, headers: new Headers() };
    if (fixture.stall) return new Promise<Response>(() => {});
    if (fixture.endless)
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(4096));
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    const route = `/synthetic/${++fixtureSequence}`;
    fixtures.set(route, fixture);
    // No headers, cookies, body, origin or credentials from the provider request
    // can reach a socket. Only this loopback URL and a synthetic marker do.
    return fetch(`${loopback}${route}`, {
      credentials: "omit",
      redirect: "manual",
      signal: request.signal,
      headers: { "X-Synthetic-Transport": "synthetic-no-live-credentials" },
    });
  };
  class SyntheticDate extends Date {
    static override now() {
      return now;
    }
  }
  const context = createContext({
    chrome,
    fetch: localFetch,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    AbortController,
    Date: SyntheticDate,
    console: {
      log: (...values: unknown[]) => retained.push(values),
      error: (...values: unknown[]) => retained.push(values),
    },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerSequence;
      if (delay < 30000) {
        now += delay;
        queueMicrotask(callback);
      } else timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const restart = () =>
    new Script(options.workerSource ?? readFileSync(path.join(preparation.packageDirectory, "worker.js"), "utf8"), {
      filename: "synthetic-packaged-worker.js",
    }).runInContext(context);
  restart();
  async function send(message: unknown, caller = sender): Promise<Reply> {
    const reply = await new Promise<Reply>((resolve) => listener(message, caller, resolve));
    await Promise.resolve();
    await Promise.resolve();
    return reply;
  }
  async function run(orderNumber: string | null = ORDER, brackets = { before: 1, after: 1 }) {
    const result = await send({ kind: "begin" });
    if (!result.ok) return result;
    const session = await send({ kind: "lookup" });
    if (session.receipt) return session;
    for (let index = 0; index < 2; index += 1) {
      const search = await send({ kind: "search", count: brackets.before, dateFilter: "LastTwoYears" });
      if (search.receipt) return search;
      const counts = await send({
        kind: "counts",
        count: brackets.after,
        dateFilter: "LastTwoYears",
        sameSession: true,
      });
      if (counts.receipt) return counts;
      if (counts.code === "fallback_available") continue;
      if (counts.code !== "selector_qualified") return send({ kind: "finish" });
      return send({
        kind: "capture",
        selections: BUCKETS.map((listStatus, index) => ({ listStatus, orderNumber: index === 0 ? orderNumber : null })),
      });
    }
    return send({ kind: "finish" });
  }
  return {
    send,
    run,
    restart,
    storage,
    retained,
    observations,
    config,
    sender,
    localFetch,
    context,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    expireRequest: () => {
      now += 30000;
      for (const callback of [...timers.values()]) callback();
    },
  };
}

function helper(
  worker: ReturnType<typeof harness>,
  input: string | null = ORDER,
  consent = true,
  options: {
    source?: string;
    onDialog?: (dialog: "confirm" | "prompt") => void;
    sendMessage?: (message: { kind: string; orderNumber?: string }) => Promise<Reply>;
    prompts?: (string | null)[];
    confirms?: boolean[];
  } = {},
) {
  const exports = new Map<string, string>();
  const blobs = new Map<string, Blob>();
  const diagnostics: unknown[] = [];
  const messages: { kind: string; orderNumber?: string }[] = [];
  const events: string[] = [];
  const dialogs: unknown[] = [];
  const prompts = [...(options.prompts ?? ["1", "LastTwoYears", "1", "LastTwoYears", input])];
  const confirms = [...(options.confirms ?? [consent, true, true, false, false, false])];
  const location = { href: worker.sender.url };
  function dialog(kind: "confirm" | "prompt") {
    events.push(kind);
    options.onDialog?.(kind);
    dialogs.push({
      kind,
      messages: messages.length,
      storage: structuredClone(worker.storage),
      requests: worker.observations.length,
      exports: exports.size,
    });
  }
  let nextBlob = 0;
  const downloads: Promise<void>[] = [];
  const window = {};
  Object.assign(window, { top: window });
  let pagehide = () => {};
  const api = createContext({
    addEventListener: (_name: string, callback: () => void) => {
      pagehide = callback;
    },
    window,
    chrome: {
      runtime: {
        id: preparation.extensionId,
        getURL: (file: string) => `chrome-extension://${preparation.extensionId}/${file}`,
        sendMessage: (message: { kind: string; orderNumber?: string }) => {
          messages.push(structuredClone(message));
          events.push(message.kind);
          return (options.sendMessage ?? worker.send)(message);
        },
      },
    },
    location,
    crypto: webcrypto,
    TextEncoder,
    Blob,
    confirm: () => {
      dialog("confirm");
      return confirms.shift() ?? false;
    },
    prompt: () => {
      dialog("prompt");
      return prompts.shift() ?? null;
    },
    console: {
      log: (...values: unknown[]) => diagnostics.push(values),
      error: (...values: unknown[]) => diagnostics.push(values),
    },
    URL: {
      createObjectURL: (blob: Blob) => {
        const id = `blob:synthetic-${++nextBlob}`;
        blobs.set(id, blob);
        return id;
      },
      revokeObjectURL: (id: string) => blobs.delete(id),
    },
    document: {
      createElement: () => {
        const link = {
          href: "",
          download: "",
          click: () => {
            const blob = blobs.get(link.href);
            if (blob)
              downloads.push(
                blob.text().then((text) => {
                  exports.set(link.download, text);
                }),
              );
          },
        };
        return link;
      },
    },
    setTimeout: (callback: () => void) => {
      queueMicrotask(callback);
    },
  });
  new Script(options.source ?? readFileSync(path.join(preparation.packageDirectory, "helper.js"), "utf8"), {
    filename: "synthetic-packaged-helper.js",
  }).runInContext(api);
  const run = async () => {
    const result = await api.orderAuthorityCapture.run();
    await Promise.all(downloads);
    return result;
  };
  return { run, exports, diagnostics, blobs, messages, events, dialogs, location, api, pagehide: () => pagehide() };
}

function receipt(reply: Reply) {
  expect(reply.ok).toBe(true);
  expect(reply.receipt).toBeDefined();
  return reply.receipt as {
    requests: {
      kind: Kind;
      responseBytes: number;
      responseComplete: boolean;
      nearCeiling: boolean;
      shape: unknown;
      failure: string | null;
      redirect: string;
      status: number;
    }[];
    failures: string[];
    selector: {
      identity: string;
      searches: {
        qualification: string;
        reason: string;
        totalOrders: number | null;
        rowCount: number | null;
        distinctCount: number | null;
        listStatuses: { surface: string; key: string; count: number }[];
        oldestRowAgeBucket: string;
        searchRange: string;
        before: unknown;
        after: unknown;
      }[];
    };
    vocabulary: {
      availability: string;
      listStatus: { surface: string; key: string };
      detailStatus: { surface: string; key: string } | null;
      refundStatus: { present: boolean; type: string } | null;
      identityEquality: boolean | null;
      qualification: string;
    }[];
    completeness: string;
    totalBytes: number;
    counts: Record<Kind, number>;
  };
}

function selections(orderNumber: string | null = ORDER) {
  return BUCKETS.map((listStatus, index) => ({ listStatus, orderNumber: index === 0 ? orderNumber : null }));
}
async function qualified(worker: ReturnType<typeof harness>) {
  expect(await worker.send({ kind: "begin" })).toEqual({ ok: true });
  expect(await worker.send({ kind: "lookup" })).toEqual({ ok: true });
  expect(await worker.send({ kind: "search", count: 1, dateFilter: "LastTwoYears" })).toEqual({
    ok: true,
    code: "search_observed",
  });
  expect(await worker.send({ kind: "counts", count: 1, dateFilter: "LastTwoYears", sameSession: true })).toEqual({
    ok: true,
    code: "selector_qualified",
  });
}
function custody(value: unknown) {
  const text = encode(value);
  for (const privateValue of [SENTINEL, ORDER, lookup.seller.sellerKey]) {
    expect(text).not.toContain(privateValue);
    expect(text).not.toContain(encodeURIComponent(privateValue));
    expect(text).not.toContain(hash(privateValue));
  }
}
function scan(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) scan(file);
    else custody(readFileSync(file, "utf8"));
  }
}
function retain(page: ReturnType<typeof helper>) {
  for (const [name, content] of page.exports) writeFileSync(path.join(out, "receipt", name), content);
}

describe("order-authority emitted package controls (synthetic, not provider authority)", () => {
  it("helper boundary and page-close abort: no input in status/other messages, terminal cleanup before replies", async () => {
    for (const failure of ["begin", "lookup", "search", "counts", "capture"]) {
      const worker = harness();
      const page = helper(worker, ORDER, true, {
        sendMessage: async (message) => {
          if (message.kind === failure) throw new Error(SENTINEL);
          return worker.send(message);
        },
      });
      await page.run();
      custody({
        storage: worker.storage,
        retained: worker.retained,
        exports: [...page.exports],
        diagnostics: page.diagnostics,
      });
      custody(page.messages.filter((message) => message.kind !== "capture"));
      expect(await page.run()).toEqual({ ok: false, code: "repeat_invocation" });
    }
    const worker = harness();
    const page = helper(worker, ORDER, true, {
      onDialog: (kind) => {
        if (kind === "prompt") page.pagehide();
      },
    });
    await page.run();
    expect(worker.observations).toHaveLength(1);
    custody({ storage: worker.storage, exports: [...page.exports], messages: page.messages });
    const wrong = helper(harness());
    wrong.location.href += "?wrong";
    expect(await wrong.run()).toEqual({ ok: false, code: "wrong_origin" });
    expect(await wrong.api.orderAuthorityCapture.abort()).toEqual({ ok: false, code: "wrong_origin" });
    expect(wrong.messages).toEqual([]);
  });

  it("complete bound: one lookup/two searches/four details; missing total and non-200 overflow cannot fallback", async () => {
    const worker = harness({ responses: { list: [{ status: 422 }, { body: encode(list) }] } });
    await worker.send({ kind: "begin" });
    await worker.send({ kind: "lookup" });
    for (let index = 0; index < 2; index += 1) {
      await worker.send({ kind: "search", count: 1, dateFilter: "LastTwoYears" });
      expect(
        (await worker.send({ kind: "counts", count: 1, dateFilter: "LastTwoYears", sameSession: true })).code,
      ).toBe(index ? "selector_qualified" : "fallback_available");
    }
    const result = receipt(
      await worker.send({
        kind: "capture",
        selections: BUCKETS.map((listStatus, index) => ({ listStatus, orderNumber: `${ORDER}-${index}` })),
      }),
    );
    expect(result.counts).toEqual({ lookup: 1, list: 2, detail: 4 });
    expect(result.failures).toEqual([]);
    expect(await worker.send({ kind: "capture", selections: selections() })).toEqual({
      ok: false,
      code: "repeat_invocation",
    });
    for (const fixture of [{ body: encode({ orders: list.orders }) }, { status: 422, body: "x".repeat(1048577) }]) {
      const negative = harness({ responses: { list: [fixture, { body: encode(list) }] } });
      const refused = receipt(await negative.run());
      expect(refused.failures).toEqual([fixture.status ? "response_ceiling_exceeded" : "completeness_unproven"]);
      expect(negative.observations).toHaveLength(2);
    }
  });

  it("custody leak mutants: actual collector reply/storage and helper export fail the same scanner", async () => {
    const emitted = readFileSync(path.join(preparation.packageDirectory, "worker.js"), "utf8");
    const replyMutant = emitted.replace(
      "failures: state.failures,",
      `failures: state.failures, leakedOrder: ${JSON.stringify(ORDER)},`,
    );
    const storageMutant = emitted.replace(
      "state.latch[kind] += 1;",
      "await chrome.storage.local.set({ leakedOrder: order }); state.latch[kind] += 1;",
    );
    for (const workerSource of [replyMutant, storageMutant]) {
      expect(workerSource).not.toBe(emitted);
      const worker = harness({ workerSource });
      const reply = await worker.run();
      expect(() => custody({ reply, storage: worker.storage })).toThrow();
    }
    const helperSource = readFileSync(path.join(preparation.packageDirectory, "helper.js"), "utf8");
    const exportMutant = helperSource.replace(
      "const text = JSON.stringify(receipt,",
      `receipt.leakedOrder = ${JSON.stringify(ORDER)}; const text = JSON.stringify(receipt,`,
    );
    expect(exportMutant).not.toBe(helperSource);
    const page = helper(harness(), ORDER, true, { source: exportMutant });
    await page.run();
    expect(() => custody([...page.exports])).toThrow();
  });

  it("private DTO cap: largest valid/cap+1 and encoded request overflow; worker custody loss never resumes", async () => {
    const base = { kind: "capture", selections: selections("") };
    const length = 8192 - Buffer.byteLength(encode(base));
    for (const extra of [0, 1]) {
      const worker = harness();
      await qualified(worker);
      const message = { kind: "capture", selections: selections("A".repeat(length + extra)) };
      expect(Buffer.byteLength(encode(message))).toBe(8192 + extra);
      const reply = await worker.send(message);
      if (extra) expect(reply).toEqual({ ok: false, code: "invalid_message" });
      else expect(receipt(reply).vocabulary[0].identityEquality).toBe(true);
      expect(worker.observations).toHaveLength(extra ? 2 : 3);
    }
    const encoded = harness();
    await qualified(encoded);
    expect(receipt(await encoded.send({ kind: "capture", selections: selections("/".repeat(3000)) })).failures).toEqual(
      ["request_ceiling_exceeded"],
    );
    expect(encoded.observations).toHaveLength(2);
    const restarted = harness();
    await qualified(restarted);
    restarted.restart();
    expect(await restarted.send({ kind: "capture", selections: selections() })).toEqual({
      ok: false,
      code: "repeat_invocation",
    });
    expect(restarted.observations).toHaveLength(2);
  });

  it("package-inventory: exact emitted bytes, isolated identity, native helper, no startup traffic", () => {
    expect(packaging.verifyPackage(out).head).toBe(preparation.head);
    const manifest = JSON.parse(readFileSync(path.join(preparation.packageDirectory, "manifest.json"), "utf8"));
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.host_permissions).toEqual([
      "https://sp-api.tcgplayer.com/*",
      "https://order-management-api.tcgplayer.com/*",
    ]);
    expect(manifest.content_security_policy.extension_pages).not.toMatch(/unsafe-eval|unsafe-inline/);
    expect(preparation.extensionId).toMatch(/^[a-p]{32}$/);
    const worker = harness();
    helper(worker);
    worker.restart();
    expect(worker.observations).toEqual([]);
    expect(worker.storage).toEqual({});
    const runbook = readFileSync(path.join(out, "RUNBOOK.md"), "utf8");
    for (const text of [
      preparation.extensionId,
      preparation.launchCommand,
      "including sign-in, prompts and removal",
      "immediately before search",
      "immediately after search",
      "absent/unqualified",
      "Closing the inspector is not removal.",
      "CDP Extensions.loadUnpacked is session-scoped",
      "at most two searches and four details",
    ])
      expect(runbook).toContain(text);
    expect(runbook).not.toMatch(/<actual-id>|<run-id>|<governed-ms>/);
  });

  it("package-inventory: cadence and digest authority refuse before output/lookup", async () => {
    for (const cadenceMs of [undefined, 0, -1, NaN, 0.5, Infinity, 1]) {
      expect(() =>
        packaging.prepare({ out: path.join(scratch, "never-created"), cadenceMs, cadenceSource: packaging.AUTHORITY }),
      ).toThrow("authority_missing");
    }
    expect(() => packaging.prepare({ out, cadenceMs: 30000, cadenceSource: packaging.AUTHORITY })).toThrow(
      "new_run_directory_required",
    );
    for (const cadenceMs of [0, -1, 0.5, null]) {
      const worker = harness({ config: { cadenceMs } });
      expect(await worker.run()).toEqual({ ok: false, code: "authority_missing" });
      expect(worker.observations).toEqual([]);
    }
    for (const file of ["worker.js", "helper.js", "manifest.json", "capture.html"]) {
      for (const options of [{ missing: file }, { tamper: file }]) {
        const worker = harness(options);
        expect(await worker.run()).toEqual({ ok: false, code: "package_mismatch" });
        expect(worker.observations).toEqual([]);
      }
    }
  });

  it("tcgplayer-ready-to-ship-selector-capture: exact worker request, scrubbed closure and distinct status surfaces", async () => {
    const worker = harness();
    const result = receipt(await worker.run());
    expect(result.failures).toEqual([]);
    expect(result.counts).toEqual({ lookup: 1, list: 1, detail: 1 });
    expect(JSON.parse(String(worker.observations[1].options.body))).toEqual({
      searchRange: "LastTwoYears",
      filters: { sellerKey: lookup.seller.sellerKey, orderStatuses: ["ReadyToShip"] },
      sortBy: [],
      from: 0,
      size: 500,
    });
    expect(result.selector.searches[0]).toMatchObject({
      searchRange: "LastTwoYears",
      qualification: "qualified",
      totalOrders: 1,
      rowCount: 1,
      distinctCount: 1,
      listStatuses: [{ surface: "list-display", key: "Ready to Ship", count: 1 }],
      oldestRowAgeBucket: "0-90-days",
      before: { count: 1, dateFilter: "LastTwoYears" },
      after: { count: 1, dateFilter: "LastTwoYears" },
    });
    expect(result.vocabulary[0]).toMatchObject({
      identityEquality: true,
      qualification: "captured",
      detailStatus: { surface: "order-detail", key: "Shipped - In Transit" },
    });
    expect(result.completeness).toBe("unknown");
    for (const observation of worker.observations) {
      expect(observation.options.credentials).toBe("include");
      expect(observation.options.redirect).toBe("manual");
      expect(new Headers(observation.options.headers).has("Authorization")).toBe(false);
      expect(new Headers(observation.options.headers).has("Cookie")).toBe(false);
    }
    for (const call of wire) {
      expect(call.host).toBe(new URL(loopback).host);
      expect(call.cookie).toBeUndefined();
      expect(call.authorization).toBeUndefined();
      expect(call.marker).toBe("synthetic-no-live-credentials");
    }
  });

  it.each([400, 422, 500])("range-only fallback: eligible HTTP %i changes only range, one attempt", async (status) => {
    const worker = harness({ responses: { list: [{ status }, { body: encode(list) }] } });
    const result = receipt(await worker.run());
    expect(result.failures).toEqual([]);
    expect(result.counts).toEqual({ lookup: 1, list: 2, detail: 1 });
    const requests = worker.observations
      .filter((item) => item.kind === "list")
      .map((item) => JSON.parse(String(item.options.body)));
    expect(requests[1]).toEqual({ ...requests[0], searchRange: "LastThreeMonths" });
    expect(result.selector.searches.map((item) => item.qualification)).toEqual(["unknown", "qualified"]);
    const both = harness({ responses: { list: { status } } });
    expect(receipt(await both.run()).failures).toEqual(["http_status"]);
    expect(both.observations.map((item) => item.kind)).toEqual(["lookup", "list", "list"]);
  });
  it.each([{ body: "{}" }, { body: "not-json" }])(
    "range-only fallback: validation %j, never parameter spraying",
    async (fixture) => {
      const worker = harness({ responses: { list: [fixture, { body: encode(list) }] } });
      expect(receipt(await worker.run()).counts).toEqual({ lookup: 1, list: 2, detail: 1 });
    },
  );
  it.each([401, 403, 429, 302])("safety stops before fallback: HTTP %i", async (status) => {
    const worker = harness({ responses: { list: { status } } });
    const result = receipt(await worker.run());
    expect(result.failures).toEqual([status === 302 ? "redirect" : "session_missing"]);
    expect(worker.observations.map((item) => item.kind)).toEqual(["lookup", "list"]);
  });
  it("safety stops before fallback: HTML/login is session loss, never validation retry", async () => {
    const worker = harness({ responses: { list: { contentType: "text/html", body: "SYNTHETIC login" } } });
    expect(receipt(await worker.run()).failures).toEqual(["session_missing"]);
    expect(worker.observations).toHaveLength(2);
  });
  it.each([
    { opaque: true },
    { error: true },
    { body: encode({ ...list, orders: [{ ...list.orders[0], orderStatus: SENTINEL }] }) },
  ])("safety stops before fallback: redirect/transport/custody %j", async (fixture) => {
    const worker = harness({ responses: { list: fixture } });
    const result = receipt(await worker.run());
    expect(result.failures).toHaveLength(1);
    expect(worker.observations).toHaveLength(2);
    custody(result);
  });
  it.each([{}, { seller: {} }, { seller: { sellerKey: null } }, { seller: { sellerKey: "" } }])(
    "session authority missing: zero order reads %j",
    async (body) => {
      const worker = harness({ responses: { lookup: { body: encode(body) } } });
      expect(receipt(await worker.run()).failures).toEqual(["session_missing"]);
      expect(worker.observations).toHaveLength(1);
    },
  );

  it("qualification matrix: empty is closed; paging, filter, duplicate, count/date/session mismatch stop without fallback", async () => {
    const empty = harness({ responses: { list: { body: encode({ totalOrders: 0, orders: [] }) } } });
    const emptyResult = receipt(await empty.run(null, { before: 0, after: 0 }));
    expect(emptyResult.selector.searches[0]).toMatchObject({ qualification: "qualified", oldestRowAgeBucket: "empty" });
    for (const [body, reason] of [
      [{ ...list, totalOrders: 2 }, "length_mismatch"],
      [
        {
          totalOrders: 500,
          orders: Array.from({ length: 500 }, (_, index) => ({
            orderNumber: `SYNTHETIC-${index}`,
            orderStatus: "Ready to Ship",
          })),
        },
        "page_not_closed",
      ],
      [{ totalOrders: 2, orders: [list.orders[0], list.orders[0]] }, "duplicate_order"],
      [{ ...list, orders: [{ ...list.orders[0], orderStatus: "Canceled" }] }, "filter_not_honored"],
    ] as const) {
      const worker = harness({ responses: { list: { body: encode(body) } } });
      const result = receipt(await worker.run());
      expect(result.selector.searches[0]).toMatchObject({ qualification: "unknown", reason });
      expect(worker.observations).toHaveLength(2);
    }
    const counts = harness();
    expect(receipt(await counts.run(ORDER, { before: 1, after: 2 })).selector.searches[0].reason).toBe(
      "count_mismatch",
    );
    expect(counts.observations).toHaveLength(2);
    for (const sameSession of [true, false]) {
      const worker = harness();
      await worker.send({ kind: "begin" });
      await worker.send({ kind: "lookup" });
      await worker.send({ kind: "search", count: 1, dateFilter: "LastTwoYears" });
      const result = await worker.send({ kind: "counts", count: 1, dateFilter: "LastThreeMonths", sameSession });
      if (sameSession) expect(result.code).toBe("selector_unknown");
      else expect(receipt(result).failures).toEqual(["session_missing"]);
      expect(worker.observations).toHaveLength(2);
    }
  });

  it("paging/filter-trust/absence-inference mutants fail frozen-input controls", async () => {
    const emitted = readFileSync(path.join(preparation.packageDirectory, "worker.js"), "utf8");
    const cases = [
      {
        body: { ...list, totalOrders: 2 },
        mutant: emitted.replace("list.orders.length !== list.totalOrders", "false"),
      },
      {
        body: { ...list, orders: [{ ...list.orders[0], orderStatus: "Canceled" }] },
        mutant: emitted.replace('list.orders.some((row) => row.orderStatus !== "Ready to Ship")', "false"),
      },
    ];
    const assertUnknown = (result: ReturnType<typeof receipt>) =>
      expect(result.selector.searches[0].qualification).toBe("unknown");
    for (const control of cases) {
      const options = { responses: { list: { body: encode(control.body) } } };
      const brackets = { before: control.body.totalOrders, after: control.body.totalOrders };
      assertUnknown(receipt(await harness(options).run(ORDER, brackets)));
      expect(control.mutant).not.toBe(emitted);
      const receiptResult = receipt(await harness({ ...options, workerSource: control.mutant }).run(ORDER, brackets));
      expect(() => assertUnknown(receiptResult)).toThrow();
    }
    const assertAbsent = (result: ReturnType<typeof receipt>) =>
      expect(result.vocabulary[1]).toMatchObject({
        availability: "absent",
        qualification: "unqualified",
        detailStatus: null,
        identityEquality: null,
      });
    const good = receipt(await harness().run());
    assertAbsent(good);
    const absentMutant = structuredClone(good);
    absentMutant.vocabulary[1] = {
      ...absentMutant.vocabulary[1],
      qualification: "captured",
      detailStatus: { surface: "order-detail", key: "Shipped - Delivered" },
      identityEquality: true,
    };
    expect(() => assertAbsent(absentMutant)).toThrow();
  });

  it("tcgplayer-order-detail-status-vocabulary: four private selections, direct identity, refund type not refund inference", async () => {
    const worker = harness({
      responses: {
        detail: BUCKETS.map((status, index) => ({
          body: encode({
            ...detail,
            orderNumber: `${ORDER}-${index}`,
            status,
            ...(index ? { refundStatus: index === 1 ? null : index === 2 ? {} : "Refunded" } : {}),
          }),
        })),
      },
    });
    await qualified(worker);
    const inputs = BUCKETS.map((listStatus, index) => ({ listStatus, orderNumber: `${ORDER}-${index}` }));
    const result = receipt(await worker.send({ kind: "capture", selections: inputs }));
    expect(result.failures).toEqual([]);
    expect(result.counts).toEqual({ lookup: 1, list: 1, detail: 4 });
    expect(result.vocabulary.map((item) => item.detailStatus)).toEqual(
      BUCKETS.map((key) => ({ surface: "order-detail", key })),
    );
    expect(result.vocabulary.map((item) => item.refundStatus)).toEqual([
      { present: false, type: "absent" },
      { present: true, type: "null" },
      { present: true, type: "object" },
      { present: true, type: "string" },
    ]);
    expect(inputs.every((item) => item.orderNumber === null)).toBe(true);
    const mismatch = receipt(
      await harness({
        responses: { detail: { body: encode({ ...detail, orderNumber: "SYNTHETIC_OTHER_ORDER" }) } },
      }).run(),
    );
    expect(mismatch.failures).toEqual(["identity_mismatch"]);
    expect(mismatch.vocabulary[0]).toMatchObject({
      identityEquality: false,
      qualification: "unqualified",
      detailStatus: null,
    });
  });

  it("tcgplayer-order-authority-custody-scan: private input positive, wrong-origin/nested/extra-field zero-dispatch negatives", async () => {
    const worker = harness();
    await qualified(worker);
    const reply = await worker.send({ kind: "capture", selections: selections() });
    expect(worker.observations.at(-1)?.url).toBe(
      `https://order-management-api.tcgplayer.com/orders/${encodeURIComponent(ORDER)}?api-version=2.0`,
    );
    expect(receipt(reply).vocabulary[0].identityEquality).toBe(true);
    const noInput = harness();
    const absent = receipt(await noInput.run(null));
    const positive = (result: ReturnType<typeof receipt>) => expect(result.vocabulary[0].identityEquality).toBe(true);
    expect(() => positive(absent)).toThrow();
    expect(noInput.observations).toHaveLength(2);
    for (const caller of [
      { ...worker.sender, origin: "https://synthetic.invalid", url: "https://synthetic.invalid/capture.html" },
      { ...worker.sender, id: "synthetic-foreign-extension" },
      { ...worker.sender, frameId: 1 },
      { ...worker.sender, url: worker.sender.url + "?private=input" },
      { ...worker.sender, url: worker.sender.url.replace("capture.html", "worker.js") },
    ]) {
      const negative = harness();
      expect(await negative.send({ kind: "capture", selections: selections() }, caller)).toEqual({
        ok: false,
        code: "wrong_origin",
      });
      expect(negative.observations).toEqual([]);
      expect(negative.storage).toEqual({});
    }
    for (const message of [
      { kind: "begin", orderNumber: ORDER },
      { kind: "capture", orderNumber: ORDER },
      { kind: "capture", selections: selections(), sellerKey: SENTINEL },
      {
        kind: "capture",
        selections: [{ listStatus: BUCKETS[0], orderNumber: { value: ORDER } }, ...selections().slice(1)],
      },
      { kind: "capture", selections: [{ ...selections()[0], extra: SENTINEL }, ...selections().slice(1)] },
      { kind: "capture", selections: selections(".") },
      { kind: "capture", selections: selections("..") },
      { kind: "capture", selections: Array(4) },
      { kind: "capture", selections: Object.assign(selections(), { extra: { buyer: SENTINEL } }) },
      {
        kind: "capture",
        selections: selections().map((item, index) => ({ ...item, orderNumber: index < 2 ? ORDER : null })),
      },
      { kind: "capture", selections: selections("x\n") },
      { kind: "capture", selections: selections("x".repeat(8193)) },
      { kind: "counts", count: 1, dateFilter: "LastTwoYears", sameSession: true, session: SENTINEL },
    ]) {
      const negative = harness();
      expect(await negative.send(message)).toEqual({ ok: false, code: "invalid_message" });
      expect(negative.observations).toEqual([]);
      expect(negative.storage).toEqual({});
    }
  });

  it("custody terminal matrix: success/refusal/cancel/abort outputs, all messages except private input, artifacts and leak mutants", async () => {
    for (const options of [
      {},
      { responses: { list: { error: true } } },
      { responses: { lookup: { body: SENTINEL } } },
    ]) {
      const worker = harness(options);
      const page = helper(worker);
      expect(await page.run()).toEqual({ ok: true, code: "scrubbed_export_created" });
      expect([...page.exports.keys()].sort()).toEqual(["8838-inventory.json", "8838-receipt.json"]);
      custody({
        storage: worker.storage,
        retained: worker.retained,
        diagnostics: page.diagnostics,
        exports: [...page.exports],
      });
      custody(page.messages.filter((message) => message.kind !== "capture"));
      retain(page);
      expect(packaging.verifyExport(out).removal.extensionAbsent).toBe(false);
      scan(out);
    }
    for (const kind of ["cancel", "abort"] as const) {
      const worker = harness();
      await qualified(worker);
      const result = receipt(await worker.send({ kind }));
      expect(result.failures).toEqual([kind === "cancel" ? "canceled" : "aborted"]);
      custody({ result, storage: worker.storage, retained: worker.retained });
      expect(await worker.send({ kind: "capture", selections: selections() })).toEqual({
        ok: false,
        code: "repeat_invocation",
      });
    }
    const candidate = { reply: await harness().run(), storage: {}, export: {} };
    custody(candidate);
    for (const boundary of ["reply", "storage", "export"]) {
      const mutant = { ...candidate, [boundary]: { orderNumber: ORDER } };
      expect(() => custody(mutant)).toThrow();
    }
    for (const input of [null, "", " \t\n"]) {
      const worker = harness();
      const page = helper(worker, input);
      expect(await page.run()).toEqual({ ok: true, code: "scrubbed_export_created" });
      custody({ storage: worker.storage, exports: [...page.exports], messages: page.messages });
      expect(worker.observations).toHaveLength(2);
      expect(await page.run()).toEqual({ ok: false, code: "repeat_invocation" });
    }
    const canceled = helper(harness(), ORDER, false);
    expect(await canceled.run()).toEqual({ ok: false, code: "canceled" });
    expect(canceled.messages).toEqual([]);
  });

  it("request-budget: serial cadence, persistent predispatch latch, no restart/reopen/repeat", async () => {
    const worker = harness({ cadenceMs: 1234 });
    const result = receipt(await worker.run());
    expect(result.counts).toEqual({ lookup: 1, list: 1, detail: 1 });
    expect(worker.observations.map((item) => item.at)).toEqual([
      Date.parse("2030-01-01Z"),
      Date.parse("2030-01-01Z") + 1234,
      Date.parse("2030-01-01Z") + 2468,
    ]);
    expect(worker.storage).toMatchObject({ orderAuthorityLatch: { used: true, lookup: 1, list: 1, detail: 1 } });
    expect(await worker.send({ kind: "begin" })).toEqual({ ok: false, code: "repeat_invocation" });
    const restarted = harness({ storage: worker.storage });
    expect(await restarted.send({ kind: "begin" })).toEqual({ ok: false, code: "repeat_invocation" });
    expect(restarted.observations).toEqual([]);
    const deadline = harness();
    await deadline.send({ kind: "begin" });
    deadline.advance(900000);
    expect(receipt(await deadline.send({ kind: "lookup" })).failures).toEqual(["deadline"]);
    expect(deadline.observations).toEqual([]);
    const slow = harness({ cadenceMs: 900000 });
    expect(receipt(await slow.run()).failures).toEqual(["deadline"]);
    expect(slow.observations).toHaveLength(1);
  });

  for (const [kind, ceiling] of [
    ["lookup", 65536],
    ["list", 1048576],
    ["detail", 524288],
  ] as const) {
    it(`response-ceilings: ${kind} largest-valid/cap+1/endless never truncated or fallback-qualified`, async () => {
      const base = encode({ lookup, list, detail }[kind]);
      const admitted = receipt(
        await harness({ responses: { [kind]: { body: base + " ".repeat(ceiling - Buffer.byteLength(base)) } } }).run(),
      );
      expect(admitted.failures).toEqual([]);
      expect(admitted.requests.find((item) => item.kind === kind)).toMatchObject({
        responseBytes: ceiling,
        nearCeiling: true,
        responseComplete: true,
      });
      for (const fixture of [{ body: base + " ".repeat(ceiling + 1 - Buffer.byteLength(base)) }, { endless: true }]) {
        const worker = harness({ responses: { [kind]: fixture } });
        const result = receipt(await worker.run());
        expect(result.failures).toEqual(["response_ceiling_exceeded"]);
        expect(result.requests.at(-1)?.shape).toBeNull();
        expect(result.requests.at(-1)?.responseComplete).toBe(false);
        expect(result.counts.list).toBeLessThanOrEqual(1);
      }
    });
  }
  it("response-timeout/abort: unchanged 30 s, zero fallback, terminal private cleanup", async () => {
    for (const kind of ["lookup", "list", "detail"] as const) {
      const worker = harness({ responses: { [kind]: { stall: true } } });
      const pending = worker.run();
      for (let index = 0; index < 100 && !worker.observations.some((item) => item.kind === kind); index += 1)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(worker.observations.at(-1)?.kind).toBe(kind);
      worker.expireRequest();
      const result = receipt(await pending);
      expect(result.failures).toEqual(["response_timeout"]);
      expect(result.requests.at(-1)?.shape).toBeNull();
      expect(worker.observations.at(-1)?.options.signal?.aborted).toBe(true);
      custody({ result, storage: worker.storage, retained: worker.retained });
    }
    const worker = harness({ responses: { detail: { stall: true } } });
    await qualified(worker);
    const input = selections();
    const pending = worker.send({ kind: "capture", selections: input });
    for (let index = 0; index < 100 && worker.observations.length < 3; index += 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(await worker.send({ kind: "abort" })).toEqual({ ok: true, code: "abort_requested" });
    worker.expireRequest();
    const result = receipt(await pending);
    expect(result.failures).toEqual(["aborted"]);
    expect(input.every((item) => item.orderNumber === null)).toBe(true);
    custody(result);
  });

  it("request-ceilings: exact 8 KiB search body and cap+1; list row cap+1 remains bounded unknown", async () => {
    const empty = encode({
      searchRange: "LastTwoYears",
      filters: { sellerKey: "", orderStatuses: ["ReadyToShip"] },
      sortBy: [],
      from: 0,
      size: 500,
    });
    for (const extra of [0, 1]) {
      const worker = harness({
        responses: {
          lookup: { body: encode({ seller: { sellerKey: "S".repeat(8192 - Buffer.byteLength(empty) + extra) } }) },
        },
      });
      const result = receipt(await worker.run());
      expect(result.failures).toEqual(extra ? ["request_ceiling_exceeded"] : []);
      expect(worker.observations).toHaveLength(extra ? 1 : 3);
      if (!extra) expect(Buffer.byteLength(String(worker.observations[1].options.body))).toBe(8192);
    }
    const overflow = harness({
      responses: {
        list: { body: encode({ totalOrders: 501, orders: Array.from({ length: 501 }, () => list.orders[0]) }) },
      },
    });
    const result = receipt(await overflow.run());
    expect(result.failures).toEqual(["page_ceiling_exceeded"]);
    expect(result.selector.searches.every((item) => item.qualification === "unknown")).toBe(true);
    expect(overflow.observations).toHaveLength(2);
  });

  it("temporary-extension-removal: closed export, nested leak refusal, digest tamper, exact-ID absence attestation", async () => {
    const page = helper(harness());
    await page.run();
    retain(page);
    expect(packaging.verifyExport(out).retainedFiles).toEqual(["8838-receipt.json", "8838-inventory.json"]);
    const file = path.join(out, "receipt", "8838-receipt.json");
    const indexFile = path.join(out, "receipt", "8838-inventory.json");
    const original = readFileSync(file, "utf8");
    const originalIndex = readFileSync(indexFile, "utf8");
    for (const target of ["shape", "vocabulary", "filter", "search-http", "detail-http"]) {
      const value = JSON.parse(original);
      if (target === "search-http" || target === "detail-http")
        value.requests[target === "search-http" ? 1 : 2].status = 500;
      else
        Object.assign(
          target === "shape"
            ? value.requests[0].shape.fields[0]
            : target === "vocabulary"
              ? value.vocabulary[0]
              : value.selector.searches[0].filter,
          { orderNumber: ORDER },
        );
      const text = encode(value);
      writeFileSync(file, text);
      const index = JSON.parse(originalIndex);
      index.files["8838-receipt.json"] = hash(text);
      writeFileSync(indexFile, encode(index));
      expect(() => packaging.verifyExport(out)).toThrow("export_schema_refused");
    }
    writeFileSync(file, original);
    writeFileSync(indexFile, originalIndex);
    expect(() => packaging.recordRemoval(out, false)).toThrow("removal_not_confirmed");
    expect(() => packaging.recordRemoval(out, true)).toThrow("removal_not_confirmed");
    const profile = path.resolve(preparation.profileDirectory);
    expect(path.dirname(profile)).toBe(path.resolve(out));
    expect(profile.startsWith(scratch + path.sep)).toBe(true);
    rmSync(profile, { recursive: true });
    expect(packaging.recordRemoval(out, true).removal).toEqual({
      extensionAbsent: true,
      profileDisposed: true,
      confirmation: "operator-attested-extension-absence-and-profile-disposal",
    });
    const workerFile = path.join(preparation.packageDirectory, "worker.js");
    const originalWorker = readFileSync(workerFile);
    writeFileSync(workerFile, "synthetic tampered worker");
    expect(() => packaging.verifyPackage(out)).toThrow("digest_mismatch");
    writeFileSync(workerFile, originalWorker);
    scan(out);
  });
});
