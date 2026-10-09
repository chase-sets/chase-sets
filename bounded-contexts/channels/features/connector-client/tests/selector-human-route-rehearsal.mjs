import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireHeavySlot } from "../../../../../scripts/lib/heavy-slot.mjs";
import { AUTHORITY, prepare, verifyPackage, verifyExport } from "../integrations/order-authority-probe/package.mjs";

const driver = fileURLToPath(import.meta.url);
const seat = path.resolve(path.dirname(driver), "../../../../..");
const corePath = "bounded-contexts/channels/features/connector-client/integrations/order-authority-probe";
export const LANDED_HEAD = "d54fafca165b483c26c9207dc3c77447b860efd4";
// Immutable #9121 oracle, not hashes derived from the candidate checkout.
export const LANDED_DIGESTS = Object.freeze({
  "capture.html": "e92e113b376ea4e568d24bd9c51e98622d4897f3784d5c1138fa03a61b0daf03",
  "capture.test.ts": "45b14d4c9ccdf4fdab50022061220a91a819309b5e0ded8a42ab044af2f603ae",
  "helper.js": "5b2fd477efd24c6706f388031f0c84c32168e8c3ea820349ae3b16a24f5ef75a",
  "manifest.json": "7e4d6ca9b8e34087eb9d36375d4ed0848bc806a8531748a831ab9d92888050b4",
  "package.mjs": "d0b765ab19f3accb56fbdeb6d9694acb1ac6d864e64018b36a62681a8beb00f6",
  "worker.js": "3530d525a67b8534b7697ceac7d16de547c5203ad2861831f6cee69199905856",
});
export const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
export const PRIVATE_TOKEN = "SYNTHETIC_PRIVATE_SENTINEL_9155";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const check = (condition, code) => {
  if (!condition) throw new Error(code);
};
const git = (...args) =>
  execFileSync("git", args, { cwd: seat, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function realPath(candidate) {
  check(
    typeof candidate === "string" && path.isAbsolute(candidate) && path.resolve(candidate) === candidate,
    "absolute_normalized_path_required",
  );
  for (let current = candidate; ; current = path.dirname(current)) {
    if (existsSync(current)) check(!lstatSync(current).isSymbolicLink(), "symlink_refused");
    if (path.dirname(current) === current) break;
  }
}

export function assertSource() {
  check(path.resolve(git("rev-parse", "--show-toplevel")) === seat, "wrong_seat");
  check(!git("status", "--porcelain", "--untracked-files=all"), "dirty_source_refused");
  for (const [name, digest] of Object.entries(LANDED_DIGESTS)) {
    const relative = `${corePath}/${name}`;
    check(
      hash(readFileSync(path.join(seat, relative))) === digest && hash(gitBytes(`HEAD:${relative}`)) === digest,
      "wrong_landed_source",
    );
  }
  check(
    hash(gitBytes(`HEAD:${path.relative(seat, driver).split(path.sep).join("/")}`)) === hash(readFileSync(driver)),
    "driver_identity_refused",
  );
  return git("rev-parse", "HEAD");
}

function gitBytes(reference) {
  return execFileSync("git", ["show", reference], { cwd: seat, stdio: ["ignore", "pipe", "pipe"] });
}

export function syntheticFixtures(count = 1) {
  check(Number.isInteger(count) && count >= 0 && count < 500, "synthetic_count_refused");
  return {
    lookup: { seller: { sellerKey: `${PRIVATE_TOKEN}_seller` } },
    list: {
      totalOrders: count,
      orders: Array.from({ length: count }, (_, index) => ({
        orderNumber: `${PRIVATE_TOKEN}_order_${index}`,
        buyerName: PRIVATE_TOKEN,
        orderStatus: "Ready to Ship",
        orderDate: new Date().toISOString(),
      })),
    },
  };
}

// This function is serialized into the worker. There is no live-network fallback.
export function bindSyntheticFetch(origin, fixtures) {
  if (globalThis.__selectorRehearsalBound) throw new Error("worker_rebind_refused");
  const original = globalThis.fetch;
  const localFiles = new Set(["capture-config.json", "manifest.json", "worker.js", "helper.js", "capture.html"]);
  const lookup = JSON.stringify(fixtures.lookup);
  const list = JSON.stringify(fixtures.list);
  const sellerKey = fixtures.lookup.seller.sellerKey;
  const refused = () => {
    throw new Error("synthetic_transport_refused");
  };
  const syntheticFetch = async (input, options = {}) => {
    if (typeof input !== "string") return refused();
    if (input.startsWith(`${origin}/`) && localFiles.has(input.slice(origin.length + 1))) {
      if (options.method && options.method !== "GET") return refused();
      return original(input, { ...options, credentials: "omit", redirect: "error" });
    }
    if (options.signal?.aborted) throw new Error("synthetic_request_aborted");
    if (new Headers(options.headers).has("authorization")) return refused();
    let body;
    if (
      input === "https://sp-api.tcgplayer.com/account/auth-detail?api-version=1.0" &&
      options.method === "GET" &&
      options.body === undefined
    )
      body = lookup;
    else if (
      input === "https://order-management-api.tcgplayer.com/orders/search?api-version=2.0" &&
      options.method === "POST"
    ) {
      const value = JSON.parse(options.body);
      const expected = {
        searchRange: "LastTwoYears",
        filters: { sellerKey, orderStatuses: ["ReadyToShip"] },
        sortBy: [],
        from: 0,
        size: 500,
      };
      if (JSON.stringify(value) !== JSON.stringify(expected)) return refused();
      body = list;
    } else return refused();
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  };
  Object.defineProperty(globalThis, "fetch", { value: syntheticFetch, writable: false, configurable: false });
  Object.defineProperty(globalThis, "__selectorRehearsalBound", { value: true });
  return true;
}

export function chromeArguments(profile, proxyPort) {
  realPath(profile);
  check(Number.isInteger(proxyPort) && proxyPort > 0 && proxyPort <= 65535, "owned_deny_proxy_required");
  return [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-quic",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    "--proxy-bypass-list=<-loopback>",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "about:blank",
  ];
}

export function humanInstructions(metadata) {
  const { out, preparation: p } = metadata;
  const cli = path.join(seat, corePath, "package.mjs");
  return `# SYNTHETIC HUMAN route rehearsal for #9155 / #9115

PENDING_HOST_REVIEW. Software/CI PASS is NOT HUMAN acceptance, provider qualification,
selector-live authority, #9115 closure or #8612 release. #9115 remains HOLD.
Run once AFTER landing, from a clean host-registered seat at the actual merge head
or a descendant with identical driver/core digests. Host binds the actual HEAD,
driver digest, six landed core digests, package digests and independent review/CI links.
Never reuse an old root/profile, move T0, replace observations or retry a failed run.
Ignore the live sign-in/launch language in run/RUNBOOK.md: this synthetic relay
launches Chrome ONLY through the driver with startup isolation. NEVER sign in,
open a provider page, import cookies/credentials, or launch preparation.launchCommand.
Host exact-head offline Chrome sentinel proof uses unchanged exclusive heavy admission;
it is AC evidence, not a lane publication/landing gate. Hosted CI owns product proof.

1. Host runs from this bound seat in the foreground:
   node "${driver}" --out "${out}"
   Keep that terminal running. The driver refuses before HANDOFF unless source,
   executable, startup network deny, worker-only seam and HTTPS sentinel bind.
   T0: ${p.t0}; deadline: ${new Date(Date.parse(p.t0) + 900000).toISOString()}.
   Real UTC and 30000 ms cadence only. Delay/expiry/cancel/isolation failure: HOLD.
2. HUMAN sets Chrome Downloads to "${p.receiptDirectory}"; permits exactly the
   two selector JSON downloads. No Playwright download/dialog owner is attached.
   HUMAN opens chrome://extensions > Developer mode > Load unpacked:
   ${p.packageDirectory}
   Confirms exact ID ${p.extensionId}. Wait for terminal HANDOFF before opening
   ${p.captureUrl}
   HUMAN opens the local Orders fixture in this SAME isolated Chrome:
   ${metadata.ordersUrl}
   The page is labelled SYNTHETIC, has a static Ready to Ship quick-filter count 1,
   no account/order data, and resets range on every fresh load. No provider page.
3. HUMAN selects Last 2 years in the fixture BEFORE helper begin. In ONLY the
   helper console invoke: await orderAuthorityCapture.run()
   No arguments. HUMAN alone answers every native prompt/confirm. During the
   real cadence wait, do not take a retrospective count. Follow range -> adjacent
   label transcription -> settled -> unchanged -> read that count ONCE. No label
   prefill/echo, all-orders/pagination/search totals or replacement observations.
   Before count observedAt <= request start, gap <=30000 ms.
4. After the response, HUMAN accepts the fresh-Orders-load prompt only after
   actually reloading the local Orders tab. The fixture resets to Last 90 days.
   Report that range to the helper; when correction is requested restore Last
   2 years ONCE, wait for settled, then confirm range. Transcribe the adjacent
   label, attest this fresh load settled and unchanged except that restoration,
   read the count ONCE and confirm same synthetic session. Response end <= after
   observedAt, gap <=120000 ms. Worker total stays hidden until both brackets seal.
   Host records actual UTC chronology, reload/reset and the single restoration.
5. Retain exactly selector-receipt.json + selector-inventory.json in receipt.
   Host verifies BEFORE publication, retains pair hashes and complete timing:
   node "${cli}" --verify-export --out "${path.join(out, "run")}"
   Nonqualified/unknown/failure/missing/late phase: HOLD, no automatic rerun.
6. HUMAN removes exact ID ${p.extensionId} through this profile's
   chrome://extensions, confirms UI absence and records ACTUAL UTC within
   [receipt.finishedAt, receipt.deadlineAt]. No CDP uninstall/offline substitute.
   HUMAN closes this exact profile, then manually deletes ONLY the checked
   absolute directory "${p.profileDirectory}" OUTSIDE agent tools.
   Host independently observes that exact path absent, zero exact-profile Chrome
   processes, and NO unknown/unreadable command lines; accepts full chronology.
   Disposal/host observations may finish later; late UI absence never qualifies.
7. Host exercises the landed synthetic removal recorder AFTER those observations
   (replace the time with the HUMAN's actual observed UTC, not disposal time):
   node "${cli}" --record-removal --extension-absent --extension-absent-at "<actual UI absence UTC>" --out "${path.join(out, "run")}"
   node "${cli}" --verify-export --out "${path.join(out, "run")}"
   Retain before/after pair hashes. The validator is NOT UI/process absence proof.
   Host publishes exact landed driver/package digests, runnable bound commands,
   scrubbed chronology, path/process observations and independent acceptance links
   as selector-successor-human-route-rehearsal. #9115 stays HOLD until accepted.

Driver never handles dialogs, reloads/corrects Orders, installs/removes an extension,
closes Chrome or deletes profiles. Ctrl+C detaches monitoring only; HUMAN still owns
closure/disposal. Any terminal HOLD requires retained evidence and host disposition.
`;
}

export function prepareRehearsal(out) {
  const head = assertSource();
  realPath(out);
  check(
    path.dirname(out) === path.join(seat, "artifacts", "9115") &&
      /^human-route-rehearsal-[A-Za-z0-9-]+$/.test(path.basename(out)),
    "unsafe_destination",
  );
  check(!existsSync(out), "existing_destination_refused");
  mkdirSync(out, { recursive: true });
  const p = prepare({
    out: path.join(out, "run"),
    cadenceMs: 30000,
    cadenceSource: AUTHORITY,
    t0: new Date().toISOString(),
    synthetic: true,
  });
  verifyPackage(path.join(out, "run"));
  const orders = path.join(out, "synthetic-orders.html");
  writeFileSync(
    orders,
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>SYNTHETIC Orders</title><h1>SYNTHETIC Orders: no account or order data</h1><label>Date range <select><option value="LastThreeMonths">Last 90 days</option><option value="LastTwoYears">Last 2 years</option></select></label><p>Ready to Ship <strong>1</strong></p><p>Fresh reload resets range. HUMAN restores it once.</p><script>addEventListener("pageshow", () => { document.querySelector("select").value = "LastThreeMonths"; });</script></html>\n`,
    { flag: "wx" },
  );
  const metadata = {
    evidence: "synthetic",
    qualification: "PENDING_HOST_REVIEW",
    head,
    out,
    landedCoreHead: LANDED_HEAD,
    landedCoreDigests: LANDED_DIGESTS,
    driverDigest: hash(readFileSync(driver)),
    preparation: p,
    ordersUrl: pathToFileURL(orders).href,
    chromeExecutable: CHROME,
    isolation: "owned-loopback-deny-proxy+dns-deny+worker-only-seam",
  };
  writeFileSync(path.join(out, "handoff.json"), json(metadata), { flag: "wx" });
  writeFileSync(path.join(out, "HUMAN.md"), humanInstructions(metadata), { flag: "wx" });
  return metadata;
}

export function verifySyntheticExport(run) {
  const index = verifyExport(run);
  check(index.evidence === "synthetic", "live_export_refused");
  for (const name of ["selector-receipt.json", "selector-inventory.json"]) {
    const text = readFileSync(path.join(run, "receipt", name), "utf8");
    assertNoSyntheticPrivateTokens(text);
  }
  return index;
}

export function assertNoSyntheticPrivateTokens(text) {
  for (const value of [
    PRIVATE_TOKEN,
    `${PRIVATE_TOKEN}_seller`,
    ...syntheticFixtures(499).list.orders.map((row) => row.orderNumber),
  ]) {
    for (const encoding of [value, encodeURIComponent(value), Buffer.from(value).toString("base64"), hash(value)])
      check(!text.includes(encoding), "synthetic_private_token_leak");
  }
}

export class WorkerIsolation {
  constructor(send, metadata, report) {
    this.send = send;
    this.metadata = metadata;
    this.report = report;
    this.session = null;
    this.ready = false;
    this.held = false;
    this.exportSealed = false;
  }
  hold(code) {
    this.ready = false;
    this.held = true;
    this.report("HOLD", code);
  }
  async start() {
    await this.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "service_worker" }, { exclude: true }],
    });
  }
  async attached({ sessionId, targetInfo, waitingForDebugger }) {
    const p = this.metadata.preparation;
    if (
      this.held ||
      this.session ||
      !waitingForDebugger ||
      targetInfo.type !== "service_worker" ||
      targetInfo.url !== `chrome-extension://${p.extensionId}/worker.js`
    ) {
      this.hold("worker_restart_or_identity_refused");
      return;
    }
    this.session = sessionId;
    try {
      await this.send("Network.enable", {}, sessionId);
      await this.send("Network.setBlockedURLs", { urls: ["http://*", "https://*", "ws://*", "wss://*"] }, sessionId);
      await this.send("Runtime.enable", {}, sessionId);
      await this.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
      const expression = `(${bindSyntheticFetch.toString()})(${JSON.stringify(`chrome-extension://${p.extensionId}`)},${JSON.stringify(syntheticFixtures())})`;
      const bound = await this.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
      check(bound.result?.value === true && !bound.exceptionDetails, "worker_seam_refused");
      const sentinel = await this.send(
        "Runtime.evaluate",
        {
          expression: `(async () => { try { await fetch('https://synthetic-provider.invalid/never-live'); return false; } catch (error) { return error.message === 'synthetic_transport_refused'; } })()`,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      );
      check(sentinel.result?.value === true && !sentinel.exceptionDetails, "https_sentinel_refused");
      check(!this.held, "worker_detached_during_binding");
      this.ready = true;
      this.report("HANDOFF", "worker_only_seam_and_https_sentinel_bound");
    } catch {
      this.hold("worker_isolation_refused");
    }
  }
  detached({ sessionId }) {
    if (sessionId !== this.session) return;
    this.ready = false;
    if (this.exportSealed) this.report("PENDING_HOST_REVIEW", "worker_absent_human_ui_observation_required");
    else this.hold("worker_detached_no_restart");
  }
  // After the export seals, Chrome closing tears down the monitor before the process exits.
  monitorClosed(exited) {
    if (!exited && !this.exportSealed) this.hold("monitor_disconnected");
  }
}

// The T0+15 min window bounds capture and UI removal; HUMAN close/disposal may finish later.
export function monitoring({ exited, exportVerified, now, t0 }) {
  return !exited && (exportVerified || now <= Date.parse(t0) + 900000);
}

export class WorkerCdp {
  constructor(socket, onEvent, onClose) {
    this.socket = socket;
    this.pending = new Map();
    this.sequence = 0;
    socket.addEventListener("message", ({ data }) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        onClose();
        socket.close();
        return;
      }
      if (message.id) {
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error("cdp_command_refused"));
        else item.resolve(message.result);
      } else onEvent(message);
    });
    socket.addEventListener("close", () => {
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("cdp_disconnected"));
      }
      this.pending.clear();
      onClose();
    });
  }
  send(method, params = {}, sessionId) {
    check(
      method === "Target.setAutoAttach" ||
        (sessionId &&
          [
            "Network.enable",
            "Network.setBlockedURLs",
            "Runtime.enable",
            "Runtime.runIfWaitingForDebugger",
            "Runtime.evaluate",
          ].includes(method)),
      "non_worker_command_refused",
    );
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("cdp_command_timeout"));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("cdp_send_refused"));
      }
    });
  }
}

async function run(out) {
  check(process.platform === "win32" && path.resolve(process.cwd()) === seat, "registered_windows_seat_required");
  realPath(CHROME);
  check(
    existsSync(CHROME) && lstatSync(CHROME).isFile() && realpathSync(CHROME) === CHROME,
    "absolute_chrome_identity_refused",
  );
  check(acquireHeavySlot("playwright"), "registered_heavy_admission_required");
  const metadata = prepareRehearsal(out);
  const evidence = path.join(out, "transport.json");
  const events = [];
  const report = (phase, code) => {
    events.push({ phase, code, at: new Date().toISOString() });
    writeFileSync(evidence, json({ evidence: "synthetic", qualification: "PENDING_HOST_REVIEW", events }));
    console.log(`selector-human-rehearsal: ${phase} ${code}`);
  };
  report("WAITING", "human_install_required_no_begin");
  const deny = createServer((connection) => connection.destroy());
  await new Promise((resolve, reject) => {
    deny.once("error", reject);
    deny.listen(0, "127.0.0.1", resolve);
  });
  const args = chromeArguments(metadata.preparation.profileDirectory, deny.address().port);
  writeFileSync(
    path.join(out, "launch.json"),
    json({ chromeExecutable: CHROME, arguments: args, evidence: "synthetic" }),
    { flag: "wx" },
  );
  const child = spawn(CHROME, args, { stdio: "ignore", windowsHide: false });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", () => {
    exited = true;
    report("HOLD", "chrome_startup_refused");
  });
  const portFile = path.join(metadata.preparation.profileDirectory, "DevToolsActivePort");
  let socket;
  let isolation;
  try {
    const start = Date.now();
    while (!existsSync(portFile) && !exited && Date.now() - start < 15000) await pause(100);
    check(!exited && existsSync(portFile), "chrome_startup_refused");
    const [port, endpoint] = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    check(
      /^\d{1,5}$/.test(port) &&
        Number(port) > 0 &&
        Number(port) <= 65535 &&
        /^\/devtools\/browser\/[a-f0-9-]+$/.test(endpoint),
      "debug_identity_refused",
    );
    socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("debug_startup_timeout")), 10000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("debug_startup_refused"));
        },
        { once: true },
      );
    });
    const cdp = new WorkerCdp(
      socket,
      (event) => {
        if (event.method === "Target.attachedToTarget") void isolation.attached(event.params);
        if (event.method === "Target.detachedFromTarget") isolation.detached(event.params);
      },
      () => isolation.monitorClosed(exited),
    );
    isolation = new WorkerIsolation(cdp.send.bind(cdp), metadata, report);
    await isolation.start();
    console.log(`HUMAN instructions: ${path.join(out, "HUMAN.md")}`);
    let exportVerified = false;
    while (monitoring({ exited, exportVerified, now: Date.now(), t0: metadata.preparation.t0 })) {
      if (isolation.held) throw new Error("isolation_hold");
      if (
        isolation.ready &&
        !exportVerified &&
        ["selector-receipt.json", "selector-inventory.json"].every((name) =>
          existsSync(path.join(out, "run", "receipt", name)),
        )
      ) {
        verifySyntheticExport(path.join(out, "run"));
        const receipt = JSON.parse(readFileSync(path.join(out, "run", "receipt", "selector-receipt.json"), "utf8"));
        check(
          receipt.failures.length === 0 &&
            receipt.selector.searches.length === 1 &&
            receipt.selector.searches[0].qualification === "qualified",
          "synthetic_capture_unknown",
        );
        exportVerified = true;
        isolation.exportSealed = true;
        report("EXPORT_VERIFIED", "synthetic_only_human_removal_still_pending");
      }
      await pause(250);
    }
    check(exportVerified && exited, "expiry_or_missing_export_hold");
    report("PENDING_HOST_REVIEW", "human_closed_profile_host_disposal_observations_required");
  } catch {
    report("HOLD", "startup_isolation_or_lifecycle_refused");
    process.exitCode = 1;
  } finally {
    socket?.close();
    // Keep the deny proxy alive on HOLD until HUMAN closes this exact Chrome.
    while (!exited) await pause(250);
    await new Promise((resolve) => deny.close(resolve));
    child.unref();
    // Never kill Chrome or dispose its profile, including on failure.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === driver) {
  try {
    const args = process.argv.slice(2);
    check(args.length === 2 && args[0] === "--out" && args[1], "invalid_arguments");
    await run(args[1]);
  } catch {
    console.error(
      "selector-human-rehearsal: HOLD; source, destination, admission or startup refused; no human acceptance",
    );
    process.exitCode = 1;
  }
}
