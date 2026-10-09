import { createHash, webcrypto } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, Script } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const relative = "bounded-contexts/channels/features/connector-client/tests/selector-human-route-rehearsal.mjs";
const core = "bounded-contexts/channels/features/connector-client/integrations/order-authority-probe";
const scratch = path.join(repo, "artifacts", "9155", "tests");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
let fixture: string;
let driver = await import(new URL("./selector-human-route-rehearsal.mjs", import.meta.url).href);
let packaging = await import(new URL("../integrations/order-authority-probe/package.mjs", import.meta.url).href);
let metadata: ReturnType<typeof driver.prepareRehearsal>;
const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture, stdio: ["ignore", "pipe", "pipe"] });
const freshOut = () => path.join(fixture, "artifacts", "9115", `human-route-rehearsal-${++sequence}`);
let sequence = 0;

beforeAll(async () => {
  mkdirSync(scratch, { recursive: true });
  fixture = mkdtempSync(path.join(scratch, "synthetic-seat-"));
  for (const name of [
    relative,
    "scripts/lib/heavy-slot.mjs",
    ...["capture.html", "capture.test.ts", "helper.js", "manifest.json", "package.mjs", "worker.js"].map(
      (name) => `${core}/${name}`,
    ),
  ]) {
    const dest = path.join(fixture, name);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(repo, name), dest);
  }
  writeFileSync(path.join(fixture, ".gitignore"), "artifacts/\n");
  git("init", "--initial-branch=synthetic");
  git("add", ".");
  git(
    "-c",
    "user.name=Synthetic fixture",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "-m",
    "synthetic fixture only",
  );
  driver = await import(pathToFileURL(path.join(fixture, relative)).href);
  packaging = await import(pathToFileURL(path.join(fixture, core, "package.mjs")).href);
  metadata = driver.prepareRehearsal(freshOut());
});

describe("selector-human-rehearsal-preparation", () => {
  it("uses actual preparation/validator with immutable landed digests, real T0, cadence and fresh identities", () => {
    const before = Date.now();
    const next = driver.prepareRehearsal(freshOut());
    const p = packaging.verifyPackage(path.join(next.out, "run"));
    expect(p.evidence).toBe("synthetic");
    expect(p.cadenceMs).toBe(30000);
    expect(Date.parse(p.t0)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(p.t0)).toBeLessThanOrEqual(Date.now());
    expect(p.extensionId).not.toBe(metadata.preparation.extensionId);
    expect(p.profileDirectory).not.toBe(metadata.preparation.profileDirectory);
    for (const [name, digest] of Object.entries(driver.LANDED_DIGESTS))
      expect(hash(readFileSync(path.join(fixture, core, name)))).toBe(digest);
    for (const name of ["worker.js", "helper.js", "capture.html"])
      expect(hash(readFileSync(path.join(p.packageDirectory, name)))).toBe(driver.LANDED_DIGESTS[name]);
  });

  it("refuses dirty and committed wrong source rather than rebaselining the digest oracle", () => {
    const file = path.join(fixture, core, "helper.js");
    const original = readFileSync(file);
    writeFileSync(file, "synthetic tamper");
    try {
      expect(() => driver.prepareRehearsal(freshOut())).toThrow("dirty_source_refused");
      git("add", file);
      git(
        "-c",
        "user.name=Synthetic fixture",
        "-c",
        "user.email=synthetic@example.invalid",
        "commit",
        "-m",
        "synthetic wrong source control",
      );
      expect(() => driver.prepareRehearsal(freshOut())).toThrow("wrong_landed_source");
    } finally {
      writeFileSync(file, original);
      git("add", file);
      git(
        "-c",
        "user.name=Synthetic fixture",
        "-c",
        "user.email=synthetic@example.invalid",
        "commit",
        "-m",
        "restore synthetic fixture",
      );
    }
  });

  it("refuses relative, existing, wrong-parent, symlink and malformed destinations", () => {
    expect(() => driver.prepareRehearsal("artifacts/relative")).toThrow("absolute_normalized_path_required");
    expect(() => driver.prepareRehearsal(metadata.out)).toThrow("existing_destination_refused");
    expect(() => driver.prepareRehearsal(path.join(fixture, "other", "human-route-rehearsal-wrong"))).toThrow(
      "unsafe_destination",
    );
    expect(() => driver.prepareRehearsal(path.join(fixture, "artifacts", "9115", "live"))).toThrow(
      "unsafe_destination",
    );
    const link = freshOut();
    symlinkSync(metadata.out, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => driver.prepareRehearsal(link)).toThrow("symlink_refused");
  });

  it("CLI rejects wrong seat and unsupported flags without launching Chrome", () => {
    for (const args of [["--prepare"], ["--synthetic"], ["--out", freshOut()]]) {
      expect(() =>
        execFileSync(process.execPath, [path.join(fixture, relative), ...args], {
          cwd: scratch,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ).toThrow();
    }
  });
});

function seamContext(count = 1) {
  const local: string[] = [];
  const context = createContext({
    fetch: async (url: string) => {
      if (!url.startsWith(`chrome-extension://${metadata.preparation.extensionId}/`))
        throw new Error("startup_network_denied");
      local.push(url);
      return new Response(
        readFileSync(path.join(metadata.preparation.packageDirectory, url.split("/").at(-1)!), "utf8"),
      );
    },
    Headers,
    Response,
  });
  const expression = `(${driver.bindSyntheticFetch.toString()})(${JSON.stringify(`chrome-extension://${metadata.preparation.extensionId}`)},${JSON.stringify(driver.syntheticFixtures(count))})`;
  new Script(expression).runInContext(context);
  return { context, local, expression };
}

describe("selector-human-rehearsal-isolation", () => {
  it("startup arguments are unconditional; seam routes only exact local files and fixed requests", async () => {
    expect(() => driver.chromeArguments(metadata.preparation.profileDirectory)).toThrow("owned_deny_proxy_required");
    const args = driver.chromeArguments(metadata.preparation.profileDirectory, 9999);
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND");
    expect(args).toContain("--proxy-server=http://127.0.0.1:9999");
    expect(args).toContain("--proxy-bypass-list=<-loopback>");
    expect(args).toContain("--disable-quic");
    expect(args).not.toContain("--load-extension");
    const seam = seamContext();
    const lookup = await seam.context.fetch("https://sp-api.tcgplayer.com/account/auth-detail?api-version=1.0", {
      method: "GET",
    });
    expect(await lookup.json()).toEqual(driver.syntheticFixtures().lookup);
    const list = await seam.context.fetch("https://order-management-api.tcgplayer.com/orders/search?api-version=2.0", {
      method: "POST",
      body: JSON.stringify({
        searchRange: "LastTwoYears",
        filters: { sellerKey: `${driver.PRIVATE_TOKEN}_seller`, orderStatuses: ["ReadyToShip"] },
        sortBy: [],
        from: 0,
        size: 500,
      }),
    });
    expect((await list.json()).totalOrders).toBe(1);
    expect(seam.local).toEqual([]);
    await seam.context.fetch(`${metadata.preparation.captureUrl.replace("capture.html", "helper.js")}`);
    expect(seam.local).toHaveLength(1);
    for (const [url, options] of [
      ["https://synthetic-provider.invalid/never-live", {}],
      ["https://sp-api.tcgplayer.com/account/auth-detail?api-version=1.0", { method: "POST" }],
      [
        "https://sp-api.tcgplayer.com/account/auth-detail?api-version=1.0",
        { method: "GET", headers: { Authorization: "synthetic-only" } },
      ],
      ["https://order-management-api.tcgplayer.com/orders/search?api-version=2.0", { method: "POST", body: "{}" }],
      [`chrome-extension://${metadata.preparation.extensionId}/../private`, {}],
      ["file:///synthetic-private", {}],
    ])
      await expect(seam.context.fetch(url, options)).rejects.toThrow("synthetic_transport_refused");
    expect(() => new Script(seam.expression).runInContext(seam.context)).toThrow("worker_rebind_refused");
  });

  it("binds only a paused exact worker before handoff; failure, omitted isolation and restart never hand off", async () => {
    for (const failure of ["none", "Network.setBlockedURLs", "seam", "sentinel", "unpaused", "wrong-id"]) {
      const calls: { method: string; params: Record<string, unknown>; session?: string }[] = [];
      const reports: string[] = [];
      let evaluated = 0;
      const isolation = new driver.WorkerIsolation(
        async (method: string, params: Record<string, unknown>, session?: string) => {
          calls.push({ method, params, session });
          if (method === failure) throw new Error("synthetic CDP failure");
          if (method === "Runtime.evaluate")
            return { result: { value: ++evaluated === 1 ? failure !== "seam" : failure !== "sentinel" } };
          return {};
        },
        metadata,
        (phase: string) => reports.push(phase),
      );
      await isolation.start();
      await isolation.attached({
        sessionId: "synthetic-worker",
        targetInfo: {
          type: "service_worker",
          url:
            failure === "wrong-id"
              ? "chrome-extension://wrong/worker.js"
              : `chrome-extension://${metadata.preparation.extensionId}/worker.js`,
        },
        waitingForDebugger: failure !== "unpaused",
      });
      expect(isolation.ready).toBe(failure === "none");
      expect(reports.includes("HANDOFF")).toBe(failure === "none");
      if (failure === "none") {
        expect(calls.map((call) => call.method)).toEqual([
          "Target.setAutoAttach",
          "Network.enable",
          "Network.setBlockedURLs",
          "Runtime.enable",
          "Runtime.runIfWaitingForDebugger",
          "Runtime.evaluate",
          "Runtime.evaluate",
        ]);
        expect(calls.slice(1).every((call) => call.session === "synthetic-worker")).toBe(true);
        isolation.detached({ sessionId: "synthetic-worker" });
        const before = calls.length;
        await isolation.attached({
          sessionId: "synthetic-restart",
          targetInfo: {
            type: "service_worker",
            url: `chrome-extension://${metadata.preparation.extensionId}/worker.js`,
          },
          waitingForDebugger: true,
        });
        expect(isolation.held).toBe(true);
        expect(calls).toHaveLength(before);
      }
    }
  });

  it("raw CDP rejects page/dialog/download/install/uninstall/close ownership", () => {
    const socket = {
      addEventListener: () => {},
      send: () => {
        throw new Error("unexpected send");
      },
    };
    const cdp = new driver.WorkerCdp(
      socket,
      () => {},
      () => {},
    );
    for (const method of [
      "Page.handleJavaScriptDialog",
      "Browser.setDownloadBehavior",
      "Extensions.loadUnpacked",
      "Extensions.uninstall",
      "Browser.close",
      "Page.reload",
      "Target.attachToTarget",
    ])
      expect(() => cdp.send(method, {}, "synthetic-worker")).toThrow("non_worker_command_refused");
    expect(() => cdp.send("Runtime.evaluate", {})).toThrow("non_worker_command_refused");
  });

  it("raw worker CDP correlates replies and surfaces command, send, malformed and disconnect failures", async () => {
    const listeners = new Map<string, (event?: { data: string }) => void>();
    const sent: { id: number; method: string; sessionId?: string }[] = [];
    const events: unknown[] = [];
    let closed = 0;
    let failSend = false;
    const socket = {
      addEventListener: (kind: string, listener: (event?: { data: string }) => void) => listeners.set(kind, listener),
      send: (text: string) => {
        if (failSend) throw new Error("synthetic send failure");
        sent.push(JSON.parse(text));
      },
      close: () => listeners.get("close")!(),
    };
    const cdp = new driver.WorkerCdp(
      socket,
      (event: unknown) => events.push(event),
      () => closed++,
    );
    const ok = cdp.send("Network.enable", {}, "synthetic-worker");
    expect(sent[0].sessionId).toBe("synthetic-worker");
    listeners.get("message")!({ data: JSON.stringify({ id: sent[0].id, result: { enabled: true } }) });
    expect(await ok).toEqual({ enabled: true });
    const error = cdp.send("Runtime.enable", {}, "synthetic-worker");
    listeners.get("message")!({ data: JSON.stringify({ id: sent[1].id, error: { code: -1 } }) });
    await expect(error).rejects.toThrow("cdp_command_refused");
    listeners.get("message")!({
      data: JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "synthetic-worker" } }),
    });
    expect(events).toHaveLength(1);
    failSend = true;
    await expect(cdp.send("Runtime.enable", {}, "synthetic-worker")).rejects.toThrow("cdp_send_refused");
    failSend = false;
    const pending = cdp.send("Runtime.enable", {}, "synthetic-worker");
    listeners.get("message")!({ data: "not-json" });
    await expect(pending).rejects.toThrow("cdp_disconnected");
    expect(closed).toBeGreaterThan(0);
  });
});

// VM-only synthetic dialog answers exercise software, never native HUMAN proof.
async function actualHelperWorker(count: number, cancel = false) {
  const next = driver.prepareRehearsal(freshOut());
  const p = next.preparation;
  const origin = `chrome-extension://${p.extensionId}`;
  let listener: (message: unknown, sender: unknown, respond: (value: unknown) => void) => void;
  const storage: Record<string, unknown> = {};
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const worker = createContext({
    fetch: async (url: string) => {
      if (!url.startsWith(`${origin}/`)) throw new Error("startup_network_denied");
      return new Response(readFileSync(path.join(p.packageDirectory, url.slice(origin.length + 1)), "utf8"));
    },
    chrome: {
      runtime: {
        id: p.extensionId,
        getURL: (file: string) => `${origin}/${file}`,
        getPlatformInfo: async () => ({}),
        onMessage: {
          addListener: (value: typeof listener) => {
            listener = value;
          },
        },
      },
      storage: {
        local: {
          setAccessLevel: async () => {},
          get: async () => structuredClone(storage),
          set: async (value: Record<string, unknown>) => Object.assign(storage, structuredClone(value)),
        },
      },
    },
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    AbortController,
    Headers,
    Response,
    Date,
    setTimeout: (fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      timers.add(id);
      return id;
    },
    clearTimeout,
    setInterval: (fn: () => void, ms: number) => {
      const id = setInterval(fn, ms);
      intervals.add(id);
      return id;
    },
    clearInterval,
  });
  new Script(
    `(${driver.bindSyntheticFetch.toString()})(${JSON.stringify(origin)},${JSON.stringify(driver.syntheticFixtures(count))})`,
  ).runInContext(worker);
  new Script(readFileSync(path.join(p.packageDirectory, "worker.js"), "utf8")).runInContext(worker);
  const send = async (message: unknown) => {
    const result = await new Promise((resolve) =>
      listener(message, { id: p.extensionId, url: p.captureUrl, origin, frameId: 0 }, resolve),
    );
    await Promise.resolve();
    await Promise.resolve();
    return result;
  };
  const blobs = new Map<string, Blob>();
  const downloads: Promise<void>[] = [];
  const prompts = [
    "LastTwoYears",
    "Ready to Ship",
    String(count),
    "LastThreeMonths",
    "LastTwoYears",
    "Ready to Ship",
    String(count),
  ];
  const dialogs: string[] = [];
  const window = { top: {} };
  window.top = window;
  const helper = createContext({
    window,
    location: { href: p.captureUrl },
    addEventListener: () => {},
    Date,
    Blob,
    crypto: webcrypto,
    TextEncoder,
    chrome: { runtime: { id: p.extensionId, getURL: (file: string) => `${origin}/${file}`, sendMessage: send } },
    prompt: (message: string) => {
      dialogs.push(message);
      return cancel ? null : prompts.shift();
    },
    confirm: (message: string) => {
      dialogs.push(message);
      return true;
    },
    URL: {
      createObjectURL: (blob: Blob) => {
        const id = `blob:synthetic-${blobs.size}`;
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
            downloads.push(
              blobs
                .get(link.href)!
                .text()
                .then((text) => writeFileSync(path.join(p.receiptDirectory, link.download), text)),
            );
          },
        };
        return link;
      },
    },
    setTimeout: (fn: () => void) => queueMicrotask(fn),
  });
  new Script(readFileSync(path.join(p.packageDirectory, "helper.js"), "utf8")).runInContext(helper);
  try {
    expect(await helper.orderAuthorityCapture.run()).toEqual({ ok: true, code: "scrubbed_export_created" });
    await Promise.all(downloads);
    expect(await helper.orderAuthorityCapture.run()).toEqual({ ok: false, code: "repeat_invocation" });
    const index = driver.verifySyntheticExport(path.join(next.out, "run"));
    const receipt = JSON.parse(readFileSync(path.join(p.receiptDirectory, "selector-receipt.json"), "utf8"));
    return { next, index, receipt, dialogs };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const timer of intervals) clearInterval(timer);
  }
}

describe("selector-human-rehearsal-isolation actual emitted helper/worker/export", () => {
  it("real clock and 30s cadence produce largest-valid closed exports without synthetic private tokens", async () => {
    const start = Date.now();
    const { next, receipt, dialogs } = await actualHelperWorker(499);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30000);
    expect(receipt.failures).toEqual([]);
    expect(receipt.counts).toEqual({ lookup: 1, list: 1, detail: 0 });
    expect(receipt.selector.searches[0].totalOrders).toBe(499);
    expect(receipt.selector.searches[0].qualification).toBe("qualified");
    expect(receipt.selector.searches[0].after.reprompted).toBe(true);
    expect(
      Date.parse(receipt.requests[1].startedAt) - Date.parse(receipt.requests[0].startedAt),
    ).toBeGreaterThanOrEqual(30000);
    expect(dialogs.some((text) => text.includes("fresh Orders view"))).toBe(true);
    expect(dialogs.some((text) => text.includes("Restore"))).toBe(true);
    const run = path.join(next.out, "run");
    const file = path.join(next.preparation.receiptDirectory, "selector-receipt.json");
    const original = readFileSync(file);
    rmSync(file);
    expect(() => driver.verifySyntheticExport(run)).toThrow();
    writeFileSync(file, original);
    writeFileSync(file, original.toString() + " ");
    expect(() => driver.verifySyntheticExport(run)).toThrow();
    writeFileSync(file, original);
    const extra = path.join(next.preparation.receiptDirectory, "extra.json");
    writeFileSync(extra, "{}");
    expect(() => driver.verifySyntheticExport(run)).toThrow("inventory_mismatch");
    rmSync(extra);
    expect(driver.verifySyntheticExport(run).evidence).toBe("synthetic");
    const indexFile = path.join(next.preparation.receiptDirectory, "selector-inventory.json");
    const originalIndex = readFileSync(indexFile);
    for (const late of ["before", "after"]) {
      const mutated = JSON.parse(original.toString());
      const request = mutated.requests[1];
      mutated.selector.searches[0][late].observedAt = new Date(
        late === "before" ? Date.parse(request.startedAt) - 30001 : Date.parse(request.endedAt) + 120001,
      ).toISOString();
      const text = encode(mutated);
      writeFileSync(file, text);
      const index = JSON.parse(originalIndex.toString());
      index.files["selector-receipt.json"] = hash(text);
      writeFileSync(indexFile, encode(index));
      expect(() => driver.verifySyntheticExport(run)).toThrow("export_schema_refused");
    }
    for (const value of [driver.PRIVATE_TOKEN, `${driver.PRIVATE_TOKEN}_seller`, `${driver.PRIVATE_TOKEN}_order_0`]) {
      for (const encoding of [value, encodeURIComponent(value), Buffer.from(value).toString("base64"), hash(value)]) {
        const mutated = JSON.parse(original.toString());
        mutated.requests[0].shape.fields.push({ field: encoding, types: ["string"] });
        const text = encode(mutated);
        writeFileSync(file, text);
        const index = JSON.parse(originalIndex.toString());
        index.files["selector-receipt.json"] = hash(text);
        writeFileSync(indexFile, encode(index));
        expect(() => driver.verifySyntheticExport(run)).toThrow();
        expect(() => driver.assertNoSyntheticPrivateTokens(encoding)).toThrow("synthetic_private_token_leak");
      }
    }
    writeFileSync(file, original);
    writeFileSync(indexFile, originalIndex);
    expect(driver.verifySyntheticExport(run).evidence).toBe("synthetic");
    // Only this test-created synthetic profile, never HUMAN/manual removal proof.
    expect(path.dirname(next.preparation.profileDirectory)).toBe(run);
    rmSync(next.preparation.profileDirectory, { recursive: true });
    expect(() =>
      packaging.recordRemoval(run, true, new Date(Date.parse(receipt.deadlineAt) + 1).toISOString()),
    ).toThrow("removal_not_confirmed");
    expect(packaging.recordRemoval(run, true, new Date().toISOString()).removal.profileDisposed).toBe(true);
    expect(driver.verifySyntheticExport(run).removal.extensionAbsent).toBe(true);
    expect(existsSync(next.preparation.profileDirectory)).toBe(false);
  });

  it("cancellation stays terminal unknown, not acceptance", async () => {
    const { receipt } = await actualHelperWorker(1, true);
    expect(receipt.failures).toEqual(["canceled"]);
    expect(receipt.selector.searches).toEqual([]);
  });
});

describe("selector-human-rehearsal-handoff", () => {
  it("ships bound runnable commands, all human phases and N4/N5/N9/N10 without live authority", () => {
    const readback = JSON.parse(readFileSync(path.join(metadata.out, "handoff.json"), "utf8"));
    expect(readback.head).toBe(git("rev-parse", readback.head).toString().trim());
    expect(readback.driverDigest).toBe(hash(readFileSync(path.join(fixture, relative))));
    expect(readback.landedCoreDigests).toEqual(driver.LANDED_DIGESTS);
    const instructions = readFileSync(path.join(metadata.out, "HUMAN.md"), "utf8");
    for (const term of [
      "actual merge head",
      "identical driver/core digests",
      "exclusive heavy admission",
      "not a lane publication/landing gate",
      "No Playwright download/dialog owner",
      "await orderAuthorityCapture.run()",
      "30000 ms",
      "120000 ms",
      "actually reloading",
      "ONCE",
      "chrome://extensions",
      "ACTUAL UTC",
      "zero exact-profile",
      "unknown/unreadable command lines",
      "OUTSIDE agent tools",
      "--record-removal",
      "--verify-export",
      "#9115 remains HOLD",
      "PENDING_HOST_REVIEW",
    ])
      expect(instructions).toContain(term);
    expect(instructions).toContain(metadata.preparation.extensionId);
    expect(instructions).toContain(metadata.preparation.packageDirectory);
    expect(instructions).toContain(metadata.preparation.profileDirectory);
    expect(instructions).toContain(metadata.ordersUrl);
    const orders = readFileSync(fileURLToPath(metadata.ordersUrl), "utf8");
    const range = { value: "LastTwoYears" };
    let onLoad: () => void = () => {};
    const context = createContext({
      document: { querySelector: () => range },
      addEventListener: (name: string, callback: () => void) => {
        expect(name).toBe("pageshow");
        onLoad = callback;
      },
    });
    new Script(orders.match(/<script>(.*?)<\/script>/)![1]).runInContext(context);
    onLoad();
    expect(range.value).toBe("LastThreeMonths");
    expect(packaging.verifyPackage(path.join(metadata.out, "run")).evidence).toBe("synthetic");
  });
});
