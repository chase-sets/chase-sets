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
const scratch = path.resolve(source, "../../../../../../artifacts/8616-impl-g3");
const SENTINEL = "SYNTHETIC_PII_SENTINEL_8616";
const ORDER = `${SENTINEL}/order ?#`;
const lookup = { seller: { sellerKey: `${SENTINEL}_seller` }, [SENTINEL]: { cookie: SENTINEL } };
const list = { totalOrders: 1190, orders: [{ orderNumber: ORDER, buyerName: SENTINEL }] };
const detail = {
  orderNumber: ORDER,
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
    responses?: Partial<Record<Kind, Fixture>>;
    tamper?: string;
    missing?: string;
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
    const fixture = options.responses?.[kind] ?? { body: encode({ lookup, list, detail }[kind]) };
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
    new Script(readFileSync(path.join(preparation.packageDirectory, "worker.js"), "utf8"), {
      filename: "synthetic-packaged-worker.js",
    }).runInContext(context);
  restart();
  async function send(message: unknown, caller = sender): Promise<Reply> {
    const reply = await new Promise<Reply>((resolve) => listener(message, caller, resolve));
    await Promise.resolve();
    await Promise.resolve();
    return reply;
  }
  async function run(orderNumber = ORDER) {
    const result = await send({ kind: "begin" });
    if (!result.ok) return result;
    return send({ kind: "capture", orderNumber });
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
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    expireRequest: () => {
      now += 30000;
      for (const callback of [...timers.values()]) callback();
    },
  };
}

function helper(worker: ReturnType<typeof harness>, input: string | null = ORDER, consent = true) {
  const exports = new Map<string, string>();
  const blobs = new Map<string, Blob>();
  const diagnostics: unknown[] = [];
  let nextBlob = 0;
  const downloads: Promise<void>[] = [];
  const api = createContext({
    chrome: {
      runtime: {
        id: preparation.extensionId,
        getURL: (file: string) => `chrome-extension://${preparation.extensionId}/${file}`,
        sendMessage: worker.send,
      },
    },
    location: { href: worker.sender.url },
    crypto: webcrypto,
    TextEncoder,
    Blob,
    confirm: () => consent,
    prompt: () => input,
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
  new Script(readFileSync(path.join(preparation.packageDirectory, "helper.js"), "utf8"), {
    filename: "synthetic-packaged-helper.js",
  }).runInContext(api);
  const run = async () => {
    const result = await api.orderAuthorityCapture.run();
    await Promise.all(downloads);
    return result;
  };
  return { run, exports, diagnostics, blobs };
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
    listDetailEquality: boolean | null;
    completeness: string;
    totalBytes: number;
    counts: Record<Kind, number>;
  };
}

describe("order-authority emitted package controls (synthetic, not browser/provider authority)", () => {
  it("package-inventory: exact emitted bytes, unique identity, resolved runbook and no startup traffic", () => {
    expect(packaging.verifyPackage(out).head).toBe(preparation.head);
    const manifest = JSON.parse(readFileSync(path.join(preparation.packageDirectory, "manifest.json"), "utf8"));
    expect(Object.keys(manifest).sort()).toEqual([
      "background",
      "content_security_policy",
      "host_permissions",
      "key",
      "manifest_version",
      "name",
      "permissions",
      "version",
    ]);
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.host_permissions).toEqual([
      "https://sp-api.tcgplayer.com/*",
      "https://order-management-api.tcgplayer.com/*",
    ]);
    expect(manifest.content_security_policy.extension_pages).not.toMatch(/unsafe-eval|unsafe-inline/);
    expect(preparation.extensionId).toMatch(/^[a-p]{32}$/);
    expect(preparation.extensionId).not.toBe("ebnhngdhefamkdjajldafonajgkadfhh");
    const instructions = readFileSync(path.join(out, "RUNBOOK.md"), "utf8");
    expect(instructions).toContain(preparation.extensionId);
    expect(instructions).toContain(preparation.launchCommand);
    expect(instructions).not.toMatch(/<actual-id>|<run-id>|<governed-ms>/);
    const worker = harness();
    helper(worker);
    worker.restart();
    helper(worker);
    expect(worker.observations).toEqual([]);
    expect(worker.storage).toEqual({});
  });

  it("package-inventory: missing cadence or source refuses preparation before output", () => {
    for (const cadenceMs of [undefined, 0, -1, NaN, 0.5, Infinity]) {
      expect(() =>
        packaging.prepare({ out: path.join(scratch, "never-created"), cadenceMs, cadenceSource: packaging.AUTHORITY }),
      ).toThrow("authority_missing");
    }
    expect(() => packaging.prepare({ out: path.join(scratch, "never-created"), cadenceMs: 10 })).toThrow(
      "authority_missing",
    );
    expect(() => packaging.prepare({ out, cadenceMs: 10, cadenceSource: packaging.AUTHORITY })).toThrow(
      "new_run_directory_required",
    );
  });

  it("synthetic-worker-origin: actual packaged worker, loopback-only sentinel transport and exact three shapes", async () => {
    const worker = harness();
    const result = receipt(await worker.run());
    expect(result.failures).toEqual([]);
    expect(result.listDetailEquality).toBe(true);
    expect(result.completeness).toBe("unknown");
    expect(result.counts).toEqual({ lookup: 1, list: 1, detail: 1 });
    expect(worker.observations.map(({ kind }) => kind)).toEqual(["lookup", "list", "detail"]);
    const search = worker.observations[1];
    expect(JSON.parse(String(search.options.body))).toEqual({
      searchRange: "LastThreeMonths",
      filters: { sellerKey: lookup.seller.sellerKey },
      sortBy: [
        { sortingType: "orderStatus", direction: "ascending" },
        { sortingType: "orderDate", direction: "ascending" },
      ],
      from: 0,
      size: 25,
    });
    expect(worker.observations[2].url).toBe(
      `https://order-management-api.tcgplayer.com/orders/${encodeURIComponent(ORDER)}?api-version=2.0`,
    );
    for (const observation of worker.observations) {
      expect(observation.options.credentials).toBe("include");
      expect(observation.options.redirect).toBe("manual");
      expect(new Headers(observation.options.headers).has("Authorization")).toBe(false);
      expect(new Headers(observation.options.headers).has("Cookie")).toBe(false);
    }
    expect(wire.length).toBeGreaterThanOrEqual(3);
    for (const call of wire) {
      expect(call.host).toBe(new URL(loopback).host);
      expect(call.cookie).toBeUndefined();
      expect(call.authorization).toBeUndefined();
      expect(call.marker).toBe("synthetic-no-live-credentials");
    }
  });

  it.each([{}, { seller: {} }, { seller: { sellerKey: null } }, { seller: { sellerKey: "" } }])(
    "session-missing: no order dispatch for missing worker-held seller authority %j",
    async (body) => {
      const worker = harness({ responses: { lookup: { body: encode(body) } } });
      expect(receipt(await worker.run()).failures).toEqual(["session_missing"]);
      expect(worker.observations.map(({ kind }) => kind)).toEqual(["lookup"]);
    },
  );

  it.each([401, 403, 429, 500])("session-missing: status %i stops without retry", async (status) => {
    const worker = harness({ responses: { list: { status, body: SENTINEL } } });
    expect(receipt(await worker.run()).failures).toEqual([status === 500 ? "http_status" : "session_missing"]);
    expect(worker.observations).toHaveLength(2);
  });

  it("disallowed-host: page, content, foreign extension, frame, query and nested-message callers have zero dispatch", async () => {
    const worker = harness();
    const callers = [
      { ...worker.sender, origin: "https://synthetic.invalid", url: "https://synthetic.invalid/capture.html" },
      { ...worker.sender, id: "synthetic-foreign-extension" },
      { ...worker.sender, frameId: 1 },
      { ...worker.sender, url: `${worker.sender.url}?order=${SENTINEL}` },
      { ...worker.sender, url: worker.sender.url.replace("capture.html", "worker.js") },
    ];
    for (const sender of callers)
      expect(await worker.send({ kind: "begin" }, sender)).toEqual({ ok: false, code: "wrong_origin" });
    for (const url of [
      "https://synthetic.invalid",
      "http://sp-api.tcgplayer.com/account/auth-detail",
      "https://sp-api.tcgplayer.com:444/",
      "https://user@sp-api.tcgplayer.com/",
      "https://sp-api.tcgplayer.com/#fragment",
    ]) {
      expect(await worker.send({ kind: "begin", url })).toEqual({ ok: false, code: "invalid_message" });
    }
    for (const message of [
      { kind: "begin", options: { url: SENTINEL } },
      { kind: "capture", orderNumber: { value: ORDER } },
      { kind: "capture", orderNumber: ORDER, headers: { Authorization: SENTINEL } },
      { kind: "capture", orderNumber: "x\n" },
      { kind: "capture", orderNumber: "." },
      { kind: "capture", orderNumber: ".." },
    ]) {
      expect(await worker.send(message)).toEqual({ ok: false, code: "invalid_message" });
    }
    expect(worker.observations).toEqual([]);
    expect(worker.storage).toEqual({});
  });

  it("repeat-invocation: predispatch latch survives concurrent calls, reopen and worker restart", async () => {
    const worker = harness();
    const first = worker.send({ kind: "begin" });
    expect(await worker.send({ kind: "begin" })).toEqual({ ok: false, code: "repeat_invocation" });
    expect(await first).toEqual({ ok: true });
    expect(worker.storage).toHaveProperty("orderAuthorityLatch");
    const restarted = harness({ storage: worker.storage });
    expect(await restarted.send({ kind: "begin" })).toEqual({ ok: false, code: "repeat_invocation" });
    expect(await restarted.send({ kind: "capture", orderNumber: ORDER })).toEqual({
      ok: false,
      code: "repeat_invocation",
    });
    expect(restarted.observations).toEqual([]);
    expect(receipt(await worker.send({ kind: "capture", orderNumber: ORDER })).counts).toEqual({
      lookup: 1,
      list: 1,
      detail: 1,
    });
    expect(await helper(worker).run()).toEqual({ ok: false, code: "preparation_refused" });
    expect(worker.observations).toHaveLength(3);
  });

  it("request-budget: serialized cadence, durable counters before each dispatch, no reset after completion", async () => {
    const worker = harness({ cadenceMs: 1234 });
    const result = receipt(await worker.run());
    expect(result.counts).toEqual({ lookup: 1, list: 1, detail: 1 });
    expect(worker.observations.map(({ at }) => at)).toEqual([
      Date.parse("2030-01-01Z"),
      Date.parse("2030-01-01Z") + 1234,
      Date.parse("2030-01-01Z") + 2468,
    ]);
    expect(worker.retained).toEqual([
      { accessLevel: "TRUSTED_CONTEXTS" },
      ...[
        { lookup: 0, list: 0, detail: 0 },
        { lookup: 1, list: 0, detail: 0 },
        { lookup: 1, list: 1, detail: 0 },
        { lookup: 1, list: 1, detail: 1 },
      ].map((counts) => ({
        orderAuthorityLatch: { used: true, ...counts, deadline: Date.parse("2030-01-01Z") + 900000 },
      })),
    ]);
    expect(await worker.send({ kind: "capture", orderNumber: ORDER })).toEqual({
      ok: false,
      code: "repeat_invocation",
    });
  });

  it("request-budget: elapsed prompts and insufficient cadence window return bounded negative, never extend deadline", async () => {
    const worker = harness();
    await worker.send({ kind: "begin" });
    worker.advance(900000);
    expect(receipt(await worker.send({ kind: "capture", orderNumber: ORDER })).failures).toEqual(["deadline"]);
    expect(worker.observations).toEqual([]);
    const slow = harness({ cadenceMs: 900000 });
    expect(receipt(await slow.run()).failures).toEqual(["deadline"]);
    expect(slow.observations).toHaveLength(1);
  });

  it.each([0, -1, 0.5, null])("missing-authority: packaged cadence %s refuses before lookup", async (cadenceMs) => {
    const worker = harness({ config: { cadenceMs } });
    expect(await worker.run()).toEqual({ ok: false, code: "authority_missing" });
    expect(worker.observations).toEqual([]);
  });

  it.each(["worker.js", "helper.js", "manifest.json", "capture.html"])(
    "digest-tamper: missing or changed %s refuses before lookup",
    async (file) => {
      for (const options of [{ missing: file }, { tamper: file }]) {
        const worker = harness(options);
        expect(await worker.run()).toEqual({ ok: false, code: "package_mismatch" });
        expect(worker.observations).toEqual([]);
      }
    },
  );

  it.each([{ opaque: true }, { status: 302 }, { contentType: "text/html", body: SENTINEL }, { body: SENTINEL }])(
    "redirect/login/invalid JSON: no destination following or detail request %j",
    async (fixture) => {
      const worker = harness({ responses: { list: fixture } });
      const result = receipt(await worker.run());
      expect(result.failures).toEqual([fixture.opaque || fixture.status === 302 ? "redirect" : "invalid_json"]);
      expect(worker.observations).toHaveLength(2);
      expect(result.requests[1].shape).toBeNull();
      if (fixture.opaque) expect(result.requests[1].redirect).toBe("opaque-destination-unknown");
    },
  );

  for (const [kind, ceiling] of [
    ["lookup", 65536],
    ["list", 1048576],
    ["detail", 524288],
  ] as const) {
    it(`response-ceilings: ${kind} largest-admitted synthetic exactly at ceiling, ceiling+1 and endless-body`, async () => {
      const base = encode({ lookup, list, detail }[kind]);
      const admitted = harness({
        responses: { [kind]: { body: base + " ".repeat(ceiling - Buffer.byteLength(base)) } },
      });
      const positive = receipt(await admitted.run());
      expect(positive.failures).toEqual([]);
      expect(positive.requests.find((request) => request.kind === kind)).toMatchObject({
        responseBytes: ceiling,
        nearCeiling: true,
        responseComplete: true,
      });
      for (const fixture of [{ body: base + " ".repeat(ceiling + 1 - Buffer.byteLength(base)) }, { endless: true }]) {
        const negative = receipt(await harness({ responses: { [kind]: fixture } }).run());
        expect(negative.failures).toEqual(["response_ceiling_exceeded"]);
        expect(negative.requests.at(-1)?.shape).toBeNull();
        expect(negative.requests.at(-1)?.responseComplete).toBe(false);
      }
    });
  }

  it("response-ceilings: per-request stalled transport aborts at unchanged 30 s without projection", async () => {
    const worker = harness({ responses: { lookup: { stall: true } } });
    await worker.send({ kind: "begin" });
    const pending = worker.send({ kind: "capture", orderNumber: ORDER });
    for (let index = 0; index < 20 && worker.observations.length === 0; index += 1) await Promise.resolve();
    expect(worker.observations).toHaveLength(1);
    worker.expireRequest();
    const result = receipt(await pending);
    expect(result.failures).toEqual(["response_timeout"]);
    expect(result.requests[0].shape).toBeNull();
    expect(worker.observations[0].options.signal?.aborted).toBe(true);
  });

  it("request-budget: largest-admitted synthetic 8 KiB body and ceiling+1", async () => {
    const empty = encode({
      searchRange: "LastThreeMonths",
      filters: { sellerKey: "" },
      sortBy: [
        { sortingType: "orderStatus", direction: "ascending" },
        { sortingType: "orderDate", direction: "ascending" },
      ],
      from: 0,
      size: 25,
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
  });

  it("pagination-truncates-authoritative-state: page overflow/count mismatch stops; missing or duplicate identity is unknown", async () => {
    for (const body of [
      { totalOrders: 26, orders: Array.from({ length: 26 }, () => ({ orderNumber: ORDER })) },
      { totalOrders: 0, orders: [{ orderNumber: ORDER }] },
    ]) {
      const worker = harness({ responses: { list: { body: encode(body) } } });
      expect(receipt(await worker.run()).failures).toEqual(["invalid_shape"]);
      expect(worker.observations).toHaveLength(2);
    }
    for (const orders of [[], [{ orderNumber: ORDER }, { orderNumber: ORDER }]]) {
      const result = receipt(
        await harness({ responses: { list: { body: encode({ totalOrders: 1190, orders }) } } }).run(),
      );
      expect(result.listDetailEquality).toBeNull();
      expect(result.completeness).toBe("unknown");
    }
    const mismatch = receipt(
      await harness({ responses: { detail: { body: encode({ orderNumber: "SYNTHETIC_OTHER_ORDER" }) } } }).run(),
    );
    expect(mismatch.listDetailEquality).toBe(false);
  });

  it("PII-sentinel: recursively inspect actual helper exports, package, retained storage and diagnostics, including failure/cancel", async () => {
    for (const options of [
      {},
      { responses: { list: { error: true } } },
      { responses: { lookup: { body: SENTINEL } } },
    ]) {
      const worker = harness(options);
      const page = helper(worker);
      expect(await page.run()).toEqual({ ok: true, code: "scrubbed_export_created" });
      expect([...page.exports.keys()].sort()).toEqual(["8607-inventory.json", "8607-receipt.json"]);
      const retained = encode({
        storage: worker.storage,
        retained: worker.retained,
        diagnostics: page.diagnostics,
        exports: [...page.exports],
        globals: Object.keys(worker),
        blobCount: page.blobs.size,
      });
      expect(retained).not.toContain(SENTINEL);
      expect(retained).not.toContain(hash(SENTINEL));
      expect(retained).not.toContain(encodeURIComponent(ORDER));
      const index = JSON.parse(page.exports.get("8607-inventory.json")!);
      expect(index.files["8607-receipt.json"]).toBe(hash(page.exports.get("8607-receipt.json")!));
      for (const [name, content] of page.exports) writeFileSync(path.join(out, "receipt", name), content);
      expect(packaging.verifyExport(out).removal.extensionAbsent).toBe(false);
    }
    for (const consent of [false, true]) {
      const worker = harness();
      const page = helper(worker, null, consent);
      expect(await page.run()).toEqual({ ok: true, code: "scrubbed_export_created" });
      expect(JSON.parse(page.exports.get("8607-receipt.json")!).failures).toEqual(["canceled"]);
      expect(worker.observations).toEqual([]);
      expect(encode([...page.exports])).not.toContain(SENTINEL);
    }
    for (const file of readdirSync(preparation.packageDirectory)) {
      expect(readFileSync(path.join(preparation.packageDirectory, file), "utf8")).not.toContain(SENTINEL);
    }
    function scan(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) scan(file);
        else {
          const bytes = readFileSync(file, "utf8");
          for (const value of [SENTINEL, ORDER, lookup.seller.sellerKey]) {
            expect(bytes).not.toContain(value);
            expect(bytes).not.toContain(encodeURIComponent(value));
            expect(bytes).not.toContain(hash(value));
          }
        }
      }
    }
    scan(out);
  });

  it("temporary-extension-removal: emitted walkthrough, exact inventory, explicit absence attestation and profile disposal", async () => {
    const page = helper(harness());
    await page.run();
    for (const [name, content] of page.exports) writeFileSync(path.join(out, "receipt", name), content);
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
    expect(packaging.verifyExport(out).retainedFiles).toEqual(["8607-receipt.json", "8607-inventory.json"]);
    const file = path.join(out, "receipt", "8607-receipt.json");
    const original = readFileSync(file, "utf8");
    const indexFile = path.join(out, "receipt", "8607-inventory.json");
    const originalIndex = readFileSync(indexFile, "utf8");
    const malformed = JSON.parse(original);
    malformed.requests[0].shape.fields[0].status = 123;
    const malformedText = encode(malformed);
    writeFileSync(file, malformedText);
    const malformedIndex = JSON.parse(originalIndex);
    malformedIndex.files["8607-receipt.json"] = hash(malformedText);
    writeFileSync(indexFile, encode(malformedIndex));
    expect(() => packaging.verifyExport(out)).toThrow("export_schema_refused");
    writeFileSync(indexFile, originalIndex);
    writeFileSync(file, original + " ");
    expect(() => packaging.verifyExport(out)).toThrow("export_schema_refused");
    writeFileSync(file, original);
    const workerFile = path.join(preparation.packageDirectory, "worker.js");
    const originalWorker = readFileSync(workerFile);
    writeFileSync(workerFile, "synthetic tampered worker");
    expect(() => packaging.verifyPackage(out)).toThrow("digest_mismatch");
    writeFileSync(workerFile, originalWorker);
    expect(packaging.verifyPackage(out).qualification).toBe("PENDING_HOST_VERIFIER");
  });
});
