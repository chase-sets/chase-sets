import { verify, createPublicKey } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { instant, readTerminalEvidence, sha256 } from "./census-terminal-evidence.mjs";

const clockKinds = Object.freeze([
  "capture-start",
  "verification-dispatched",
  "namespace-created",
  "provider-finalized",
  "seal-written",
  "delete-started",
  "delete-completed",
]);
const headers = new Set([
  "content-type",
  "date",
  "etag",
  "link",
  "x-github-request-id",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);
const hash = /^[a-f0-9]{64}$/;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const encoded = (v) => Buffer.from(`${JSON.stringify(v)}\n`);
class CustodyRefusal extends Error {}
function need(condition, reason) {
  if (!condition) throw new CustodyRefusal(reason);
}
function time(value) {
  return instant(value).ticks;
}
function local(path) {
  need(
    typeof path === "string" &&
      isAbsolute(path) &&
      !/^[\\/]{2}/.test(path) &&
      (process.platform !== "win32" || /^[A-Za-z]:[\\/]/.test(path)),
    "LOCAL_NAMED_PATH",
  );
  const full = resolve(path);
  for (let parent = full; ; parent = dirname(parent)) {
    if (existsSync(parent)) need(!lstatSync(parent).isSymbolicLink(), "SYMLINK_PATH");
    if (dirname(parent) === parent) break;
  }
  return full;
}
function key(path) {
  const p = local(path);
  return process.platform === "win32" ? p.toLowerCase() : p;
}
function under(path, prefix) {
  const p = relative(local(prefix), local(path));
  return p !== "" && p !== ".." && !p.startsWith(`..${sep}`) && !isAbsolute(p);
}
function read(path) {
  local(path);
  need(lstatSync(path).isFile(), "NAMED_FILE");
  return readFileSync(path);
}
function decode(bytes) {
  const value = bytes.toString("utf8");
  need(Buffer.from(value).equals(bytes), "ENCODING");
  return value;
}
function json(bytes) {
  return JSON.parse(decode(bytes));
}
function pointer(value, path) {
  need(typeof path === "string" && (path === "" || path.startsWith("/")), "SOURCE_POINTER");
  if (!path) return value;
  for (const segment of path.slice(1).split("/")) {
    const k = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    need(value !== null && typeof value === "object" && Object.hasOwn(value, k), "SOURCE_POINTER");
    value = value[k];
  }
  return value;
}
function checked(bytes, file) {
  need(bytes.length === file.bytes && sha256(bytes) === file.sha256, `SOURCE_BYTES:${file.id}`);
  if (file.encoding === "utf8") decode(bytes);
  else need(file.encoding === "binary" && file.artifactArchive === true, `ENCODING:${file.id}`);
  return bytes;
}
function sourceOrigin(bytes, file) {
  need(
    typeof file.origin.evidencePointer === "string" &&
      (file.origin.evidencePointer === "" || file.origin.evidencePointer.startsWith("/")),
    `SOURCE_POINTER:${file.id}`,
  );
  if (file.encoding !== "utf8") return;
  let value;
  try {
    value = json(bytes);
  } catch {
    need(file.origin.evidencePointer === "", `SOURCE_POINTER:${file.id}`);
    return;
  }
  pointer(value, file.origin.evidencePointer);
  if (value && typeof value === "object") {
    need(!Object.hasOwn(value, "stderr"), `UNSAFE_DIAGNOSTIC:${file.id}`);
    if (typeof value.body === "string" && typeof value.url === "string") {
      need(
        value.url === file.origin.url &&
          value.method === file.origin.method &&
          value.apiVersion === file.origin.apiVersion &&
          value.status === file.origin.status &&
          equal(value.headers, file.origin.headers) &&
          value.captureStartedAt === file.origin.startedAt &&
          value.captureCompletedAt === file.origin.completedAt &&
          value.encoding === "utf8" &&
          value.bytes === Buffer.byteLength(value.body) &&
          value.sha256 === sha256(value.body),
        `RESPONSE_PROVENANCE:${file.id}`,
      );
    }
  }
}
function writeNew(path, bytes, written) {
  const fd = openSync(path, "wx", 0o600);
  written.push(path);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  need(read(path).equals(bytes), "ORIGINAL_REREAD");
}
function admission(plan, authority, backup, now) {
  need(plan.version === "c1-evidence-custody/v1" && plan.performer === authority.performer, "PERFORMER");
  need(
    time(plan.validFrom) <= time(now) &&
      time(now) <= time(plan.validUntil) &&
      time(plan.retainUntil) > time(plan.validUntil),
    "RETENTION_AUTHORITY",
  );
  need(
    plan.original?.custodian &&
      plan.backup?.custodian &&
      plan.original.custodian !== plan.backup.custodian &&
      backup?.custodian === plan.backup.custodian &&
      typeof backup.retain === "function",
    "INDEPENDENT_CUSTODIAN",
  );
  need(
    key(plan.original.prefix) !== key(plan.backup.prefix) &&
      !under(plan.original.prefix, plan.backup.prefix) &&
      !under(plan.backup.prefix, plan.original.prefix),
    "DISTINCT_PREFIXES",
  );
  need(createPublicKey(plan.backup.publicKey).asymmetricKeyType === "ed25519", "BACKUP_AUTHORITY");
  need(
    Array.isArray(plan.files) &&
      plan.files.length > 0 &&
      plan.files.length <= 1000 &&
      new Set(plan.files.map((f) => f.id)).size === plan.files.length,
    "ORDERED_INVENTORY",
  );
  const source = (id) => plan.files.find((f) => f.id === id);
  need(
    source(plan.sourceGraph?.workflowId)?.sha256 === plan.binding.workflowHash &&
      source(plan.sourceGraph?.helperId)?.sha256 === plan.binding.helperHash &&
      Array.isArray(plan.sourceGraph?.actionIds) &&
      plan.sourceGraph.actionIds.length > 0 &&
      plan.sourceGraph.actionIds.every((id) => source(id)),
    "SOURCE_GRAPH_BYTES",
  );
  need(
    under(plan.planOriginalPath, plan.original.prefix) && under(plan.planBackupPath, plan.backup.prefix),
    "PLAN_DESTINATIONS",
  );
  const paths = [plan.manifestPath, plan.acknowledgementPath, plan.planOriginalPath, plan.planBackupPath];
  if (plan.consumption) {
    need(
      equal(Object.keys(plan.consumption.outputs).sort(), ["envelope", "manifest", "receipt"]),
      "CONSUMPTION_OUTPUTS",
    );
    need(equal(plan.artifacts?.map((a) => a.role).sort(), ["census", "verification"]), "TERMINAL_ARTIFACT_COVERAGE");
    paths.push(plan.consumption.custodyPath, ...Object.values(plan.consumption.outputs));
  }
  for (const f of plan.files) {
    need(["terminal", "lifecycle"].includes(f.scope), `SOURCE_SCOPE:${f.id}`);
    const binding = f.scope === "lifecycle" ? plan.history?.binding : plan.binding;
    need(binding, `SOURCE_SCOPE_BINDING:${f.id}`);
    need(
      typeof f.id === "string" &&
        /^[a-zA-Z0-9_.-]{1,128}$/.test(f.id) &&
        f.id !== "custody-plan" &&
        hash.test(f.sha256) &&
        Number.isSafeInteger(f.bytes) &&
        f.bytes >= 0,
      "FILE_IDENTITY",
    );
    need(under(f.originalPath, plan.original.prefix) && under(f.backupPath, plan.backup.prefix), `DESTINATION:${f.id}`);
    paths.push(f.originalPath, f.backupPath);
    local(f.sourcePath);
    need(f.safety?.reviewer && f.safety.sha256 === f.sha256, `SAFE_SOURCE:${f.id}`);
    const o = f.origin;
    need(
      o &&
        equal(
          Object.keys(o).sort(),
          [
            "method",
            "url",
            "apiVersion",
            "status",
            "headers",
            "startedAt",
            "completedAt",
            "expiresAt",
            "sourceHash",
            "workflowHead",
            "release",
            "digest",
            "runId",
            "attempt",
            "jobId",
            "step",
            "namespaceUid",
            "nodeUid",
            "containerUid",
            "evidencePointer",
          ].sort(),
        ),
      `SOURCE_PROVENANCE:${f.id}`,
    );
    need(
      o.method === "GET" &&
        new URL(o.url).protocol === "https:" &&
        !new URL(o.url).username &&
        !new URL(o.url).password &&
        !new URL(o.url).hash &&
        o.status === 200 &&
        typeof o.apiVersion === "string" &&
        hash.test(o.sourceHash),
      `SOURCE_AUTHORITY:${f.id}`,
    );
    need(
      o.headers && Object.keys(o.headers).every((name) => headers.has(name) && typeof o.headers[name] === "string"),
      `SAFE_HEADERS:${f.id}`,
    );
    need(
      time(o.startedAt) <= time(o.completedAt) &&
        time(o.completedAt) - time(o.startedAt) <= 20000000000n &&
        time(o.completedAt) <= time(now) &&
        time(now) < time(o.expiresAt),
      `SOURCE_RETENTION:${f.id}`,
    );
    need(
      plan.files.some((file) => file.sha256 === o.sourceHash),
      `SOURCE_IMPLEMENTATION:${f.id}`,
    );
    need(
      o.workflowHead === binding.workflowHead &&
        o.release === binding.release &&
        o.digest === binding.digest &&
        o.namespaceUid === binding.uid &&
        o.nodeUid === (f.scope === "lifecycle" ? binding.nodeUid : (plan.nodeUid ?? binding.nodeUid)) &&
        typeof o.containerUid === "string" &&
        o.containerUid.length > 0 &&
        o.jobId &&
        o.step,
      `CAUSAL_SOURCE:${f.id}`,
    );
    need(
      [binding.census, binding.verification].some((b) => b && o.runId === b.id && o.attempt === b.attempt),
      `SOURCE_ATTEMPT:${f.id}`,
    );
  }
  const normalized = paths.map(key);
  need(
    new Set(normalized).size === normalized.length && plan.files.every((f) => !normalized.includes(key(f.sourcePath))),
    "DISTINCT_FILES",
  );
  return paths;
}

function clocks(plan, sources) {
  need(
    equal(
      plan.clockMappings?.map((m) => m.kind),
      clockKinds,
    ),
    "SEVEN_CLOCK_SOURCES",
  );
  for (const m of plan.clockMappings) {
    const f = plan.files.find((f) => f.id === m.fileId);
    need(f?.scope === "terminal", `CLOCK_SOURCE:${m.kind}`);
    const record = pointer(json(sources.get(f.id)), m.pointer);
    const b = m.kind === "capture-start" ? plan.binding.census : plan.binding.verification;
    need(
      record.kind === m.kind &&
        record.uid === plan.binding.uid &&
        record.runId === b.id &&
        record.attempt === b.attempt,
      `CLOCK_CAUSALITY:${m.kind}`,
    );
    need(
      m.sourcePointer === m.pointer && m.delivery === sha256(`${f.sha256}:${m.sourcePointer}:${m.kind}`),
      `CLOCK_DELIVERY:${m.kind}`,
    );
  }
}

function history(plan, sources, now) {
  const h = plan.history;
  const binding = h?.binding;
  need(
    binding &&
      /^[a-f0-9]{40}$/.test(binding.release) &&
      /^sha256:[a-f0-9]{64}$/.test(binding.digest) &&
      binding.uid &&
      binding.nodeUid &&
      binding.verification?.id &&
      binding.verification?.attempt,
    "C1_HISTORY_BINDING",
  );
  need(h && time(h.start) < time(h.end) && Array.isArray(h.segments) && h.segments.length > 0, "WHOLE_HISTORY");
  const get = (id) => {
    need(sources.has(id), `HISTORY_SOURCE:${id}`);
    need(plan.files.find((f) => f.id === id)?.scope === "lifecycle", `HISTORY_SCOPE:${id}`);
    return json(sources.get(id));
  };
  const inventory = get(h.inventoryId);
  need(
    equal(inventory.binding, binding) &&
      Array.isArray(inventory.resources) &&
      inventory.resources.length > 0 &&
      new Set(inventory.resources.map((r) => r.uid)).size === inventory.resources.length,
    "RESOURCE_INVENTORY",
  );
  need(
    ["Namespace", "Node", "Pod", "Container", "Producer"].every((kind) =>
      inventory.resources.some((r) => r.kind === kind),
    ),
    "RESOURCE_KINDS",
  );
  const records = [];
  let previousTime = h.start,
    previousVersion = h.startResourceVersion;
  need(typeof previousVersion === "string" && previousVersion.length > 0, "START_RESOURCE_VERSION");
  for (const [index, id] of h.segments.entries()) {
    const segment = get(id);
    need(
      equal(segment.binding, binding) &&
        segment.startedAt === previousTime &&
        time(segment.completedAt) >= time(segment.startedAt) &&
        time(segment.retainedFrom) <= time(h.start) &&
        time(now) < time(segment.expiresAt),
      `HISTORY_INTERVAL:${id}`,
    );
    need(
      segment.fromResourceVersion === previousVersion &&
        typeof segment.resourceVersion === "string" &&
        segment.resourceVersion.length > 0,
      `RESOURCE_VERSION_GAP:${id}`,
    );
    need(
      segment.page === index + 1 &&
        segment.totalPages === h.segments.length &&
        segment.totalPages <= 10 &&
        Array.isArray(segment.records) &&
        segment.records.length <= 100 &&
        segment.totalCount === get(h.segments[0]).totalCount,
      `HISTORY_PAGES:${id}`,
    );
    records.push(...segment.records);
    previousVersion = segment.resourceVersion;
    previousTime = segment.completedAt;
  }
  need(
    previousTime === h.end && records.length === get(h.segments[0]).totalCount && records.length <= 1000,
    "HISTORY_TOTAL",
  );
  need(records.filter((r) => r.kind === "Event").length === inventory.eventCount, "EVENT_COVERAGE");
  const unique = new Map();
  for (const r of records) {
    need(
      typeof r.uid === "string" && r.uid.length > 0 && time(r.at) >= time(h.start) && time(r.at) <= time(h.end),
      "HISTORY_RECORD",
    );
    const identity = `${r.kind}:${r.uid}:${r.action}:${r.at}`;
    need(!unique.has(identity) || equal(unique.get(identity), r), "DELIVERY_CONFLICT");
    unique.set(identity, r);
    if (r.kind === "Namespace") need(r.uid === binding.uid, `COMPETING_NAMESPACE:${r.uid}`);
    if (r.kind === "Node") need(r.uid === binding.nodeUid, `NODE_UID_DRIFT:${r.uid}`);
    if (r.kind === "Producer")
      need(
        inventory.resources.some((v) => v.kind === "Producer" && v.uid === r.uid),
        `COMPETING_PRODUCER:${r.uid}`,
      );
    if (r.kind !== "Event")
      need(
        inventory.resources.some((v) => v.kind === r.kind && v.uid === r.uid),
        `OMITTED_RESOURCE:${r.uid}`,
      );
  }
  const logs = [];
  for (const r of inventory.resources) {
    need(time(r.createdAt) >= time(h.start) && time(r.finalizedAt) <= time(h.end), `EARLY_HISTORY:${r.uid}`);
    if (["Pod", "Container", "Producer"].includes(r.kind))
      need(
        equal(r.identity, {
          runId: binding.verification.id,
          attempt: binding.verification.attempt,
          namespaceUid: binding.uid,
          nodeUid: binding.nodeUid,
          digest: binding.digest,
        }),
        `RESOURCE_CAUSALITY:${r.uid}`,
      );
    for (const [action, at] of [
      ["created", r.createdAt],
      ["finalized", r.finalizedAt],
    ])
      need(
        records.some(
          (v) =>
            v.kind === r.kind && v.uid === r.uid && v.action === action && v.at === at && equal(v.identity, r.identity),
        ),
        `RESOURCE_LIFECYCLE:${r.uid}:${action}`,
      );
    if (r.kind !== "Container") continue;
    need(Array.isArray(r.generations) && r.generations.length > 0, `GENERATION_COVERAGE:${r.uid}`);
    for (const [generation, g] of r.generations.entries()) {
      need(g.number === generation && Array.isArray(g.rotations) && g.rotations.length > 0, `GENERATION_GAP:${r.uid}`);
      for (const [rotation, chunk] of g.rotations.entries()) {
        need(chunk.number === rotation, `ROTATION_GAP:${r.uid}`);
        const matches = plan.files.filter(
          (f) =>
            f.scope === "lifecycle" &&
            f.log?.ownerUid === r.uid &&
            f.log.generation === generation &&
            f.log.rotation === rotation,
        );
        need(
          matches.length === 1 && matches[0].bytes === chunk.bytes && matches[0].sha256 === chunk.sha256,
          `OWNING_LOG:${r.uid}:${generation}:${rotation}`,
        );
        logs.push(matches[0].id);
      }
    }
  }
  need(equal(logs, h.logIds), "LOG_INVENTORY");
  return {
    binding,
    inventoryHash: sha256(sources.get(h.inventoryId)),
    segments: h.segments.map((id) => ({ id, sha256: sha256(sources.get(id)) })),
    start: h.start,
    end: h.end,
  };
}

function artifacts(plan, sources) {
  need(Array.isArray(plan.artifacts), "ARTIFACT_INVENTORY");
  for (const a of plan.artifacts) {
    need(
      [a.payloadId, a.archiveId, ...(a.pages ?? [])].every(
        (id) => plan.files.find((f) => f.id === id)?.scope === "terminal",
      ),
      "ARTIFACT_SOURCE_SCOPE",
    );
    const owner = plan.binding[a.role];
    need(owner, "ARTIFACT_OWNER");
    const payload = sources.get(a.payloadId),
      archive = sources.get(a.archiveId);
    need(
      payload &&
        archive &&
        a.payloadId !== a.archiveId &&
        hash.test(a.archiveHash) &&
        sha256(archive) === a.archiveHash,
      "CANONICAL_PAYLOAD",
    );
    const name =
      a.role === "census"
        ? `preview-pool-census-${owner.id}-${owner.attempt}`
        : `ephemeral-verification-${plan.binding.release}-${owner.id}-${owner.attempt}`;
    need(
      a.runId === owner.id &&
        a.attempt === owner.attempt &&
        a.name === name &&
        a.payloadName === (a.role === "census" ? "preview-pool-census.json" : "ephemeral-verification.json"),
      "ARTIFACT_IDENTITY",
    );
    need(Array.isArray(a.pages) && a.pages.length > 0 && a.pages.length <= 10, "ARTIFACT_PAGES");
    let rows = [],
      total;
    for (const [index, id] of a.pages.entries()) {
      const response = json(sources.get(id));
      const body = JSON.parse(response.body);
      const url = new URL(response.url);
      need(
        url.protocol === "https:" &&
          url.hostname === "api.github.com" &&
          url.pathname === `/repos/${owner.repository}/actions/runs/${owner.id}/artifacts` &&
          url.search === `?per_page=100&page=${index + 1}` &&
          response.method === "GET" &&
          response.status === 200 &&
          response.apiVersion === "2022-11-28" &&
          response.bytes === Buffer.byteLength(response.body) &&
          response.sha256 === sha256(response.body),
        "ARTIFACT_RESPONSE",
      );
      total ??= body.total_count;
      need(
        Number.isSafeInteger(total) &&
          total > 0 &&
          total <= 1000 &&
          total === body.total_count &&
          Array.isArray(body.artifacts) &&
          body.artifacts.length > 0 &&
          body.artifacts.length <= 100,
        "ARTIFACT_TOTAL",
      );
      need(
        response.headers &&
          Object.keys(response.headers).every((name) => headers.has(name)) &&
          time(response.captureCompletedAt) - time(response.captureStartedAt) >= 0n &&
          time(response.captureCompletedAt) - time(response.captureStartedAt) <= 20000000000n,
        "ARTIFACT_HEADERS",
      );
      const links = new Map();
      for (const part of response.headers.link?.split(",") ?? []) {
        const match = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
        need(match && !links.has(match[2]), "ARTIFACT_LINK");
        const linked = new URL(match[1]);
        need(
          linked.origin === url.origin &&
            linked.pathname === url.pathname &&
            /^\?per_page=100&page=[1-9][0-9]*$/.test(linked.search) &&
            !linked.hash &&
            !linked.username &&
            !linked.password &&
            Number(linked.searchParams.get("page")) <= Math.ceil(total / 100),
          "ARTIFACT_LINK",
        );
        links.set(match[2], linked.href);
      }
      need(
        index + 1 < a.pages.length
          ? links.get("next") === `${url.origin}${url.pathname}?per_page=100&page=${index + 2}`
          : !links.has("next"),
        "ARTIFACT_NEXT_PAGE",
      );
      rows.push(...body.artifacts);
    }
    need(
      rows.length === total &&
        new Set(rows.map((r) => r.id)).size === total &&
        a.pages.length === Math.ceil(total / 100),
      "ARTIFACT_TRUNCATION",
    );
    const matches = rows.filter(
      (r) =>
        r.id === a.id &&
        r.name === a.name &&
        r.expired === false &&
        r.workflow_run?.id === owner.id &&
        r.digest === `sha256:${a.archiveHash}` &&
        r.size_in_bytes === archive.length,
    );
    need(matches.length === 1, "ARTIFACT_CANONICAL_IDENTITY");
    const value = json(payload);
    if (a.role === "verification")
      need(
        [
          "schemaVersion",
          "releaseCommit",
          "imageRepository",
          "imageDigest",
          "producerRunId",
          "producerRunAttempt",
          "trigger",
          "namespace",
          "workflowRunId",
          "workflowRunAttempt",
          "result",
          "failurePhase",
          "teardownResult",
          "persistentStagingResult",
          "persistentStagingRetained",
          "workloads",
          "checkedAt",
        ].every((key) => Object.hasOwn(value, key)) &&
          value.schemaVersion === "ephemeral-verification/v1" &&
          value.releaseCommit === plan.binding.release &&
          value.imageDigest === plan.binding.digest &&
          String(value.workflowRunId) === String(owner.id) &&
          String(value.workflowRunAttempt) === String(owner.attempt) &&
          value.namespace === plan.binding.namespace,
        "ARTIFACT_PAYLOAD_BINDING",
      );
    else
      need(
        [
          "schemaVersion",
          "result",
          "mode",
          "startedAt",
          "finishedAt",
          "intervalSeconds",
          "durationMinutes",
          "lowerBound",
          "nodes",
          "namespaces",
          "containers",
          "events",
          "autoscalerStatus",
          "thinSamples",
          "errors",
        ].every((key) => Object.hasOwn(value, key)) &&
          value.schemaVersion === "preview-pool-census/v1" &&
          value.mode === "sample" &&
          time(value.startedAt) < time(value.finishedAt) &&
          Array.isArray(value.containers) &&
          value.containers.length > 0 &&
          value.containers.every((c) => c.namespace === plan.binding.namespace) &&
          value.result === "success" &&
          equal(value.errors, []) &&
          equal(value.thinSamples, []),
        "CENSUS_CANONICAL_PAYLOAD",
      );
  }
}

function acknowledgement(plan, planHash, receipt, now, startedAt, files) {
  need(
    receipt && equal(Object.keys(receipt).sort(), ["payload", "signature"]) && typeof receipt.signature === "string",
    "SAFE_BACKUP_ACKNOWLEDGEMENT",
  );
  const p = receipt?.payload;
  need(
    p &&
      equal(
        Object.keys(p).sort(),
        ["planHash", "custodian", "captureStartedAt", "acknowledgedAt", "retainUntil", "files"].sort(),
      ) &&
      p.planHash === planHash &&
      p.custodian === plan.backup.custodian &&
      p.captureStartedAt === startedAt &&
      time(p.acknowledgedAt) >= time(startedAt) &&
      time(p.acknowledgedAt) <= time(now) &&
      time(p.retainUntil) >= time(plan.retainUntil),
    "BACKUP_ACKNOWLEDGEMENT",
  );
  need(
    verify(
      null,
      Buffer.from(JSON.stringify(p)),
      createPublicKey(plan.backup.publicKey),
      Buffer.from(receipt.signature, "base64"),
    ),
    "BACKUP_SIGNATURE",
  );
  need(
    equal(
      p.files,
      files.map((f) => ({ path: f.backupPath, bytes: f.bytes, sha256: f.sha256 })),
    ),
    "BACKUP_INVENTORY",
  );
  for (const f of files) {
    need(existsSync(f.originalPath), `ORIGINAL_UNAVAILABLE:${f.id}`);
    need(existsSync(f.backupPath), `BACKUP_UNAVAILABLE:${f.id}`);
    checked(read(f.originalPath), f);
    checked(read(f.backupPath), f);
  }
}

// Host approval is an out-of-band trust input, not a field read from the source plan.
// Only exact admitted local files are read here. No capture/executor authority is created.
export async function retainC1Evidence(
  { planFile, authority } = {},
  { backup, now = () => new Date().toISOString(), requireConsumption = false } = {},
) {
  const written = [];
  let planHash;
  try {
    need(authority && hash.test(authority.approvedPlanHash), "HOST_APPROVAL");
    const planBytes = read(planFile);
    planHash = sha256(planBytes);
    need(planHash === authority.approvedPlanHash, "APPROVED_PLAN_BYTES");
    const plan = json(planBytes);
    need(!requireConsumption || plan.consumption, "TERMINAL_CONSUMPTION_PLAN");
    local(plan.manifestPath);
    const existingManifest = existsSync(plan.manifestPath) ? json(read(plan.manifestPath)) : null;
    const startedAt = existingManifest?.startedAt ?? now();
    need(time(now()) <= time(plan.retainUntil), "RETENTION_ENDED");
    const paths = admission(plan, authority, backup, startedAt);
    need(
      !paths.some((p) => key(p) === key(planFile)) ||
        (existingManifest && key(planFile) === key(plan.planOriginalPath)),
      "DISTINCT_PLAN",
    );
    const files = [
      {
        id: "custody-plan",
        originalPath: plan.planOriginalPath,
        backupPath: plan.planBackupPath,
        bytes: planBytes.length,
        sha256: planHash,
        encoding: "utf8",
      },
      ...plan.files,
    ];
    const inventory = files.map(({ id, originalPath, backupPath, bytes, sha256 }) => ({
      id,
      originalPath,
      backupPath,
      bytes,
      sha256,
    }));
    const sources = new Map(
      plan.files.map((f) => {
        const path = existingManifest ? f.originalPath : f.sourcePath;
        need(existsSync(path), `SOURCE_UNAVAILABLE:${f.id}`);
        const bytes = checked(read(path), f);
        sourceOrigin(bytes, f);
        return [f.id, bytes];
      }),
    );
    clocks(plan, sources);
    const historyFacts = history(plan, sources, startedAt);
    artifacts(plan, sources);
    const envelope = json(sources.get(plan.envelopeId)),
      admitted = json(sources.get(plan.admittedId));
    need(equal(envelope.binding, plan.binding) && equal(admitted.binding, plan.binding), "TERMINAL_BINDING");
    need(
      Array.isArray(envelope.files) &&
        Array.isArray(admitted.manifest) &&
        envelope.files.length === admitted.manifest.length,
      "TERMINAL_FILE_INVENTORY",
    );
    const mapped = plan.files.filter((f) => f.readerPath !== undefined);
    need(
      mapped.every((f) => f.scope === "terminal") &&
        [plan.envelopeId, plan.admittedId].every((id) => plan.files.find((f) => f.id === id)?.scope === "terminal"),
      "TERMINAL_SOURCE_SCOPE",
    );
    need(
      equal(
        mapped.map((f) => f.readerPath),
        admitted.manifest.map((f) => f.path),
      ),
      "TERMINAL_FILE_ORDER",
    );
    envelope.files = envelope.files.map((f, i) => {
      const source = mapped[i],
        expected = admitted.manifest[i];
      need(
        source.readerPath === f.path &&
          expected.bytes === source.bytes &&
          expected.sha256 === source.sha256 &&
          f.originalCustodian === plan.original.custodian &&
          f.backupCustodian === plan.backup.custodian,
        `TERMINAL_SOURCE:${source.id}`,
      );
      need(
        f.original === decode(sources.get(source.id)) && f.backup === f.original,
        `TERMINAL_INLINE_BYTES:${source.id}`,
      );
      return f;
    });
    let receipt, manifest;
    if (existingManifest) {
      manifest = existingManifest;
      need(
        equal(
          Object.keys(manifest).sort(),
          [
            "version",
            "planHash",
            "startedAt",
            "retainUntil",
            "originalCustodian",
            "backupCustodian",
            "files",
            "acknowledgement",
            "clocks",
            "history",
            "terminal",
            ...(plan.consumption ? ["consumption"] : []),
          ].sort(),
        ) && manifest.version === plan.version,
        "MANIFEST_SHAPE",
      );
      receipt = json(read(plan.acknowledgementPath));
      acknowledgement(plan, planHash, receipt, now(), manifest.startedAt, files);
      need(
        manifest.planHash === planHash &&
          equal(manifest.files, inventory) &&
          equal(manifest.history, historyFacts) &&
          equal(manifest.acknowledgement, {
            path: plan.acknowledgementPath,
            bytes: read(plan.acknowledgementPath).length,
            sha256: sha256(read(plan.acknowledgementPath)),
          }),
        "DELIVERY_CONFLICT",
      );
      if (plan.consumption)
        need(manifest.consumption.custodyHash === sha256(read(plan.consumption.custodyPath)), "CONSUMPTION_CUSTODY");
      need(
        equal(manifest.clocks, plan.clockMappings) &&
          equal(manifest.terminal, {
            envelopeId: plan.envelopeId,
            admittedId: plan.admittedId,
            binding: plan.binding,
            facts: readTerminalEvidence(envelope, admitted),
          }) &&
          manifest.retainUntil === plan.retainUntil &&
          manifest.originalCustodian === plan.original.custodian &&
          manifest.backupCustodian === plan.backup.custodian,
        "MANIFEST_BINDING",
      );
      if (plan.consumption) {
        const input = (id) => plan.files.find((f) => f.id === id);
        need(
          equal(manifest.consumption.outputs, plan.consumption.outputs) &&
            manifest.consumption.envelopeFile === input(plan.envelopeId).originalPath &&
            manifest.consumption.admittedFile === input(plan.admittedId).originalPath &&
            manifest.consumption.custodyFile === plan.consumption.custodyPath,
          "CONSUMPTION_PLAN_BINDING",
        );
      }
    } else {
      need(
        paths.every((p) => !existsSync(p)),
        "EXISTING_DESTINATION",
      );
      need(!existsSync(plan.original.prefix) && !existsSync(plan.backup.prefix), "EXISTING_PREFIX");
      for (const prefix of [plan.original.prefix, plan.backup.prefix]) {
        mkdirSync(prefix, { mode: 0o700 });
        written.push(prefix);
      }
      writeNew(plan.planOriginalPath, planBytes, written);
      for (const f of plan.files) writeNew(f.originalPath, sources.get(f.id), written);
      receipt = await backup.retain({ planHash, startedAt, files: inventory, retainUntil: plan.retainUntil });
      acknowledgement(plan, planHash, receipt, now(), startedAt, files);
      writeNew(plan.acknowledgementPath, encoded(receipt), written);
      const terminalFacts = readTerminalEvidence(envelope, admitted);
      let consumption;
      if (plan.consumption) {
        need(equal(plan.artifacts.map((a) => a.role).sort(), ["census", "verification"]), "TERMINAL_ARTIFACT_COVERAGE");
        const input = (id) => plan.files.find((f) => f.id === id);
        const envelopeFile = input(plan.envelopeId).originalPath,
          admittedFile = input(plan.admittedId).originalPath;
        const custody = encoded({
          inputs: [input(plan.envelopeId), input(plan.admittedId)].map((f) => ({
            path: f.originalPath,
            bytes: f.bytes,
            sha256: f.sha256,
          })),
          manifest: admitted.manifest,
          externalManifestHash: admitted.externalManifestHash,
        });
        writeNew(plan.consumption.custodyPath, custody, written);
        consumption = {
          envelopeFile,
          admittedFile,
          custodyFile: plan.consumption.custodyPath,
          outputs: plan.consumption.outputs,
          custodyHash: sha256(custody),
        };
      }
      manifest = {
        version: plan.version,
        planHash,
        startedAt,
        retainUntil: plan.retainUntil,
        originalCustodian: plan.original.custodian,
        backupCustodian: plan.backup.custodian,
        files: inventory,
        acknowledgement: {
          path: plan.acknowledgementPath,
          bytes: read(plan.acknowledgementPath).length,
          sha256: sha256(read(plan.acknowledgementPath)),
        },
        clocks: plan.clockMappings,
        history: historyFacts,
        terminal: {
          envelopeId: plan.envelopeId,
          admittedId: plan.admittedId,
          binding: plan.binding,
          facts: terminalFacts,
        },
        ...(consumption ? { consumption } : {}),
      };
      writeNew(plan.manifestPath, encoded(manifest), written);
    }
    // Backups are read again immediately before the caller can invoke the reader.
    acknowledgement(plan, planHash, receipt, now(), manifest.startedAt, files);
    return { state: "RETAINED", planHash, manifestPath: plan.manifestPath, manifest, envelope, admitted };
  } catch (error) {
    return {
      state: "STOP",
      reasons: ["STOP_CUSTODY_OR_AUTHORITY"],
      missing: [error instanceof CustodyRefusal ? error.message : "UNAVAILABLE_CUSTODY_SOURCE"],
      partial: written.length > 0,
      written,
      ...(planHash ? { planHash } : {}),
    };
  }
}
