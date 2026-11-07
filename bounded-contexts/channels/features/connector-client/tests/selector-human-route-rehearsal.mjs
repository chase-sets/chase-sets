import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

export const historicalSource = path.join(seat, "artifacts", "9514", `historical-${LANDED_HEAD}`);
function historicalBytes(name) {
  try {
    return gitBytes(`${LANDED_HEAD}:${corePath}/${name}`);
  } catch {
    throw new Error("historical_source_unavailable");
  }
}
let historicalPackage;
export async function loadHistoricalPackage() {
  // Read every immutable blob before creating anything. Shallow advisory
  // checkouts fail closed, without a candidate fallback or rebaselined oracle.
  const historicalCore = Object.fromEntries(Object.keys(LANDED_DIGESTS).map((name) => [name, historicalBytes(name)]));
  realPath(historicalSource);
  for (const [name, bytes] of Object.entries(historicalCore)) {
    check(hash(bytes) === LANDED_DIGESTS[name], "wrong_landed_source");
    const file = path.join(historicalSource, corePath, name);
    mkdirSync(path.dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, bytes, { flag: "wx" });
  }
  // The historical package reads its own real historical HEAD, not the
  // candidate's HEAD relabeled as the source of these immutable bytes.
  if (!existsSync(path.join(historicalSource, ".git"))) {
    execFileSync("git", ["init", "--initial-branch=historical"], { cwd: historicalSource, stdio: "ignore" });
    const common = path.resolve(seat, git("rev-parse", "--git-common-dir"), "objects");
    writeFileSync(path.join(historicalSource, ".git", "objects", "info", "alternates"), `${common}\n`, { flag: "wx" });
  }
  execFileSync("git", ["update-ref", "HEAD", LANDED_HEAD], { cwd: historicalSource, stdio: "ignore" });
  assertSource();
  historicalPackage = await import(pathToFileURL(path.join(historicalSource, corePath, "package.mjs")).href);
  return historicalPackage;
}

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
  for (const [name, digest] of Object.entries(LANDED_DIGESTS)) {
    check(
      !lstatSync(path.join(historicalSource, corePath, name)).isSymbolicLink() &&
        hash(readFileSync(path.join(historicalSource, corePath, name))) === digest &&
        hash(historicalBytes(name)) === digest,
      "wrong_landed_source",
    );
  }
  return LANDED_HEAD;
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

function historicalInstructions() {
  return "# Historical #9121 fixture only\nNo prospective human launch or acceptance authority.\n";
}

export function prepareRehearsal(out) {
  const head = assertSource();
  check(historicalPackage, "historical_package_not_loaded");
  const { AUTHORITY, prepare, verifyPackage } = historicalPackage;
  realPath(out);
  check(
    path.dirname(out) === path.join(seat, "artifacts", "9115") &&
      /^historical-route-rehearsal-[A-Za-z0-9-]+$/.test(path.basename(out)),
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
  writeFileSync(path.join(out, "HISTORICAL.md"), historicalInstructions(), { flag: "wx" });
  return metadata;
}

export function verifySyntheticExport(run) {
  check(historicalPackage, "historical_package_not_loaded");
  const index = historicalPackage.verifyExport(run);
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

const COMPONENT_ID = "fignfifoniblkonapihmkfakmlgkbkcf";
const COMPONENT_PROVENANCE_POLL_INTERVAL_MS = 250;
// Chrome's ImportantFileWriter first commits preferences after about 10 seconds.
const COMPONENT_PROVENANCE_DEADLINE_MS = 25000;

function chromeBundledComponentWorker(targetInfo, preparation) {
  const id = COMPONENT_ID;
  return (
    preparation.extensionId !== id &&
    targetInfo.type === "service_worker" &&
    targetInfo.url === `chrome-extension://${id}/service_worker.js`
  );
}

function componentProvenance(preparation) {
  let settings;
  try {
    const preferences = path.join(preparation.profileDirectory, "Default", "Secure Preferences");
    realPath(preferences);
    check(lstatSync(preferences).isFile(), "component_preferences_refused");
    settings = JSON.parse(readFileSync(preferences, "utf8"))?.extensions?.settings;
  } catch (error) {
    if (
      ["absolute_normalized_path_required", "symlink_refused", "component_preferences_refused"].includes(error.message)
    )
      return "refused";
    return "unavailable";
  }
  if (!settings || !Object.hasOwn(settings, COMPONENT_ID)) return "unavailable";
  const registration = settings[COMPONENT_ID];
  // Trust the fresh Chrome-owned profile, not preference MACs or hostile local writers.
  // Chrome's bundled resource path is logical, not necessarily a directory on disk.
  return registration?.location === 5 &&
    registration.manifest?.manifest_version === 3 &&
    registration.manifest.background?.service_worker === "service_worker.js" &&
    typeof registration.path === "string" &&
    // Guard cwd-relative resolution even though run() pins the working directory.
    path.win32.isAbsolute(registration.path) &&
    /^\d+\.\d+\.\d+\.\d+\\resources\\network_speech_synthesis\\mv3$/.test(
      path.win32.relative(path.win32.dirname(CHROME), registration.path),
    )
    ? "verified"
    : "refused";
}

export class WorkerIsolation {
  constructor(send, metadata, report, { componentProvenancePoll = {} } = {}) {
    const { intervalMs = COMPONENT_PROVENANCE_POLL_INTERVAL_MS, deadlineMs = COMPONENT_PROVENANCE_DEADLINE_MS } =
      componentProvenancePoll;
    check(
      Number.isFinite(intervalMs) && intervalMs > 0 && Number.isFinite(deadlineMs) && deadlineMs >= 0,
      "component_provenance_poll_refused",
    );
    this.componentProvenancePoll = { intervalMs, deadlineMs };
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
    if (!this.held && chromeBundledComponentWorker(targetInfo, p)) {
      const { intervalMs, deadlineMs } = this.componentProvenancePoll;
      const deadline = performance.now() + deadlineMs;
      while (!this.held) {
        const provenance = componentProvenance(p);
        if (provenance === "verified") break;
        if (provenance === "refused") {
          this.hold("component_provenance_refused");
          return;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          this.hold("component_provenance_unavailable");
          return;
        }
        await pause(Math.min(intervalMs, remaining));
      }
      if (this.held) return;
      try {
        await this.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
        await this.send("Target.detachFromTarget", { sessionId });
        this.report("COMPONENT_DETACHED", "chrome_bundled_network_speech_no_binding");
      } catch {
        this.hold("component_worker_detach_refused");
      }
      return;
    }
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
      check(!this.held, "worker_detached_during_binding");
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
    if (this.exportSealed) this.report("PENDING_HOST_REVIEW", "worker_absent_ui_observation_required");
    else this.hold("worker_detached_no_restart");
  }
  // After the export seals, Chrome closing tears down the monitor before the process exits.
  monitorClosed(exited) {
    if (!exited && !this.exportSealed) this.hold("monitor_disconnected");
  }
}

// The C window bounds capture and UI removal; disposal acceptance remains separate.
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
        (method === "Target.detachFromTarget" &&
          !sessionId &&
          Object.keys(params).length === 1 &&
          typeof params.sessionId === "string" &&
          params.sessionId.length > 0) ||
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

if (process.argv[1] && path.resolve(process.argv[1]) === driver) {
  console.error("selector-historical-rehearsal: prospective launch authority withdrawn");
  process.exitCode = 1;
}
