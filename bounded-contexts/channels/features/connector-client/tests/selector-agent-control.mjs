import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const closed = (value, keys) =>
  value && typeof value === "object" && !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort());
const utc = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const check = (value, code) => {
  if (!value) throw new Error(code);
};
const freeze = (value) => {
  for (const member of Object.values(value)) if (member && typeof member === "object") freeze(member);
  return Object.freeze(value);
};

// One identity binds both modes, including their different operation sets.
const contract = {
  identity: "selector-agent-operation-capability-policy/v1",
  tool: "channels-selector-run-endpoint/v1",
  operations: {
    S: [
      "attach",
      "pause",
      "resume",
      "navigate-orders",
      "initial-range",
      "reload",
      "restore",
      "fallback-check",
      "close",
    ],
    C: ["attach", "install", "pause", "resume", "cancel-before-begin", "capture", "remove", "close"],
  },
  phases: [
    "admission",
    "private-sign-in",
    "Orders-navigation",
    "initial-range",
    "post-reload",
    "restoration",
    "fallback-check",
    "closure",
    "disposal",
  ],
  causes: [
    "SIGN_IN_NOT_COMPLETED",
    "ORDERS_UI_UNREACHABLE",
    "ANCHOR_ABSENT",
    "ANCHOR_AMBIGUOUS",
    "STATE_CONTRADICTORY",
    "SETTLE_UNOBSERVABLE",
    "DEADLINE",
    "DISCLOSURE_GUARD",
    "CONTROL_BOUNDARY_LOST",
    "PROTOCOL_REFUSED",
    "CANCELLED",
    "ADAPTER_FAILURE",
  ],
  cleanup: ["PENDING", "REFUSED", "FAILED", "LATE", "TIMELY_VERIFIED"],
  booleans: [
    "rangeSemanticsValid",
    "selectedRangeValid",
    "quickFilterRelationshipValid",
    "currentEpochComplete",
    "oldCompletionInvalidated",
  ],
  cardinalities: ["rangeControlMatches", "quickFilterLabelMatches", "adjacentCountMatches", "completionSignalMatches"],
  ranges: ["LastTwoYears", "LastThreeMonths"],
  // Candidate DOM contract; authenticated Orders fidelity is NOT_CAPTURED.
  anchors: {
    orders: "[data-selector-orders]",
    range: 'select[name="dateRange"]',
    quickFilter: '[data-quick-filter="ReadyToShip"]',
    label: "[data-filter-label]",
    count: "[data-filter-count]",
    completion: "[data-orders-completion]",
  },
};
export const POLICY = freeze({ ...contract, hash: hash(JSON.stringify(contract)) });

export function validateTerminal(value, acceptance = false) {
  if (
    !closed(value, ["phase", "cause", "cleanup", "at"]) ||
    !POLICY.phases.includes(value.phase) ||
    !(value.cause === null || POLICY.causes.includes(value.cause)) ||
    !POLICY.cleanup.includes(value.cleanup) ||
    !utc(value.at)
  )
    return null;
  if (acceptance && (value.phase !== "disposal" || value.cause !== null || value.cleanup !== "TIMELY_VERIFIED"))
    return null;
  return { phase: value.phase, cause: value.cause, cleanup: value.cleanup, at: value.at };
}
export function validatePayload(value) {
  if (
    !closed(value, [...POLICY.booleans, ...POLICY.cardinalities]) ||
    POLICY.booleans.some((name) => typeof value[name] !== "boolean") ||
    POLICY.cardinalities.some((name) => ![0, 1, "many"].includes(value[name]))
  )
    return null;
  return Object.fromEntries([...POLICY.booleans, ...POLICY.cardinalities].map((name) => [name, value[name]]));
}

// Serialized only by the private adapter. No order count text or network reads.
export function inspectOrders(document, expectedRange, previous = null) {
  if (!document.querySelectorAll) {
    previous = document.previous;
    expectedRange = document.range;
    document = globalThis.document;
  }
  const cardinality = (n) => (n === 0 ? 0 : n === 1 ? 1 : "many");
  const roots = [...document.querySelectorAll("[data-selector-orders]")];
  const ranges = roots.flatMap((root) => [...root.querySelectorAll('select[name="dateRange"]')]);
  const filters = roots.flatMap((root) => [...root.querySelectorAll('[data-quick-filter="ReadyToShip"]')]);
  const labels = filters.flatMap((filter) => [...filter.querySelectorAll("[data-filter-label]")]);
  const counts = labels.flatMap((label) =>
    label.nextElementSibling?.matches("[data-filter-count]") ? [label.nextElementSibling] : [],
  );
  const completions = roots.flatMap((root) => [...root.querySelectorAll("[data-orders-completion]")]);
  const range = ranges[0];
  const options = range ? [...range.options] : [];
  const rangeSemanticsValid =
    options.length === 2 &&
    ["LastTwoYears", "LastThreeMonths"].every(
      (value, i) =>
        options.filter(
          (option) =>
            option.value === value &&
            option.textContent.trim().replace(/\s+/g, " ") === ["Last 2 years", "Last 90 days"][i],
        ).length === 1,
    );
  const labelValid =
    labels.length === 1 && labels[0].textContent.trim().replace(/\s+/g, " ").toLowerCase() === "ready to ship";
  const selected = ranges.length === 1 ? range.value : null;
  const loading = roots.length === 1 && roots[0].getAttribute("aria-busy") === "true";
  const observable = roots.length === 1 && ["true", "false"].includes(roots[0].getAttribute("aria-busy"));
  const token = completions.length === 1 ? completions[0].getAttribute("data-load") : null;
  const completionRange = completions.length === 1 ? completions[0].getAttribute("data-range") : null;
  const invalidated = previous !== null && (previous.token !== token || loading || completionRange !== selected);
  const complete =
    observable &&
    !loading &&
    !!token &&
    completionRange === selected &&
    selected === expectedRange &&
    (previous === null || (invalidated && previous.token !== token));
  const payload = {
    rangeSemanticsValid,
    selectedRangeValid: selected === expectedRange,
    quickFilterRelationshipValid: filters.length === 1 && labelValid && counts.length === 1,
    currentEpochComplete: complete,
    oldCompletionInvalidated: invalidated,
    rangeControlMatches: cardinality(ranges.length),
    quickFilterLabelMatches: cardinality(labels.length),
    adjacentCountMatches: cardinality(counts.length),
    completionSignalMatches: cardinality(completions.length),
  };
  let cause = null;
  if (roots.length === 0) cause = "ORDERS_UI_UNREACHABLE";
  else if ([roots, ranges, filters, labels, counts, completions].some((matches) => matches.length > 1))
    cause = "ANCHOR_AMBIGUOUS";
  else if ([roots, ranges, filters, labels, counts].some((matches) => matches.length === 0)) cause = "ANCHOR_ABSENT";
  else if (!rangeSemanticsValid || !labelValid || (!loading && completionRange && completionRange !== selected))
    cause = "STATE_CONTRADICTORY";
  else if (!observable || !token || completions.length === 0) cause = "SETTLE_UNOBSERVABLE";
  else if (!complete && !loading && selected === expectedRange) cause = "SETTLE_UNOBSERVABLE";
  return { payload, cause, token, selected, loading };
}

const bindingKeys = [
  "evidence",
  "runId",
  "mode",
  "performer",
  "verifier",
  "session",
  "model",
  "tool",
  "root",
  "profile",
  "profileIdentity",
  "executable",
  "executableHash",
  "version",
  "packageId",
  "packageHash",
  "adapterHash",
  "policyIdentity",
  "policyHash",
  "controlHash",
  "startedAt",
  "freshSignedOut",
];
const absolute = (value) => typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value;
function pathIdentity(target) {
  const identities = [];
  for (let current = target; ; current = path.dirname(current)) {
    check(existsSync(current), "cleanup_path_missing");
    const stat = lstatSync(current, { bigint: true });
    check(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(current) === current, "cleanup_link_refused");
    identities.push([current, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
    if (path.dirname(current) === current) break;
  }
  return identities;
}
export function validateCleanupTarget(binding, admitted = null) {
  check(
    absolute(binding.root) && absolute(binding.profile) && binding.profile === path.join(binding.root, "profile"),
    "cleanup_target_refused",
  );
  check(
    /^selector-(capability|sentinel|rehearsal|S|C)-[A-Za-z0-9-]+$/.test(path.basename(binding.root)),
    "cleanup_scope_refused",
  );
  const identities = pathIdentity(binding.profile);
  const expected = admitted ?? binding.profileIdentity;
  check(!expected || same(identities, expected), "cleanup_race_refused");
  return identities;
}
function validateBinding(binding, identity) {
  check(
    closed(binding, bindingKeys) &&
      closed(identity, bindingKeys) &&
      bindingKeys.every((name) => same(binding[name], identity[name])),
    "attachment_identity_refused",
  );
  check(
    binding.evidence === "synthetic" &&
      ["C", "S"].includes(binding.mode) &&
      binding.performer === "selector-agent-operator" &&
      binding.verifier === "selector-agent-host-verifier" &&
      binding.tool === POLICY.tool &&
      binding.policyIdentity === POLICY.identity &&
      binding.policyHash === POLICY.hash &&
      binding.adapterHash === hash(readFileSync(source)) &&
      binding.controlHash === binding.adapterHash &&
      absolute(binding.executable) &&
      lstatSync(binding.executable).isFile() &&
      !lstatSync(binding.executable).isSymbolicLink() &&
      binding.executableHash === hash(readFileSync(binding.executable)) &&
      /^[a-p]{32}$/.test(binding.packageId) &&
      /^[a-f0-9]{64}$/.test(binding.packageHash) &&
      ["runId", "session", "model", "version"].every(
        (name) => typeof binding[name] === "string" && /^[A-Za-z0-9./_-]{1,100}$/.test(binding[name]),
      ) &&
      utc(binding.startedAt) &&
      binding.freshSignedOut === true,
    "attachment_boundary_refused",
  );
  validateCleanupTarget(binding);
}
class SelectorFailure extends Error {
  constructor(code) {
    super("selector_operation_refused");
    this.code = POLICY.causes.includes(code) ? code : "ADAPTER_FAILURE";
  }
}

export function attachSelectorSession({ binding, browser, now = Date.now }) {
  validateBinding(binding, browser.identity);
  // Persist before admitting any operation. The marker survives cancellation,
  // restart and profile disposal, with no age-based reclaim or retry route.
  const marker = path.join(path.dirname(binding.root), `${path.basename(binding.root)}.agent-control.json`);
  let descriptor;
  try {
    descriptor = openSync(marker, "wx", 0o600);
    writeSync(
      descriptor,
      JSON.stringify({
        format: "selector-agent-ownership/v1",
        runId: binding.runId,
        policyIdentity: POLICY.identity,
        policyHash: POLICY.hash,
        session: binding.session,
        state: "CONSUMED",
        at: new Date(now()).toISOString(),
      }) + "\n",
    );
    fsyncSync(descriptor);
  } catch (error) {
    throw new Error(error.code === "EEXIST" ? "selector_lifecycle_consumed" : "selector_admission_refused");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const admitted = structuredClone(binding);
  const used = new Set();
  let phase = "admission",
    failurePhase = null,
    paused = false,
    cause = null,
    terminal = false,
    cleanup = "PENDING",
    inFlight = false;
  const deadline = Date.parse(binding.startedAt) + 900000;
  function refuse(code) {
    if (cause === null) {
      cause = code;
      failurePhase = phase;
    }
    terminal = true;
    return null;
  }
  const hostTerminal = (cleanupEvidence = null) => {
    if (cleanupEvidence !== null) {
      const validated = validateCleanupEvidence(admitted, cleanupEvidence);
      if (!validated) return null;
      if (cleanup === "PENDING") cleanup = validated.cleanup;
    }
    return { phase: failurePhase ?? phase, cause, cleanup, at: new Date(now()).toISOString() };
  };
  async function execute(message) {
    if (inFlight) return refuse("PROTOCOL_REFUSED");
    if (
      !closed(message, ["runId", "policyHash", "operation"]) ||
      message.runId !== admitted.runId ||
      message.policyHash !== POLICY.hash ||
      !POLICY.operations[admitted.mode].includes(message.operation)
    )
      return refuse("PROTOCOL_REFUSED");
    const op = message.operation;
    if (terminal && !["remove", "close"].includes(op)) return null;
    if (paused && op !== "resume" && op !== "close") return null;
    if (now() > deadline && !["remove", "close"].includes(op)) return refuse("DEADLINE");
    if (used.has(op)) return refuse("PROTOCOL_REFUSED");
    const allowed = {
      attach: ["admission"],
      install: ["private-sign-in"],
      pause: ["private-sign-in"],
      resume: ["private-sign-in"],
      "navigate-orders": ["Orders-navigation"],
      "initial-range": ["initial-range"],
      reload: ["post-reload"],
      restore: ["restoration"],
      "fallback-check": ["fallback-check"],
      "cancel-before-begin": ["private-sign-in"],
      capture: ["private-sign-in", "Orders-navigation"],
      remove: terminal ? POLICY.phases : ["closure"],
      close: POLICY.phases,
    };
    if (!allowed[op]?.includes(phase)) return refuse("PROTOCOL_REFUSED");
    inFlight = true;
    used.add(op);
    try {
      if (bindingKeys.some((name) => !same(browser.identity[name], admitted[name])))
        return refuse("CONTROL_BOUNDARY_LOST");
      if (op === "remove" && now() > deadline) refuse("DEADLINE");
      if (op === "attach") {
        phase = "private-sign-in";
        return { ok: true };
      }
      if (op === "pause") {
        paused = true;
        await browser.pause?.();
        return null;
      }
      if (op === "resume") {
        paused = false;
        await browser.resume?.();
        phase = "Orders-navigation";
        return { ok: true };
      }
      if (op === "close") {
        if (!terminal && !used.has(admitted.mode === "C" ? "capture" : "fallback-check"))
          refuse(phase === "private-sign-in" ? "SIGN_IN_NOT_COMPLETED" : "PROTOCOL_REFUSED");
        phase = "closure";
        await browser.close();
        phase = "disposal";
        return paused ? null : { ok: true };
      }
      if (op === "cancel-before-begin") {
        await browser.action(op);
        phase = "closure";
        refuse("CANCELLED");
        return { ok: true };
      }
      if (["install", "remove", "capture"].includes(op)) {
        const result = await browser.action(op);
        if (!closed(result, ["ok"]) || result.ok !== true) return refuse("DISCLOSURE_GUARD");
        if (op !== "install") phase = "closure";
        if (now() > deadline) return refuse("DEADLINE");
        return { ok: true };
      }
      await browser.action(op);
      if (op === "navigate-orders") {
        phase = "initial-range";
        return { ok: true };
      }
      const result = await browser.inspect();
      if (!result || !validatePayload(result.payload)) return refuse("DISCLOSURE_GUARD");
      if (result.cause !== null)
        return refuse(POLICY.causes.includes(result.cause) ? result.cause : "DISCLOSURE_GUARD");
      if (result.loading) return refuse(now() >= deadline ? "DEADLINE" : "SETTLE_UNOBSERVABLE");
      if (op === "reload" && !result.payload.selectedRangeValid) phase = "restoration";
      else if (!result.payload.currentEpochComplete) return refuse("SETTLE_UNOBSERVABLE");
      else phase = op === "initial-range" ? "post-reload" : op === "fallback-check" ? "closure" : "fallback-check";
      return validatePayload(result.payload);
    } catch (error) {
      return refuse(error instanceof SelectorFailure ? error.code : "ADAPTER_FAILURE");
    } finally {
      inFlight = false;
    }
  }
  async function dispatch(message) {
    const result = await execute(message);
    return terminal || paused ? null : result;
  }
  return Object.freeze({ dispatch, hostTerminal });
}

export function validateCleanupEvidence(binding, value) {
  if (
    !closed(value, ["format", "runId", "policyIdentity", "policyHash", "cleanup", "code", "at", "observations"]) ||
    value.format !== "selector-profile-cleanup-result/v1" ||
    value.runId !== binding.runId ||
    value.policyIdentity !== POLICY.identity ||
    value.policyHash !== POLICY.hash ||
    !POLICY.cleanup.includes(value.cleanup) ||
    !["CLEANUP_OBSERVED", "CLEANUP_REFUSED"].includes(value.code) ||
    !utc(value.at) ||
    !Array.isArray(value.observations) ||
    value.observations.length > 4
  )
    return null;
  if (value.cleanup === "TIMELY_VERIFIED") {
    if (
      value.code !== "CLEANUP_OBSERVED" ||
      value.observations.length !== 4 ||
      Date.parse(value.at) > Date.parse(binding.startedAt) + 900000
    )
      return null;
    let prior = Date.parse(binding.startedAt);
    for (const observation of value.observations) {
      if (
        !closed(observation, ["complete", "matches", "unknown", "at"]) ||
        observation.complete !== true ||
        observation.matches !== 0 ||
        observation.unknown !== 0 ||
        !utc(observation.at) ||
        Date.parse(observation.at) < prior ||
        Date.parse(observation.at) > Date.parse(value.at)
      )
        return null;
      prior = Date.parse(observation.at);
    }
  }
  return value;
}

export async function createRunEndpoint(session, binding) {
  const token = randomBytes(32).toString("hex"),
    authorization = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const candidate = Buffer.from(request.headers.authorization ?? "");
    if (
      request.method !== "POST" ||
      request.url !== "/operation" ||
      request.headers.origin !== undefined ||
      candidate.length !== authorization.length ||
      !timingSafeEqual(candidate, authorization)
    ) {
      response.writeHead(403).end();
      return;
    }
    let text = "";
    try {
      for await (const chunk of request) {
        text += chunk.toString("utf8");
        if (Buffer.byteLength(text) > 512) {
          await session.dispatch(null);
          response.writeHead(413).end();
          request.destroy();
          return;
        }
      }
      const value = JSON.parse(text);
      if (text !== JSON.stringify(value)) {
        await session.dispatch(null);
        response.writeHead(400).end();
        return;
      }
      const result = await session.dispatch(value);
      if (result === null) {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch {
      await session.dispatch(null);
      response.writeHead(400).end();
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return Object.freeze({
    tool: POLICY.tool,
    runId: binding.runId,
    policyIdentity: POLICY.identity,
    policyHash: POLICY.hash,
    url: `http://127.0.0.1:${server.address().port}/operation`,
    token,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  });
}

// Raw browser primitives are private to this offline-only Channels adapter.
export function createPlaywrightSelectorBrowser({
  context,
  preparation,
  binding,
  ordersUrl,
  deadline,
  cancel = false,
}) {
  check(binding.evidence === "synthetic" && preparation.evidence === "synthetic", "live_launch_not_authorized");
  check(context.browser().version() === binding.version, "chrome_version_refused");
  check(
    binding.packageId === preparation.extensionId &&
      binding.profile === preparation.profileDirectory &&
      binding.packageHash === hash(JSON.stringify(preparation.packageDigests)),
    "package_binding_refused",
  );
  check(new URL(ordersUrl).protocol === "file:" && absolute(fileURLToPath(ordersUrl)), "offline_orders_required");
  let orders, helper;
  let previous = null,
    expectedRange = "LastTwoYears",
    paused = false,
    closedBrowser = false;
  let dialogs = 0,
    downloads = 0,
    dialogFailure = null;
  const saved = [],
    countReads = new Set();
  async function boundary(page, expectedUrl) {
    if (closedBrowser || !page || page.url() !== expectedUrl) throw new SelectorFailure("CONTROL_BOUNDARY_LOST");
  }
  async function snapshot() {
    await boundary(orders, ordersUrl);
    return orders.evaluate(inspectOrders, {
      range: expectedRange,
      previous,
    });
  }
  async function settle() {
    while (Date.now() <= deadline) {
      const result = await snapshot();
      if (result.cause) throw new SelectorFailure(result.cause);
      if (!result.loading) return result;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new SelectorFailure("DEADLINE");
  }
  async function remember() {
    const prior = await snapshot();
    previous = { token: prior.token };
  }
  async function select(range) {
    await remember();
    expectedRange = range;
    await orders.locator(POLICY.anchors.range).selectOption(range);
  }
  async function reload() {
    await remember();
    await orders.reload({ waitUntil: "commit" });
  }
  async function count(bracket) {
    if (countReads.has(bracket)) throw new SelectorFailure("PROTOCOL_REFUSED");
    const result = await settle();
    if (!result.payload.currentEpochComplete || !result.payload.quickFilterRelationshipValid)
      throw new SelectorFailure("SETTLE_UNOBSERVABLE");
    countReads.add(bracket);
    const value = await orders.locator(`${POLICY.anchors.quickFilter} ${POLICY.anchors.count}`).textContent();
    if (!/^\d{1,9}$/.test(value ?? "")) throw new SelectorFailure("STATE_CONTRADICTORY");
    return value;
  }
  async function nativeDialog(dialog) {
    try {
      if (paused || dialogs >= 40) throw new SelectorFailure("PROTOCOL_REFUSED");
      await boundary(helper, preparation.captureUrl);
      const text = dialog.message();
      dialogs += 1;
      if (
        text ===
        "AGENT: one selector lifecycle with pre-launch T0, including sign-in and removal within T0+15 minutes? Preparation grants no execution; no raw recording or retries."
      ) {
        if (cancel) await dialog.dismiss();
        else await dialog.accept();
      } else if (
        text ===
        "The worker response has ended. AGENT: load a fresh Orders view now. Continue only after that fresh load; no screenshots or page output."
      ) {
        await reload();
        let result = await settle();
        if (!result.payload.selectedRangeValid) {
          await select(expectedRange);
          result = await settle();
        }
        if (!result.payload.currentEpochComplete) throw new SelectorFailure("SETTLE_UNOBSERVABLE");
        await dialog.accept();
      } else if (
        dialog.type() === "prompt" &&
        ["LastTwoYears", "LastThreeMonths"].some(
          (range) =>
            text ===
            `Expected range: ${range === "LastTwoYears" ? "Last 2 years" : "Last 90 days"} (${range}). Confirm the visible date filter as LastTwoYears or LastThreeMonths BEFORE reading any count. Cancel stops.`,
        )
      ) {
        const range = text.includes("(LastTwoYears)") ? "LastTwoYears" : "LastThreeMonths";
        if (expectedRange !== range || (await snapshot()).selected !== range) await select(range);
        if (!(await settle()).payload.currentEpochComplete) throw new SelectorFailure("SETTLE_UNOBSERVABLE");
        await dialog.accept(range);
      } else if (
        text ===
        "Transcribe ONLY the label adjacent to the count you intend to read. Do not read the count yet. Cancel stops."
      ) {
        if (!(await settle()).payload.quickFilterRelationshipValid) throw new SelectorFailure("STATE_CONTRADICTORY");
        await dialog.accept("Ready to Ship");
      } else if (
        [
          "Has this post-response fresh Orders load (and any explicit range restoration) settled?",
          "Has the selected Orders display settled?",
          "Has the seller, session and Orders display remained unchanged, except for the explicit range restoration above?",
          "Same seller and approved session throughout this bracket? Session loss stops.",
        ].includes(text)
      ) {
        if (!(await settle()).payload.currentEpochComplete) throw new SelectorFailure("SETTLE_UNOBSERVABLE");
        await dialog.accept();
      } else if (
        ["Last 2 years", "Last 90 days"].some(
          (label) =>
            text ===
            `Record that adjacent quick-filter count ONCE now, under ${label}. Digits only. Exclude all-orders, pagination and search totals; Cancel stops.`,
        )
      ) {
        await dialog.accept(await count(`${expectedRange}:${countReads.size % 2 === 0 ? "before" : "after"}`));
      } else throw new SelectorFailure("PROTOCOL_REFUSED");
    } catch (error) {
      dialogFailure = error instanceof SelectorFailure ? error : new SelectorFailure("ADAPTER_FAILURE");
      await dialog.dismiss().catch(() => {});
    }
  }
  async function remove() {
    const page = await context.newPage();
    await page.goto("chrome://extensions/", { waitUntil: "commit" });
    const item = page.locator(`extensions-item[id="${preparation.extensionId}"]`);
    if ((await item.count()) !== 1) throw new SelectorFailure("ANCHOR_ABSENT");
    page.on("dialog", (dialog) => {
      dialogFailure = new SelectorFailure("PROTOCOL_REFUSED");
      void dialog.dismiss();
    });
    await item.locator("#removeButton").click();
    const confirmation = page.locator("extensions-remove-dialog").locator("#remove");
    if ((await confirmation.count()) === 1) await confirmation.click();
    if (dialogFailure) throw dialogFailure;
    await item.waitFor({ state: "detached" });
    if (page.url() !== "chrome://extensions/" || (await item.count()) !== 0)
      throw new SelectorFailure("CONTROL_BOUNDARY_LOST");
  }
  return Object.freeze({
    identity: structuredClone(binding),
    pause: async () => {
      paused = true;
    },
    resume: async () => {
      paused = false;
    },
    inspect: settle,
    async action(op) {
      if (paused) throw new SelectorFailure("PROTOCOL_REFUSED");
      if (op === "install") {
        check(binding.mode === "C", "S_install_refused");
        const cdp = await context.browser().newBrowserCDPSession();
        try {
          if (
            (await cdp.send("Extensions.loadUnpacked", { path: preparation.packageDirectory })).id !==
            preparation.extensionId
          )
            throw new SelectorFailure("CONTROL_BOUNDARY_LOST");
        } finally {
          await cdp.detach();
        }
        return { ok: true };
      }
      if (op === "navigate-orders") {
        orders = await context.newPage();
        try {
          await orders.goto(ordersUrl, { waitUntil: "commit" });
        } catch {
          throw new SelectorFailure("ORDERS_UI_UNREACHABLE");
        }
      } else if (op === "initial-range") await select("LastTwoYears");
      else if (op === "reload") await reload();
      else if (op === "restore") await select(expectedRange);
      else if (op === "fallback-check") await select("LastThreeMonths");
      else if (op === "remove") {
        await remove();
        return { ok: true };
      } else if (op === "capture" || op === "cancel-before-begin") {
        check(binding.mode === "C", "S_helper_refused");
        orders = await context.newPage();
        try {
          await orders.goto(ordersUrl, { waitUntil: "commit" });
        } catch {
          throw new SelectorFailure("ORDERS_UI_UNREACHABLE");
        }
        expectedRange = "LastTwoYears";
        await select(expectedRange);
        await settle();
        helper = await context.newPage();
        await helper.goto(preparation.captureUrl, { waitUntil: "commit" });
        helper.on("dialog", (dialog) => {
          void nativeDialog(dialog);
        });
        helper.on("download", (download) => {
          if (paused || helper.url() !== preparation.captureUrl || downloads >= 2) {
            dialogFailure = new SelectorFailure("DISCLOSURE_GUARD");
            void download.cancel();
            return;
          }
          const name = download.suggestedFilename();
          if (!["selector-receipt.json", "selector-inventory.json"].includes(name)) {
            dialogFailure = new SelectorFailure("DISCLOSURE_GUARD");
            void download.cancel();
            return;
          }
          downloads += 1;
          saved.push(download.saveAs(path.join(preparation.receiptDirectory, name)));
        });
        await boundary(helper, preparation.captureUrl);
        const result = await helper.evaluate(async () => globalThis.orderAuthorityCapture.run());
        if (dialogFailure) throw dialogFailure;
        if (op === "cancel-before-begin") {
          if (!same(result, { ok: false, code: "canceled" }) || downloads !== 0)
            throw new SelectorFailure("PROTOCOL_REFUSED");
        } else {
          if (!same(result, { ok: true, code: "scrubbed_export_created" }))
            throw new SelectorFailure("PROTOCOL_REFUSED");
          while (downloads < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
          if (downloads !== 2) throw new SelectorFailure("DEADLINE");
          await Promise.all(saved);
          const { verifyExport } = await import("../integrations/order-authority-probe/package.mjs");
          verifyExport(path.dirname(preparation.packageDirectory));
          const receipt = JSON.parse(
            readFileSync(path.join(preparation.receiptDirectory, "selector-receipt.json"), "utf8"),
          );
          if (receipt.failures.length) {
            const causes = {
              deadline: "DEADLINE",
              canceled: "CANCELLED",
              date_filter_mismatch: "STATE_CONTRADICTORY",
              count_surface_mismatch: "STATE_CONTRADICTORY",
              display_unsettled: "SETTLE_UNOBSERVABLE",
              bracket_changed: "CONTROL_BOUNDARY_LOST",
              count_input_invalid: "STATE_CONTRADICTORY",
            };
            throw new SelectorFailure(causes[receipt.failures[0]] ?? "PROTOCOL_REFUSED");
          }
        }
        return { ok: true };
      } else throw new SelectorFailure("PROTOCOL_REFUSED");
      return { ok: true };
    },
    async close() {
      await context.close();
      closedBrowser = true;
    },
  });
}
export function createSyntheticBinding({ preparation, executable, version, session, model, mode = "C" }) {
  check(
    preparation.evidence === "synthetic" && readdirSync(preparation.profileDirectory).length === 0,
    "fresh_signed_out_profile_required",
  );
  const root = path.dirname(preparation.profileDirectory);
  return {
    evidence: "synthetic",
    runId: path.basename(root),
    mode,
    performer: "selector-agent-operator",
    verifier: "selector-agent-host-verifier",
    session,
    model,
    tool: POLICY.tool,
    root,
    profile: preparation.profileDirectory,
    profileIdentity: validateCleanupTarget({ root, profile: preparation.profileDirectory }),
    executable: path.resolve(executable),
    executableHash: hash(readFileSync(executable)),
    version,
    packageId: preparation.extensionId,
    packageHash: hash(JSON.stringify(preparation.packageDigests)),
    adapterHash: hash(readFileSync(source)),
    policyIdentity: POLICY.identity,
    policyHash: POLICY.hash,
    controlHash: hash(readFileSync(source)),
    startedAt: preparation.t0,
    freshSignedOut: true,
  };
}

export function verifyStructureEvidence(value) {
  if (
    !closed(value, ["format", "binding", "observations", "terminal", "cleanup"]) ||
    value.format !== "selector-agent-structure-evidence/v1" ||
    !closed(value.binding, bindingKeys) ||
    value.binding.mode !== "S" ||
    value.binding.policyIdentity !== POLICY.identity ||
    value.binding.policyHash !== POLICY.hash ||
    value.binding.adapterHash !== hash(readFileSync(source)) ||
    value.binding.controlHash !== value.binding.adapterHash ||
    !validateTerminal(value.terminal, true) ||
    !validateCleanupEvidence(value.binding, value.cleanup) ||
    value.cleanup.cleanup !== "TIMELY_VERIFIED" ||
    !Array.isArray(value.observations) ||
    value.observations.length < 3 ||
    value.observations.length > 4
  )
    return false;
  const expected =
    value.observations.length === 4
      ? ["initial-range", "post-reload", "restoration", "fallback-check"]
      : ["initial-range", "post-reload", "fallback-check"];
  let prior = Date.parse(value.binding.startedAt);
  for (let i = 0; i < expected.length; i += 1) {
    const record = value.observations[i];
    if (
      !closed(record, ["phase", "payload", "at"]) ||
      record.phase !== expected[i] ||
      !utc(record.at) ||
      Date.parse(record.at) < prior ||
      Date.parse(record.at) > Date.parse(value.terminal.at) ||
      !validatePayload(record.payload) ||
      POLICY.cardinalities.some((name) => record.payload[name] !== 1) ||
      !record.payload.rangeSemanticsValid ||
      !record.payload.quickFilterRelationshipValid ||
      (i > 0 && !record.payload.oldCompletionInvalidated)
    )
      return false;
    const reset = record.phase === "post-reload" && expected.includes("restoration");
    if (
      reset
        ? record.payload.selectedRangeValid || record.payload.currentEpochComplete
        : !record.payload.selectedRangeValid || !record.payload.currentEpochComplete
    )
      return false;
    prior = Date.parse(record.at);
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === source) {
  try {
    const args = process.argv.slice(2);
    check(
      args.length === 3 && args[0] === "--verify-structure-evidence" && args[1] === "--evidence" && absolute(args[2]),
      "invalid_arguments",
    );
    check(
      lstatSync(args[2]).isFile() && !lstatSync(args[2]).isSymbolicLink() && lstatSync(args[2]).size <= 65536,
      "evidence_refused",
    );
    check(verifyStructureEvidence(JSON.parse(readFileSync(args[2], "utf8"))), "structure_evidence_refused");
    console.log("selector-agent-control: schema verified; independent host acceptance remains pending");
  } catch {
    console.error("selector-agent-control: evidence refused");
    process.exitCode = 1;
  }
}
