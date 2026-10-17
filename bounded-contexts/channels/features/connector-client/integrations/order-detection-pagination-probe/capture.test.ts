import { createHash, webcrypto } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, Script } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

const source = path.dirname(fileURLToPath(import.meta.url));
const packaging = await import(new URL("./package.mjs", import.meta.url).href);
const scratch = path.resolve(source, "../../../../../../artifacts/9142/tests");
const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const PRIVATE = "SYNTHETIC_PRIVATE_9142";
const seller = `${PRIVATE}:seller`;
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
  ignoreAbort?: boolean;
};
type ReadPhase = "headers" | "body" | "latch";
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
      snapshotCount: total,
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
  console.info(`SYNTHETIC_9181 emitted controls: ${path.dirname(out)}`);
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
    holdLatch?: "lookup" | "page";
    onReadPhase?: (kind: "lookup" | "page", phase: ReadPhase) => void;
  } = {},
) {
  let now = T0;
  let ticking = false;
  let releaseLatch = () => {};
  let releaseRead = () => {};
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
    const kind = lookup ? "lookup" : "page";
    const page = wire.filter((read) => !read.url.includes("auth-detail")).length - 1;
    const fixture = (lookup ? options.lookup : options.fixtures?.[page]) ?? {};
    if (fixture.error) throw new Error(PRIVATE);
    now += fixture.elapsed ?? 0;
    if (fixture.stall) {
      options.onReadPhase?.(kind, "headers");
      return new Promise<Response>((resolve) => {
        releaseRead = () => resolve(new Response(json({ seller: { sellerKey: seller } })));
      });
    }
    if (fixture.bodyStall && fixture.ignoreAbort) {
      let reads = 0;
      return {
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        body: {
          getReader: () => ({
            read: async () => {
              if (++reads === 1) return { done: false, value: new TextEncoder().encode("{") };
              options.onReadPhase?.(kind, "body");
              return new Promise((resolve) => {
                releaseRead = () => resolve({ done: false, value: new TextEncoder().encode(PRIVATE) });
              });
            },
            cancel: () => new Promise(() => {}),
          }),
        },
      };
    }
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
      return ticking ? now++ : now;
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
            const latch = value.detectionPaginationLatch as { counts: { lookup: number; page: number } };
            const kind = options.holdLatch;
            if (kind && latch?.counts[kind] === 1) {
              options.onReadPhase?.(kind, "latch");
              await new Promise<void>((resolve) => {
                releaseLatch = resolve;
              });
            }
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
    timers,
    releaseLatch: () => releaseLatch(),
    releaseRead: () => releaseRead(),
    tickAt: (at: number) => {
      now = at;
      ticking = true;
    },
    heartbeat: () => {
      for (const timer of intervals.values()) timer.callback();
    },
    expire: () => {
      const expiry = [...timers.values()].find((timer) => timer.at === T0 + 900000);
      expect(expiry).toBeDefined();
      expiry!.callback();
    },
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
function rehash(value: ReturnType<typeof JSON.parse>, index: ReturnType<typeof JSON.parse>) {
  const text = json(value);
  index.files["9142-receipt.json"] = hash(text);
  writeFileSync(path.join(out, "receipt", "9142-receipt.json"), text);
  writeFileSync(path.join(out, "receipt", "9142-inventory.json"), json(index));
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
    expect(await page.api.detectionPaginationCapture.run(PRIVATE)).toEqual({ ok: false, code: "wrong_origin" });
    expect(page.messages).toEqual([]);
    page.location.href += "?input";
    expect(await page.run()).toEqual({ ok: false, code: "wrong_origin" });
    expect(page.messages).toEqual([]);
    expect(await page.api.detectionPaginationCapture.run(PRIVATE)).toEqual({ ok: false, code: "wrong_origin" });
  });
});

describe("detection-pagination-authority-controls", () => {
  it("operator receipt validates but rehashed synthetic authority cannot qualify it", async () => {
    const worker = harness({ evidence: "operator", pages: cohort(0) });
    const value = (await worker.run()).receipt;
    const p = { ...packaging.verifyPackage(out), evidence: "operator" };
    expect(value.reason).toBe("discovery_unknown");
    expect(worker.wire).toHaveLength(2);
    expect(() => packaging.assertReceipt(value, p)).not.toThrow();
    const forged = structuredClone(value);
    Object.assign(forged, {
      state: "qualified",
      reason: "qualified",
      total: 0,
      facts: {
        detection: "qualified",
        range: "qualified",
        pagination: "unknown",
        caps: "qualified",
        envelope: "qualified",
      },
    });
    Object.assign(forged.pages[0], {
      effectiveSize: 8,
      snapshotCount: 0,
      snapshotPresent: true,
      snapshotEqual: true,
      sameSession: true,
      allEligible: true,
      hardResultCap: 1000,
      hardPageCap: 1000,
      stable: true,
      negativeCovered: true,
      terminal: true,
    });
    // The synthetic-evidence positive holds every qualification field fixed.
    expect(() =>
      packaging.assertReceipt({ ...forged, evidence: "synthetic" }, { ...p, evidence: "synthetic" }),
    ).not.toThrow();
    expect(() => packaging.assertReceipt(forged, p)).toThrow(/^verdict$/);
  });
  const prepareSeat = {
    synthetic: false,
    platform: "win32",
    outParent: path.join(scratch, "seat"),
    expectedParent: path.join(scratch, "seat"),
    porcelain: "",
    chromePresent: true,
    now: T0,
    t0: T0,
  };
  it.each([
    { name: "platform", change: { platform: "linux" } },
    { name: "output parent", change: { outParent: path.join(scratch, "other") } },
    { name: "clean porcelain", change: { porcelain: " M synthetic-file" } },
    { name: "Chrome presence", change: { chromePresent: false } },
    { name: "late T0", change: { now: T0 + 1001 } },
    { name: "future T0", change: { now: T0 - 1001 } },
  ])("operator prepare seat binds $name independently", ({ change }) => {
    expect(() => packaging.assertPrepareSeat(prepareSeat)).not.toThrow();
    for (const now of [T0 - 1000, T0 + 1000])
      expect(() => packaging.assertPrepareSeat({ ...prepareSeat, now })).not.toThrow();
    expect(() => packaging.assertPrepareSeat({ ...prepareSeat, ...change })).toThrow(/^reviewed_seat_required$/);
    expect(() => packaging.assertPrepareSeat({ ...prepareSeat, ...change, synthetic: true })).not.toThrow();
  });
  const sourceHashes = {
    "capture.html": "synthetic-html",
    "helper.js": "synthetic-helper",
    "worker.js": "synthetic-worker",
  };
  const packageSeat = {
    evidence: "operator",
    head: "a".repeat(40),
    expectedHead: "a".repeat(40),
    porcelain: "",
    sourceHashes,
    expectedHashes: { ...sourceHashes },
  };
  it.each([
    { name: "HEAD", change: { head: "b".repeat(40) } },
    { name: "clean porcelain", change: { porcelain: " M synthetic-file" } },
    ...Object.keys(sourceHashes).map((name) => ({
      name,
      change: { sourceHashes: { ...sourceHashes, [name]: "changed" } },
    })),
  ])("operator package seat binds $name independently", ({ change }) => {
    expect(() => packaging.assertPackageSeat(packageSeat)).not.toThrow();
    expect(() => packaging.assertPackageSeat({ ...packageSeat, ...change })).toThrow(/^reviewed_seat_required$/);
    expect(() => packaging.assertPackageSeat({ ...packageSeat, ...change, evidence: "synthetic" })).not.toThrow();
  });
  it("same-snapshot total churn refuses on the total clause before export validation", async () => {
    const pages = cohort(17);
    pages[1].totalOrders = 16;
    pages[1].syntheticAuthority.snapshotCount = 16;
    const worker = harness({ pages });
    const value = (await worker.run()).receipt;
    expect(value.reason).toBe("frontier_replaced");
    expect(worker.wire).toHaveLength(3);
  });
  it("worker independently refuses a ninth page after eight next replies", async () => {
    const worker = harness({ pages: cohort(800) });
    expect((await worker.send({ kind: "begin" })).ok).toBe(true);
    expect((await worker.send({ kind: "lookup" })).ok).toBe(true);
    for (let page = 0; page < 8; page += 1)
      expect(await worker.send({ kind: "page" })).toEqual({ ok: true, code: "next" });
    expect((await worker.send({ kind: "page" })).receipt.reason).toBe("request_cap");
    expect(worker.wire).toHaveLength(9);
  });
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
    { name: "missing independent snapshot count", change: { snapshotCount: null }, reason: "total_missing" },
    { name: "independent snapshot count mismatch", change: { snapshotCount: 10 }, reason: "count_mismatch" },
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
  it("independent snapshot count bypass fails frozen-input control and closed validator", async () => {
    const pages = cohort(9, { snapshotCount: 10 });
    expect((await capture({ pages })).value.reason).toBe("count_mismatch");
    const emitted = readFileSync(path.join(preparation.packageDirectory, "worker.js"), "utf8");
    const mutant = emitted.replace('if (page.total !== page.snapshotCount) fail("count_mismatch");', "");
    expect(mutant).not.toBe(emitted);
    const worker = harness({ pages, workerSource: mutant });
    const page = helper(worker);
    await page.run();
    const value = JSON.parse(page.exports.get("9142-receipt.json")!);
    expect(value.reason).toBe("qualified");
    expect(() => expect(value.reason).toBe("count_mismatch")).toThrow();
    retain(page);
    expect(() => packaging.verifyExport(out)).toThrow("verdict");
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
    const olderCycle = cohort(25);
    olderCycle[2].syntheticAuthority.next = olderCycle[0].syntheticAuthority.next;
    const cycled = await capture({ pages: olderCycle });
    expect(cycled.value.reason).toBe("unsafe_next");
    expect(cycled.worker.wire).toHaveLength(4);
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
    expect((await capture({ pages: cohort(11, { resultCap: 10 }) })).value.reason).toBe("cap_hit");
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

type TerminalControl = {
  kind: "lookup" | "page";
  phase: ReadPhase;
  trigger: "custody_loss" | "expired" | "invalid_message" | "deadline";
};
const terminalControls: TerminalControl[] = (["lookup", "page"] as const).flatMap((kind) => [
  ...(["headers", "body"] as const).flatMap((phase) =>
    (["custody_loss", "expired", "invalid_message"] as const).map((trigger) => ({ kind, phase, trigger })),
  ),
  ...(["custody_loss", "expired", "deadline"] as const).map((trigger) => ({ kind, phase: "latch" as const, trigger })),
]);

async function terminalCapture({ kind, phase, trigger }: TerminalControl) {
  let entered = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const fixture = phase === "headers" ? { stall: true } : { bodyStall: true, ignoreAbort: true };
  const worker = harness({
    ...(kind === "lookup" ? { lookup: fixture } : { fixtures: [fixture] }),
    holdLatch: phase === "latch" ? kind : undefined,
    onReadPhase: (readKind, readPhase) => {
      if (readKind === kind && readPhase === phase) entered();
    },
  });
  const page = helper(worker);
  const pending = page.run();
  await ready;
  const calls = kind === "lookup" ? (phase === "latch" ? 0 : 1) : phase === "latch" ? 1 : 2;
  expect(worker.wire).toHaveLength(calls);
  worker.tickAt(T0 + (["expired", "deadline"].includes(trigger) ? 900000 : kind === "lookup" ? 20000 : 60000));
  if (trigger === "custody_loss") {
    worker.loseCustody();
    worker.heartbeat();
    await Promise.resolve();
    await Promise.resolve();
  } else if (trigger === "expired") worker.expire();
  else if (trigger === "invalid_message")
    expect(await worker.send({ kind: "SYNTHETIC_INVALID_MESSAGE_9181" })).toEqual({
      ok: false,
      code: "invalid_message",
    });
  if (trigger !== "deadline") {
    expect(worker.intervals.size).toBe(0);
    expect([...worker.timers.values()].some((timer) => timer.at === T0 + 900000)).toBe(false);
    if (phase !== "latch") expect(worker.wire.at(-1)!.request.signal!.aborted).toBe(true);
  }
  worker.releaseLatch();
  expect(await pending).toEqual({ ok: true, code: "scrubbed_export_created" });
  expect([...page.exports.keys()].sort()).toEqual(["9142-inventory.json", "9142-receipt.json"]);
  retain(page);
  // This is the unchanged production validator, not a patched diagnostic receipt.
  const evidence = path.join(path.dirname(out), "terminal-controls", `${kind}-${phase}-${trigger}`);
  mkdirSync(evidence, { recursive: true });
  for (const [name, text] of page.exports) writeFileSync(path.join(evidence, name), text);
  writeFileSync(
    path.join(evidence, "frozen-inputs.json"),
    json({ evidence: "synthetic", kind, phase, trigger, t0: T0, out }),
  );
  packaging.verifyExport(out);
  const value = JSON.parse(page.exports.get("9142-receipt.json")!);
  const reason = trigger === "deadline" ? "expired" : trigger;
  expect(value.reason).toBe(reason);
  expect(value.state).toBe(reason === "expired" ? "expired" : "unknown");
  expect(Object.values(value.facts)).toEqual(Array(5).fill("unknown"));
  expect(value.counts).toEqual({ lookup: 1, page: kind === "page" ? 1 : 0, detail: 0, write: 0 });
  expect(value.requests).toHaveLength(kind === "page" ? 2 : 1);
  const last = value.requests.at(-1);
  expect(last.failure).toBe(phase === "latch" ? reason : "aborted");
  expect(last.responseComplete).toBe(false);
  expect(last.withinFinalCall).toBe(last.elapsedMs <= 10000);
  expect(value.finishedAt).toBeGreaterThanOrEqual(last.startedAt + last.elapsedMs);
  expect(worker.timers.size).toBe(0);
  expect(value.totalBytes).toBe(
    value.requests.reduce(
      (bytes: number, read: { requestBytes: number; responseBytes: number }) =>
        bytes + read.requestBytes + read.responseBytes,
      0,
    ),
  );
  if (phase === "latch") {
    expect(last.requestBytes).toBe(0);
    expect(last.responseBytes).toBe(0);
    expect(last.status).toBeNull();
  } else {
    expect(last.elapsedMs).toBeGreaterThan(10000);
    expect(last.responseBytes).toBe(phase === "body" ? 1 : 0);
  }
  worker.releaseRead();
  await Promise.resolve();
  await Promise.resolve();
  expect(await worker.send({ kind: "finish" })).toEqual({ ok: true, receipt: value });
  for (const message of ["finish", "begin", "lookup", "page"])
    expect(await worker.send({ kind: message })).toEqual({ ok: false, code: "repeat_invocation" });
  worker.restart();
  worker.advance(900000);
  expect(await worker.send({ kind: "begin" })).toEqual({ ok: false, code: "repeat_invocation" });
  expect(worker.wire).toHaveLength(calls);
  expect(worker.storage.detectionPaginationLatch).toEqual({
    used: true,
    counts: { lookup: 1, page: kind === "page" ? 1 : 0 },
  });
  scrub({ value, exports: [...page.exports], storage: worker.storage });
  return { value, page };
}

describe("detection-pagination-inflight-terminal-chronology", () => {
  it.each(terminalControls)("$kind/$phase/$trigger seals after finalization", async (control) => {
    await terminalCapture(control);
  });
});

describe("detection-pagination-cadence-terminal-reuse", () => {
  it.each(["custody_loss", "invalid_message"] as const)("%s reuses the promptly sealed receipt", async (trigger) => {
    const worker = harness({ holdCadence: true });
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let confirmations = 0;
    const page = helper(worker, {
      onConfirm: () => {
        confirmations += 1;
        if (confirmations === 2) worker.advance(30000);
        if (confirmations === 3) entered();
      },
    });
    const pending = page.run();
    await waiting;
    await Promise.resolve();
    await Promise.resolve();
    expect(page.messages).toEqual([{ kind: "begin" }, { kind: "lookup" }, { kind: "page" }, { kind: "page" }]);
    expect(worker.wire).toHaveLength(2);
    expect([...worker.timers.values()].some((timer) => timer.at === T0 + 60000)).toBe(true);
    expect(worker.intervals.size).toBe(1);
    expect([...worker.timers.values()].some((timer) => timer.at === T0 + 900000)).toBe(true);
    worker.advance(20000);
    const stoppedAt = T0 + 50000;
    if (trigger === "custody_loss") {
      worker.loseCustody();
      worker.heartbeat();
      await Promise.resolve();
      await Promise.resolve();
    } else
      expect(await worker.send({ kind: "SYNTHETIC_INVALID_MESSAGE_9181" })).toEqual({
        ok: false,
        code: "invalid_message",
      });
    expect(worker.intervals.size).toBe(0);
    expect(worker.timers.size).toBe(0);
    expect(worker.wire).toHaveLength(2);
    expect(await pending).toEqual({ ok: true, code: "scrubbed_export_created" });
    expect([...page.exports.keys()].sort()).toEqual(["9142-inventory.json", "9142-receipt.json"]);
    retain(page);
    packaging.verifyExport(out);
    const value = JSON.parse(page.exports.get("9142-receipt.json")!);
    expect(value.reason).toBe(trigger);
    expect(value.state).toBe("unknown");
    expect(value.finishedAt).toBe(stoppedAt);
    expect(value.pages).toHaveLength(1);
    expect(value.pages[0].distinctCount).toBe(8);
    expect(value.distinctCount).toBe(8);
    expect(value.distinctCount).toBe(value.pages[0].distinctCount);
    expect(value.requests).toHaveLength(2);
    expect(Object.values(value.facts)).toEqual(Array(5).fill("unknown"));
    expect(await worker.send({ kind: "finish" })).toEqual({ ok: true, receipt: value });
    for (const kind of ["finish", "begin", "lookup", "page"])
      expect(await worker.send({ kind })).toEqual({ ok: false, code: "repeat_invocation" });
    expect(await page.run()).toEqual({ ok: false, code: "repeat_invocation" });
    worker.advance(900000);
    expect(worker.wire).toHaveLength(2);
    scrub({ value, exports: [...page.exports], storage: worker.storage, retained: worker.retained });
  });
});

describe("detection-pagination-terminal-cleanup-chronology", () => {
  it.each(["custody_loss", "expired"] as const)("%s keeps actual completion and honest removal", async (trigger) => {
    const { value, page } = await terminalCapture({ kind: "page", phase: "body", trigger });
    const profile = path.resolve(preparation.profileDirectory);
    expect(path.dirname(profile)).toBe(path.resolve(out));
    expect(profile.startsWith(scratch + path.sep)).toBe(true);
    rmdirSync(profile);
    try {
      expect(() => packaging.recordRemoval(out, true, true, value.finishedAt - 1)).toThrow(/^custody$/);
      expect(() => packaging.recordRemoval(out, true, true, value.deadline + 1)).toThrow(/^custody$/);
      if (trigger === "expired") {
        expect(value.finishedAt).toBeGreaterThan(value.deadline);
        expect(() => packaging.recordRemoval(out, true, true, value.deadline)).toThrow(/^custody$/);
        expect(() => packaging.recordRemoval(out, true, true, value.finishedAt)).toThrow(/^custody$/);
        const index = JSON.parse(page.exports.get("9142-inventory.json")!);
        index.removal = {
          extensionAbsent: true,
          profileDisposed: true,
          processesAbsent: true,
          extensionAbsentAt: value.deadline,
        };
        writeFileSync(path.join(out, "receipt", "9142-inventory.json"), json(index));
        expect(() => packaging.verifyExport(out)).toThrow(/^custody$/);
        retain(page);
        expect(packaging.verifyExport(out).removal.extensionAbsent).toBe(false);
      } else {
        expect(value.finishedAt).toBeLessThan(value.deadline);
        expect(packaging.recordRemoval(out, true, true, value.finishedAt).removal.extensionAbsentAt).toBe(
          value.finishedAt,
        );
        expect(() => packaging.verifyExport(out)).not.toThrow();
      }
    } finally {
      retain(page);
      mkdirSync(profile);
    }
  });
});

function prepareCallsiteControl(module: typeof packaging) {
  const stale = path.join(mkdtempSync(path.join(scratch, "SYNTHETIC_9181_stale-seat-")), "unemitted");
  expect(() => module.prepare({ out: stale, t0: Date.now() - 5000 })).toThrow(/^reviewed_seat_required$/);
  expect(existsSync(stale)).toBe(false);
}

function packageCallsiteControl(module: typeof packaging) {
  const root = path.join(mkdtempSync(path.join(scratch, "SYNTHETIC_9181_wrong-head-")), "run");
  const prepared = packaging.prepare({ out: root, synthetic: true, t0: T0 });
  const configFile = path.join(prepared.packageDirectory, "capture-config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.head = prepared.head === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40);
  config.evidence = "operator";
  writeFileSync(configFile, json(config));
  const changed = {
    ...prepared,
    ...config,
    packageDigests: { ...prepared.packageDigests, "capture-config.json": hash(json(config)) },
  };
  writeFileSync(path.join(root, "preparation.json"), json(changed));
  const inventoryFile = path.join(root, "preparation-inventory.json");
  const inventory = JSON.parse(readFileSync(inventoryFile, "utf8"));
  inventory.files["preparation.json"] = hash(json(changed));
  inventory.files["package/capture-config.json"] = hash(json(config));
  writeFileSync(inventoryFile, json(inventory));
  expect(() => module.verifyPackage(root)).toThrow(/^reviewed_seat_required$/);
}

async function seatCallBypass(call: "assertPrepareSeat" | "assertPackageSeat") {
  const text = readFileSync(path.join(source, "package.mjs"), "utf8");
  const start = text.indexOf(`    ${call}({`);
  expect(start).toBeGreaterThan(0);
  const end = text.indexOf("    });", start) + "    });".length;
  expect(end).toBeGreaterThan(start);
  // Only the production call is deleted. Relocation keeps every real source/git/inventory read unchanged.
  const relocated = (text.slice(0, start) + "    void 0;" + text.slice(end)).replace(
    "const source = path.dirname(fileURLToPath(import.meta.url));",
    `const source = ${JSON.stringify(source)};`,
  );
  const file = path.join(mkdtempSync(path.join(scratch, "SYNTHETIC_9181_call-deletion-")), "package.mjs");
  writeFileSync(file, relocated);
  return import(pathToFileURL(file).href);
}

describe("detection-pagination-seat-callsite-controls", () => {
  it("real prepare refuses stale T0 before emitting any directory", () => prepareCallsiteControl(packaging));
  it("real verifyPackage refuses an internally rehashed synthetic operator fixture with wrong HEAD", () =>
    packageCallsiteControl(packaging));
  it.each([
    { call: "assertPrepareSeat" as const, control: prepareCallsiteControl },
    { call: "assertPackageSeat" as const, control: packageCallsiteControl },
  ])("deleting only the $call production call makes the same control RED", async ({ call, control }) => {
    control(packaging);
    const bypass = await seatCallBypass(call);
    expect(() => control(bypass)).toThrow(/^expected \[Function\] to throw an error$/);
    console.info(
      `SYNTHETIC_9181 ${call}: candidate GREEN; production-call deletion RED (expected refusal did not throw)`,
    );
  });
});

describe("detection-pagination-custody-and-byte-controls", () => {
  it("fixed expiry while the helper awaits a native confirm still exports the expired receipt", async () => {
    const worker = harness();
    let confirms = 0;
    const page = helper(worker, {
      onConfirm: () => {
        if (++confirms === 3) worker.advance(900000);
      },
    });
    expect(await page.run()).toEqual({ ok: true, code: "scrubbed_export_created" });
    expect(page.exports.size).toBe(2);
    expect(JSON.parse(page.exports.get("9142-receipt.json")!).state).toBe("expired");
    expect(worker.wire).toHaveLength(2);
    retain(page);
    expect(() => packaging.verifyExport(out)).not.toThrow();
    for (const kind of ["finish", "begin"])
      expect(await worker.send({ kind })).toEqual({ ok: false, code: "repeat_invocation" });
    expect(worker.wire).toHaveLength(2);
  });
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
    for (const [field, code] of [
      ["leak", "closed_schema"],
      ["nested", "closed_schema"],
      ["old", "closed_schema"],
      ["verdict", "verdict"],
      ["count", "bounds"],
      ["bytes", "bounds"],
      ["size", "verdict"],
    ]) {
      const value = JSON.parse(original);
      const index = JSON.parse(originalIndex);
      if (field === "leak") value.snapshot = PRIVATE;
      if (field === "nested") value.pages[0].snapshot = { value: PRIVATE };
      if (field === "old") value.format = "order-authority-receipt/v3";
      if (field === "verdict") value.facts.detection = "qualified";
      if (field === "count") value.counts.page = 1;
      if (field === "bytes") value.totalBytes += 1;
      if (field === "size") value.pages[0].effectiveSize = 500;
      rehash(value, index);
      expect(() => packaging.verifyExport(out), field).toThrow(new RegExp(`^${code}$`));
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
  it.each([
    {
      name: "serial gap",
      code: "chronology",
      change: (value: ReturnType<typeof JSON.parse>) => {
        value.requests[1].startedAt = value.requests[0].startedAt + 29999;
      },
    },
    {
      name: "finished deadline",
      code: "chronology",
      change: (value: ReturnType<typeof JSON.parse>) => {
        value.finishedAt = value.deadline + 1;
      },
    },
    {
      name: "lookup first",
      code: "chronology",
      change: (value: ReturnType<typeof JSON.parse>) => {
        const [lookup, page] = value.requests;
        // Reorder requests while preserving ordinal and timestamp validity at each slot.
        value.requests = [
          { ...page, ordinal: 0, startedAt: lookup.startedAt },
          { ...lookup, ordinal: 1, startedAt: page.startedAt },
        ];
      },
    },
    {
      name: "FINAL classification",
      code: "chronology",
      change: (value: ReturnType<typeof JSON.parse>) => {
        value.requests[1].withinFinalCall = !value.requests[1].withinFinalCall;
      },
    },
    {
      name: "successful status",
      code: "bounds",
      change: (value: ReturnType<typeof JSON.parse>) => {
        value.requests[1].status = 500;
      },
    },
  ])("rehashed unknown receipt isolates $name", async ({ change, code }) => {
    const { page, value } = await capture({ pages: cohort(9, { allEligible: false }) });
    expect(value.state).toBe("unknown");
    const index = JSON.parse(page.exports.get("9142-inventory.json")!);
    change(value);
    rehash(value, index);
    expect(() => packaging.verifyExport(out)).toThrow(new RegExp(`^${code}$`));
    retain(page);
  });
  it("rehashed qualified receipt cannot declare a full last page terminal", async () => {
    const { page, value } = await capture({ pages: cohort(15) });
    expect(value.state).toBe("qualified");
    expect(value.pages.at(-1).rowCount).toBe(7);
    value.pages.at(-1).rowCount = 8;
    value.pages.at(-1).distinctCount = 8;
    value.total = 16;
    value.distinctCount = 16;
    for (const item of value.pages) item.total = item.snapshotCount = 16;
    rehash(value, JSON.parse(page.exports.get("9142-inventory.json")!));
    expect(() => packaging.verifyExport(out)).toThrow(/^verdict$/);
    retain(page);
  });
  it("rehashed removal isolates the UI deadline and actual profile disposal", async () => {
    const { page, value } = await capture();
    const index = JSON.parse(page.exports.get("9142-inventory.json")!);
    index.removal = {
      extensionAbsent: true,
      profileDisposed: true,
      processesAbsent: true,
      extensionAbsentAt: value.finishedAt,
    };
    const profile = path.resolve(preparation.profileDirectory);
    expect(path.dirname(profile)).toBe(path.resolve(out));
    expect(profile.startsWith(scratch + path.sep)).toBe(true);
    rmdirSync(profile);
    try {
      rehash(value, index);
      expect(() => packaging.verifyExport(out)).not.toThrow();
      index.removal.extensionAbsentAt = value.deadline + 1;
      rehash(value, index);
      expect(() => packaging.verifyExport(out)).toThrow(/^custody$/);
      index.removal.extensionAbsentAt = value.finishedAt;
      rehash(value, index);
      mkdirSync(profile);
      expect(() => packaging.verifyExport(out)).toThrow(/^custody$/);
    } finally {
      retain(page);
      if (!readdirSync(out).includes("profile")) mkdirSync(profile);
    }
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
