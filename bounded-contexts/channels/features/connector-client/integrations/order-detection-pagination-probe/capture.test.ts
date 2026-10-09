import { createHash, webcrypto } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

const source = path.dirname(fileURLToPath(import.meta.url));
const packaging = await import(new URL("./package.mjs", import.meta.url).href);
const scratch = path.resolve(source, "../../../../../../artifacts/9142/tests");
const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const PRIVATE = "SYNTHETIC_PRIVATE_9142";
const seller = `${PRIVATE}/seller`;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
type Reply = { ok: boolean; code?: string; receipt?: ReturnType<typeof JSON.parse> };
type Caller = { id: string; url: string; origin: string; frameId: number };
type Listener = (message: unknown, sender: Caller, respond: (reply: Reply) => void) => boolean;
type Fixture = {
  body?: string;
  status?: number;
  type?: string;
  stall?: boolean;
  endless?: boolean;
  error?: boolean;
  elapsed?: number;
  bodyStall?: boolean;
};
let out: string;
let preparation: { extensionId: string; packageDirectory: string; head: string; profileDirectory: string };

function cohort(total: number, change: Record<string, unknown> = {}) {
  return Array.from({ length: Math.max(1, Math.floor(total / 8) + 1) }, (_, page) => ({
    totalOrders: total,
    orders: Array.from({ length: Math.min(8, Math.max(0, total - page * 8)) }, (_, row) => ({
      orderNumber: `${PRIVATE}/order-${page * 8 + row}`,
      orderDate: "2000-01-01",
      orderStatus: "Ready to Ship",
      buyerName: PRIVATE,
      [PRIVATE]: { cookie: PRIVATE },
    })),
    syntheticAuthority: {
      snapshot: `${PRIVATE}/snapshot`,
      seller,
      effectiveSize: 8,
      mechanism: "snapshot",
      immutableTie: true,
      entryCoverage: true,
      allEligible: true,
      resultCap: 1000,
      pageCap: 1000,
      expiresAt: T0 + 900000,
      next: page * 8 + 8 <= total ? `${PRIVATE}/cursor-${page + 1}` : null,
      safeNext: true,
      terminal: page * 8 + 8 > total,
      negativeCovered: true,
      olderEntryCovered: true,
      ...change,
    },
  }));
}

beforeAll(() => {
  mkdirSync(scratch, { recursive: true });
  out = path.join(mkdtempSync(path.join(scratch, "emitted-")), "run");
  preparation = packaging.prepare({ out, synthetic: true, t0: T0 });
});

function harness(
  options: {
    pages?: unknown[];
    fixtures?: Fixture[];
    lookup?: Fixture;
    workerSource?: string;
    storage?: Record<string, unknown>;
    evidence?: string;
    tamper?: string;
    holdCadence?: boolean;
  } = {},
) {
  let now = T0;
  let sequence = 0;
  let listener: Listener;
  const storage = options.storage ?? {};
  const retained: unknown[] = [];
  const wire: { url: string; request: RequestInit; at: number }[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  const intervals = new Map<number, { at: number; delay: number; callback: () => void }>();
  const origin = `chrome-extension://${preparation.extensionId}`;
  const sender = { id: preparation.extensionId, url: `${origin}/capture.html`, origin, frameId: 0 };
  const config = JSON.parse(readFileSync(path.join(preparation.packageDirectory, "capture-config.json"), "utf8"));
  if (options.evidence) config.evidence = options.evidence;
  let custody = true;
  const localFetch = async (url: string, request: RequestInit = {}) => {
    if (url.startsWith(`${origin}/`)) {
      const name = url.slice(origin.length + 1);
      if (name === "capture-config.json") return new Response(json(config));
      if (!["worker.js", "helper.js", "manifest.json", "capture.html"].includes(name))
        throw new Error("synthetic path");
      return new Response(
        options.tamper === name ? "tampered" : readFileSync(path.join(preparation.packageDirectory, name)),
      );
    }
    // No socket, browser, provider session or credential is ever used by this transport.
    expect([
      "https://sp-api.tcgplayer.com/account/auth-detail?api-version=1.0",
      "https://order-management-api.tcgplayer.com/orders/search?api-version=2.0",
    ]).toContain(url);
    wire.push({ url, request, at: now });
    const lookup = url.includes("auth-detail");
    const page = wire.filter((read) => !read.url.includes("auth-detail")).length - 1;
    const fixture = (lookup ? options.lookup : options.fixtures?.[page]) ?? {};
    if (fixture.error) throw new Error(PRIVATE);
    now += fixture.elapsed ?? 0;
    if (fixture.stall) return new Promise<Response>(() => {});
    let body: BodyInit;
    if (fixture.endless)
      body = new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(16384));
        },
      });
    else if (fixture.bodyStall)
      body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
      });
    else {
      const bytes = new TextEncoder().encode(
        fixture.body ??
          json(lookup ? { seller: { sellerKey: seller }, cookie: PRIVATE } : (options.pages ?? cohort(9))[page]),
      );
      let offset = 0;
      body = new ReadableStream({
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(offset, offset + 16384));
          offset = Math.min(bytes.length, offset + 16384);
        },
      });
    }
    return new Response(body, {
      status: fixture.status ?? 200,
      headers: { "Content-Type": fixture.type ?? "application/json" },
    });
  };
  class Clock extends Date {
    static override now() {
      return now;
    }
  }
  const context = createContext({
    chrome: {
      runtime: {
        id: preparation.extensionId,
        getURL: (name: string) => `${origin}/${name}`,
        getPlatformInfo: async () => {
          if (!custody) throw new Error(PRIVATE);
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
          get: async () => structuredClone(storage),
          set: async (value: Record<string, unknown>) => {
            Object.assign(storage, structuredClone(value));
            retained.push(structuredClone(value));
          },
          setAccessLevel: async (value: unknown) => {
            retained.push(value);
          },
        },
      },
    },
    fetch: localFetch,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    AbortController,
    Date: Clock,
    console: {
      log: (...values: unknown[]) => retained.push(values),
      error: (...values: unknown[]) => retained.push(values),
    },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++sequence;
      if (delay < 30000) {
        now += delay;
        queueMicrotask(callback);
      } else timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (callback: () => void, delay: number) => {
      const id = ++sequence;
      intervals.set(id, { at: now + delay, delay, callback });
      return id;
    },
    clearInterval: (id: number) => intervals.delete(id),
  });
  const restart = () => {
    timers.clear();
    intervals.clear();
    new Script(
      options.workerSource ?? readFileSync(path.join(preparation.packageDirectory, "worker.js"), "utf8"),
    ).runInContext(context);
  };
  restart();
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = Math.min(...[...timers.values(), ...intervals.values()].map((timer) => timer.at));
      if (next > end) break;
      now = next;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      for (const timer of [...intervals.values()])
        if (timer.at <= now) {
          timer.at += timer.delay;
          timer.callback();
        }
    }
    now = end;
  };
  const send = async (message: unknown, caller = sender) => {
    if (
      !options.holdCadence &&
      message &&
      typeof message === "object" &&
      "kind" in message &&
      message.kind === "page" &&
      wire.length
    ) {
      const gap = wire.at(-1)!.at + 30000 - now;
      if (gap > 0) advance(gap);
    }
    const output = await new Promise<Reply>((resolve) => listener(message, caller, resolve));
    await Promise.resolve();
    await Promise.resolve();
    return output;
  };
  const run = async () => {
    let reply = await send({ kind: "begin" });
    if (!reply.ok || reply.receipt) return reply;
    reply = await send({ kind: "lookup" });
    for (let index = 0; index < 8 && reply.ok && !reply.receipt; index += 1) reply = await send({ kind: "page" });
    return reply.receipt || !reply.ok ? reply : send({ kind: "finish" });
  };
  return {
    send,
    run,
    wire,
    storage,
    retained,
    sender,
    restart,
    advance,
    intervals,
    loseCustody: () => {
      custody = false;
    },
  };
}

function helper(
  worker: ReturnType<typeof harness>,
  options: { source?: string; confirms?: boolean[]; onConfirm?: () => void; response?: Reply } = {},
) {
  const exports = new Map<string, string>();
  const blobs = new Map<string, Blob>();
  const downloads: Promise<void>[] = [];
  const confirms = [...(options.confirms ?? Array(12).fill(true))];
  let pagehide = () => {};
  let blob = 0;
  const diagnostics: unknown[] = [];
  const messages: unknown[] = [];
  const location = { href: worker.sender.url };
  const window = {};
  Object.assign(window, { top: window });
  const api = createContext({
    window,
    location,
    crypto: webcrypto,
    TextEncoder,
    Blob,
    chrome: {
      runtime: {
        id: preparation.extensionId,
        getURL: (name: string) => `chrome-extension://${preparation.extensionId}/${name}`,
        sendMessage: (message: unknown) => {
          messages.push(message);
          return options.response ?? worker.send(message);
        },
      },
    },
    confirm: () => {
      options.onConfirm?.();
      return confirms.shift() ?? false;
    },
    addEventListener: (_name: string, callback: () => void) => {
      pagehide = callback;
    },
    URL: {
      createObjectURL: (value: Blob) => {
        const id = `blob:synthetic-${++blob}`;
        blobs.set(id, value);
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
            const value = blobs.get(link.href);
            if (value)
              downloads.push(
                value.text().then((text) => {
                  exports.set(link.download, text);
                }),
              );
          },
        };
        return link;
      },
    },
    console: {
      log: (...values: unknown[]) => diagnostics.push(values),
      error: (...values: unknown[]) => diagnostics.push(values),
    },
    setTimeout: (callback: () => void) => queueMicrotask(callback),
  });
  new Script(options.source ?? readFileSync(path.join(preparation.packageDirectory, "helper.js"), "utf8")).runInContext(
    api,
  );
  return {
    api,
    location,
    exports,
    diagnostics,
    messages,
    pagehide: () => pagehide(),
    run: async () => {
      const reply = await api.detectionPaginationCapture.run();
      await Promise.all(downloads);
      return reply;
    },
  };
}
function scrub(value: unknown) {
  const text = json(value);
  for (const token of [PRIVATE, seller, `${PRIVATE}/snapshot`, `${PRIVATE}/cursor-1`, `${PRIVATE}/order-0`]) {
    expect(text).not.toContain(token);
    expect(text).not.toContain(encodeURIComponent(token));
    expect(text).not.toContain(Buffer.from(token).toString("base64"));
    expect(text).not.toContain(hash(token));
  }
}
function retain(page: ReturnType<typeof helper>) {
  for (const [name, text] of page.exports) writeFileSync(path.join(out, "receipt", name), text);
}
async function capture(options: Parameters<typeof harness>[0] = {}) {
  const worker = harness(options);
  const page = helper(worker);
  expect(await page.run()).toEqual({ ok: true, code: "scrubbed_export_created" });
  retain(page);
  packaging.verifyExport(out);
  const value = JSON.parse(page.exports.get("9142-receipt.json")!);
  scrub({
    value,
    exports: [...page.exports],
    storage: worker.storage,
    retained: worker.retained,
    diagnostics: page.diagnostics,
    messages: page.messages,
  });
  return { worker, page, value };
}

describe("detection-pagination-helper-lifecycle", () => {
  it("worker owns the unchanged 30 s serial gap and aborts a pending cadence wait", async () => {
    const worker = harness({ holdCadence: true });
    await worker.send({ kind: "begin" });
    await worker.send({ kind: "lookup" });
    const pending = worker.send({ kind: "page" });
    await Promise.resolve();
    worker.advance(29999);
    await Promise.resolve();
    expect(worker.wire).toHaveLength(1);
    worker.advance(1);
    expect((await pending).code).toBe("next");
    expect(worker.wire[1].at - worker.wire[0].at).toBe(30000);
    const waiting = worker.send({ kind: "page" });
    await Promise.resolve();
    await worker.send({ kind: "abort" });
    expect((await waiting).receipt.reason).toBe("aborted");
    expect(worker.wire).toHaveLength(2);
    expect(worker.intervals.size).toBe(0);
  });
  async function lifecycle(workerSource?: string) {
    const { worker, page, value } = await capture({ workerSource });
    expect(value.requestedSize).toBe(8);
    expect(value.pages.map((item: { effectiveSize: number }) => item.effectiveSize)).toEqual([8, 8]);
    expect(value.counts).toEqual({ lookup: 1, page: 2, detail: 0, write: 0 });
    for (const read of worker.wire.slice(1)) expect(JSON.parse(String(read.request.body)).size).toBe(8);
    expect(worker.wire.every((read, index) => !index || read.at - worker.wire[index - 1].at >= 30000)).toBe(true);
    expect(value.facts.pagination).toBe("qualified");
    expect(await page.run()).toEqual({ ok: false, code: "repeat_invocation" });
    expect(await worker.send({ kind: "begin" })).toEqual({ ok: false, code: "repeat_invocation" });
    worker.restart();
    worker.advance(86400000);
    expect(await worker.send({ kind: "begin" })).toEqual({ ok: false, code: "repeat_invocation" });
    expect(worker.wire).toHaveLength(3);
    expect(worker.intervals.size).toBe(0);
  }
  it("emitted helper -> worker -> exporter -> validator; size-500 mutant fails the same frozen control", async () => {
    await lifecycle();
    const emitted = readFileSync(path.join(preparation.packageDirectory, "worker.js"), "utf8");
    const mutant = emitted.replace("const SIZE = 8;", "const SIZE = 500;");
    expect(mutant).not.toBe(emitted);
    await expect(lifecycle(mutant)).rejects.toThrow();
    const result = await harness({ workerSource: mutant }).run();
    expect(result.receipt.reason).toBe("size_mismatch");
  });
  it("preparation, install, reload are inert; live discovery unknown before unsupported next or detection relay", async () => {
    expect(packaging.verifyPackage(out).head).toBe(preparation.head);
    const worker = harness({ evidence: "operator" });
    helper(worker);
    worker.restart();
    expect(worker.wire).toEqual([]);
    expect(worker.storage).toEqual({});
    const value = (await worker.run()).receipt;
    expect(value.state).toBe("unknown");
    expect(value.reason).toBe("discovery_unknown");
    expect(Object.values(value.facts)).toEqual(Array(5).fill("unknown"));
    expect(value.pages[0].effectiveSize).toBeNull();
    expect(worker.wire).toHaveLength(2);
    expect(JSON.parse(String(worker.wire[1].request.body))).toEqual({
      searchRange: "LastTwoYears",
      filters: { sellerKey: seller, orderStatuses: ["ReadyToShip"] },
      sortBy: [],
      from: 0,
      size: 8,
    });
    const manifest = JSON.parse(readFileSync(path.join(preparation.packageDirectory, "manifest.json"), "utf8"));
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.content_scripts).toBeUndefined();
    const runbook = readFileSync(path.join(out, "RUNBOOK.md"), "utf8");
    for (const term of [
      "before first profile launch",
      "HUMAN Chrome UI removal",
      "#9115/#8838 profiles absent",
      "no renewals",
      "BOTH #8612 and #9144",
      "discovery_unknown",
      "10000 ms",
      "zero exact-profile processes",
      "Day-after",
    ])
      expect(runbook).toContain(term);
  });
  it("origin/schema/package guards, one-begin burned before package validation", async () => {
    for (const field of ["id", "url", "origin", "frameId"] as const) {
      const worker = harness();
      const caller = { ...worker.sender, [field]: field === "frameId" ? 1 : "synthetic-wrong" };
      expect(await worker.send({ kind: "begin" }, caller)).toEqual({ ok: false, code: "wrong_origin" });
      expect(worker.storage).toEqual({});
      expect(worker.wire).toEqual([]);
    }
    for (const input of [{ kind: "begin", cursor: PRIVATE }, { kind: { nested: PRIVATE } }, { kind: "details" }]) {
      const worker = harness();
      expect(await worker.send(input)).toEqual({ ok: false, code: "invalid_message" });
      expect(worker.wire).toEqual([]);
      scrub(worker.storage);
    }
    for (const tamper of ["worker.js", "helper.js", "manifest.json", "capture.html"]) {
      const worker = harness({ tamper });
      expect((await worker.run()).code).toBe("package_mismatch");
      expect((await worker.run()).code).toBe("repeat_invocation");
      expect(worker.wire).toEqual([]);
    }
    const page = helper(harness());
    page.location.href += "?input";
    expect(await page.run()).toEqual({ ok: false, code: "wrong_origin" });
    expect(page.messages).toEqual([]);
    expect(await page.api.detectionPaginationCapture.run(PRIVATE)).toEqual({ ok: false, code: "wrong_origin" });
  });
});

describe("detection-pagination-authority-controls", () => {
  it("older-entry negative needs entry coverage despite equal totals and known head; bypass is discriminating", async () => {
    const positive = await capture({ pages: cohort(0) });
    expect(positive.value.facts.detection).toBe("qualified");
    const pages = cohort(0, { olderEntryCovered: false });
    const { value } = await capture({ pages });
    expect(value.reason).toBe("frontier_unknown");
    expect(value.facts.detection).toBe("unknown");
    const emitted = readFileSync(path.join(preparation.packageDirectory, "worker.js"), "utf8");
    const mutant = emitted.replace(" && proof?.olderEntryCovered === true", "");
    expect(mutant).not.toBe(emitted);
    const changed = (await harness({ pages, workerSource: mutant }).run()).receipt;
    expect(changed.reason).toBe("qualified");
    expect(() => expect(changed.facts.detection).toBe("unknown")).toThrow();
    for (const mechanism of ["creation-sort", "count", "cache", "known-head", "202"]) {
      const negative = await capture({ pages: cohort(0, { mechanism }) });
      expect(negative.value.reason).toBe("frontier_unknown");
    }
  });
  it.each(["snapshot", "keyset"])(
    "frozen %s survives insertion/removal/reorder/equal-count churn with ties",
    async (mechanism) => {
      const pages = cohort(17, { mechanism });
      pages[1].orders.reverse(); // Live collection can churn; frozen cohort response remains the authority.
      for (const page of pages) for (const order of page.orders) order.orderDate = "2000-01-01";
      const { value } = await capture({ pages });
      expect(value.state).toBe("qualified");
      expect(value.distinctCount).toBe(17);
      expect(value.facts.pagination).toBe("qualified");
    },
  );
  const cases = [
    { name: "offset churn", change: { mechanism: "offset" }, reason: "offset_unknown" },
    { name: "excluded eligible older order", change: { allEligible: false }, reason: "range_unknown" },
    { name: "mutable equal-key tie", change: { immutableTie: false }, reason: "frontier_unknown" },
    { name: "frontier lacks entry coverage", change: { entryCoverage: false }, reason: "frontier_unknown" },
    { name: "expired frontier", change: { expiresAt: T0 }, reason: "frontier_expired" },
    { name: "missing hard cap", change: { resultCap: null }, reason: "discovery_unknown" },
    { name: "result cap hit", change: { resultCap: 9 }, reason: "cap_hit" },
    { name: "page cap hit", change: { pageCap: 1 }, reason: "cap_hit" },
    { name: "unsafe next", change: { safeNext: false }, reason: "unsafe_next" },
    { name: "session replacement", change: { seller: `${PRIVATE}/other` }, reason: "session_loss" },
    { name: "provider clamps size", change: { effectiveSize: 500 }, reason: "size_mismatch" },
  ];
  it.each(cases)("$name remains unknown for the governing clause", async ({ change, reason }) => {
    const { value, worker } = await capture({ pages: cohort(9, change) });
    expect(value.reason).toBe(reason);
    expect(value.state).toBe("unknown");
    expect(worker.wire).toHaveLength(2);
  });
  it("replaced frontier, missing totals, duplicate/missing tail, cursor cycle and full page require continuation", async () => {
    const replaced = cohort(9);
    replaced[1].syntheticAuthority.snapshot = `${PRIVATE}/replaced`;
    expect((await capture({ pages: replaced })).value.reason).toBe("frontier_replaced");
    const duplicate = cohort(9);
    duplicate[1].orders[0] = duplicate[0].orders[0];
    expect((await capture({ pages: duplicate })).value.reason).toBe("duplicate");
    const missing = cohort(9);
    missing[1].orders = [];
    expect((await capture({ pages: missing })).value.reason).toBe("tail_missing");
    const total = cohort(9).map(({ totalOrders: _, ...page }) => page);
    expect((await capture({ pages: total })).value.reason).toBe("total_missing");
    const cycle = cohort(17);
    cycle[1].syntheticAuthority.next = cycle[0].syntheticAuthority.next;
    expect((await capture({ pages: cycle })).value.reason).toBe("unsafe_next");
    const full = cohort(8, { next: null, terminal: true });
    expect((await capture({ pages: full })).value.reason).toBe("tail_missing");
    expect((await capture({ pages: cohort(8) })).value.facts.pagination).toBe("unknown");
    expect((await capture({ pages: cohort(1) })).value.facts.pagination).toBe("unknown");
  });
  it.each([101, 300, 301, 500, 800])(
    "synthetic cohort %i honestly exhausts eight size-8 reads, never truncates PASS",
    async (total) => {
      const { value, worker } = await capture({ pages: cohort(total) });
      expect(value.state).toBe("unknown");
      expect(value.reason).toBe("request_cap");
      expect(value.distinctCount).toBe(64);
      expect(value.total).toBe(total);
      expect(value.counts.page).toBe(8);
      expect(worker.wire).toHaveLength(9);
    },
  );
  it("cap+1 control and one-clause bypass keep all other authority frozen", async () => {
    expect((await capture({ pages: cohort(9, { resultCap: 10 }) })).value.state).toBe("qualified");
    const pages = cohort(10, { resultCap: 10 });
    const { value } = await capture({ pages });
    expect(value.reason).toBe("cap_hit");
    const emitted = readFileSync(path.join(preparation.packageDirectory, "worker.js"), "utf8");
    const mutant = emitted.replace("state.total >= page.hardResultCap || ", "");
    expect(mutant).not.toBe(emitted);
    const changed = (await harness({ pages, workerSource: mutant }).run()).receipt;
    expect(changed.reason).toBe("qualified");
    expect(() => expect(changed.state).toBe("unknown")).toThrow();
  });
});

describe("detection-pagination-custody-and-byte-controls", () => {
  it.each(["lookup", "page"])("%s largest-valid/cap+1/endless body; no partial qualification", async (kind) => {
    const cap = kind === "lookup" ? 65536 : 1048576;
    const base = json(kind === "lookup" ? { seller: { sellerKey: seller } } : cohort(0)[0]);
    const fixture = (extra: number): Fixture => ({ body: base + " ".repeat(cap + extra - Buffer.byteLength(base)) });
    const options = (response: Fixture) =>
      kind === "lookup" ? { lookup: response, pages: cohort(0) } : { fixtures: [response] };
    const positive = await capture(options(fixture(0)));
    expect(positive.value.state).toBe("qualified");
    expect(positive.value.requests.find((read: { kind: string }) => read.kind === kind).responseBytes).toBe(cap);
    for (const response of [fixture(1), { endless: true }]) {
      const { value } = await capture(options(response));
      expect(value.reason).toBe("response_bytes");
      expect(value.requests.at(-1).responseComplete).toBe(false);
      expect(value.state).toBe("unknown");
    }
  });
  it("request largest-valid/cap+1 and session largest-valid/cap+1 use actual complete byte accounting", async () => {
    const base = JSON.stringify({
      searchRange: "LastTwoYears",
      filters: { sellerKey: "", orderStatuses: ["ReadyToShip"] },
      sortBy: [],
      from: 0,
      size: 8,
    });
    for (const extra of [0, 1]) {
      const input = "S".repeat(8192 - Buffer.byteLength(base) + extra);
      const pages = cohort(0, { seller: input });
      const { value, worker } = await capture({ pages, lookup: { body: json({ seller: { sellerKey: input } }) } });
      expect(value.reason).toBe(extra ? "request_bytes" : "qualified");
      expect(worker.wire).toHaveLength(extra ? 1 : 2);
      if (!extra) expect(value.requests[1].requestBytes).toBe(8192);
    }
    const pages = cohort(57);
    const baseline = (await harness({ pages }).run()).receipt;
    const lookupBytes = baseline.requests[0].responseBytes;
    const requestBytes = baseline.requests.reduce(
      (sum: number, read: { requestBytes: number }) => sum + read.requestBytes,
      0,
    );
    for (const extra of [0, 1]) {
      const fixtures = pages.map((page, index) => {
        const basePage = json(page);
        const bytes = index === 7 ? 8388608 - requestBytes - lookupBytes - 7 * 1048576 + extra : 1048576;
        return { body: basePage + " ".repeat(bytes - Buffer.byteLength(basePage)) };
      });
      const { value } = await capture({ pages, fixtures });
      expect(value.totalBytes).toBe(8388608 + extra);
      expect(value.reason).toBe(extra ? "session_bytes" : "qualified");
    }
  });
  it.each([401, 403, 429, 302, 500])("HTTP %i is terminal without retry", async (status) => {
    const { value, worker } = await capture({ fixtures: [{ status }] });
    expect(value.reason).toBe(status === 302 ? "redirect" : status === 500 ? "http_status" : "session_loss");
    expect(worker.wire).toHaveLength(2);
  });
  it("login/transport and body timeout, cancellation, pagehide, restart/custody loss and fixed expiry", async () => {
    for (const fixture of [{ type: "text/html" }, { error: true }, { body: "invalid" }]) {
      const { value, worker } = await capture({ fixtures: [fixture] });
      expect(value.state).toBe("unknown");
      expect(worker.wire).toHaveLength(2);
    }
    for (const fixture of [{ stall: true }, { bodyStall: true }]) {
      const worker = harness({ lookup: fixture });
      const page = helper(worker);
      const pending = page.run();
      for (let tries = 0; tries < 100 && worker.wire.length === 0; tries += 1)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(worker.wire).toHaveLength(1);
      worker.advance(30000);
      await pending;
      const value = JSON.parse(page.exports.get("9142-receipt.json")!);
      expect(value.reason).toBe("timeout");
      retain(page);
      packaging.verifyExport(out);
      expect(value.requests[0].elapsedMs).toBe(30000);
      scrub(value);
    }
    const pendingWorker = harness({ lookup: { bodyStall: true } });
    const pendingPage = helper(pendingWorker);
    const reading = pendingPage.run();
    for (let tries = 0; tries < 100 && pendingWorker.wire.length === 0; tries += 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    pendingPage.pagehide();
    await reading;
    const aborted = JSON.parse(pendingPage.exports.get("9142-receipt.json")!);
    expect(aborted.reason).toBe("aborted");
    expect(aborted.requests[0].responseComplete).toBe(false);
    expect(pendingWorker.wire).toHaveLength(1);
    retain(pendingPage);
    packaging.verifyExport(out);
    const canceled = helper(harness(), { confirms: [true, false] });
    await canceled.run();
    expect(JSON.parse(canceled.exports.get("9142-receipt.json")!).reason).toBe("canceled");
    const stopped = harness();
    await stopped.send({ kind: "begin" });
    await stopped.send({ kind: "lookup" });
    const closing = helper(stopped);
    closing.pagehide();
    await closing.api.detectionPaginationCapture.abort();
    expect((await stopped.send({ kind: "begin" })).code).toBe("repeat_invocation");
    const restarted = harness();
    await restarted.send({ kind: "begin" });
    restarted.restart();
    expect((await restarted.send({ kind: "lookup" })).code).toBe("repeat_invocation");
    expect(restarted.wire).toEqual([]);
    const custody = harness();
    await custody.send({ kind: "begin" });
    custody.loseCustody();
    custody.advance(20000);
    await Promise.resolve();
    await Promise.resolve();
    expect((await custody.send({ kind: "finish" })).receipt.reason).toBe("custody_loss");
    const expired = harness();
    await expired.send({ kind: "begin" });
    expired.advance(900000);
    expect((await expired.send({ kind: "finish" })).receipt.state).toBe("expired");
    expect(expired.wire).toEqual([]);
    expect(expired.intervals.size).toBe(0);
    scrub(expired.storage);
  });
  it("FINAL 10 s classification is separate from unchanged probe 30 s timeout", async () => {
    const { value } = await capture({ fixtures: [{ elapsed: 10001 }] });
    expect(value.state).toBe("qualified");
    expect(value.requests[1].withinFinalCall).toBe(false);
    expect(value.facts.envelope).toBe("unknown");
  });
  it("closed hash-bound export rejects missing/extra/nested/old/tampered payload and rehashed leaks", async () => {
    const { page } = await capture();
    const original = page.exports.get("9142-receipt.json")!;
    const originalIndex = page.exports.get("9142-inventory.json")!;
    for (const field of ["leak", "nested", "old", "verdict", "count", "bytes", "size"]) {
      const value = JSON.parse(original);
      const index = JSON.parse(originalIndex);
      if (field === "leak") value.snapshot = PRIVATE;
      if (field === "nested") value.pages[0].snapshot = { value: PRIVATE };
      if (field === "old") value.format = "order-authority-receipt/v3";
      if (field === "verdict") value.facts.detection = "qualified";
      if (field === "count") value.counts.page = 1;
      if (field === "bytes") value.totalBytes += 1;
      if (field === "size") value.pages[0].effectiveSize = 500;
      const text = json(value);
      index.files["9142-receipt.json"] = hash(text);
      writeFileSync(path.join(out, "receipt", "9142-receipt.json"), text);
      writeFileSync(path.join(out, "receipt", "9142-inventory.json"), json(index));
      expect(() => packaging.verifyExport(out), field).toThrow();
    }
    retain(page);
    const duplicateKey = original.replace('"requestedSize": 8,', '"requestedSize": 500, "requestedSize": 8,');
    expect(duplicateKey).not.toBe(original);
    const rehashed = JSON.parse(originalIndex);
    rehashed.files["9142-receipt.json"] = hash(duplicateKey);
    writeFileSync(path.join(out, "receipt", "9142-receipt.json"), duplicateKey);
    writeFileSync(path.join(out, "receipt", "9142-inventory.json"), json(rehashed));
    expect(() => packaging.verifyExport(out)).toThrow("closed_schema");
    retain(page);
    const duplicate = path.join(out, "receipt", "9142-receipt (1).json");
    writeFileSync(duplicate, original);
    expect(() => packaging.verifyExport(out)).toThrow("inventory");
    rmSync(duplicate);
    const nested = path.join(out, "receipt", "nested");
    mkdirSync(nested);
    expect(() => packaging.verifyExport(out)).toThrow("inventory");
    rmdirSync(nested);
    const missing = path.join(out, "receipt", "9142-receipt.json");
    rmSync(missing);
    expect(() => packaging.verifyExport(out)).toThrow("inventory");
    retain(page);
    writeFileSync(missing, original + " ");
    expect(() => packaging.verifyExport(out)).toThrow("closed_schema");
    retain(page);
    const emitted = readFileSync(path.join(preparation.packageDirectory, "worker.js"), "utf8");
    for (const mutant of [
      emitted.replace("reason: code,", `reason: code, leaked: ${JSON.stringify(PRIVATE)},`),
      emitted.replace(
        "state.latch.counts[kind] += 1;",
        `await chrome.storage.local.set({ leaked: ${JSON.stringify(PRIVATE)} }); state.latch.counts[kind] += 1;`,
      ),
    ]) {
      expect(mutant).not.toBe(emitted);
      const worker = harness({ workerSource: mutant });
      const reply = await worker.run();
      expect(() => scrub({ reply, storage: worker.storage })).toThrow();
    }
    const emittedHelper = readFileSync(path.join(preparation.packageDirectory, "helper.js"), "utf8");
    const leak = emittedHelper.replace(
      "const text = JSON.stringify(receipt,",
      `receipt.leaked = ${JSON.stringify(PRIVATE)}; const text = JSON.stringify(receipt,`,
    );
    expect(leak).not.toBe(emittedHelper);
    const leaking = helper(harness(), { source: leak });
    await leaking.run();
    expect(() => scrub([...leaking.exports])).toThrow();
    retain(leaking);
    expect(() => packaging.verifyExport(out)).toThrow("closed_schema");
    retain(page);
  });
  it("export cap+1 creates no partial downloads; removal remains pending until all custody observations", async () => {
    const { page, value } = await capture();
    // This synthetic extra field isolates the exporter byte guard; the closed
    // validator must reject it even when it fits the byte limit.
    const base = { ...value, extra: "" };
    const length = Buffer.byteLength(json(base));
    for (const extra of [0, 1]) {
      const payload = { ...base, extra: "X".repeat(65536 - length + extra) };
      expect(Buffer.byteLength(json(payload))).toBe(65536 + extra);
      const boundary = helper(harness(), { response: { ok: true, receipt: payload } });
      expect(await boundary.run()).toEqual(
        extra ? { ok: false, code: "capture_refused" } : { ok: true, code: "scrubbed_export_created" },
      );
      expect(boundary.exports.size).toBe(extra ? 0 : 2);
      if (!extra) {
        retain(boundary);
        expect(() => packaging.verifyExport(out)).toThrow("closed_schema");
      }
    }
    retain(page);
    expect(packaging.verifyExport(out).removal.extensionAbsent).toBe(false);
    expect(() => packaging.recordRemoval(out, true, false)).toThrow("custody");
    expect(() => packaging.recordRemoval(out, true, true)).toThrow("custody");
    const profile = path.resolve(preparation.profileDirectory);
    expect(path.dirname(profile)).toBe(path.resolve(out));
    expect(profile.startsWith(scratch + path.sep)).toBe(true);
    rmSync(profile, { recursive: true });
    expect(() => packaging.recordRemoval(out, true, true, T0 + 900001)).toThrow("custody");
    expect(() => packaging.recordRemoval(out, true, true, T0)).toThrow("custody");
    expect(packaging.recordRemoval(out, true, true, T0 + 899000).removal).toEqual({
      extensionAbsent: true,
      profileDisposed: true,
      processesAbsent: true,
      extensionAbsentAt: T0 + 899000,
    });
    for (const name of ["worker.js", "helper.js", "capture.html", "manifest.json"]) {
      const file = path.join(preparation.packageDirectory, name);
      const before = readFileSync(file);
      writeFileSync(file, "tampered");
      expect(() => packaging.verifyPackage(out)).toThrow("digests");
      writeFileSync(file, before);
    }
    for (const name of readdirSync(path.join(out, "receipt")))
      scrub(readFileSync(path.join(out, "receipt", name), "utf8"));
  });
});
