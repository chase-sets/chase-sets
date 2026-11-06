import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const METHOD = "h6-terminal-source-api/v3";
export const RECEIPT = "h6-terminal-custody/v2";
export const CERTIFY = "Certify census terminal before namespace deletion";
export const DELETE = "Delete verification Kubernetes namespace";
const executed = new Set([
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "neutral",
  "action_required",
  "stale",
  "startup_failure",
]);
const safeHeaders = new Set(["content-type", "date", "link", "x-github-request-id", "x-github-api-version-selected"]);
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function requireEvidence(condition, reason) {
  if (!condition) throw new Error(reason);
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function instant(raw) {
  requireEvidence(typeof raw === "string", "STOP_UTC");
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(raw);
  requireEvidence(m, "STOP_UTC");
  const [, y, mo, d, h, mi, s, fraction = "", zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  requireEvidence(
    year >= 1000 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= days[month - 1] &&
      hour < 24 &&
      minute < 60 &&
      second < 60,
    "STOP_UTC",
  );
  const offsetHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  requireEvidence(offsetHour <= 23 && offsetMinute < 60, "STOP_UTC");
  const offset = (offsetHour * 60 + offsetMinute) * (zone.startsWith("-") ? -1 : 1);
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60000;
  const normalized = new Date(milliseconds).toISOString().slice(0, 19);
  requireEvidence(/^\d{4}-/.test(normalized), "STOP_UTC");
  return {
    raw,
    utc: `${normalized}${fraction}Z`,
    precision: fraction.length ? fraction.length - 1 : 0,
    ticks: BigInt(milliseconds) * 1000000n + BigInt((fraction.slice(1) || "0").padEnd(9, "0")),
  };
}

function terminal(value) {
  return value?.status === "completed" && executed.has(value.conclusion);
}

function runIdentity(run, expected) {
  requireEvidence(
    run &&
      run.id === expected.id &&
      run.run_attempt === expected.attempt &&
      run.repository?.full_name === expected.repository &&
      run.workflow_id === expected.workflowId &&
      run.path === expected.path &&
      run.head_sha === expected.head &&
      run.event === "workflow_dispatch",
    "STOP_RUN_IDENTITY",
  );
  requireEvidence(terminal(run), "STOP_NONTERMINAL_RUN");
  requireEvidence(!Object.hasOwn(run, "completed_at"), "STOP_UNSUPPORTED_RUN_CLOCK");
}

export function responseRecord(url, body, headers = {}, status = 200, capture = {}) {
  return {
    url,
    method: "GET",
    status,
    apiVersion: "2022-11-28",
    encoding: "utf8",
    bytes: Buffer.byteLength(body),
    sha256: sha256(body),
    headers,
    body,
    ...capture,
  };
}

function response(record, url) {
  requireEvidence(
    record?.url === url &&
      record.method === "GET" &&
      record.status === 200 &&
      record.apiVersion === "2022-11-28" &&
      record.encoding === "utf8" &&
      typeof record.body === "string" &&
      record.bytes === Buffer.byteLength(record.body) &&
      record.sha256 === sha256(record.body),
    "STOP_RESPONSE_CUSTODY",
  );
  requireEvidence(
    instant(record.captureStartedAt).ticks <= instant(record.captureCompletedAt).ticks,
    "STOP_CAPTURE_CUSTODY",
  );
  requireEvidence(
    record.headers &&
      Object.keys(record.headers).every((key) => safeHeaders.has(key)) &&
      typeof record.headers["x-github-request-id"] === "string" &&
      record.headers["x-github-request-id"].length > 0,
    "STOP_RESPONSE_HEADERS",
  );
  return JSON.parse(record.body);
}

function runUrl(binding) {
  return `https://api.github.com/repos/${binding.repository}/actions/runs/${binding.id}`;
}

function bindingValid(binding) {
  requireEvidence(
    binding &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(binding.repository) &&
      positive(binding.id) &&
      positive(binding.attempt) &&
      positive(binding.workflowId) &&
      /^\.github\/workflows\/[A-Za-z0-9_-]+\.yml$/.test(binding.path) &&
      /^[a-f0-9]{40}$/.test(binding.head),
    "STOP_BINDING",
  );
}

export function validateCensusSeal(seal, binding) {
  bindingValid(binding.census);
  bindingValid(binding.verification);
  requireEvidence(
    binding.census.repository === binding.verification.repository &&
      binding.census.path === ".github/workflows/platform-preview-pool-census.yml" &&
      binding.verification.path === ".github/workflows/platform-ephemeral-verification.yml" &&
      binding.verification.head === binding.workflowHead,
    "STOP_SOURCE_BINDING",
  );
  requireEvidence(
    seal?.schemaVersion === "h6-pre-delete-seal/v1" && equal(seal.binding, binding) && seal.responses?.length === 3,
    "STOP_SEAL",
  );
  const base = runUrl(binding.census);
  const urls = [base, `${base}/attempts/${binding.census.attempt}`, base];
  const values = seal.responses.map((record, index) => response(record, urls[index]));
  for (const value of values) runIdentity(value, binding.census);
  requireEvidence(
    values.every((value) => value.conclusion === values[0].conclusion),
    "STOP_RUN_CONFLICT",
  );
  return values;
}

export async function certifyCensusTerminal(binding, { request, seal }) {
  bindingValid(binding.census);
  bindingValid(binding.verification);
  requireEvidence(
    binding.census.repository === binding.verification.repository &&
      binding.namespace === `chase-sets-verify-${binding.verification.id}-${binding.verification.attempt}` &&
      typeof binding.uid === "string" &&
      binding.uid.length > 0,
    "STOP_NAMESPACE_BINDING",
  );
  for (const key of ["bodyHash", "methodHash", "helperHash", "workflowHash", "reviewHash", "decisionHash"])
    requireEvidence(/^[a-f0-9]{64}$/.test(binding[key]), "STOP_SOURCE_BINDING");
  requireEvidence(
    /^[a-f0-9]{40}$/.test(binding.release) && /^sha256:[a-f0-9]{64}$/.test(binding.digest),
    "STOP_RELEASE_BINDING",
  );
  const base = runUrl(binding.census);
  const records = [];
  for (const url of [base, `${base}/attempts/${binding.census.attempt}`, base]) {
    const record = await request(url);
    runIdentity(response(record, url), binding.census);
    records.push(record);
  }
  const certificate = { schemaVersion: "h6-pre-delete-seal/v1", binding, responses: records };
  validateCensusSeal(certificate, binding);
  await seal(certificate);
  return certificate;
}

function pageLinks(header, base, current, totalPages) {
  const result = {};
  if (header !== undefined) {
    requireEvidence(typeof header === "string" && header.length > 0, "STOP_INCOMPLETE_JOBS");
    for (const part of header.split(",")) {
      const match = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
      requireEvidence(match && !Object.hasOwn(result, match[2]), "STOP_INCOMPLETE_JOBS");
      const url = new URL(match[1]);
      const page = Number(url.searchParams.get("page"));
      requireEvidence(
        url.origin === "https://api.github.com" &&
          url.pathname === base.pathname &&
          !url.username &&
          !url.password &&
          !url.hash &&
          url.searchParams.get("per_page") === "100" &&
          [...url.searchParams.keys()].sort().join(",") === "page,per_page" &&
          positive(page) &&
          url.searchParams.getAll("page").length === 1 &&
          url.searchParams.getAll("per_page").length === 1,
        "STOP_UNSAFE_LINK",
      );
      const wanted = { next: current + 1, prev: current - 1, first: 1, last: totalPages }[match[2]];
      requireEvidence(page === wanted && page <= totalPages, "STOP_INCOMPLETE_JOBS");
      result[match[2]] = page;
    }
  }
  requireEvidence(
    current < totalPages ? result.next === current + 1 : result.next === undefined,
    "STOP_INCOMPLETE_JOBS",
  );
}

export function readAttemptJobs(pages, details, binding) {
  bindingValid(binding);
  requireEvidence(
    Array.isArray(pages) && pages.length > 0 && pages.length <= 10 && Array.isArray(details),
    "STOP_INCOMPLETE_JOBS",
  );
  const base = new URL(`${runUrl(binding)}/attempts/${binding.attempt}/jobs`);
  const jobs = [];
  const ids = new Set();
  let total;
  for (const [index, record] of pages.entries()) {
    const page = index + 1;
    const value = response(record, `${base}?per_page=100&page=${page}`);
    requireEvidence(
      Number.isSafeInteger(value.total_count) &&
        value.total_count >= 0 &&
        value.total_count <= 1000 &&
        Array.isArray(value.jobs),
      "STOP_INCOMPLETE_JOBS",
    );
    total ??= value.total_count;
    requireEvidence(
      total === value.total_count && value.jobs.length === Math.min(100, total - index * 100),
      "STOP_INCOMPLETE_JOBS",
    );
    pageLinks(record.headers.link, base, page, Math.max(1, Math.ceil(total / 100)));
    for (const job of value.jobs) {
      requireEvidence(
        positive(job.id) &&
          !ids.has(job.id) &&
          job.run_id === binding.id &&
          (job.run_attempt === undefined || job.run_attempt === binding.attempt) &&
          job.head_sha === binding.head &&
          terminal(job),
        "STOP_JOB_IDENTITY",
      );
      requireEvidence(Array.isArray(job.steps), "STOP_INCOMPLETE_STEPS");
      ids.add(job.id);
      jobs.push(job);
    }
  }
  requireEvidence(jobs.length === total && details.length === total, "STOP_INCOMPLETE_JOBS");
  const detailIds = new Set();
  for (const record of details) {
    const value = response(
      record,
      `https://api.github.com/repos/${binding.repository}/actions/jobs/${JSON.parse(record.body).id}`,
    );
    const listed = jobs.find((job) => job.id === value.id);
    requireEvidence(listed && !detailIds.has(value.id) && equal(listed, value), "STOP_JOB_DETAIL_CONFLICT");
    detailIds.add(value.id);
    const numbers = new Set();
    for (const step of value.steps) {
      requireEvidence(
        positive(step.number) && !numbers.has(step.number) && typeof step.name === "string",
        "STOP_INCOMPLETE_STEPS",
      );
      numbers.add(step.number);
    }
  }
  return jobs;
}

function executedStep(steps, name) {
  const matches = steps.filter((step) => step.name === name);
  requireEvidence(
    matches.length === 1 &&
      terminal(matches[0]) &&
      ["success", "failure", "cancelled", "timed_out"].includes(matches[0].conclusion),
    "STOP_MISSING_DELETE_TERMINAL",
  );
  const value = matches[0];
  const start = instant(value.started_at);
  const end = instant(value.completed_at);
  requireEvidence(start.ticks <= end.ticks, "STOP_UTC_ORDER");
  return { value, start, end };
}

function verifyFiles(files, manifest) {
  requireEvidence(
    Array.isArray(files) && Array.isArray(manifest) && files.length === manifest.length,
    "STOP_PAYLOAD_COVERAGE",
  );
  const paths = new Set();
  for (const [index, expected] of manifest.entries()) {
    const file = files[index];
    requireEvidence(
      file?.path === expected.path &&
        !paths.has(file.path) &&
        typeof file.backupPath === "string" &&
        file.backupPath !== file.path &&
        file.backupPath === expected.backupPath &&
        typeof file.originalCustodian === "string" &&
        file.originalCustodian.length > 0 &&
        typeof file.backupCustodian === "string" &&
        file.backupCustodian.length > 0 &&
        file.originalCustodian !== file.backupCustodian &&
        file.originalCustodian === expected.originalCustodian &&
        file.backupCustodian === expected.backupCustodian &&
        file.encoding === "utf8" &&
        typeof file.original === "string" &&
        typeof file.backup === "string" &&
        file.original === file.backup &&
        Buffer.byteLength(file.original) === expected.bytes &&
        sha256(file.original) === expected.sha256 &&
        sha256(file.backup) === expected.sha256,
      "STOP_PAYLOAD_CUSTODY",
    );
    paths.add(file.path);
  }
}

export function validateWindowSchedule(schedule, t0Utc, acknowledgedAt) {
  const t0 = instant(t0Utc).ticks;
  const ack = instant(acknowledgedAt).ticks;
  const slotTicks = 30000000000n;
  requireEvidence(
    schedule?.t0Utc === t0Utc &&
      instant(schedule.deadlineUtc).ticks === t0 + 180n * slotTicks &&
      Array.isArray(schedule.windows) &&
      schedule.windows.length === 3,
    "STOP_SCHEDULE",
  );
  const persisted = instant(schedule.persistedAt).ticks;
  requireEvidence(persisted >= t0 && persisted <= ack && ack < t0 + slotTicks, "STOP_SCHEDULE_DELAY");
  let next = 0;
  let previousEnded = true;
  let lastObserved = ack;
  for (const [index, window] of schedule.windows.entries()) {
    requireEvidence(
      window.ordinal === index + 1 &&
        window.slotLimit === 60 &&
        window.intervalSeconds === 30 &&
        Array.isArray(window.reads),
      "STOP_SCHEDULE",
    );
    if (!previousEnded) {
      requireEvidence(
        window.startSlot === null && window.reads.length === 0 && window.ended === false,
        "STOP_SCHEDULE_RESTART",
      );
      continue;
    }
    requireEvidence(window.startSlot === next && window.reads.length <= 60 && next < 180, "STOP_SCHEDULE_SHIFT");
    let ended = false;
    for (const [offset, read] of window.reads.entries()) {
      const slot = next + offset;
      const at = instant(read.at).ticks;
      requireEvidence(
        !ended &&
          slot < 180 &&
          read.slot === slot &&
          at >= t0 + BigInt(slot) * slotTicks &&
          at < t0 + BigInt(slot + 1) * slotTicks &&
          at >= lastObserved &&
          ["COMPLETE", "INCOMPLETE", "ERROR"].includes(read.status) &&
          /^[a-f0-9]{64}$/.test(read.payloadHash),
        "STOP_MISSED_OR_DUPLICATE_SLOT",
      );
      lastObserved = at;
      ended = read.status !== "COMPLETE" || offset === 59;
    }
    requireEvidence(window.ended === ended, "STOP_SCHEDULE_END");
    previousEnded = ended;
    if (ended) next += window.reads.length;
  }
  return { deadlineUtc: schedule.deadlineUtc, windows: schedule.windows };
}

function lifecycleEvidence(envelope, owner) {
  const roleValue = (role) => {
    const entry = envelope.coverage.find((value) => value.role === role);
    requireEvidence(entry?.paths.length === 1, "STOP_LIFECYCLE_COVERAGE");
    return JSON.parse(envelope.files.find((file) => file.path === entry.paths[0]).original);
  };
  const events = roleValue("events");
  requireEvidence(Array.isArray(events), "STOP_EVENT_COVERAGE");
  const seen = new Map();
  const unique = [];
  for (const event of events) {
    requireEvidence(typeof event.delivery === "string" && event.delivery.length > 0, "STOP_EVENT_IDENTITY");
    if (seen.has(event.delivery)) {
      requireEvidence(equal(seen.get(event.delivery), event), "STOP_EVENT_CONFLICT");
      continue;
    }
    const ownerBinding = event.kind === "capture-start" ? envelope.binding.census : envelope.binding.verification;
    requireEvidence(
      typeof event.delivery === "string" &&
        event.delivery.length > 0 &&
        event.runId === ownerBinding.id &&
        event.attempt === ownerBinding.attempt &&
        event.uid === envelope.binding.uid,
      "STOP_EVENT_IDENTITY",
    );
    seen.set(event.delivery, event);
    unique.push(event);
  }
  const kinds = unique.map((event) => event.kind);
  requireEvidence(
    equal(kinds, [
      "capture-start",
      "verification-dispatched",
      "namespace-created",
      "provider-finalized",
      "seal-written",
      "delete-started",
      "delete-completed",
    ]),
    "STOP_EVENT_COVERAGE",
  );
  const namespace = roleValue("namespace");
  const metadata = namespace.creation?.metadata;
  requireEvidence(
    namespace.creation?.kind === "Namespace" &&
      metadata?.uid === envelope.binding.uid &&
      metadata.name === envelope.binding.namespace &&
      metadata.creationTimestamp === envelope.namespace.createdAt,
    "STOP_CREATION_PROOF",
  );
  const logs = roleValue("logs");
  requireEvidence(
    logs.entire === true &&
      logs.safe === true &&
      logs.jobId === owner.id &&
      typeof logs.text === "string" &&
      logs.text.includes(`CENSUS_SEAL_SHA256=${sha256(`${JSON.stringify(envelope.seal)}\n`)}`),
    "STOP_EXECUTION_LOG",
  );
  const actions = roleValue("actions");
  requireEvidence(
    Array.isArray(actions.expanded) &&
      actions.expanded.length > 0 &&
      sha256(JSON.stringify(actions.expanded)) === envelope.sourceMap.expandedActionsHash,
    "STOP_ACTION_COVERAGE",
  );
  const finalizers = roleValue("finalizers");
  requireEvidence(
    ["success", "failure", "cancelled", "timed_out"].includes(finalizers.provider) &&
      ["success", "failure", "cancelled", "timed_out"].includes(finalizers.delete),
    "STOP_FINALIZER_COVERAGE",
  );
  return finalizers;
}

export function readTerminalEvidence(envelope, admitted) {
  const stopped = (reason) => ({
    method: METHOD,
    schemaVersion: RECEIPT,
    binding: envelope?.binding ?? null,
    dispatch: envelope?.dispatch ?? null,
    externalManifestHash: envelope?.externalManifestHash ?? null,
    bracketState: "STOP",
    reasons: [reason],
    cRunTerminal: null,
    vDeleteTerminal: null,
    t0Utc: null,
    c1Schedule: "NOT_STARTED",
    newOpportunities: 0,
  });
  try {
    requireEvidence(
      envelope?.method === METHOD && envelope.schemaVersion === RECEIPT && equal(envelope.binding, admitted.binding),
      "STOP_RECEIPT_BINDING",
    );
    requireEvidence(
      equal(envelope.admission, admitted.admission) &&
        admitted.admission?.method === METHOD &&
        admitted.admission?.decision === "ACCEPT_A" &&
        admitted.admission?.implementationCommit === envelope.binding.workflowHead &&
        typeof admitted.admission?.receiptId === "string" &&
        admitted.admission.receiptId.length > 0 &&
        ["dispatchHash", "controlReceiptHash"].every((key) => /^[a-f0-9]{64}$/.test(admitted.admission[key])),
      "STOP_ADMISSION",
    );
    verifyFiles(envelope.files, admitted.manifest);
    for (const key of ["bodyHash", "methodHash", "helperHash", "workflowHash", "reviewHash", "decisionHash"]) {
      requireEvidence(
        /^[a-f0-9]{64}$/.test(envelope.binding[key]) &&
          admitted.manifest.some((file) => file.sha256 === envelope.binding[key]),
        "STOP_SOURCE_BINDING",
      );
    }
    requireEvidence(
      sha256(JSON.stringify(admitted.manifest)) === envelope.externalManifestHash &&
        envelope.externalManifestHash === admitted.externalManifestHash,
      "STOP_EXTERNAL_MANIFEST",
    );
    const retained = (value) => envelope.files.some((file) => file.original === JSON.stringify(value));
    requireEvidence(
      retained({
        binding: envelope.binding,
        admission: envelope.admission,
        dispatch: envelope.dispatch,
        namespace: envelope.namespace,
        sourceMap: envelope.sourceMap,
        custodians: envelope.custodians,
        ack: envelope.ack,
        coverage: envelope.coverage,
        schedule: envelope.schedule,
        histories: envelope.histories,
      }),
      "STOP_FACT_CUSTODY",
    );
    const facts = envelope.dispatch;
    requireEvidence(facts && equal(facts, admitted.dispatch), "STOP_DISPATCH");
    const noV =
      facts.verificationDispatched === false && facts.verificationRunExists === false && facts.bracketStarted === false;
    if (!noV) requireEvidence(retained(envelope.seal), "STOP_SEAL_CUSTODY");
    for (const phase of ["capture", "consumption"])
      for (const role of ["census", "verification"]) {
        for (const record of envelope[phase]?.[role] ?? []) requireEvidence(retained(record), "STOP_RESPONSE_CUSTODY");
      }
    for (const role of ["census", "verification"])
      for (const record of [...(envelope.jobs?.[role]?.pages ?? []), ...(envelope.jobs?.[role]?.details ?? [])])
        requireEvidence(retained(record), "STOP_RESPONSE_CUSTODY");
    requireEvidence(
      Array.isArray(envelope.coverage) &&
        equal(envelope.coverage, admitted.coverage) &&
        ["dispatch", "sources", "actions", "logs", "events", "namespace", "finalizers", "capture", "consumption"].every(
          (role) =>
            envelope.coverage.some(
              (entry) =>
                entry.role === role &&
                entry.complete === true &&
                Array.isArray(entry.paths) &&
                ((entry.paths.length > 0 &&
                  entry.paths.every((path) => admitted.manifest.some((file) => file.path === path))) ||
                  (noV &&
                    entry.notApplicable === true &&
                    entry.reason === "NO_VERIFICATION_RUN" &&
                    entry.paths.length === 0 &&
                    ["actions", "logs", "events", "namespace", "finalizers"].includes(role))),
            ),
        ),
      "STOP_LIFECYCLE_COVERAGE",
    );
    requireEvidence(
      envelope.custodians &&
        equal(envelope.custodians, admitted.custodians) &&
        ["timestamp", "schedule", "executor"].every(
          (key) => typeof envelope.custodians[key] === "string" && envelope.custodians[key].length > 0,
        ) &&
        new Set(Object.values(envelope.custodians)).size === 3,
      "STOP_CUSTODIANS",
    );
    if (noV) {
      if (envelope.binding.census) {
        for (const phase of ["capture", "consumption"]) {
          const base = runUrl(envelope.binding.census);
          const urls = [base, `${base}/attempts/${envelope.binding.census.attempt}`, base];
          requireEvidence(envelope[phase]?.census?.length === 3, "STOP_CURRENT_ATTEMPT_COVERAGE");
          envelope[phase].census.forEach((record, index) =>
            runIdentity(response(record, urls[index]), envelope.binding.census),
          );
        }
        readAttemptJobs(envelope.jobs.census.pages, envelope.jobs.census.details, envelope.binding.census);
      }
      return { ...stopped("N7"), bracketState: "NO_BRACKET_NO_T0" };
    }
    requireEvidence(
      facts.verificationDispatched === true && facts.verificationRunExists === true,
      "STOP_DISPATCH_UNKNOWN",
    );
    const binding = envelope.binding;
    requireEvidence(
      /^[a-f0-9]{40}$/.test(binding.release) && /^sha256:[a-f0-9]{64}$/.test(binding.digest),
      "STOP_RELEASE_BINDING",
    );
    for (const role of ["census", "verification"]) {
      bindingValid(binding[role]);
      let conclusion;
      for (const phase of ["capture", "consumption"]) {
        const records = envelope[phase]?.[role];
        requireEvidence(records?.length === 3, "STOP_CURRENT_ATTEMPT_COVERAGE");
        const base = runUrl(binding[role]);
        const urls = [base, `${base}/attempts/${binding[role].attempt}`, base];
        const values = records.map((record, index) => response(record, urls[index]));
        values.forEach((value) => runIdentity(value, binding[role]));
        requireEvidence(
          values.every((value) => value.conclusion === values[0].conclusion),
          "STOP_RUN_CONFLICT",
        );
        conclusion ??= values[0].conclusion;
        requireEvidence(conclusion === values[0].conclusion, "STOP_RUN_CONFLICT");
      }
    }
    const cJobs = readAttemptJobs(envelope.jobs.census.pages, envelope.jobs.census.details, binding.census);
    const vJobs = readAttemptJobs(
      envelope.jobs.verification.pages,
      envelope.jobs.verification.details,
      binding.verification,
    );
    requireEvidence(cJobs.length > 0, "STOP_CAPTURE_UNKNOWN");
    const creation = envelope.namespace;
    requireEvidence(["CREATED", "NOT_CREATED"].includes(creation?.state), "STOP_CREATION_UNKNOWN");
    if (creation.state === "NOT_CREATED" || vJobs.length === 0) return stopped("CLOCK-2");
    requireEvidence(
      creation.state === "CREATED" &&
        creation.name === binding.namespace &&
        creation.uid === binding.uid &&
        creation.release === binding.release &&
        creation.digest === binding.digest &&
        creation.runId === binding.verification.id &&
        creation.attempt === binding.verification.attempt,
      "STOP_NAMESPACE_IDENTITY",
    );
    instant(creation.createdAt);
    const sealedRuns = validateCensusSeal(envelope.seal, binding);
    for (const phase of ["capture", "consumption"])
      requireEvidence(
        envelope[phase].census.every((record) => JSON.parse(record.body).conclusion === sealedRuns[0].conclusion),
        "STOP_RUN_CONFLICT",
      );
    const owners = vJobs.filter((job) => job.name === "Verify Release in Ephemeral Namespace");
    requireEvidence(
      owners.length === 1 &&
        owners[0].id === envelope.sourceMap.jobId &&
        envelope.sourceMap.jobKey === "verify-release" &&
        equal(envelope.sourceMap, admitted.sourceMap),
      "STOP_SOURCE_OWNER",
    );
    const steps = owners[0].steps;
    requireEvidence(
      equal(
        steps.map(({ name }) => ({ name })),
        envelope.sourceMap.steps,
      ),
      "STOP_SOURCE_STEPS",
    );
    const finalizers = lifecycleEvidence(envelope, owners[0]);
    const w = executedStep(steps, CERTIFY);
    requireEvidence(w.value.conclusion === "success", "STOP_SEAL_EXECUTION");
    const d = executedStep(steps, DELETE);
    requireEvidence(
      steps.indexOf(w.value) + 1 === steps.indexOf(d.value) &&
        w.end.ticks <= d.start.ticks &&
        envelope.sourceMap.synchronous === true &&
        envelope.sourceMap.deleteDependsOnSeal === false,
      "STOP_CAUSAL_ORDER",
    );
    requireEvidence(
      envelope.ack?.scheduleHash === admitted.scheduleHash &&
        envelope.ack.custodian === admitted.custodians.schedule &&
        envelope.ack.receiptHash ===
          sha256(JSON.stringify({ binding, seal: envelope.seal, endpoint: d.value.completed_at })),
      "STOP_ACK",
    );
    const ack = instant(envelope.ack.at);
    requireEvidence(ack.ticks >= d.end.ticks && ack.ticks < d.end.ticks + 30000000000n, "STOP_LATE_ACK");
    requireEvidence(
      equal(envelope.histories, admitted.histories) &&
        ["opportunity", "oneFreshArm", "sizingWindows", "lifetimeAttempts", "consumedHeads", "blockingRounds"].every(
          (key) => /^[a-f0-9]{64}$/.test(envelope.histories?.[key]),
        ),
      "STOP_HISTORY_RESET",
    );
    requireEvidence(sha256(JSON.stringify(envelope.schedule)) === admitted.scheduleHash, "STOP_SCHEDULE_CUSTODY");
    const schedule = validateWindowSchedule(envelope.schedule, d.end.utc, envelope.ack.at);
    const detail = envelope.jobs.verification.details.find((record) => JSON.parse(record.body).id === owners[0].id);
    const point = {
      raw: d.end.raw,
      utc: d.end.utc,
      precision: d.end.precision,
      payloadHash: detail.sha256,
      requestUrl: detail.url,
      responseHash: sha256(JSON.stringify(detail)),
      retainedPath: envelope.files.find((file) => file.original === JSON.stringify(detail)).path,
      pointer: `/steps/${steps.indexOf(d.value)}/completed_at`,
      jobId: owners[0].id,
      conclusion: d.value.conclusion,
    };
    const cleanupSucceeded =
      d.value.conclusion === "success" && finalizers.provider === "success" && envelope.namespace.deleted === true;
    return {
      method: METHOD,
      schemaVersion: RECEIPT,
      binding: structuredClone(binding),
      externalManifestHash: admitted.externalManifestHash,
      admissionHash: sha256(JSON.stringify(admitted.admission)),
      bracketState: "TERMINAL_BEFORE_DELETE",
      reasons: [],
      cRunTerminal: {
        state: "TERMINAL_BEFORE_DELETE",
        utc: null,
        proof: envelope.seal.responses.map((record) => record.sha256),
      },
      vDeleteTerminal: point,
      t0Utc: point.utc,
      cleanupSucceeded,
      c1Admission: cleanupSucceeded ? null : false,
      c1Schedule: "HANDOFF_REQUIRED",
      schedule,
      scheduleHash: admitted.scheduleHash,
    };
  } catch (error) {
    return stopped(error.message.startsWith("STOP_") ? error.message : "STOP_MALFORMED_EVIDENCE");
  }
}

export async function githubGet(url, token) {
  const captureStartedAt = new Date().toISOString();
  const result = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const body = await result.text();
  const headers = Object.fromEntries([...result.headers].filter(([key]) => safeHeaders.has(key)));
  return responseRecord(url, body, headers, result.status, {
    captureStartedAt,
    captureCompletedAt: new Date().toISOString(),
  });
}

async function main(env) {
  const binding = JSON.parse(env.CENSUS_TERMINAL_BINDING);
  const self = readFileSync(new URL(import.meta.url));
  requireEvidence(
    sha256(self) === binding.helperHash &&
      binding.workflowHead === env.FROZEN_WORKFLOW_SHA &&
      binding.release === env.RELEASE_COMMIT &&
      binding.digest === env.RELEASE_DIGEST,
    "STOP_MATERIALIZATION",
  );
  const namespace = JSON.parse(readFileSync(env.NAMESPACE_CREATION_PATH, "utf8"));
  binding.verification = {
    repository: env.GITHUB_REPOSITORY,
    id: Number(env.GITHUB_RUN_ID),
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
    workflowId: binding.verificationWorkflowId,
    path: ".github/workflows/platform-ephemeral-verification.yml",
    head: env.FROZEN_WORKFLOW_SHA,
  };
  binding.namespace = `chase-sets-verify-${binding.verification.id}-${binding.verification.attempt}`;
  requireEvidence(
    namespace.metadata?.name === binding.namespace && typeof namespace.metadata?.uid === "string",
    "STOP_NAMESPACE_IDENTITY",
  );
  binding.uid = namespace.metadata.uid;
  let requestNumber = 0;
  await certifyCensusTerminal(binding, {
    request: async (url) => {
      const record = await githubGet(url, env.GH_TOKEN);
      writeFileSync(`${env.CENSUS_SEAL_PATH}.response-${++requestNumber}.json`, `${JSON.stringify(record)}\n`, {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      return record;
    },
    seal: (value) => {
      const bytes = `${JSON.stringify(value)}\n`;
      writeFileSync(env.CENSUS_SEAL_PATH, bytes, { flag: "wx", mode: 0o600, flush: true });
      console.log(`CENSUS_SEAL_SHA256=${sha256(bytes)}`);
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch(() => {
    console.error("STOP_CENSUS_CERTIFICATION");
    process.exitCode = 1;
  });
}
