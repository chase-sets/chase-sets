import { createHash, webcrypto } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

const source = path.dirname(fileURLToPath(import.meta.url));
const packaging = await import(new URL("./package.mjs", import.meta.url).href);
const scratch = path.resolve(source, "../../../../../../artifacts/9114/tests");
const T0 = "2030-01-01T00:00:00.000Z";
const SENTINEL = "SYNTHETIC_PRIVATE_SENTINEL_9114";
const ORDER = `${SENTINEL}/order ?#`;
const lookup = { seller: { sellerKey: `${SENTINEL}_seller` }, [SENTINEL]: { cookie: SENTINEL } };
const list = {
  totalOrders: 1,
  orders: [{ orderNumber: ORDER, buyerName: SENTINEL, orderStatus: "Ready to Ship", orderDate: "2029-12-31" }],
};
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => JSON.stringify(value);
type Kind = "lookup" | "list";
type Reply = { ok: boolean; code?: string; receipt?: Record<string, unknown> };
type Sender = { id: string; url: string; origin: string; frameId: number };
type Listener = (message: unknown, sender: Sender, respond: (reply: Reply) => void) => boolean;
type Fixture = {
  body?: string;
  status?: number;
  contentType?: string;
  opaque?: boolean;
  stall?: boolean;
  endless?: boolean;
  error?: boolean;
  delay?: number;
};
let out: string;
let preparation: {
  extensionId: string;
  head: string;
  packageDirectory: string;
  profileDirectory: string;
  launchCommand: string;
  t0: string;
};
beforeAll(() => {
  mkdirSync(scratch, { recursive: true });
  out = path.join(mkdtempSync(path.join(scratch, "synthetic-emitted-")), "run");
  preparation = packaging.prepare({ out, cadenceMs: 1, cadenceSource: packaging.AUTHORITY, t0: T0, synthetic: true });
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
    onStorageSet?: (value: Record<string, unknown>) => void;
    configurationReady?: Promise<void>;
    tickPerRead?: boolean;
  } = {},
) {
  let now = Date.parse(T0);
  let listener: Listener;
  const storage = options.storage ?? {};
  const retained: unknown[] = [];
  const observations: { kind: Kind; url: string; options: RequestInit; at: number; persisted: unknown }[] = [];
  const boundaries = new Set<{ predicate: () => boolean; resolve: () => void }>();
  const notify = () => {
    for (const boundary of boundaries)
      if (boundary.predicate()) {
        boundaries.delete(boundary);
        boundary.resolve();
      }
  };
  const when = (predicate: () => boolean, terminal: Promise<unknown>) => {
    if (predicate()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const boundary = { predicate, resolve };
      boundaries.add(boundary);
      void terminal.then(
        () => {
          if (boundaries.delete(boundary)) reject(new Error("synthetic initialization boundary not reached"));
        },
        (error) => {
          boundaries.delete(boundary);
          reject(error);
        },
      );
    });
  };
  const timers = new Map<number, { callback: () => void; at: number }>();
  const intervals = new Map<number, { callback: () => void; delay: number; at: number }>();
  const heartbeats: { at: number; arguments: unknown[] }[] = [];
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
      getPlatformInfo: async (...args: unknown[]) => {
        heartbeats.push({ at: now, arguments: args });
        return { os: "win" };
      },
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
          options.onStorageSet?.(value);
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
      if (file === "capture-config.json") {
        await options.configurationReady;
        return new Response(encode(config));
      }
      if (!["manifest.json", "worker.js", "helper.js", "capture.html"].includes(file))
        throw new Error("synthetic local path refused");
      return new Response(
        file === options.tamper
          ? "SYNTHETIC_TAMPER"
          : readFileSync(path.join(preparation.packageDirectory, file), "utf8"),
      );
    }
    let kind: Kind;
    if (target === "https://sp-api.tcgplayer.com/account/auth-detail?api-version=1.0" && request.method === "GET")
      kind = "lookup";
    else if (
      target === "https://order-management-api.tcgplayer.com/orders/search?api-version=2.0" &&
      request.method === "POST"
    )
      kind = "list";
    else throw new Error("synthetic provider boundary refused");
    observations.push({ kind, url: target, options: request, at: now, persisted: structuredClone(storage) });
    request.signal?.addEventListener("abort", notify, { once: true });
    notify();
    const configured = options.responses?.[kind];
    const fixture = (Array.isArray(configured)
      ? configured[observations.filter((item) => item.kind === kind).length - 1]
      : configured) ?? { body: encode({ lookup, list }[kind]) };
    if (fixture.delay) now += fixture.delay;
    if (fixture.error) throw new Error(SENTINEL);
    if (fixture.opaque) return { type: "opaqueredirect", status: 0, redirected: false, headers: new Headers() };
    if (fixture.stall)
      return new Promise<Response>((_resolve, reject) =>
        request.signal?.addEventListener("abort", () => reject(new Error(SENTINEL)), { once: true }),
      );
    if (fixture.endless)
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(4096));
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    // No socket, cookies or credentials: only unmistakably synthetic responses.
    return new Response(fixture.body ?? "{}", {
      status: fixture.status ?? 200,
      headers: { "Content-Type": fixture.contentType ?? "application/json" },
    });
  };
  class SyntheticDate extends Date {
    static override now() {
      return options.tickPerRead ? now++ : now;
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
      // Only short cadence waits auto-advance. Deadlines/requests are explicit.
      if (delay < 30000 && delay <= config.cadenceMs) {
        now += delay;
        queueMicrotask(callback);
      } else timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (callback: () => void, delay: number) => {
      const id = ++timerSequence;
      intervals.set(id, { callback, delay, at: now + delay });
      return id;
    },
    clearInterval: (id: number) => intervals.delete(id),
  });
  const restart = () => {
    timers.clear();
    intervals.clear();
    new Script(options.workerSource ?? readFileSync(path.join(preparation.packageDirectory, "worker.js"), "utf8"), {
      filename: "synthetic-packaged-worker.js",
    }).runInContext(context);
  };
  restart();
  const advance = (milliseconds: number) => {
    const end = now + milliseconds;
    for (;;) {
      const next = Math.min(...[...timers.values(), ...intervals.values()].map((timer) => timer.at));
      if (next > end) break;
      now = next;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      for (const [id, timer] of [...intervals])
        if (intervals.has(id) && timer.at <= now) {
          timer.at += timer.delay;
          timer.callback();
        }
    }
    now = end;
  };
  async function send(message: unknown, caller = sender): Promise<Reply> {
    const reply = await new Promise<Reply>((resolve) => listener(message, caller, resolve));
    await Promise.resolve();
    await Promise.resolve();
    return reply;
  }
  const bracket = (range = "LastTwoYears", count = 1) => ({
    count,
    dateFilter: range,
    reprompted: false,
    countSurface: "ready-to-ship-quick-filter",
    observedAt: new Date(now).toISOString(),
    settled: true,
    unchanged: true,
  });
  const run = async (counts = { before: 1, after: 1 }) => {
    const begin = await send({ kind: "begin" });
    if (!begin.ok || begin.receipt) return begin;
    const session = await send({ kind: "lookup" });
    if (session.receipt) return session;
    for (const range of ["LastTwoYears", "LastThreeMonths"]) {
      const search = await send({ kind: "search", ...bracket(range, counts.before) });
      if (!search.ok || search.receipt) return search;
      const after = await send({ kind: "counts", ...bracket(range, counts.after), sameSession: true });
      if (!after.ok || after.receipt) return after;
      if (after.code !== "fallback_available") return send({ kind: "finish" });
    }
    return send({ kind: "finish" });
  };
  return {
    send,
    run,
    restart,
    storage,
    retained,
    observations,
    config,
    sender,
    context,
    heartbeats,
    intervals,
    advance,
    bracket,
    Date: SyntheticDate,
    now: () => now,
    expireRequest: () => advance(30000),
    when,
  };
}

function helper(
  worker: ReturnType<typeof harness>,
  options: {
    source?: string;
    prompts?: (string | null)[];
    confirms?: boolean[];
    onDialog?: (kind: string, text: string) => void;
    sendMessage?: (message: Record<string, unknown>) => Promise<Reply>;
  } = {},
) {
  const exports = new Map<string, string>();
  const blobs = new Map<string, Blob>();
  const diagnostics: unknown[] = [];
  const messages: Record<string, unknown>[] = [];
  const replies: Reply[] = [];
  const events: { kind: string; text?: string; arguments?: unknown[] }[] = [];
  const prompts = [
    ...(options.prompts ?? ["LastTwoYears", "Ready to Ship", "1", "LastTwoYears", "Ready to Ship", "1"]),
  ];
  const confirms = [...(options.confirms ?? [true, true, true, true, true, true, true])];
  const location = { href: worker.sender.url };
  const dialog = (kind: string, text: string, args: unknown[]) => {
    events.push({ kind, text, arguments: args });
    options.onDialog?.(kind, text);
  };
  const downloads: Promise<void>[] = [];
  let nextBlob = 0;
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
        sendMessage: async (message: Record<string, unknown>) => {
          messages.push(structuredClone(message));
          events.push({ kind: String(message.kind) });
          const reply = await (options.sendMessage ?? worker.send)(message);
          replies.push(structuredClone(reply));
          return reply;
        },
      },
    },
    location,
    crypto: webcrypto,
    TextEncoder,
    Blob,
    Date: worker.Date,
    confirm: (...args: [string]) => {
      dialog("confirm", args[0], args);
      return confirms.shift() ?? false;
    },
    prompt: (...args: [string]) => {
      dialog("prompt", args[0], args);
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
    setTimeout: (callback: () => void) => queueMicrotask(callback),
  });
  new Script(options.source ?? readFileSync(path.join(preparation.packageDirectory, "helper.js"), "utf8"), {
    filename: "synthetic-packaged-helper.js",
  }).runInContext(api);
  const run = async () => {
    const result = await api.orderAuthorityCapture.run();
    await Promise.all(downloads);
    return result;
  };
  return { run, exports, diagnostics, blobs, messages, replies, events, location, api, pagehide: () => pagehide() };
}

function receipt(reply: Reply) {
  expect(reply.ok).toBe(true);
  expect(reply.receipt).toBeDefined();
  return reply.receipt as {
    format: string;
    t0: string;
    startedAt: string;
    finishedAt: string;
    deadlineAt: string;
    requests: {
      kind: Kind;
      startedAt: string;
      endedAt: string;
      elapsedMs: number;
      requestBytes: number;
      responseBytes: number;
      responseComplete: boolean;
      shape: unknown;
      failure: string | null;
      status: number;
    }[];
    failures: string[];
    counts: { lookup: number; list: number; detail: number };
    totalBytes: number;
    selector: {
      searches: {
        qualification: string;
        reason: string;
        totalOrders: number | null;
        rowCount: number | null;
        distinctCount: number | null;
        searchRange: string;
        before: Record<string, unknown>;
        after: Record<string, unknown> | null;
        listStatuses: unknown[];
      }[];
    };
  };
}
function exported(page: ReturnType<typeof helper>) {
  return receipt({ ok: true, receipt: JSON.parse(page.exports.get("selector-receipt.json")!) });
}
function retain(page: ReturnType<typeof helper>) {
  for (const [name, text] of page.exports) writeFileSync(path.join(out, "receipt", name), text);
}
function custody(value: unknown) {
  const text = encode(value);
  for (const privateValue of [SENTINEL, ORDER, lookup.seller.sellerKey])
    for (const encoding of [
      privateValue,
      encodeURIComponent(privateValue),
      Buffer.from(privateValue).toString("base64"),
      hash(privateValue),
    ])
      expect(text).not.toContain(encoding);
}
function scan(directory: string) {
  for (const entry of readdirSync(directory)) {
    const file = path.join(directory, entry);
    const metadata = lstatSync(file);
    if (metadata.isDirectory()) scan(file);
    else if (metadata.isFile()) custody(readFileSync(file, "utf8"));
    else if (metadata.isSymbolicLink()) custody(readlinkSync(file));
    else if (metadata.isSocket()) continue;
    else throw new Error(`Unsupported custody scan entry: ${file}`);
  }
}
function replaceExport(mutator: (value: ReturnType<typeof exported>) => void) {
  const file = path.join(out, "receipt", "selector-receipt.json");
  const value = JSON.parse(readFileSync(file, "utf8"));
  mutator(value);
  const text = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(file, text);
  const indexFile = path.join(out, "receipt", "selector-inventory.json");
  const index = JSON.parse(readFileSync(indexFile, "utf8"));
  index.files["selector-receipt.json"] = hash(text);
  writeFileSync(indexFile, JSON.stringify(index, null, 2) + "\n");
}
async function beginSearch(worker: ReturnType<typeof harness>) {
  expect(await worker.send({ kind: "begin" })).toEqual({ ok: true });
  expect(await worker.send({ kind: "lookup" })).toEqual({ ok: true });
}

describe("synthetic custody scan", () => {
  it("does not follow a dangling Chromium SingletonCookie link and still inspects nested regular files", () => {
    const directory = mkdtempSync(path.join(scratch, "synthetic-custody-"));
    const link = path.join(directory, "SingletonCookie");
    symlinkSync(path.join(directory, "missing-cookie"), link, process.platform === "win32" ? "junction" : "file");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(() => readFileSync(link)).toThrow();
    const nested = path.join(directory, "nested");
    mkdirSync(nested);
    const file = path.join(nested, "receipt.json");
    writeFileSync(file, "synthetic clean receipt");
    expect(() => scan(directory)).not.toThrow();
    for (const value of [SENTINEL, ORDER, lookup.seller.sellerKey]) {
      for (const encoding of [value, encodeURIComponent(value), Buffer.from(value).toString("base64"), hash(value)]) {
        writeFileSync(file, encoding);
        expect(() => scan(directory)).toThrow(/not to contain/);
      }
    }
  });

  it("inspects dangling link text without following the target", () => {
    const directory = mkdtempSync(path.join(scratch, "synthetic-custody-"));
    symlinkSync(
      path.join(directory, SENTINEL),
      path.join(directory, "SingletonCookie"),
      process.platform === "win32" ? "junction" : "file",
    );
    expect(() => scan(directory)).toThrow(/not to contain/);
  });
});

describe("selector-surface-boundary (synthetic human attestations, not portal proof)", () => {
  it.each(["Ready to Ship", "  READY   TO   SHIP  ", "ready\tto\nship"])(
    "real helper -> worker -> export admits normalized label %j without raw text",
    async (label) => {
      const worker = harness();
      const page = helper(worker, { prompts: ["LastTwoYears", label, "1", "LastTwoYears", label, "1"] });
      expect(await page.run()).toEqual({ ok: true, code: "scrubbed_export_created" });
      const value = exported(page);
      expect(value.selector.searches[0].qualification).toBe("qualified");
      for (const bracket of [value.selector.searches[0].before, value.selector.searches[0].after])
        expect(bracket).toMatchObject({
          countSurface: "ready-to-ship-quick-filter",
          observedAt: expect.any(String),
          settled: true,
          unchanged: true,
        });
      expect(page.messages.map((message) => message.kind)).toEqual(["begin", "lookup", "search", "counts", "finish"]);
      expect(page.replies.slice(0, -1).some((reply) => encode(reply).includes("totalOrders"))).toBe(false);
      const labelPrompts = page.events.filter(
        (event) => event.kind === "prompt" && event.text?.startsWith("Transcribe"),
      );
      expect(labelPrompts).toHaveLength(2);
      expect(
        labelPrompts.every((event) => event.arguments?.length === 1 && !event.text?.includes("Ready to Ship")),
      ).toBe(true);
      retain(page);
      expect(packaging.verifyExport(out).evidence).toBe("synthetic");
      custody({
        messages: page.messages,
        replies: page.replies,
        storage: worker.storage,
        retained: worker.retained,
        diagnostics: page.diagnostics,
      });
    },
  );
  it.each(["All Orders", "ReadyToShip", "Ready to Ship (1)", "Ready to Ship orders", SENTINEL, ""])(
    "wrong label %j refuses BEFORE count and is never echoed",
    async (label) => {
      const worker = harness();
      const page = helper(worker, { prompts: ["LastTwoYears", label, "1"] });
      expect(await page.run()).toEqual({ ok: true, code: "scrubbed_export_created" });
      expect(worker.observations.map((item) => item.kind)).toEqual(["lookup"]);
      expect(page.events.filter((event) => event.kind === "prompt")).toHaveLength(2);
      expect(exported(page).failures).toEqual(["count_surface_mismatch"]);
      custody({ messages: page.messages, exports: [...page.exports], diagnostics: page.diagnostics });
    },
  );
  it("post-response sequence is fresh reload -> range/one correction -> label -> settled/unchanged -> single count", async () => {
    const worker = harness();
    const page = helper(worker, {
      prompts: [
        "LastThreeMonths",
        "LastTwoYears",
        "Ready to Ship",
        "1",
        "LastThreeMonths",
        "LastTwoYears",
        "Ready to Ship",
        "1",
      ],
    });
    expect((await page.run()).ok).toBe(true);
    const events = page.events.slice(page.events.findIndex((event) => event.kind === "search") + 1);
    expect(events.map((event) => event.kind)).toEqual([
      "confirm",
      "prompt",
      "prompt",
      "prompt",
      "confirm",
      "confirm",
      "prompt",
      "confirm",
      "counts",
      "finish",
    ]);
    expect(events[0].text).toContain("load a fresh Orders view");
    expect(events[2].text).toContain("Restore Last 2 years");
    expect(events[3].text).toContain("Transcribe ONLY");
    expect(events[4].text).toContain("post-response fresh");
    const value = exported(page);
    expect(value.selector.searches[0].before.reprompted).toBe(true);
    expect(value.selector.searches[0].after?.reprompted).toBe(true);
    retain(page);
    expect(packaging.verifyExport(out).probe).toBe(packaging.PROBE);
  });
  it.each(["before", "after"])("second range mismatch at %s refuses without reading a count", async (side) => {
    const worker = harness();
    const prompts =
      side === "before"
        ? ["LastThreeMonths", SENTINEL]
        : ["LastTwoYears", "Ready to Ship", "1", "LastThreeMonths", SENTINEL];
    const page = helper(worker, { prompts });
    await page.run();
    const value = exported(page);
    expect(value.failures).toEqual(["date_filter_mismatch"]);
    expect(worker.observations.filter((item) => item.kind === "list")).toHaveLength(side === "before" ? 0 : 1);
    if (side === "after") expect(value.selector.searches[0].totalOrders).toBeNull();
    retain(page);
    expect(packaging.verifyExport(out).evidence).toBe("synthetic");
    custody([...page.exports]);
  });
  it.each([30000, 31000])("before gap %i discriminates at unchanged 30 s limit", async (gap) => {
    const worker = harness();
    await beginSearch(worker);
    const bracket = worker.bracket();
    worker.advance(gap);
    const response = await worker.send({ kind: "search", ...bracket });
    if (gap === 30000) expect(response.code).toBe("search_observed");
    else {
      expect(receipt(response).failures).toEqual(["bracket_timing"]);
      expect(worker.observations).toHaveLength(1);
    }
    if (!response.receipt) await worker.send({ kind: "cancel" });
  });
  it.each([120000, 121000])("after gap %i discriminates at unchanged 120 s limit", async (gap) => {
    const worker = harness();
    await beginSearch(worker);
    await worker.send({ kind: "search", ...worker.bracket() });
    worker.advance(gap);
    const response = await worker.send({ kind: "counts", ...worker.bracket(), sameSession: true });
    if (gap === 120000) expect(response.code).toBe("selector_qualified");
    else {
      expect(receipt(response).failures).toEqual(["bracket_timing"]);
      expect(receipt(response).selector.searches[0].totalOrders).toBeNull();
    }
    if (!response.receipt) await worker.send({ kind: "finish" });
  });
  it("wrong/omitted surface propagation and both gate-removal mutants fail the frozen-input control", async () => {
    const workerSource = readFileSync(path.join(preparation.packageDirectory, "worker.js"), "utf8");
    for (const countSurface of [undefined, "all-orders", "Ready to Ship"]) {
      const worker = harness();
      await beginSearch(worker);
      const message: Record<string, unknown> = { kind: "search", ...worker.bracket(), countSurface };
      if (countSurface === undefined) delete message.countSurface;
      expect(await worker.send(message)).toEqual({ ok: false, code: "invalid_message" });
      expect(worker.observations).toHaveLength(1);
    }
    const mutant = workerSource
      .replace('message.countSurface === "ready-to-ship-quick-filter" &&', "")
      .replace('if (message.countSurface !== "ready-to-ship-quick-filter") fail("count_surface_mismatch");', "");
    expect(mutant).not.toBe(workerSource);
    const worker = harness({ workerSource: mutant });
    await beginSearch(worker);
    await worker.send({ kind: "search", ...worker.bracket(), countSurface: "all-orders" });
    await worker.send({ kind: "counts", ...worker.bracket(), countSurface: "all-orders", sameSession: true });
    const response = await worker.send({ kind: "finish" });
    expect(receipt(response).selector.searches[0].qualification).toBe("qualified");
    const page = helper(harness());
    await page.run();
    retain(page);
    replaceExport((value) => {
      value.selector = receipt(response).selector;
    });
    expect(() => packaging.verifyExport(out)).toThrow("export_schema_refused");
    const helperSource = readFileSync(path.join(preparation.packageDirectory, "helper.js"), "utf8");
    const missing = helper(harness(), {
      source: helperSource.replace('countSurface: "ready-to-ship-quick-filter",', ""),
    });
    expect((await missing.run()).ok).toBe(false);
    expect(missing.exports.size).toBe(0);
  });
  it.each(["settled", "unchanged"])("false %s refuses worker admission without fallback", async (field) => {
    const worker = harness();
    await beginSearch(worker);
    const value = receipt(await worker.send({ kind: "search", ...worker.bracket(), [field]: false }));
    expect(value.failures).toEqual([field === "settled" ? "display_unsettled" : "bracket_changed"]);
    expect(value.counts.list).toBe(0);
  });
  it("validator independently rejects forged timing, filter, session and count with matching file hashes", async () => {
    const mutations: ((value: ReturnType<typeof exported>) => void)[] = [
      (value) => {
        for (const field of ["startedAt", "endedAt"] as const)
          value.requests[1][field] = new Date(Date.parse(value.requests[1][field]) + 60000).toISOString();
        value.selector.searches[0].after!.observedAt = new Date(
          Date.parse(String(value.selector.searches[0].after!.observedAt)) + 60000,
        ).toISOString();
        value.finishedAt = new Date(Date.parse(value.finishedAt) + 60000).toISOString();
        value.selector.searches[0].before.observedAt = new Date(
          Date.parse(value.requests[1].startedAt) - 31000,
        ).toISOString();
        expect(Date.parse(String(value.selector.searches[0].before.observedAt))).toBeGreaterThanOrEqual(
          Date.parse(value.startedAt),
        );
      },
      (value) => {
        value.selector.searches[0].after!.observedAt = new Date(
          Date.parse(value.requests[1].endedAt) + 121000,
        ).toISOString();
        value.finishedAt = String(value.selector.searches[0].after!.observedAt);
      },
      (value) => {
        value.selector.searches[0].before.observedAt = new Date(
          Date.parse(value.requests[1].startedAt) + 1,
        ).toISOString();
      },
      (value) => {
        value.selector.searches[0].before.dateFilter = "LastThreeMonths";
      },
      (value) => {
        Object.assign(value.selector.searches[0], { sameSession: false });
      },
      (value) => {
        value.selector.searches[0].after!.count = 2;
      },
    ];
    for (const mutate of mutations) {
      const page = helper(harness());
      await page.run();
      retain(page);
      replaceExport(mutate);
      expect(() => packaging.verifyExport(out)).toThrow("export_schema_refused");
    }
  });
  it("validator accepts the exact 30 s before-gap boundary with matching file hashes", async () => {
    const page = helper(harness());
    await page.run();
    retain(page);
    replaceExport((value) => {
      for (const field of ["startedAt", "endedAt"] as const)
        value.requests[1][field] = new Date(Date.parse(value.requests[1][field]) + 60000).toISOString();
      value.selector.searches[0].after!.observedAt = new Date(
        Date.parse(String(value.selector.searches[0].after!.observedAt)) + 60000,
      ).toISOString();
      value.finishedAt = new Date(Date.parse(value.finishedAt) + 60000).toISOString();
      value.selector.searches[0].before.observedAt = new Date(
        Date.parse(value.requests[1].startedAt) - 30000,
      ).toISOString();
      expect(Date.parse(String(value.selector.searches[0].before.observedAt))).toBeGreaterThanOrEqual(
        Date.parse(value.startedAt),
      );
    });
    expect(packaging.verifyExport(out).evidence).toBe("synthetic");
  });
});

describe("selector-only-protocol", () => {
  it("real helper -> worker -> export binds request elapsed time with an advancing synthetic clock", async () => {
    const page = helper(harness({ tickPerRead: true }));
    await page.run();
    const value = exported(page);
    expect(value.selector.searches[0].qualification).toBe("qualified");
    expect(value.failures).toEqual([]);
    for (const request of value.requests)
      expect(request.elapsedMs).toBe(Date.parse(request.endedAt) - Date.parse(request.startedAt));
    retain(page);
    expect(packaging.verifyExport(out).evidence).toBe("synthetic");
  });
  it.each([
    ["finish", "deadline"],
    ["abort", "aborted"],
    ["cancel", "canceled"],
    ["finish", null],
  ] as const)("qualified search then %s (%s) retains a verifiable terminal export", async (kind, failure) => {
    const worker = harness();
    const page = helper(worker, {
      sendMessage: async (message) => {
        if (message.kind !== "finish") return worker.send(message);
        if (failure === "deadline") worker.Date.now = () => Date.parse(T0) + 900000;
        return worker.send({ kind });
      },
    });
    await page.run();
    expect(page.replies.some((reply) => reply.code === "selector_qualified")).toBe(true);
    const value = exported(page);
    expect(value.failures).toEqual(failure ? [failure] : []);
    expect(value.selector.searches[0].qualification).toBe(failure ? "unknown" : "qualified");
    expect(value.selector.searches[0].reason).toBe(failure ?? "qualified");
    expect(value.counts).toEqual({ lookup: 1, list: 1, detail: 0 });
    retain(page);
    expect(packaging.verifyExport(out).evidence).toBe("synthetic");
    expect(await worker.send({ kind: "begin" })).toEqual({ ok: false, code: "repeat_invocation" });
  });
  // Copied from captured g3 23831c28e10c14989055ccb8d66112bc812e37fe worker,
  // equal package at main 95b2b22f2e91994e91002c7a5d6e7ac55fda0107. NOT candidate-derived.
  const oracle = {
    lookupUrl: "https://sp-api.tcgplayer.com/account/auth-detail?api-version=1.0",
    searchUrl: "https://order-management-api.tcgplayer.com/orders/search?api-version=2.0",
    body: '{"searchRange":"LastTwoYears","filters":{"sellerKey":"SYNTHETIC_PRIVATE_SENTINEL_9114_seller","orderStatuses":["ReadyToShip"]},"sortBy":[],"from":0,"size":500}',
    lookupBytes: 65536,
    listBytes: 1048576,
    requestBytes: 8192,
    sessionBytes: 8388608,
    cadenceMs: 30000,
    deadlineMs: 900000,
    timeoutMs: 30000,
  };
  it("immutable baseline request oracle: actual worker bytes, credentials, serial cadence and predispatch latch", async () => {
    const worker = harness({ cadenceMs: oracle.cadenceMs });
    const pending = worker.run();
    await worker.when(() => worker.observations[0]?.options.signal?.aborted === true, pending);
    worker.advance(30000);
    const value = receipt(await pending);
    expect(worker.observations.map((item) => item.url)).toEqual([oracle.lookupUrl, oracle.searchUrl]);
    expect(worker.observations[1].options.body).toBe(oracle.body);
    expect(worker.observations[1].at - worker.observations[0].at).toBe(oracle.cadenceMs);
    for (const observation of worker.observations) {
      expect(observation.options).toMatchObject({ credentials: "include", redirect: "manual", cache: "no-store" });
      expect(observation.options.headers).not.toHaveProperty("Authorization");
      expect(observation.persisted).toMatchObject({ orderAuthorityLatch: { used: true, [observation.kind]: 1 } });
    }
    expect(value.requests.map((request) => request.kind)).toEqual(["lookup", "list"]);
    expect(value.counts).toEqual({ lookup: 1, list: 1, detail: 0 });
    expect(value.requests[0]).toMatchObject({ ceilingBytes: oracle.lookupBytes });
    expect(value.requests[1]).toMatchObject({ ceilingBytes: oracle.listBytes });
    expect(Date.parse(value.deadlineAt) - Date.parse(T0)).toBe(oracle.deadlineMs);
  });
  it.each([400, 422, 500, "invalid_json", "invalid_shape"])(
    "exactly one eligible fallback %s changes range only, after fresh bracket/cadence",
    async (failure) => {
      const fixture =
        typeof failure === "number"
          ? { status: failure, body: "{}" }
          : { body: failure === "invalid_json" ? "not-json" : "{}" };
      const worker = harness({ responses: { list: [fixture, { body: encode(list) }] } });
      const prompts = [
        "LastTwoYears",
        "Ready to Ship",
        "1",
        "LastTwoYears",
        "Ready to Ship",
        "1",
        "LastThreeMonths",
        "Ready to Ship",
        "1",
        "LastThreeMonths",
        "Ready to Ship",
        "1",
      ];
      const page = helper(worker, { prompts, confirms: Array(13).fill(true) });
      await page.run();
      const searches = worker.observations.filter((item) => item.kind === "list");
      expect(searches).toHaveLength(2);
      expect(searches.map((item) => item.options.body)).toEqual([
        oracle.body,
        oracle.body.replace("LastTwoYears", "LastThreeMonths"),
      ]);
      expect(page.messages.map((message) => message.kind)).toEqual([
        "begin",
        "lookup",
        "search",
        "counts",
        "search",
        "counts",
        "finish",
      ]);
      expect(exported(page).selector.searches.map((search) => search.qualification)).toEqual(["unknown", "qualified"]);
      retain(page);
      expect(packaging.verifyExport(out).evidence).toBe("synthetic");
    },
  );
  it.each([401, 403, 429, 302, "opaque", "html", "transport", "overflow", "endless"])(
    "safety stop %s never falls back or reads a second bracket",
    async (failure) => {
      const fixture: Fixture =
        typeof failure === "number"
          ? { status: failure }
          : failure === "opaque"
            ? { opaque: true }
            : failure === "html"
              ? { contentType: "text/html", body: SENTINEL }
              : failure === "transport"
                ? { error: true }
                : failure === "endless"
                  ? { endless: true }
                  : { body: "x".repeat(1048577) };
      const worker = harness({ responses: { list: fixture } });
      const page = helper(worker);
      await page.run();
      expect(exported(page).failures.length).toBeGreaterThan(0);
      expect(worker.observations).toHaveLength(2);
      expect(page.messages.map((message) => message.kind)).toEqual(["begin", "lookup", "search"]);
      expect(worker.intervals.size).toBe(0);
      retain(page);
      expect(packaging.verifyExport(out).evidence).toBe("synthetic");
      custody([...page.exports]);
    },
  );
  it.each([
    { payload: { orders: [] }, reason: "completeness_unproven" },
    { payload: { totalOrders: 2, orders: list.orders }, reason: "length_mismatch" },
    {
      payload: {
        totalOrders: 500,
        orders: Array.from({ length: 500 }, (_, index) => ({ ...list.orders[0], orderNumber: `${ORDER}-${index}` })),
      },
      reason: "page_not_closed",
    },
    { payload: { totalOrders: 2, orders: [list.orders[0], list.orders[0]] }, reason: "duplicate_order" },
    { payload: { ...list, orders: [{ ...list.orders[0], orderStatus: SENTINEL }] }, reason: "filter_not_honored" },
    { payload: { totalOrders: 501, orders: Array(501).fill(list.orders[0]) }, reason: "page_ceiling_exceeded" },
  ])("closed-set negative $reason never paginates/falls back", async ({ payload, reason }) => {
    const worker = harness({ responses: { list: { body: encode(payload) } } });
    const page = helper(worker);
    await page.run();
    const value = exported(page);
    expect(value.selector.searches[0].qualification).toBe("unknown");
    expect(value.selector.searches[0].reason).toBe(reason);
    expect(value.counts).toEqual({ lookup: 1, list: 1, detail: 0 });
    retain(page);
    expect(packaging.verifyExport(out).evidence).toBe("synthetic");
    custody(value);
  });
  it("certified empty needs every bracket gate; count mismatch and equal-count wrong range are unknown", async () => {
    const empty = helper(harness({ responses: { list: { body: encode({ totalOrders: 0, orders: [] }) } } }), {
      prompts: ["LastTwoYears", "Ready to Ship", "0", "LastTwoYears", "Ready to Ship", "0"],
    });
    await empty.run();
    expect(exported(empty).selector.searches[0].qualification).toBe("qualified");
    retain(empty);
    expect(packaging.verifyExport(out).evidence).toBe("synthetic");
    const mismatch = receipt(await harness().run({ before: 2, after: 1 }));
    expect(mismatch.selector.searches[0].reason).toBe("count_mismatch");
    expect(mismatch.counts.list).toBe(1);
    const worker = harness();
    await beginSearch(worker);
    const wrong = receipt(await worker.send({ kind: "search", ...worker.bracket("LastThreeMonths") }));
    expect(wrong.failures).toEqual(["date_filter_mismatch"]);
    expect(wrong.counts.list).toBe(0);
  });
  it("largest-valid/cap+1 lookup, list, request and page controls discriminate without partial projection", async () => {
    for (const [kind, cap, base] of [
      ["lookup", oracle.lookupBytes, lookup],
      ["list", oracle.listBytes, list],
    ] as const) {
      for (const extra of [0, 1]) {
        const prefix = encode(
          kind === "lookup" ? { ...base, [SENTINEL]: "" } : { ...list, orders: [{ ...list.orders[0], buyerName: "" }] },
        );
        const body = prefix.replace('""', JSON.stringify("x".repeat(cap - prefix.length + extra)));
        expect(Buffer.byteLength(body)).toBe(cap + extra);
        const worker = harness({ responses: { [kind]: { body } } });
        const value = receipt(await worker.run());
        if (extra === 0) {
          expect(value.failures).toEqual([]);
          expect(value.selector.searches[0].qualification).toBe("qualified");
        } else {
          expect(value.failures).toContain("response_ceiling_exceeded");
          expect(value.requests.at(-1)?.shape).toBeNull();
        }
        custody(value);
      }
    }
    const emptyBody = oracle.body.replace(lookup.seller.sellerKey, "");
    for (const extra of [0, 1]) {
      const sellerKey = "x".repeat(oracle.requestBytes - Buffer.byteLength(emptyBody) + extra);
      const value = receipt(
        await harness({ responses: { lookup: { body: encode({ seller: { sellerKey } }) } } }).run(),
      );
      if (extra === 0) expect(value.requests[1].requestBytes).toBe(8192);
      else {
        expect(value.failures).toEqual(["request_ceiling_exceeded"]);
        expect(value.requests).toHaveLength(1);
      }
    }
  });
  it("changed counts veto even an eligible validation fallback", async () => {
    const worker = harness({ responses: { list: { status: 422, body: "{}" } } });
    const value = receipt(await worker.run({ before: 1, after: 2 }));
    expect(value.selector.searches[0].reason).toBe("count_mismatch");
    expect(value.counts).toEqual({ lookup: 1, list: 1, detail: 0 });
    expect(worker.observations).toHaveLength(2);
  });
  it("fallback pre-dispatch refusal does not attach a second search to the first request", async () => {
    const worker = harness({
      responses: { list: { status: 422, body: "{}" } },
      onStorageSet: (value) => {
        if ((value.orderAuthorityLatch as { list?: number })?.list === 2) worker.advance(31000);
      },
    });
    const page = helper(worker, {
      prompts: [
        "LastTwoYears",
        "Ready to Ship",
        "1",
        "LastTwoYears",
        "Ready to Ship",
        "1",
        "LastThreeMonths",
        "Ready to Ship",
        "1",
      ],
      confirms: Array(13).fill(true),
    });
    await page.run();
    const value = exported(page);
    expect(value.failures).toEqual(["bracket_timing"]);
    expect(value.requests.filter((request) => request.kind === "list")).toHaveLength(1);
    retain(page);
    expect(packaging.verifyExport(out).evidence).toBe("synthetic");
    expect(value.selector.searches).toHaveLength(1);
  });
  it("largest closed page is 499 distinct Ready to Ship rows, never a truncated 500-row page", async () => {
    const rows = Array.from({ length: 499 }, (_, index) => ({ ...list.orders[0], orderNumber: `${ORDER}-${index}` }));
    const worker = harness({ responses: { list: { body: encode({ totalOrders: 499, orders: rows }) } } });
    const page = helper(worker, {
      prompts: ["LastTwoYears", "Ready to Ship", "499", "LastTwoYears", "Ready to Ship", "499"],
    });
    await page.run();
    expect(exported(page).selector.searches[0]).toMatchObject({
      qualification: "qualified",
      totalOrders: 499,
      rowCount: 499,
      distinctCount: 499,
    });
    retain(page);
    expect(packaging.verifyExport(out).evidence).toBe("synthetic");
    custody([...page.exports]);
  });
  it("30 s response timeout, cancel, in-flight abort and session loss are terminal, latch survives custody loss", async () => {
    const timeout = harness({ responses: { list: { stall: true } } });
    const pending = timeout.run();
    await timeout.when(() => timeout.observations.length === 2, pending);
    timeout.expireRequest();
    expect(receipt(await pending).failures).toEqual(["response_timeout"]);
    expect(timeout.intervals.size).toBe(0);
    expect(await timeout.send({ kind: "begin" })).toEqual({ ok: false, code: "repeat_invocation" });
    const abort = harness({ responses: { list: { stall: true } } });
    const aborted = abort.run();
    await abort.when(() => abort.observations.length === 2, aborted);
    expect(await abort.send({ kind: "abort" })).toMatchObject({ ok: true, code: "abort_requested" });
    expect(receipt(await aborted).failures).toEqual(["aborted"]);
    const session = harness();
    await beginSearch(session);
    await session.send({ kind: "search", ...session.bracket() });
    expect(receipt(await session.send({ kind: "counts", ...session.bracket(), sameSession: false })).failures).toEqual([
      "session_missing",
    ]);
    const lost = harness();
    await beginSearch(lost);
    lost.restart();
    expect(await lost.send({ kind: "search", ...lost.bracket() })).toEqual({ ok: false, code: "repeat_invocation" });
    expect(await lost.send({ kind: "begin" })).toEqual({ ok: false, code: "repeat_invocation" });
    const cancel = harness();
    await beginSearch(cancel);
    expect(receipt(await cancel.send({ kind: "cancel" })).failures).toEqual(["canceled"]);
  });
  it("request boundary waits for actual delayed initialization, not an event-loop poll budget", async () => {
    let release!: () => void;
    const configurationReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = harness({ configurationReady, responses: { list: { stall: true } } });
    const pending = worker.run();
    let reached = false;
    const boundary = worker
      .when(() => worker.observations.length === 2, pending)
      .then(() => {
        reached = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reached).toBe(false);
    expect(worker.observations).toHaveLength(0);
    release();
    await boundary;
    expect(reached).toBe(true);
    expect(worker.observations).toHaveLength(2);
    await worker.send({ kind: "abort" });
    expect(receipt(await pending).failures).toEqual(["aborted"]);
  });
  it("pre-launch T0 caps begin, expired pre-begin consumes lifecycle and never moves T0", async () => {
    const worker = harness();
    worker.advance(100000);
    await beginSearch(worker);
    const value = receipt(await worker.send({ kind: "cancel" }));
    expect(Date.parse(value.deadlineAt)).toBe(Date.parse(T0) + 900000);
    expect(value.t0).toBe(T0);
    const expired = harness();
    expired.advance(900001);
    const terminal = receipt(await expired.send({ kind: "begin" }));
    expect(terminal.failures).toEqual(["deadline"]);
    expect(terminal.counts.lookup).toBe(0);
    expect(await expired.send({ kind: "begin" })).toEqual({ ok: false, code: "repeat_invocation" });
    const expiredHelper = harness();
    const page = helper(expiredHelper, {
      onDialog: (kind, text) => {
        if (kind === "confirm" && text.includes("HUMAN ONLY")) expiredHelper.advance(900001);
      },
    });
    await page.run();
    expect(exported(page).failures).toEqual(["deadline"]);
    retain(page);
    expect(packaging.verifyExport(out).evidence).toBe("synthetic");
  });
});

describe("selector-custody-and-export", () => {
  it("actual collector/export is recursively closed, with bounded metadata and known package hashes only", async () => {
    const worker = harness();
    const page = helper(worker);
    await page.run();
    retain(page);
    expect(packaging.verifyExport(out)).toMatchObject({
      format: "order-authority-inventory/v4",
      evidence: "synthetic",
      probe: packaging.PROBE,
      head: preparation.head,
    });
    scan(out);
    custody({
      messages: page.messages,
      replies: page.replies,
      retained: worker.retained,
      storage: worker.storage,
      diagnostics: page.diagnostics,
    });
    expect(page.exports.size).toBe(2);
    expect([...page.exports.keys()]).toEqual(["selector-receipt.json", "selector-inventory.json"]);
  });
  it("wrong origin, frame, nested/extra fields and retired messages have zero dispatch", async () => {
    for (const change of [
      { id: "synthetic-wrong-id" },
      { url: "https://synthetic.invalid/capture.html" },
      { origin: "https://synthetic.invalid" },
      { frameId: 1 },
    ]) {
      const worker = harness();
      expect(await worker.send({ kind: "begin" }, { ...worker.sender, ...change })).toEqual({
        ok: false,
        code: "wrong_origin",
      });
      expect(worker.observations).toHaveLength(0);
      expect(worker.retained).toHaveLength(0);
    }
    for (const message of [
      { kind: "begin", [SENTINEL]: SENTINEL },
      { kind: "begin", nested: { [SENTINEL]: SENTINEL } },
      { kind: "capture", selections: [] },
      { kind: "detail", orderNumber: ORDER },
      { kind: "abort", reason: SENTINEL },
    ]) {
      const worker = harness();
      expect(await worker.send(message)).toEqual({ ok: false, code: "invalid_message" });
      expect(worker.observations).toHaveLength(0);
    }
  });
  it("leakage mutants and rehashed raw label/identifier/encoding/hash/error fields are refused by real validator", async () => {
    const privateValues = [
      SENTINEL,
      ORDER,
      lookup.seller.sellerKey,
      encodeURIComponent(ORDER),
      Buffer.from(ORDER).toString("base64"),
      hash(ORDER),
    ];
    for (const privateValue of privateValues) {
      const page = helper(harness());
      await page.run();
      retain(page);
      replaceExport((value) => {
        Object.assign(value.selector.searches[0].before, { label: privateValue });
      });
      expect(() => packaging.verifyExport(out)).toThrow();
    }
    for (const mutate of [
      (value: ReturnType<typeof exported>) => {
        Object.assign(value.selector.searches[0].before, { countSurface: SENTINEL });
      },
      (value: ReturnType<typeof exported>) => {
        value.failures = [SENTINEL];
      },
      (value: ReturnType<typeof exported>) => {
        value.selector.searches[0].listStatuses = [{ surface: "list-display", key: SENTINEL, count: 1 }];
      },
      (value: ReturnType<typeof exported>) => {
        value.requests[0].shape = { fields: [{ field: SENTINEL, types: ["string"] }], omittedFields: 0 };
      },
    ]) {
      const page = helper(harness());
      await page.run();
      retain(page);
      replaceExport(mutate);
      expect(() => packaging.verifyExport(out)).toThrow("export_schema_refused");
    }
    const emitted = readFileSync(path.join(preparation.packageDirectory, "worker.js"), "utf8");
    const mutant = emitted.replace(
      'completeness: "unknown",',
      `completeness: "unknown", raw: ${JSON.stringify(SENTINEL)},`,
    );
    const page = helper(harness({ workerSource: mutant }));
    await page.run();
    retain(page);
    expect(() => custody([...page.exports])).toThrow();
    expect(() => packaging.verifyExport(out)).toThrow("export_schema_refused");
  });
  it("missing pair member, extra/duplicate download, file/hash mismatch and v2/v3 qualification refuse", async () => {
    for (const name of ["selector-receipt.json", "selector-inventory.json"]) {
      const page = helper(harness());
      await page.run();
      retain(page);
      const file = path.join(out, "receipt", name);
      const text = readFileSync(file);
      rmSync(file);
      expect(() => packaging.verifyExport(out)).toThrow("inventory_mismatch");
      writeFileSync(file, text);
    }
    const extra = path.join(out, "receipt", "selector-receipt (1).json");
    writeFileSync(extra, "{}");
    expect(() => packaging.verifyExport(out)).toThrow("inventory_mismatch");
    rmSync(extra);
    for (const format of ["order-authority-receipt/v2", "order-authority-receipt/v3"]) {
      const page = helper(harness());
      await page.run();
      retain(page);
      replaceExport((value) => {
        value.format = format;
      });
      expect(() => packaging.verifyExport(out)).toThrow("export_schema_refused");
    }
    const page = helper(harness());
    await page.run();
    retain(page);
    writeFileSync(path.join(out, "receipt", "selector-receipt.json"), page.exports.get("selector-receipt.json")! + " ");
    expect(() => packaging.verifyExport(out)).toThrow();
    const file = path.join(preparation.packageDirectory, "helper.js");
    const original = readFileSync(file);
    writeFileSync(file, "synthetic-tamper");
    expect(() => packaging.verifyPackage(out)).toThrow("digest_mismatch");
    writeFileSync(file, original);
  });
  it("duplicate JSON keys cannot conceal private payload under a canonical metadata key", async () => {
    const page = helper(harness());
    await page.run();
    retain(page);
    const receiptFile = path.join(out, "receipt", "selector-receipt.json");
    const text = readFileSync(receiptFile, "utf8").replace(
      '"countSurface": "ready-to-ship-quick-filter"',
      `"countSurface": ${JSON.stringify(SENTINEL)}, "countSurface": "ready-to-ship-quick-filter"`,
    );
    writeFileSync(receiptFile, text);
    const indexFile = path.join(out, "receipt", "selector-inventory.json");
    const index = JSON.parse(readFileSync(indexFile, "utf8"));
    index.files["selector-receipt.json"] = hash(text);
    writeFileSync(indexFile, JSON.stringify(index, null, 2) + "\n");
    expect(() => packaging.verifyExport(out)).toThrow();
  });
  it("configuration hash, authority and old-schema refusal consumes latch without lookup", async () => {
    for (const options of [
      { tamper: "helper.js" },
      { missing: "worker.js" },
      { config: { format: "order-authority-package/v2" } },
      { config: { format: "order-authority-package/v3" } },
      { config: { probe: "synthetic-wrong-probe" } },
      { config: { t0: "not-utc" } },
      { config: { cadenceSource: "synthetic-wrong-authority" } },
    ]) {
      const worker = harness(options);
      expect((await worker.send({ kind: "begin" })).ok).toBe(false);
      expect(worker.observations).toHaveLength(0);
      expect(await worker.send({ kind: "begin" })).toEqual({ ok: false, code: "repeat_invocation" });
      custody(worker.retained);
    }
  });
});

describe("selector-lifecycle-removal", () => {
  it("one native selector-only helper, unchanged permissions and HUMAN-only runbook; no prospective detail/bucket/v3 path", () => {
    expect(packaging.verifyPackage(out).qualification).toBe("PENDING_HOST_VERIFIER");
    const worker = readFileSync(path.join(preparation.packageDirectory, "worker.js"), "utf8");
    const page = readFileSync(path.join(preparation.packageDirectory, "helper.js"), "utf8");
    for (const text of [worker, page]) {
      expect(text).not.toContain("BUCKETS");
      expect(text).not.toContain('kind: "capture"');
      expect(text).not.toContain('kind === "detail"');
      expect(text).not.toContain("order-authority-receipt/v3");
      expect(text).not.toContain("8838-receipt.json");
    }
    expect(page).not.toContain("fetch(");
    expect(page).not.toContain("querySelector");
    expect(page).not.toContain("chrome.tabs");
    const manifest = JSON.parse(readFileSync(path.join(preparation.packageDirectory, "manifest.json"), "utf8"));
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.host_permissions).toEqual([
      "https://sp-api.tcgplayer.com/*",
      "https://order-management-api.tcgplayer.com/*",
    ]);
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest).not.toHaveProperty("externally_connectable");
    const runbook = readFileSync(path.join(out, "RUNBOOK.md"), "utf8");
    for (const phrase of [
      "Preparation grants NO execution",
      "No agent/model may access a provider page",
      "HUMAN-only",
      "Pre-begin expiry consumes",
      "no agent auto-delete or offline substitution",
      "zero exact-profile Chrome processes",
      "Late extension absence never satisfies",
    ])
      expect(runbook).toContain(phrase);
    expect(runbook).not.toContain("Privately enter");
    expect(runbook).not.toContain("four details");
  });
  it("residency handles native-dialog dwell without traffic, deadline extension or surviving terminal states", async () => {
    const worker = harness();
    let postBegin = false;
    const page = helper(worker, {
      onDialog: (_kind, text) => {
        if (text.includes("Expected range:")) postBegin = true;
        if (postBegin) {
          const requests = worker.observations.length;
          worker.advance(10000);
          expect(worker.observations).toHaveLength(requests);
        }
      },
    });
    await page.run();
    expect(exported(page).failures).toEqual([]);
    expect(worker.heartbeats.length).toBeGreaterThan(0);
    expect(worker.heartbeats.every((beat) => beat.arguments.length === 0)).toBe(true);
    expect(worker.intervals.size).toBe(0);
    const count = worker.heartbeats.length;
    worker.advance(45000);
    expect(worker.heartbeats).toHaveLength(count);
    for (const terminal of ["cancel", "abort", "invalid", "deadline"] as const) {
      const active = harness();
      await beginSearch(active);
      expect(active.intervals.size).toBe(1);
      if (terminal === "deadline") {
        active.advance(900000);
        expect(await active.send({ kind: "lookup" })).toEqual({ ok: false, code: "repeat_invocation" });
      } else await active.send({ kind: terminal });
      expect(active.intervals.size).toBe(0);
    }
  });
  it("cancel/blank/false settled/fresh-load refusal, wrong helper origin, pagehide and repeat are terminal", async () => {
    for (const prompts of [
      [null],
      ["LastTwoYears", null],
      ["LastTwoYears", "Ready to Ship", ""],
      ["LastTwoYears", "Ready to Ship", null],
    ]) {
      const worker = harness();
      const page = helper(worker, { prompts });
      await page.run();
      expect(exported(page).failures.length).toBeGreaterThan(0);
      expect(worker.intervals.size).toBe(0);
      expect(await page.run()).toEqual({ ok: false, code: "repeat_invocation" });
      custody([...page.exports]);
    }
    for (const confirms of [
      [true, false],
      [true, true, false],
      [true, true, true, false],
    ]) {
      const worker = harness();
      const page = helper(worker, { confirms });
      await page.run();
      expect(exported(page).failures.length).toBeGreaterThan(0);
    }
    const wrong = helper(harness());
    wrong.location.href = "https://synthetic.invalid";
    expect(await wrong.run()).toEqual({ ok: false, code: "wrong_origin" });
    expect(wrong.messages).toHaveLength(0);
    const worker = harness({ responses: { list: { stall: true } } });
    const page = helper(worker);
    const pending = page.run();
    await worker.when(() => worker.observations.length === 2, pending);
    page.pagehide();
    await pending;
    expect(exported(page).failures).toEqual(["aborted"]);
    expect(worker.intervals.size).toBe(0);
  });
  it("actual absence timestamp and exact-profile disposal are required; neither pending export nor offline substitution proves removal", async () => {
    const page = helper(harness());
    await page.run();
    retain(page);
    const value = exported(page);
    expect(packaging.verifyExport(out).removal.confirmation).toBe("pending-operator-removal");
    expect(() => packaging.recordRemoval(out, true, value.finishedAt)).toThrow("removal_not_confirmed");
    // Synthetic empty directory only, checked against this test's created run.
    expect(path.dirname(preparation.profileDirectory)).toBe(out);
    expect(readdirSync(preparation.profileDirectory)).toEqual([]);
    rmdirSync(preparation.profileDirectory);
    try {
      expect(() => packaging.recordRemoval(out, false, value.finishedAt)).toThrow("removal_not_confirmed");
      expect(() => packaging.recordRemoval(out, true)).toThrow("removal_not_confirmed");
      expect(() =>
        packaging.recordRemoval(out, true, new Date(Date.parse(value.deadlineAt) + 1).toISOString()),
      ).toThrow("removal_not_confirmed");
      expect(packaging.recordRemoval(out, true, value.finishedAt).removal.extensionAbsentAt).toBe(value.finishedAt);
      expect(packaging.verifyExport(out).removal.confirmation).toBe(
        "operator-attested-extension-absence-and-profile-disposal",
      );
    } finally {
      mkdirSync(preparation.profileDirectory);
      retain(page);
    }
  });
});

// A separate host-attributed opt-in registration, not a skipped unit test or a
// substitute for HUMAN-route rehearsal. Host must use exclusive heavy admission.
if (process.env.CHASE_SETS_HERMETIC_CHROMIUM === "1") {
  describe("selector-lifecycle-removal host-attributed hermetic Chromium", () => {
    it.each(["qualified", "canceled", "expired"])(
      "native dialogs and terminal %s with synthetic install/removal; provider reachability refused",
      async (scenario) => {
        const { chromium } = await import("@playwright/test");
        const runOut = path.join(mkdtempSync(path.join(scratch, "synthetic-chromium-")), "run");
        const hostPackage = packaging.prepare({
          out: runOut,
          cadenceMs: 1,
          cadenceSource: packaging.AUTHORITY,
          t0: T0,
          synthetic: true,
        });
        const clockOffset = Date.parse(T0) - Date.now();
        const profile = hostPackage.profileDirectory;
        const context = await chromium.launchPersistentContext(profile, {
          headless: false,
          args: [
            "--disable-background-networking",
            "--host-resolver-rules=MAP * ~NOTFOUND",
            "--enable-unsafe-extension-debugging",
            `--disable-extensions-except=${hostPackage.packageDirectory}`,
            `--load-extension=${hostPackage.packageDirectory}`,
          ],
        });
        try {
          const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
          let blocked = 0;
          await context.route("**/*", async (route) => {
            if (new URL(route.request().url()).protocol === "chrome-extension:") await route.continue();
            else {
              blocked += 1;
              await route.abort("blockedbyclient");
            }
          });
          // Provider fetch is replaced inside the installed worker before begin.
          // Unmatched HTTPS requests throw; no live provider route is reachable.
          await worker.evaluate(
            ({ lookup, list, clockOffset, expired }) => {
              const original = globalThis.fetch;
              const originalNow = Date.now;
              const offset = clockOffset + (expired ? 900001 : 0);
              Date.now = () => originalNow() + offset;
              globalThis.fetch = async (input, options) => {
                const url = String(input);
                if (url.startsWith("chrome-extension://")) return original(input, options);
                if (url === "https://sp-api.tcgplayer.com/account/auth-detail?api-version=1.0")
                  return new Response(JSON.stringify(lookup), { headers: { "Content-Type": "application/json" } });
                if (url === "https://order-management-api.tcgplayer.com/orders/search?api-version=2.0")
                  return new Response(JSON.stringify(list), { headers: { "Content-Type": "application/json" } });
                throw new Error("synthetic-provider-reachability-refused");
              };
            },
            { lookup, list, clockOffset, expired: scenario === "expired" },
          );
          expect(
            await worker.evaluate(async () => {
              try {
                await fetch("https://synthetic-provider.invalid/never-live");
                return false;
              } catch (error) {
                return error instanceof Error && error.message === "synthetic-provider-reachability-refused";
              }
            }),
          ).toBe(true);
          const page = await context.newPage();
          await page.goto(`chrome-extension://${hostPackage.extensionId}/capture.html`);
          await page.evaluate((offset) => {
            const original = Date.now;
            Date.now = () => original() + offset;
          }, clockOffset);
          const input = [
            "LastTwoYears",
            "  READY   TO SHIP ",
            "1",
            "LastThreeMonths",
            "LastTwoYears",
            "Ready to Ship",
            "1",
          ];
          const dialogs: string[] = [];
          page.on("dialog", async (dialog) => {
            dialogs.push(dialog.message());
            if (scenario === "canceled" && dialog.type() === "prompt") await dialog.dismiss();
            else if (dialog.type() === "prompt") await dialog.accept(input.shift());
            else await dialog.accept();
          });
          const downloads: Promise<string>[] = [];
          page.on("download", (download) => {
            downloads.push(
              download
                .saveAs(path.join(runOut, "receipt", download.suggestedFilename()))
                .then(() => download.suggestedFilename()),
            );
          });
          expect(
            await page.evaluate(async () => {
              const capture = Reflect.get(globalThis, "orderAuthorityCapture");
              return capture.run();
            }),
          ).toEqual({ ok: true, code: "scrubbed_export_created" });
          await expect.poll(() => downloads.length).toBe(2);
          await Promise.all(downloads);
          expect(downloads).toHaveLength(2);
          expect(dialogs.some((text) => text.includes("load a fresh Orders view"))).toBe(scenario === "qualified");
          expect(packaging.verifyExport(runOut).evidence).toBe("synthetic");
          const output = JSON.parse(readFileSync(path.join(runOut, "receipt", "selector-receipt.json"), "utf8"));
          expect(output.failures).toEqual(
            scenario === "qualified" ? [] : [scenario === "canceled" ? "canceled" : "deadline"],
          );
          expect(output.counts.detail).toBe(0);
          scan(runOut);
          expect(blocked).toBe(0);
          expect(await page.evaluate(async () => Reflect.get(globalThis, "orderAuthorityCapture").run())).toEqual({
            ok: false,
            code: "repeat_invocation",
          });
          const cdp = await context.browser()!.newBrowserCDPSession();
          try {
            await cdp.send("Extensions.uninstall", { id: hostPackage.extensionId });
          } finally {
            await cdp.detach();
          }
          const extensions = await context.newPage();
          await extensions.goto("chrome://extensions/");
          await expect
            .poll(async () =>
              extensions.evaluate((id) => {
                const list = document
                  .querySelector("extensions-manager")
                  ?.shadowRoot?.querySelector("extensions-item-list")?.shadowRoot;
                return list ? list.querySelector(`extensions-item[id="${id}"]`) !== null : null;
              }, hostPackage.extensionId),
            )
            .toBe(false);
        } finally {
          await context.close();
          // Only this synthetic test profile; never a user or provider profile.
          expect(path.dirname(profile)).toBe(runOut);
          rmSync(profile, { recursive: true });
        }
      },
    );
  });
}
