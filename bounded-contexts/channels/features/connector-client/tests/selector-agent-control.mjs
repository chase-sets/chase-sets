import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
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

export const hermeticChromiumArguments = Object.freeze([
  "--enable-automation",
  "--disable-background-networking",
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--enable-unsafe-extension-debugging",
  "--force-renderer-accessibility",
]);

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

// Chromium's extension confirmation is a native Views dialog, not WebUI.
// The accessibility action is private, one-shot, and exact-process bound.
export function writeNativeBusConfiguration(preparation) {
  check(preparation.evidence === "synthetic", "live_launch_not_authorized");
  const root = path.dirname(preparation.profileDirectory);
  check(absolute(root) && /^selector-capability-[A-Za-z0-9-]+$/.test(path.basename(root)), "native_bus_root_refused");
  const config = path.join(path.dirname(root), `${path.basename(root)}.native-bus.conf`);
  writeFileSync(
    config,
    `<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen><auth>EXTERNAL</auth><policy context="default"><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>`,
    { flag: "wx", mode: 0o600 },
  );
  return config;
}
const nativeRemovalStages = [
  "PROCESS",
  "PROCESS_PROFILE",
  "PROCESS_EXECUTABLE",
  "PROCESS_EXECUTABLE_UNREADABLE",
  "PROCESS_DIGEST",
  "PROCESS_UNIQUE",
  "PROCESS_START",
  "LIBRARY",
  "SYMBOL",
  "CONNECT",
  "LIST",
  "OWNER",
  "CHILDREN",
  "ROLE",
  "NAME",
  "DIALOG",
  "WINDOW",
  "BUTTON",
  "IDENTITY",
  "ACTIONS",
  "ACTION",
];
const nativeRemovalScript = String.raw`
import ctypes as c, hashlib, json, os, pathlib, sys, time
stage = 'PROCESS'
until = time.time()
nonce = sys.argv[-1]
site, ordinal, sequence, candidate = None, 0, 0, 0
predicate_keys = ['role', 'title', 'dialogState', 'uniqueButton', 'buttonState', 'actionInterfaceRead', 'actionCount', 'actionDefault', 'actionAttempt', 'actionResult']
witness = dict(epoch=0, names=0, scanned=0, enumeration='NOT_STARTED', roots=[], started=None, completed=None, caught=None, caughtCount=0, terminal=None, predicates=['NOT_OBSERVED'] * len(predicate_keys), dialogBits=['NOT_OBSERVED'] * 3, buttonBits=['NOT_OBSERVED'] * 5, lastPredicate=None, identity='NOT_OBSERVED', budget='WITHIN', final=False, integrity='COMPLETE')

def emit_witness(final=False):
    witness['budget'] = 'EXHAUSTED' if time.time() >= until else 'WITHIN'
    witness['final'] = final
    if sequence > 65535 or witness['epoch'] > 4095 or witness['caughtCount'] > 65535 or candidate > 65535:
        witness['integrity'] = 'OVERFLOW'
    child_binding = hashlib.sha256((nonce + ':' + str(os.getpid())).encode()).hexdigest()
    payload = json.dumps(dict(nonce=nonce, child=child_binding, witness=witness), separators=(',', ':')).encode('ascii')
    if len(payload) > 3600:
        witness['integrity'] = 'OVERFLOW'
        witness['roots'] = []
        payload = json.dumps(dict(nonce=nonce, child=child_binding, witness=witness), separators=(',', ':')).encode('ascii')
    frame = ('%08d' % len(payload)).encode() + hashlib.sha256(payload).hexdigest().encode() + payload
    os.pwrite(3, frame + bytes(4096 - len(frame)), 0)

def predicate(key, value):
    index = predicate_keys.index(key)
    observed = 'TRUE' if value else 'FALSE'
    old = witness['predicates'][index]
    witness['predicates'][index] = observed if old in ['NOT_OBSERVED', observed] else 'MIXED'
    witness['lastPredicate'] = [min(witness['epoch'], 4095), ordinal, min(candidate, 65535), key, bool(value)]
    emit_witness()
    return value

def complete(outcome, error='NONE'):
    witness['completed'] = witness['started'][:5] + [outcome, error]
    if site == 'ROOT' and witness['started'][4] == 'CHILDREN' and witness['roots']:
        witness['roots'][-1][1:3] = [outcome, error]
    emit_witness()

def decoded(fn):
    def read(*args):
        try: value = fn(*args)
        except BaseException:
            if witness['completed'] and witness['completed'][0] == min(sequence, 65535) and witness['completed'][5] == 'RPC_RETURNED': complete('DECODE_FAILED')
            raise
        complete('RETURNED')
        return value
    return read
def refused(kind, value, trace):
    failed = witness['completed']
    witness['terminal'] = [stage, 'RPC_FAILED' if failed and failed[0] == min(sequence, 65535) and failed[5] == 'RPC_FAILED' else 'UNCLASSIFIED']
    emit_witness(True)
    print('NATIVE_REMOVE_WITNESS:' + json.dumps(witness, separators=(',', ':')), flush=True)
    print('NATIVE_REMOVE_REFUSED:' + stage)
sys.excepthook = refused
profile, executable, digest, address, until, pid, nonce = sys.argv[1:]
until = float(until)
emit_witness()
if not address.startswith('unix:') or not os.path.isabs(profile): raise RuntimeError()
pid = int(pid)
if pid <= 0: raise RuntimeError()
stage = 'PROCESS_EXECUTABLE_UNREADABLE'
actual_executable = os.path.realpath(pathlib.Path('/proc', str(pid), 'exe'), strict=True)
stage = 'PROCESS_EXECUTABLE'
if actual_executable != executable: raise RuntimeError()
stage = 'PROCESS_DIGEST'
if hashlib.sha256(pathlib.Path(executable).read_bytes()).hexdigest() != digest: raise RuntimeError()
stage = 'PROCESS_START'
started = pathlib.Path('/proc', str(pid), 'stat').read_bytes().split(b') ')[1].split()[19]
witness['identity'] = 'INITIAL_MATCH'
emit_witness()
stage = 'LIBRARY'
gio, glib = c.CDLL('libgio-2.0.so.0'), c.CDLL('libglib-2.0.so.0')
ptr = c.c_void_p
stage = 'SYMBOL'
def api(lib, name, result, args):
    fn = getattr(lib, name); fn.restype = result; fn.argtypes = args; return fn
child = api(glib, 'g_variant_get_child_value', ptr, [ptr, c.c_size_t])
length = api(glib, 'g_variant_n_children', c.c_size_t, [ptr])
string = api(glib, 'g_variant_get_string', c.c_char_p, [ptr, ptr])
uint = api(glib, 'g_variant_get_uint32', c.c_uint, [ptr])
int_value = api(glib, 'g_variant_get_int32', c.c_int, [ptr])
boolean = api(glib, 'g_variant_get_boolean', c.c_int, [ptr])
variant = api(glib, 'g_variant_get_variant', ptr, [ptr])
unref = api(glib, 'g_variant_unref', None, [ptr])
text = api(glib, 'g_variant_new_string', ptr, [c.c_char_p])
integer = api(glib, 'g_variant_new_int32', ptr, [c.c_int])
tuple_new = api(glib, 'g_variant_new_tuple', ptr, [c.POINTER(ptr), c.c_size_t])
def params(*values):
    items = [text(v) if isinstance(v, bytes) else integer(v) for v in values]
    return tuple_new((ptr * len(items))(*items), len(items))
error = ptr()
stage = 'CONNECT'
connection = api(gio, 'g_dbus_connection_new_for_address_sync', ptr, [c.c_char_p, c.c_int, ptr, ptr, c.POINTER(ptr)])(address.encode(), 9, None, None, c.byref(error))
if not connection: raise RuntimeError()
emit_witness()
invoke = api(gio, 'g_dbus_connection_call_sync', ptr, [ptr, c.c_char_p, c.c_char_p, c.c_char_p, c.c_char_p, ptr, ptr, c.c_int, c.c_int, ptr, c.POINTER(ptr)])
remote_error = api(gio, 'g_dbus_error_get_remote_error', ptr, [ptr])
free = api(glib, 'g_free', None, [ptr])
def call(bus, path, interface, method, arguments=None, category=None):
    global stage, sequence
    stage = {b'ListNames':'LIST', b'GetConnectionUnixProcessID':'OWNER', b'GetChildren':'CHILDREN', b'GetRoleName':'ROLE', b'GetState':'WINDOW', b'Get':'NAME', b'GetName':'ACTIONS', b'DoAction':'ACTION'}[method]
    category = category or {b'ListNames':'LIST', b'GetConnectionUnixProcessID':'OWNER', b'GetChildren':'CHILDREN', b'GetRoleName':'ROLE', b'GetState':'STATE', b'Get':'NAME', b'GetName':'ACTION_NAME', b'DoAction':'DO_ACTION'}[method]
    error = ptr()
    remaining = int((until - time.time()) * 1000)
    if remaining <= 0: raise RuntimeError()
    if sequence == 65535: witness['integrity'] = 'OVERFLOW'
    sequence = min(sequence + 1, 65535)
    witness['started'] = [min(sequence, 65535), min(witness['epoch'], 4095), ordinal, site, category]
    if site == 'ROOT' and category == 'CHILDREN' and witness['roots']: witness['roots'][-1][1:3] = ['IN_FLIGHT', 'NONE']
    emit_witness()
    remaining = int((until - time.time()) * 1000)
    if remaining <= 0: raise RuntimeError()
    if category == 'DO_ACTION':
        predicate('actionAttempt', True)
        remaining = int((until - time.time()) * 1000)
        if remaining <= 0: raise RuntimeError()
    reply = invoke(connection, bus, path, interface, method, arguments, None, 0, remaining, None, c.byref(error))
    if not reply:
        code = 'OTHER'
        if error:
            remote = remote_error(error)
            if remote:
                try:
                    known = {b'org.freedesktop.DBus.Error.NameHasNoOwner':'NO_OWNER', b'org.freedesktop.DBus.Error.AccessDenied':'ACCESS_DENIED', b'org.freedesktop.DBus.Error.UnknownMethod':'UNKNOWN_METHOD', b'org.freedesktop.DBus.Error.InvalidArgs':'INVALID_ARGS', b'org.freedesktop.DBus.Error.NoReply':'NO_REPLY', b'org.freedesktop.DBus.Error.ServiceUnknown':'SERVICE_UNKNOWN'}
                    code = known.get(c.string_at(remote), 'OTHER')
                finally: free(remote)
        complete('RPC_FAILED', code)
        raise RuntimeError()
    complete('RPC_RETURNED')
    return reply
@decoded
def scalar(reply, reader):
    value = child(reply, 0)
    try: return reader(value)
    finally: unref(value); unref(reply)
@decoded
def strings(reply):
    array = child(reply, 0)
    try:
        result = []
        for i in range(length(array)):
            value = child(array, i)
            try: result.append(string(value, None))
            finally: unref(value)
        return result
    finally: unref(array); unref(reply)
accessible = b'org.a11y.atspi.Accessible'
root = b'/org/a11y/atspi/accessible/root'
@decoded
def children(bus, path):
    reply = call(bus, path, accessible, b'GetChildren'); array = child(reply, 0)
    try:
        if length(array) > 512: raise RuntimeError()
        result = []
        for i in range(length(array)):
            item = child(array, i); owner, location = child(item, 0), child(item, 1)
            try:
                if string(owner, None) == bus: result.append(string(location, None))
            finally: unref(owner); unref(location); unref(item)
        if site == 'ROOT' and witness['roots']: witness['roots'][-1][3:] = [length(array), len(result)]
        return result
    finally: unref(array); unref(reply)
def role(bus, path): return scalar(call(bus, path, accessible, b'GetRoleName'), lambda value: string(value, None))
@decoded
def states(bus, path, *required):
    reply = call(bus, path, accessible, b'GetState'); array = child(reply, 0)
    try:
        if length(array) != 2: raise RuntimeError()
        words = []
        for i in range(2):
            word = child(array, i)
            try: words.append(uint(word))
            finally: unref(word)
        key = 'dialogBits' if site == 'EXACT_DIALOG' else 'buttonBits' if site == 'REMOVE_BUTTON' else None
        if key:
            for index, value in enumerate(required):
                observed = 'TRUE' if words[value // 32] & (1 << (value % 32)) else 'FALSE'
                old = witness[key][index]
                witness[key][index] = observed if old in ['NOT_OBSERVED', observed] else 'MIXED'
        return all(words[value // 32] & (1 << (value % 32)) for value in required)
    finally: unref(array); unref(reply)
@decoded
def property_value(bus, path, interface, key, reader):
    reply = call(bus, path, b'org.freedesktop.DBus.Properties', b'Get', params(interface, key), category='ACTION_COUNT' if key == b'NActions' else 'NAME')
    wrapped = child(reply, 0); value = variant(wrapped)
    try: return reader(value)
    finally: unref(value); unref(wrapped); unref(reply)
def name(bus, path): return property_value(bus, path, accessible, b'Name', lambda value: string(value, None))
title = b'Remove "Chase Sets Temporary Order Authority Capture"?'
button = None
while time.time() < until:
    matches = []
    owned_ordinals, dialog_candidates = {}, {}
    if witness['epoch'] == 4095: witness['integrity'] = 'OVERFLOW'
    witness.update(epoch=min(witness['epoch'] + 1, 4095), names=0, scanned=0, enumeration='IN_FLIGHT', roots=[], predicates=['NOT_OBSERVED'] * len(predicate_keys), dialogBits=['NOT_OBSERVED'] * 3, buttonBits=['NOT_OBSERVED'] * 5, lastPredicate=None)
    site, ordinal, candidate = None, 0, 0
    names = strings(call(b'org.freedesktop.DBus', b'/org/freedesktop/DBus', b'org.freedesktop.DBus', b'ListNames'))
    if len(names) > 64: raise RuntimeError()
    witness['names'] = len(names)
    if len(set(names)) != len(names): witness['integrity'] = 'AMBIGUOUS'
    for bus in names:
        site = None
        ordinal += 1
        witness['scanned'] = ordinal
        if not bus.startswith(b':'): continue
        if scalar(call(b'org.freedesktop.DBus', b'/org/freedesktop/DBus', b'org.freedesktop.DBus', b'GetConnectionUnixProcessID', params(bus)), uint) != pid: continue
        witness['roots'].append([ordinal, 'NOT_STARTED', 'NONE', None, None])
        owned_ordinals[bus] = ordinal
        emit_witness()
        site = 'ROOT'
        try: windows = children(bus, root)
        except RuntimeError:
            witness['caught'] = witness['completed']
            if witness['caughtCount'] == 65535: witness['integrity'] = 'OVERFLOW'
            witness['caughtCount'] = min(witness['caughtCount'] + 1, 65535)
            emit_witness()
            continue
        if len(windows) > 64: raise RuntimeError()
        # Chromium exposes top-level RootViews through the application and
        # child-widget RootViews directly below them, not through page DOM.
        candidates = []
        for window in windows:
            site = 'TOP_LEVEL_WIDGET'
            candidates.extend([window] + children(bus, window))
        if len(candidates) > 1024: raise RuntimeError()
        seen = set()
        for path in candidates:
            if path in seen: continue
            seen.add(path)
            if candidate == 65535: witness['integrity'] = 'OVERFLOW'
            candidate = min(candidate + 1, 65535)
            site = 'TOP_LEVEL_WIDGET' if path in windows else 'DIRECT_CHILD'
            if predicate('role', role(bus, path) == b'dialog'):
                # ACTIVE, SHOWING, VISIBLE: inactive browser UI is not a prompt
                # to act on; an unknown active native dialog still refuses.
                site = 'EXACT_DIALOG'
                if not predicate('dialogState', states(bus, path, 1, 25, 30)): continue
                actual = name(bus, path); stage = 'DIALOG'
                predicate('title', actual == title)
                if actual != title: raise RuntimeError()
                buttons, nested, visited = [], children(bus, path), set()
                while nested:
                    node = nested.pop()
                    if node in visited: continue
                    visited.add(node)
                    if len(visited) > 512: raise RuntimeError()
                    site = 'REMOVE_BUTTON'
                    if role(bus, node) == b'push button' and name(bus, node) == b'Remove': buttons.append(node)
                    site = 'EXACT_DIALOG'
                    nested.extend(children(bus, node))
                stage = 'BUTTON'
                predicate('uniqueButton', len(buttons) == 1)
                if len(buttons) != 1: raise RuntimeError()
                matches.append((bus, path, buttons[0]))
                dialog_candidates[path] = candidate
    witness['enumeration'] = 'COMPLETE'
    emit_witness()
    if len(matches) > 1: raise RuntimeError()
    if matches: button = matches[0]; break
    time.sleep(.025)
if button is None: raise RuntimeError()
stage = 'IDENTITY'
if pathlib.Path('/proc', str(pid), 'stat').read_bytes().split(b') ')[1].split()[19] != started: raise RuntimeError()
witness['identity'] = 'RECHECK_MATCH'
bus, dialog, path = button
ordinal, candidate = owned_ordinals[bus], dialog_candidates[dialog]
# GetActions returns localized names, which Chromium leaves empty for native
# actions. GetName is the nonlocalized, stable action identity.
action_interface = b'org.a11y.atspi.Action'
site = 'REMOVE_BUTTON'
try: count = property_value(bus, path, action_interface, b'NActions', int_value)
except RuntimeError:
    predicate('actionInterfaceRead', False)
    raise
predicate('actionInterfaceRead', True)
stage = 'ACTIONS'
predicate('actionCount', 1 <= count <= 16)
if not 1 <= count <= 16: raise RuntimeError()
default = []
for index in range(count):
    label = scalar(call(bus, path, action_interface, b'GetName', params(index)), lambda value: string(value, None))
    if label in [b'click', b'press']: default.append(index)
predicate('actionDefault', default == [0])
if default != [0]: raise RuntimeError()
stage = 'WINDOW'
site = 'EXACT_DIALOG'
if not predicate('dialogState', states(bus, dialog, 1, 25, 30)): raise RuntimeError()
site = 'REMOVE_BUTTON'
if not predicate('buttonState', states(bus, path, 8, 12, 24, 25, 30)): raise RuntimeError()
stage = 'IDENTITY'
if pathlib.Path('/proc', str(pid), 'stat').read_bytes().split(b') ')[1].split()[19] != started: raise RuntimeError()
witness['identity'] = 'ACTION_RECHECK_MATCH'
if not predicate('actionResult', scalar(call(bus, path, b'org.a11y.atspi.Action', b'DoAction', params(0)), boolean)): raise RuntimeError()
emit_witness(True)
print('NATIVE_REMOVE_WITNESS:' + json.dumps(witness, separators=(',', ':')), flush=True)
print('NATIVE_REMOVE_SENT')
`;

const nativeErrors = [
  "NONE",
  "OTHER",
  "NO_OWNER",
  "ACCESS_DENIED",
  "UNKNOWN_METHOD",
  "INVALID_ARGS",
  "NO_REPLY",
  "SERVICE_UNKNOWN",
];
const nativeSites = [null, "ROOT", "TOP_LEVEL_WIDGET", "DIRECT_CHILD", "EXACT_DIALOG", "REMOVE_BUTTON"];
const nativeMethods = [
  "LIST",
  "OWNER",
  "CHILDREN",
  "ROLE",
  "STATE",
  "NAME",
  "ACTION_COUNT",
  "ACTION_NAME",
  "DO_ACTION",
];
const nativeOutcomes = ["RPC_RETURNED", "RETURNED", "RPC_FAILED", "DECODE_FAILED"];
const nativePredicates = [
  "role",
  "title",
  "dialogState",
  "uniqueButton",
  "buttonState",
  "actionInterfaceRead",
  "actionCount",
  "actionDefault",
  "actionAttempt",
  "actionResult",
];
// Calls: sequence, epoch, connection ordinal, site, method, then outcome/error.
// Roots: connection ordinal, outcome, error, decoded total/owned child counts.
const boundedInteger = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
function nativeCall(value, completed = false) {
  return (
    Array.isArray(value) &&
    value.length === (completed ? 7 : 5) &&
    boundedInteger(value[0], 65535) &&
    value[0] > 0 &&
    boundedInteger(value[1], 4095) &&
    boundedInteger(value[2], 64) &&
    nativeSites.includes(value[3]) &&
    nativeMethods.includes(value[4]) &&
    (!completed ||
      (nativeOutcomes.includes(value[5]) &&
        nativeErrors.includes(value[6]) &&
        (value[5] === "RPC_FAILED" ? value[6] !== "NONE" : value[6] === "NONE")))
  );
}
function validNativeWitness(value) {
  const observed = (items, size) =>
    Array.isArray(items) &&
    items.length === size &&
    items.every((state) => ["NOT_OBSERVED", "FALSE", "TRUE", "MIXED"].includes(state));
  return (
    closed(value, [
      "epoch",
      "names",
      "scanned",
      "enumeration",
      "roots",
      "started",
      "completed",
      "caught",
      "caughtCount",
      "terminal",
      "predicates",
      "dialogBits",
      "buttonBits",
      "lastPredicate",
      "identity",
      "budget",
      "final",
      "integrity",
    ]) &&
    boundedInteger(value.epoch, 4095) &&
    boundedInteger(value.names, 64) &&
    boundedInteger(value.scanned, value.names) &&
    ["NOT_STARTED", "IN_FLIGHT", "COMPLETE"].includes(value.enumeration) &&
    (value.enumeration !== "COMPLETE" || value.scanned === value.names) &&
    Array.isArray(value.roots) &&
    value.roots.length <= 64 &&
    value.roots.every(
      (root, index) =>
        Array.isArray(root) &&
        root.length === 5 &&
        boundedInteger(root[0], value.scanned) &&
        root[0] > 0 &&
        (index === 0 || value.roots[index - 1][0] < root[0]) &&
        ["NOT_STARTED", "IN_FLIGHT", ...nativeOutcomes].includes(root[1]) &&
        nativeErrors.includes(root[2]) &&
        (root[1] === "RPC_FAILED" ? root[2] !== "NONE" : root[2] === "NONE") &&
        (root[1] === "RETURNED"
          ? boundedInteger(root[3], 512) && boundedInteger(root[4], root[3])
          : root[3] === null && root[4] === null),
    ) &&
    (value.started === null || nativeCall(value.started)) &&
    (value.completed === null ||
      (nativeCall(value.completed, true) && value.started && value.completed[0] <= value.started[0])) &&
    (value.caught === null ||
      (nativeCall(value.caught, true) && ["RPC_FAILED", "DECODE_FAILED"].includes(value.caught[5]))) &&
    boundedInteger(value.caughtCount, 65535) &&
    (value.caught === null ? value.caughtCount === 0 : value.caughtCount > 0) &&
    (value.terminal === null ||
      (Array.isArray(value.terminal) &&
        value.terminal.length === 2 &&
        nativeRemovalStages.includes(value.terminal[0]) &&
        ["RPC_FAILED", "UNCLASSIFIED"].includes(value.terminal[1]))) &&
    observed(value.predicates, nativePredicates.length) &&
    observed(value.dialogBits, 3) &&
    observed(value.buttonBits, 5) &&
    (value.lastPredicate === null ||
      (Array.isArray(value.lastPredicate) &&
        value.lastPredicate.length === 5 &&
        boundedInteger(value.lastPredicate[0], 4095) &&
        boundedInteger(value.lastPredicate[1], 64) &&
        boundedInteger(value.lastPredicate[2], 65535) &&
        nativePredicates.includes(value.lastPredicate[3]) &&
        typeof value.lastPredicate[4] === "boolean")) &&
    ["NOT_OBSERVED", "INITIAL_MATCH", "RECHECK_MATCH", "ACTION_RECHECK_MATCH"].includes(value.identity) &&
    ["WITHIN", "EXHAUSTED"].includes(value.budget) &&
    typeof value.final === "boolean" &&
    ["COMPLETE", "OVERFLOW", "AMBIGUOUS"].includes(value.integrity)
  );
}
function readNativeRemovalOutput(output) {
  const refused = { result: "", witness: null };
  if (typeof output !== "string" || Buffer.byteLength(output) > 4096 || !output.endsWith("\n")) return refused;
  const lines = output.slice(0, -1).split("\n");
  if (lines.length > 9) return refused;
  const last = lines.at(-1);
  const fixed = last.split(":");
  const result =
    last === "NATIVE_REMOVE_SENT" ||
    (fixed.length === 2 && fixed[0] === "NATIVE_REMOVE_REFUSED" && nativeRemovalStages.includes(fixed[1]))
      ? last
      : "";
  if (!result || lines.length !== 2 || !lines[0].startsWith("NATIVE_REMOVE_WITNESS:")) return refused;
  try {
    const witness = JSON.parse(lines[0].slice("NATIVE_REMOVE_WITNESS:".length));
    const sent = result === "NATIVE_REMOVE_SENT";
    return validNativeWitness(witness) &&
      witness.final &&
      (!sent ||
        (witness.enumeration === "COMPLETE" &&
          witness.identity === "ACTION_RECHECK_MATCH" &&
          witness.terminal === null &&
          witness.predicates[8] === "TRUE" &&
          witness.predicates[9] === "TRUE" &&
          witness.completed?.[4] === "DO_ACTION" &&
          witness.completed[5] === "RETURNED"))
      ? { result, witness }
      : refused;
  } catch {
    return refused;
  }
}
function readNativeRemovalSlot(bytes, nonce, child) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length !== 4096 || !boundedInteger(child, 2147483647) || child === 0)
      return null;
    const size = Number(bytes.subarray(0, 8).toString("ascii"));
    if (
      !/^[0-9]{8}$/.test(bytes.subarray(0, 8).toString("ascii")) ||
      size < 1 ||
      size > 4024 ||
      bytes.subarray(72 + size).some((byte) => byte !== 0)
    )
      return null;
    const payload = bytes.subarray(72, 72 + size);
    if (hash(payload) !== bytes.subarray(8, 72).toString("ascii")) return null;
    const envelope = JSON.parse(payload.toString("utf8"));
    return closed(envelope, ["nonce", "child", "witness"]) &&
      envelope.nonce === nonce &&
      envelope.child === hash(Buffer.from(`${nonce}:${child}`)) &&
      validNativeWitness(envelope.witness)
      ? envelope.witness
      : null;
  } catch {
    return null;
  }
}

// Raw browser primitives are private to this offline-only Channels adapter.
export function createPlaywrightSelectorBrowser({
  context,
  preparation,
  binding,
  ordersUrl,
  deadline,
  nativeSessionBus,
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
    dialogFailure = null,
    cancelBeforeBegin = false;
  let nativeRemovalStage = null;
  let nativeRemovalWitness = null;
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
        if (cancelBeforeBegin) await dialog.dismiss();
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
    if (binding.mode !== "C") throw new SelectorFailure("PROTOCOL_REFUSED");
    nativeRemovalWitness = null;
    const removalDeadline = Math.min(deadline, Date.now() + 30000);
    const remaining = () => Math.max(1, removalDeadline - Date.now());
    async function bounded(call) {
      let timer;
      try {
        return await Promise.race([
          call(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new SelectorFailure("CONTROL_BOUNDARY_LOST")), remaining());
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    nativeRemovalStage = "CAPABILITY";
    if (typeof nativeSessionBus !== "string" || !nativeSessionBus.startsWith("unix:"))
      throw new SelectorFailure("CONTROL_BOUNDARY_LOST");
    let cdp, pid;
    try {
      // Chromium flattens /proc/cmdline into a display title. These two fixed
      // browser-only queries preserve argument boundaries and launch identity;
      // neither is exposed by the run endpoint or performs uninstallation.
      nativeRemovalStage = "PROCESS_PROFILE";
      cdp = await bounded(() => context.browser().newBrowserCDPSession());
      const { arguments: args } = await bounded(() => cdp.send("Browser.getBrowserCommandLine"));
      if (
        !Array.isArray(args) ||
        !args.every((arg) => typeof arg === "string") ||
        args.filter((arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir=")).length !== 1 ||
        !args.includes(`--user-data-dir=${binding.profile}`)
      )
        throw new SelectorFailure("CONTROL_BOUNDARY_LOST");
      nativeRemovalStage = "PROCESS_UNIQUE";
      const { processInfo } = await bounded(() => cdp.send("SystemInfo.getProcessInfo"));
      const browsers = Array.isArray(processInfo) ? processInfo.filter((info) => info?.type === "browser") : [];
      if (browsers.length !== 1 || !Number.isSafeInteger(browsers[0].id) || browsers[0].id <= 0)
        throw new SelectorFailure("CONTROL_BOUNDARY_LOST");
      pid = browsers[0].id;
    } catch {
      throw new SelectorFailure("CONTROL_BOUNDARY_LOST");
    } finally {
      if (cdp) {
        try {
          await bounded(() => cdp.detach());
        } catch {
          throw new SelectorFailure("CONTROL_BOUNDARY_LOST");
        }
      }
    }
    const page = await context.newPage();
    await page.goto("chrome://extensions/", { waitUntil: "commit", timeout: remaining() });
    nativeRemovalStage = "WINDOW";
    try {
      await bounded(() => page.bringToFront());
    } catch {
      throw new SelectorFailure("CONTROL_BOUNDARY_LOST");
    }
    const item = page.locator(`extensions-item[id="${preparation.extensionId}"]`);
    await item.waitFor({ state: "visible", timeout: remaining() });
    if ((await item.count()) !== 1) throw new SelectorFailure("ANCHOR_ABSENT");
    page.on("dialog", (dialog) => {
      dialogFailure = new SelectorFailure("PROTOCOL_REFUSED");
      void dialog.dismiss();
    });
    await item.locator("#removeButton").click({ timeout: remaining() });
    let slot, slotPath;
    try {
      nativeRemovalStage = "UNKNOWN";
      const nonce = randomBytes(24).toString("hex");
      slotPath = path.join(path.dirname(binding.root), `${path.basename(binding.root)}.remove-${nonce}.slot`);
      slot = openSync(slotPath, "wx+", 0o600);
      ftruncateSync(slot, 4096);
      const child = spawnSync(
        "python3",
        [
          "-c",
          nativeRemovalScript,
          binding.profile,
          binding.executable,
          binding.executableHash,
          nativeSessionBus,
          String(removalDeadline / 1000),
          String(pid),
          nonce,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore", slot], maxBuffer: 4096, timeout: remaining() },
      );
      const bytes = Buffer.alloc(4096);
      const retained =
        fstatSync(slot).size === 4096 && readSync(slot, bytes, 0, 4096, 0) === 4096
          ? readNativeRemovalSlot(bytes, nonce, child.pid)
          : null;
      const output = readNativeRemovalOutput(child.stdout);
      // Empty stdout is recoverable only for an interrupted child, never private,
      // malformed or partially emitted output. The slot is not action proof.
      const interrupted = child.stdout === "" && (child.signal || child.error) && child.status !== 0;
      const witness =
        retained && (output.witness && same(retained, output.witness) ? retained : interrupted ? retained : null);
      nativeRemovalWitness = {
        transport: witness ? (interrupted ? "INTERRUPTED" : "FINAL") : "REFUSED",
        record: witness,
      };
      const fixed = output.result.split(":");
      if (fixed.length === 2 && fixed[0] === "NATIVE_REMOVE_REFUSED") nativeRemovalStage = fixed[1];
      if (child.status !== 0 || child.error || !witness || output.result !== "NATIVE_REMOVE_SENT")
        throw new SelectorFailure("CONTROL_BOUNDARY_LOST");
      nativeRemovalStage = "SENT";
    } catch {
      nativeRemovalWitness ??= { transport: "REFUSED", record: null };
      throw new SelectorFailure("CONTROL_BOUNDARY_LOST");
    } finally {
      if (slot !== undefined) {
        closeSync(slot);
        unlinkSync(slotPath);
      }
    }
    if (dialogFailure) throw dialogFailure;
    await item.waitFor({ state: "detached", timeout: remaining() });
    if (page.url() !== "chrome://extensions/" || (await item.count()) !== 0)
      throw new SelectorFailure("CONTROL_BOUNDARY_LOST");
    nativeRemovalStage = "UI_ABSENT";
  }
  return Object.freeze({
    identity: structuredClone(binding),
    // Host-only diagnostic, never an endpoint operation or terminal-schema field.
    hostNativeRemovalStage: () => nativeRemovalStage,
    hostNativeRemovalWitness: () => structuredClone(nativeRemovalWitness),
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
        cancelBeforeBegin = op === "cancel-before-begin";
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
        await helper.waitForFunction(
          () =>
            typeof globalThis.orderAuthorityCapture?.run === "function" &&
            typeof globalThis.orderAuthorityCapture?.abort === "function",
        );
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
    executable: realpathSync(executable),
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
