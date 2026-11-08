import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { instant, readTerminalEvidence, sha256, validateWindowSchedule } from "./census-terminal-evidence.mjs";
import { retainC1Evidence } from "./c1-evidence-custody.mjs";

const roleNames = ["timestamp", "schedule", "executor"];
export const SCHEDULE_HISTORIES = Object.freeze([
  "opportunity",
  "oneFreshArm",
  "sizingWindows",
  "lifetimeAttempts",
  "consumedHeads",
  "blockingRounds",
]);
const slotTicks = 30000000000n;
const digest = (value) => sha256(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ticks = (value) => instant(value).ticks;
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const identity = (value) => typeof value === "string" && /^[a-zA-Z0-9_.:@/-]{1,200}$/.test(value);
class BridgeRefusal extends Error {}
function need(condition, reason) {
  if (!condition) throw new BridgeRefusal(reason);
}
function keys(value, expected, reason) {
  need(value && equal(Object.keys(value).sort(), [...expected].sort()), reason);
}
function histories(value) {
  keys(value, SCHEDULE_HISTORIES, "STOP_HISTORY_RESET");
  need(
    SCHEDULE_HISTORIES.every((key) => hash(value[key])),
    "STOP_HISTORY_RESET",
  );
}
function local(path) {
  need(
    typeof path === "string" && isAbsolute(path) && !path.startsWith("\\\\") && !path.startsWith("//"),
    "STOP_LOCAL_PATH",
  );
  let current = resolve(path);
  for (;;) {
    if (existsSync(current)) need(!lstatSync(current).isSymbolicLink(), "STOP_LOCAL_PATH");
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return path;
}
function read(path) {
  local(path);
  need(lstatSync(path).isFile() && lstatSync(path).size <= 64 * 1024 * 1024, "STOP_LOCAL_FILE");
  return readFileSync(path);
}
const json = (path) => JSON.parse(read(path).toString("utf8"));
function create(path, value) {
  local(path);
  const bytes = Buffer.from(JSON.stringify(value));
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    need(error.code === "EEXIST" && read(path).equals(bytes), "STOP_CREATE_CONFLICT_OR_PARTIAL_WRITE");
  }
  need(read(path).equals(bytes), "STOP_PERSISTENCE");
}
function stopped(error, root) {
  return {
    state: "STOP",
    reasons: [error instanceof BridgeRefusal ? error.message : "STOP_BRIDGE_EVIDENCE"],
    t0Utc: null,
    c1Schedule: "NOT_STARTED",
    partial: typeof root === "string" && isAbsolute(root) && existsSync(join(root, "snapshot.json")),
  };
}
function validatePlan(plan, authority) {
  need(authority && digest(plan) === authority.approvedPlanHash, "STOP_HOST_APPROVAL");
  keys(
    plan,
    ["root", "oneFreshArm", "roles", "original", "backup", "histories", "observationBinding", "validFrom", "expiresAt"],
    "STOP_ROLE_PLAN",
  );
  local(plan.root);
  need(equal(plan.oneFreshArm, { consumed: false, dispatch: null }), "STOP_ARM_ALREADY_CONSUMED");
  keys(plan.observationBinding, ["sourceHash", "capabilityHash"], "STOP_OBSERVATION_BINDING");
  need(Object.values(plan.observationBinding).every(hash), "STOP_OBSERVATION_BINDING");
  keys(plan.roles, roleNames, "STOP_ROLES");
  for (const role of roleNames) {
    keys(plan.roles[role], ["identity", "capabilityHash"], "STOP_ROLES");
    need(identity(plan.roles[role].identity) && hash(plan.roles[role].capabilityHash), "STOP_ROLES");
  }
  need(new Set(roleNames.map((role) => plan.roles[role].identity)).size === 3, "STOP_SHARED_ROLE");
  for (const name of ["original", "backup"]) {
    keys(plan[name], ["custodian", "destination"], "STOP_DESTINATION");
    need(identity(plan[name].custodian), "STOP_DESTINATION");
    local(plan[name].destination);
  }
  need(
    plan.original.custodian !== plan.backup.custodian &&
      resolve(plan.original.destination).toLowerCase() !== resolve(plan.backup.destination).toLowerCase(),
    "STOP_SHARED_CUSTODY",
  );
  histories(plan.histories);
  need(ticks(plan.validFrom) < ticks(plan.expiresAt), "STOP_ROLE_EXPIRY");
}
function validateReadiness(record, authority, at) {
  validatePlan(record.plan, authority);
  need(record.planHash === digest(record.plan), "STOP_ROLE_PLAN");
  const plan = record.plan;
  need(
    ticks(record.admittedAt) >= ticks(plan.validFrom) &&
      ticks(record.admittedAt) <= ticks(at) &&
      ticks(at) < ticks(plan.expiresAt),
    "STOP_ROLE_EXPIRY",
  );
  keys(record.acknowledgements, [...roleNames, "original", "backup"], "STOP_READINESS");
  for (const name of [...roleNames, "original", "backup"]) {
    const expected = plan.roles[name] ?? plan[name],
      ack = record.acknowledgements[name];
    keys(ack, [...Object.keys(expected), "planHash", "at", "expiresAt"], "STOP_READINESS");
    need(
      Object.keys(expected).every((key) => ack[key] === expected[key]) &&
        ack.planHash === record.planHash &&
        ticks(ack.at) >= ticks(plan.validFrom) &&
        ticks(ack.at) <= ticks(record.admittedAt) &&
        ticks(at) < ticks(ack.expiresAt) &&
        ticks(ack.expiresAt) <= ticks(plan.expiresAt),
      "STOP_READINESS",
    );
  }
}

function initialSnapshot(readiness) {
  return {
    version: "c1-schedule-initial/v1",
    readinessHash: digest(readiness),
    at: readiness.admittedAt,
    histories: readiness.plan.histories,
    oneFreshArm: { consumed: readiness.plan.oneFreshArm.consumed },
    armDispatch: readiness.plan.oneFreshArm.dispatch,
    windows: [1, 2, 3].map((ordinal) => ({ ordinal, slotLimit: 60, intervalSeconds: 30 })),
  };
}
function validateInitial(root, readiness) {
  need(resolve(root) === resolve(readiness.plan.root), "STOP_ROOT_BINDING");
  const initial = json(join(root, "initial-snapshot.json"));
  need(equal(initial, initialSnapshot(readiness)), "STOP_INITIAL_SNAPSHOT");
  return initial;
}

// Capabilities are host-owned objects, never names read from the plan.
export async function admitScheduleRoles(
  { root, plan, authority },
  { roles, custody, now = () => new Date().toISOString() } = {},
) {
  try {
    local(root);
    validatePlan(plan, authority);
    need(resolve(root) === resolve(plan.root), "STOP_ROOT_BINDING");
    const path = join(root, "readiness.json");
    if (existsSync(path)) {
      const record = json(path);
      validateReadiness(record, authority, now());
      need(equal(record.plan, plan), "STOP_ROLE_PLAN");
      validateInitial(root, record);
      return { state: "READY", readinessHash: digest(record) };
    }
    const acknowledgements = {};
    for (const name of [...roleNames, "original", "backup"]) {
      const capability = roles?.[name] ?? custody?.[name],
        expected = plan.roles[name] ?? plan[name];
      need(
        capability &&
          Object.keys(expected).every((key) => capability[key] === expected[key]) &&
          typeof capability.acknowledge === "function",
        "STOP_CAPABILITY_UNAVAILABLE",
      );
      acknowledgements[name] = await capability.acknowledge({ planHash: authority.approvedPlanHash });
    }
    const record = {
      plan: structuredClone(plan),
      planHash: authority.approvedPlanHash,
      admittedAt: now(),
      acknowledgements,
    };
    validateReadiness(record, authority, record.admittedAt);
    create(path, record);
    create(join(root, "initial-snapshot.json"), initialSnapshot(record));
    return { state: "READY", readinessHash: digest(record) };
  } catch (error) {
    return stopped(error, root);
  }
}

export function prepareScheduleSnapshot(
  { root, authority, binding, seal, rawD },
  { now = () => new Date().toISOString() } = {},
) {
  try {
    const readiness = json(join(local(root), "readiness.json")),
      at = now();
    validateReadiness(readiness, authority, at);
    const initial = validateInitial(root, readiness);
    const t0 = instant(rawD);
    need(
      ticks(readiness.admittedAt) < t0.ticks && ticks(at) >= t0.ticks && ticks(at) < t0.ticks + slotTicks,
      "STOP_SCHEDULE_DELAY",
    );
    const path = join(root, "snapshot.json");
    if (existsSync(path)) {
      const prior = json(path);
      need(equal(prior.binding, binding) && equal(prior.seal, seal) && prior.rawD === rawD, "STOP_SNAPSHOT_CONFLICT");
      validateSnapshot(prior, readiness, authority);
      return {
        state: "PREPARED",
        snapshotHash: digest(prior),
        schedule: prior.schedule,
        t0Utc: null,
        c1Schedule: "NOT_STARTED",
      };
    }
    const schedule = {
      t0Utc: t0.utc,
      deadlineUtc: new Date(Number(t0.ticks / 1000000n) + 5400000).toISOString(),
      persistedAt: at,
      windows: [0, 1, 2].map((i) => ({
        ordinal: i + 1,
        startSlot: i === 0 ? 0 : null,
        slotLimit: 60,
        intervalSeconds: 30,
        reads: [],
        ended: false,
      })),
    };
    // Preserve sub-millisecond D when forming the deadline rather than rounding its grid.
    const fraction = t0.utc.match(/\.(\d+)Z$/)?.[1];
    if (fraction?.length > 3) schedule.deadlineUtc = schedule.deadlineUtc.replace(/\.\d{3}Z$/, `.${fraction}Z`);
    const snapshot = {
      initialHash: digest(initial),
      readinessHash: digest(readiness),
      binding: structuredClone(binding),
      seal: structuredClone(seal),
      rawD,
      receiptHash: digest({ binding, seal, endpoint: rawD }),
      histories: readiness.plan.histories,
      schedule,
    };
    validateSnapshot(snapshot, readiness, authority);
    create(path, snapshot);
    return { state: "PREPARED", snapshotHash: digest(snapshot), schedule, t0Utc: null, c1Schedule: "NOT_STARTED" };
  } catch (error) {
    return stopped(error, root);
  }
}
function validateSnapshot(snapshot, readiness, authority) {
  keys(
    snapshot,
    ["initialHash", "readinessHash", "binding", "seal", "rawD", "receiptHash", "histories", "schedule"],
    "STOP_SNAPSHOT",
  );
  validateReadiness(readiness, authority, snapshot.schedule.persistedAt);
  need(
    snapshot.readinessHash === digest(readiness) &&
      equal(snapshot.histories, readiness.plan.histories) &&
      snapshot.receiptHash === digest({ binding: snapshot.binding, seal: snapshot.seal, endpoint: snapshot.rawD }) &&
      ticks(readiness.admittedAt) < ticks(snapshot.rawD),
    "STOP_SNAPSHOT",
  );
  validateWindowSchedule(snapshot.schedule, instant(snapshot.rawD).utc, snapshot.schedule.persistedAt);
  need(
    snapshot.schedule.windows.every((w) => w.reads.length === 0 && !w.ended),
    "STOP_INITIAL_READS",
  );
}

// Called only with the freshly revalidated return value of the landed custody reader.
export async function acquireScheduleBridge({ root, authority }, input, capabilities = {}) {
  const { now = () => new Date().toISOString() } = capabilities;
  try {
    const readiness = json(join(local(root), "readiness.json"));
    validateReadiness(readiness, authority, now());
    const initial = validateInitial(root, readiness);
    const custodyPlan = json(input.planFile);
    need(
      custodyPlan.handoff?.initialHash === digest(initial) &&
        custodyPlan.handoff?.readinessHash === digest(readiness) &&
        resolve(custodyPlan.handoff.initialPath) === resolve(join(root, "initial-snapshot.json")) &&
        resolve(custodyPlan.handoff.readinessPath) === resolve(join(root, "readiness.json")),
      "STOP_HANDOFF_BINDING",
    );
    const custody = await retainC1Evidence(input, { ...capabilities, requireConsumption: true });
    need(custody?.state === "RETAINED", "STOP_COMPLETE_CUSTODY");
    const { envelope, admitted, manifest } = custody;
    const receipt = readTerminalEvidence(envelope, admitted);
    need(
      manifest.originalCustodian === readiness.plan.original.custodian &&
        manifest.backupCustodian === readiness.plan.backup.custodian &&
        equal(envelope.histories, initial.histories) &&
        equal(
          envelope.custodians,
          Object.fromEntries(roleNames.map((role) => [role, readiness.plan.roles[role].identity])),
        ),
      "STOP_CUSTODY_DESTINATION",
    );
    const inside = (path, prefix) =>
      resolve(path)
        .toLowerCase()
        .startsWith(`${resolve(prefix).toLowerCase()}\\`) || resolve(path).startsWith(`${resolve(prefix)}/`);
    for (const file of manifest.files) {
      need(
        inside(file.originalPath, readiness.plan.original.destination) &&
          inside(file.backupPath, readiness.plan.backup.destination),
        "STOP_CUSTODY_DESTINATION",
      );
      for (const path of [file.originalPath, file.backupPath]) {
        const bytes = read(path);
        need(bytes.length === file.bytes && sha256(bytes) === file.sha256, "STOP_COMPLETE_CUSTODY");
      }
    }
    if (receipt.bracketState === "NO_BRACKET_NO_T0") {
      need(!existsSync(join(root, "snapshot.json")), "STOP_NO_BRACKET_SNAPSHOT");
      return {
        state: "NO_BRACKET_NO_T0",
        receipt,
        c1Admission: false,
        t0Utc: null,
        c1Schedule: "NOT_STARTED",
        newOpportunities: 0,
      };
    }
    need(
      receipt.bracketState === "TERMINAL_BEFORE_DELETE" && receipt.cRunTerminal.utc === null,
      "STOP_QUALIFIED_RECEIPT",
    );
    need(
      envelope.capture.verification.every(
        (record) => ticks(readiness.admittedAt) < ticks(JSON.parse(record.body).run_started_at),
      ),
      "STOP_POST_BRACKET_READINESS",
    );
    const snapshot = json(join(root, "snapshot.json"));
    validateSnapshot(snapshot, readiness, authority);
    need(snapshot.initialHash === digest(initial), "STOP_INITIAL_SNAPSHOT");
    need(
      equal(snapshot.binding, receipt.binding) &&
        equal(snapshot.seal, envelope.seal) &&
        snapshot.rawD === receipt.vDeleteTerminal.raw &&
        equal(snapshot.schedule, envelope.schedule) &&
        equal(snapshot.histories, envelope.histories) &&
        snapshot.receiptHash === envelope.ack.receiptHash,
      "STOP_SNAPSHOT_RECEIPT_BINDING",
    );
    const ack = envelope.ack,
      path = join(root, "acknowledgement.json");
    const record = {
      snapshotHash: digest(snapshot),
      readinessHash: digest(readiness),
      custodyPlanHash: custody.planHash,
      custodyManifestHash: sha256(read(custody.manifestPath)),
      receiptHash: digest(receipt),
      ack,
      cleanupSucceeded: receipt.cleanupSucceeded,
      c1Admission: receipt.c1Admission,
    };
    if (existsSync(path)) {
      need(equal(json(path), record), "STOP_ACK_CONFLICT");
      need(
        json(join(root, "acknowledgement-complete.json")).acknowledgementHash === digest(record),
        "STOP_PARTIAL_ACK",
      );
    } else {
      const at = now();
      validateReadiness(readiness, authority, at);
      need(
        at === ack.at &&
          ticks(at) >= ticks(snapshot.schedule.persistedAt) &&
          ticks(at) < ticks(snapshot.rawD) + slotTicks,
        "STOP_ACTUAL_ACK_TIME",
      );
      create(path, record);
      need(now() === at, "STOP_ACK_WRITE_DELAY");
    }
    create(join(root, "acknowledgement-complete.json"), { acknowledgementHash: digest(record) });
    return { ...reconstructScheduleBridge({ root, authority }), receipt };
  } catch (error) {
    return stopped(error, root);
  }
}

const eventPath = (root, n) => join(root, `transition-${String(n).padStart(3, "0")}.json`);
function resultState(state) {
  return state.arm
    ? "CONSUMED"
    : state.claimed
      ? "ARM_UNCERTAIN"
      : state.stopped
        ? "STOP"
        : state.schedule.windows.every((w) => w.ended) && !state.pending && !state.qualified
          ? "REFUSED_THREE_WINDOWS_RETURN_TO_PLANNING_C"
          : "WAITING";
}
function applyEvent(state, event) {
  keys(event, ["id", "kind", "at", "payload"], "STOP_EVENT_SHAPE");
  need(
    identity(event.id) && ["READ", "RECHECK", "ARM_CLAIM", "ARM_CONFIRMED"].includes(event.kind),
    "STOP_EVENT_SHAPE",
  );
  const at = ticks(event.at),
    t0 = ticks(state.schedule.t0Utc);
  need(
    at >= ticks(state.lastAt) && at < t0 + 180n * slotTicks && !state.arm && !state.stopped,
    "STOP_EVENT_ORDER_OR_DEADLINE",
  );
  const window =
    event.kind === "RECHECK"
      ? state.schedule.windows.find((w) => w.reads.at(-1)?.slot === state.pending?.slot)
      : state.schedule.windows.find((w) => !w.ended);
  const payload = event.payload;
  if (event.kind === "ARM_CONFIRMED") {
    keys(payload, ["claimId", "executor", "runId", "attempt"], "STOP_ARM_CONFIRMATION");
    need(
      state.claimed === payload.claimId &&
        payload.executor === state.executor &&
        Number.isSafeInteger(payload.runId) &&
        payload.runId > 0 &&
        Number.isSafeInteger(payload.attempt) &&
        payload.attempt > 0,
      "STOP_ARM_CONFIRMATION",
    );
    state.arm = payload;
  } else {
    need(!state.claimed && (window || (event.kind === "ARM_CLAIM" && state.qualified)), "STOP_NO_OPPORTUNITY");
    const slot = Number((at - t0) / slotTicks);
    if (event.kind === "READ") {
      need(!state.pending, "STOP_RECHECK_REQUIRED");
      const expected = window.startSlot + window.reads.length;
      need(slot === expected, "STOP_MISSED_OR_DUPLICATE_SLOT");
      const status = validateObservation(payload, event.at, slot, state);
      window.reads.push({ slot, at: event.at, status, payloadHash: digest(payload) });
      window.ended = status !== "COMPLETE" || window.reads.length === 60;
      if (payload.state === "ADMITTED" && state.c1Admission !== false) state.pending = { slot, payload };
      else state.qualified = null;
      if (window.ended) startNext(state, slot + 1);
    } else if (event.kind === "RECHECK") {
      need(state.pending && slot === state.pending.slot, "STOP_IMMEDIATE_RECHECK");
      const status = validateObservation(payload, event.at, slot, state);
      if (status !== "COMPLETE") {
        const read = window.reads.at(-1);
        need(read?.slot === slot, "STOP_RECHECK_WINDOW");
        read.status = status;
        read.payloadHash = digest({ observation: state.pending.payload, recheck: payload });
        window.ended = true;
        startNext(state, slot + 1);
      }
      state.qualified =
        payload.state === "ADMITTED" && payload.nodeUid === state.pending.payload.nodeUid
          ? { slot, nodeUid: payload.nodeUid, at: event.at, recheckHash: digest(payload) }
          : null;
      state.pending = null;
    } else {
      keys(payload, ["executor", "recheckHash"], "STOP_ARM_CLAIM");
      need(
        state.qualified &&
          slot === state.qualified.slot &&
          payload.executor === state.executor &&
          payload.recheckHash === state.qualified.recheckHash &&
          state.c1Admission !== false,
        "STOP_ARM_CLAIM",
      );
      state.claimed = event.id;
      state.qualified = null;
    }
  }
  state.lastAt = event.at;
}
function startNext(state, slot) {
  const next = state.schedule.windows.find((w) => !w.ended);
  if (next) next.startSlot = slot;
}
function validateObservation(payload, at, slot, state) {
  need(payload && ["ADMITTED", "REFUSED", "STOP"].includes(payload.state), "STOP_OBSERVATION");
  if (payload.state === "STOP") {
    need(Array.isArray(payload.reasons) && payload.reasons.length > 0 && payload.nodeUid === null, "STOP_OBSERVATION");
    return "ERROR";
  }
  need(
    payload.snapshot &&
      digest(payload.snapshot) === payload.snapshotHash &&
      payload.snapshot.sourceHash === state.sourceHash &&
      payload.snapshot.capabilityHash === state.capabilityHash &&
      payload.snapshot.slot?.index === slot &&
      payload.snapshot.elapsedMs >= 0 &&
      payload.snapshot.elapsedMs < 30000 &&
      payload.snapshot.slot.deadline - payload.snapshot.slot.startedAt === 30000 &&
      payload.snapshot.reads?.length === 5 &&
      payload.snapshot.inventory?.length > 0 &&
      Array.isArray(payload.reasons) &&
      (payload.state !== "ADMITTED" || (payload.reasons.length === 0 && identity(payload.nodeUid))),
    "STOP_OBSERVATION",
  );
  const from = ticks(state.schedule.t0Utc) + BigInt(slot) * slotTicks;
  need(
    payload.snapshot.reads.every(
      (r) =>
        ticks(r.startedAt) >= from &&
        ticks(r.completedAt) >= ticks(r.startedAt) &&
        ticks(r.completedAt) <= ticks(at) &&
        ticks(r.completedAt) < from + slotTicks,
    ),
    "STOP_OBSERVATION_TIME",
  );
  return "COMPLETE";
}

export function reconstructScheduleBridge({ root, authority }) {
  try {
    return reconstruct(root, authority).current;
  } catch (error) {
    return stopped(error, root);
  }
}

function retainedRecord(path) {
  const bytes = read(path);
  const value = JSON.parse(bytes.toString("utf8"));
  need(bytes.equals(Buffer.from(JSON.stringify(value))), "STOP_RETAINED_BYTES");
  return { bytes, value };
}

function reconstruct(root, authority) {
  // All journal entries are direct children of the independently checked root.
  const names = new Set(readdirSync(local(root)));
  for (const name of names) {
    if (name.startsWith("transition-"))
      need(
        /^transition-\d{3}\.json$/.test(name) && Number(name.slice(11, 14)) >= 1 && Number(name.slice(11, 14)) <= 362,
        "STOP_TRANSITION_BOUND",
      );
  }
  const transition = (ordinal) => {
    const path = eventPath(root, ordinal);
    const stat = lstatSync(path);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 * 1024, "STOP_LOCAL_FILE");
    const bytes = readFileSync(path);
    const value = JSON.parse(bytes.toString("utf8"));
    need(bytes.equals(Buffer.from(JSON.stringify(value))), "STOP_RETAINED_BYTES");
    return { bytes, value };
  };
  const anchors = new Map();
  const anchor = (name) => {
    const record = retainedRecord(join(root, name));
    anchors.set(name, record.bytes);
    return record.value;
  };
  const readiness = anchor("readiness.json"),
    snapshot = anchor("snapshot.json");
  anchor("initial-snapshot.json");
  const initial = validateInitial(root, readiness);
  validateSnapshot(snapshot, readiness, authority);
  need(snapshot.initialHash === digest(initial), "STOP_INITIAL_SNAPSHOT");
  const snapshotHash = digest(snapshot),
    ackPath = join(root, "acknowledgement.json");
  if (!existsSync(ackPath))
    return { current: { state: "NOT_STARTED", t0Utc: null, c1Schedule: "NOT_STARTED", snapshotHash } };
  const acknowledged = anchor("acknowledgement.json"),
    ack = acknowledged.ack;
  need(anchor("acknowledgement-complete.json").acknowledgementHash === digest(acknowledged), "STOP_PARTIAL_ACK");
  need(
    acknowledged.snapshotHash === snapshotHash &&
      acknowledged.readinessHash === digest(readiness) &&
      ack.scheduleHash === digest(snapshot.schedule) &&
      ack.receiptHash === snapshot.receiptHash &&
      ack.custodian === readiness.plan.roles.schedule.identity,
    "STOP_ACK_BINDING",
  );
  validateReadiness(readiness, authority, ack.at);
  validateWindowSchedule(snapshot.schedule, instant(snapshot.rawD).utc, ack.at);
  const state = {
    schedule: structuredClone(snapshot.schedule),
    ackAt: ack.at,
    lastAt: ack.at,
    c1Admission: acknowledged.c1Admission,
    executor: readiness.plan.roles.executor.identity,
    ...readiness.plan.observationBinding,
    pending: null,
    qualified: null,
    claimed: null,
    arm: null,
    stopped: false,
  };
  let previous = digest(acknowledged);
  const events = [];
  const ids = new Set();
  const entries = new Map();
  const present = (n) => names.has(`transition-${String(n).padStart(3, "0")}.json`);
  // 180 reads, at most 180 rechecks, one irreversible claim and its confirmation.
  for (let ordinal = 1; ordinal <= 363; ordinal++) {
    if (!present(ordinal)) {
      for (let tail = ordinal + 1; tail <= 363; tail++) need(!present(tail), "STOP_TRANSITION_GAP");
      // Each event enforces its transition; validate the resulting schedule once,
      // rather than revalidating every growing prefix during replay.
      validateWindowSchedule(state.schedule, state.schedule.t0Utc, state.ackAt);
      return {
        anchors,
        entries,
        snapshot,
        current: {
          state: resultState(state),
          t0Utc: state.stopped ? null : snapshot.schedule.t0Utc,
          c1Schedule: resultState(state),
          snapshotHash,
          previous,
          events,
          ...state,
        },
      };
    }
    need(ordinal <= 362, "STOP_TRANSITION_BOUND");
    const { value: entry, bytes } = transition(ordinal);
    keys(entry, ["ordinal", "snapshotHash", "histories", "previous", "event", "payloadHash"], "STOP_TRANSITION_SHAPE");
    need(
      entry.ordinal === ordinal &&
        entry.snapshotHash === snapshotHash &&
        entry.previous === previous &&
        equal(entry.histories, snapshot.histories) &&
        entry.payloadHash === digest(entry.event.payload) &&
        !ids.has(entry.event.id),
      "STOP_TRANSITION_CAUSALITY",
    );
    applyEvent(state, entry.event);
    previous = digest(entry);
    events.push(entry.event);
    ids.add(entry.event.id);
    entries.set(entry.event.id, { ordinal, bytes });
  }
  need(false, "STOP_TRANSITION_BOUND");
}

const writers = new WeakMap();

// This cursor verifies appends, never substitutes for a fresh authoritative read.
export function openScheduleBridgeWriter({ root, authority, writer }) {
  try {
    if (writer !== undefined) {
      const binding = writers.get(writer);
      need(
        binding && binding.root === resolve(root) && binding.approval === authority?.approvedPlanHash,
        "STOP_WRITER_BINDING",
      );
      return writer;
    }
    const pinned = reconstruct(root, authority);
    need(Array.isArray(pinned.current.events), "STOP_NOT_ACKNOWLEDGED");
    root = resolve(root);
    authority = structuredClone(authority);
    let current = pinned.current;
    let live = !["CONSUMED", "REFUSED_THREE_WINDOWS_RETURN_TO_PLANNING_C"].includes(current.state);
    const checkBinding = (input = {}) => {
      need(live, "STOP_WRITER_CLOSED");
      need(
        (input.root === undefined || resolve(input.root) === root) &&
          (input.authority === undefined || input.authority.approvedPlanHash === authority.approvedPlanHash),
        "STOP_WRITER_BINDING",
      );
    };
    const independent = () => {
      const fresh = reconstruct(root, authority).current;
      need(equal(fresh, current), "STOP_WRITER_PREFIX");
      return structuredClone(fresh);
    };
    const audit = (input, close) => {
      try {
        checkBinding(input);
        const fresh = independent();
        if (close) live = false;
        return fresh;
      } catch (error) {
        live = false;
        return stopped(error, root);
      }
    };
    const progress = () => {
      const result = structuredClone(current);
      result.verification = "APPEND_VERIFIED_PROGRESS";
      // Only a fresh reconstruction may disclose positive qualification.
      result.qualified = null;
      return result;
    };
    const append = (input, { now = () => new Date().toISOString() } = {}) => {
      let persistenceStarted = false;
      try {
        checkBinding(input);
        local(root);
        for (const [name, bytes] of pinned.anchors) need(read(join(root, name)).equals(bytes), "STOP_WRITER_ANCHOR");
        if (current.events.length) {
          const tip = pinned.entries.get(current.events.at(-1).id);
          need(read(eventPath(root, tip.ordinal)).equals(tip.bytes), "STOP_WRITER_PREDECESSOR");
        }
        const event = structuredClone(input.event);
        const duplicate = pinned.entries.get(event.id);
        if (duplicate) {
          need(read(eventPath(root, duplicate.ordinal)).equals(duplicate.bytes), "STOP_DUPLICATE_BYTES");
          need(equal(JSON.parse(duplicate.bytes).event, event), "STOP_CONFLICTING_EVENT");
          if (["RECHECK", "ARM_CLAIM", "ARM_CONFIRMED"].includes(event.kind)) return independent();
          return progress();
        }
        need(current.events.length < 362, "STOP_TRANSITION_BOUND");
        need(
          current.previous === input.expectedPrevious && ticks(now()) === ticks(event.at),
          "STOP_STALE_PREDECESSOR_OR_TIME",
        );
        if (["RECHECK", "ARM_CLAIM", "ARM_CONFIRMED"].includes(event.kind)) independent();
        const next = structuredClone(current);
        applyEvent(next, event);
        validateWindowSchedule(next.schedule, next.schedule.t0Utc, next.ackAt);
        const entry = {
          ordinal: current.events.length + 1,
          snapshotHash: current.snapshotHash,
          histories: pinned.snapshot.histories,
          previous: current.previous,
          event,
          payloadHash: digest(event.payload),
        };
        persistenceStarted = true;
        create(eventPath(root, entry.ordinal), entry);
        const bytes = Buffer.from(JSON.stringify(entry));
        next.events.push(event);
        next.previous = sha256(bytes);
        next.state = resultState(next);
        next.c1Schedule = next.state;
        current = next;
        pinned.entries.set(event.id, { ordinal: entry.ordinal, bytes });
        if (next.state === "REFUSED_THREE_WINDOWS_RETURN_TO_PLANNING_C") return audit(undefined, true);
        if ((event.kind === "RECHECK" && next.qualified) || ["ARM_CLAIM", "ARM_CONFIRMED"].includes(event.kind)) {
          const fresh = independent();
          if (next.state === "CONSUMED") live = false;
          return fresh;
        }
        return progress();
      } catch (error) {
        if (
          persistenceStarted ||
          ![
            "STOP_STALE_PREDECESSOR_OR_TIME",
            "STOP_MISSED_OR_DUPLICATE_SLOT",
            "STOP_CONFLICTING_EVENT",
            "STOP_NO_OPPORTUNITY",
          ].includes(error.message)
        )
          live = false;
        return stopped(error, root);
      }
    };
    const result = Object.freeze({
      append,
      read: (input) => audit(input, false),
      close: (input) => audit(input, true),
    });
    writers.set(result, { root, approval: authority.approvedPlanHash });
    return result;
  } catch (error) {
    return stopped(error, root);
  }
}

export function appendScheduleTransition(
  { root, authority, expectedPrevious, event },
  { now = () => new Date().toISOString() } = {},
) {
  try {
    const writer = openScheduleBridgeWriter({ root, authority });
    if (writer.state === "STOP") return writer;
    const result = writer.append({ expectedPrevious, event }, { now });
    if (result.state === "STOP" || result.verification === undefined) return result;
    return writer.close();
  } catch (error) {
    return stopped(error, root);
  }
}
