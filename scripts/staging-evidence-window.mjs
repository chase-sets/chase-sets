#!/usr/bin/env node
// One governed staging TEST-MODE evidence window, provisioned, admitted, held, closed
// and revoked inside the CI job that holds the staging deploy lock. Every
// credential is generated, used and revoked here; none leaves the job. The closed
// commands below are the workflow's steps:
//
//   inputs     validate the closed inputs and derive the run-bound identity
//   preflight  take over a finished run's residue; bind the owning deploy generation
//   provision  arm the cleanup observer, then install the admission key, restart both
//              runtimes, create the journal login and capture the provisioning binding
//   attest     read-only Stripe attestation for every consumer's declared fixtures
//   open       recapture the binding, then open exactly one 3600 s window
//   consume    run one reviewed consumer with step-local credentials until D-10 min
//   close      close the window by D-5 min through the shipped route
//   revoke     remove the key, restart, end and drop the login; each part reports
//   receipt    write the value-free receipt and scan it for credential markers
//   observe    the cleanup observer: take over at run end or D-5 min
//
// Stripe is read with GET only; nothing here sends, creates fixtures or reads the
// webhook signing secret. Registration is used only through its shipped routes.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect as connectTcp } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  countEvidenceWindowJournalSessions,
  evidenceWindowJournalPrincipal,
  evidenceWindowJournalPrincipalDropStatements,
  evidenceWindowJournalPrincipalExists,
  evidenceWindowJournalPrincipalExpireStatement,
  evidenceWindowJournalPrincipalProvisionStatements,
  listEvidenceWindowJournalPrincipals,
  parseEvidenceWindowJournalPrincipal,
  runEvidenceWindowJournalProbes,
  scramSha256Verifier,
  terminateEvidenceWindowJournalSessions,
} from "../infrastructure/platform-runtime/evidence-window-journal-principal.ts";
import { createPostgresEvidenceWindowProviderWrite } from "../infrastructure/platform-runtime/evidence-window-provider-write.ts";
import {
  EVIDENCE_WINDOW_ADMISSION_HEADER,
  createPostgresEvidenceWindowById,
} from "../infrastructure/platform-runtime/evidence-window-registration.ts";
import { postgresClientConfig } from "./lib/postgres-connection.mjs";
import { managedPostgresCaSecretName } from "./platform-kubernetes-secret.mjs";
import { selectStagingDeployGeneration } from "./staging-deploy-generation.mjs";
import { STAGING_PRODUCT_ORIGIN, observeProviderMode } from "./staging-product-observations.mjs";

export const RECEIPT_SCHEMA = "staging-evidence-window/v1";
export const ANNOTATION_SCHEMA = "staging-evidence-window-annotation/v1";
export const ADMISSION_SECRET_KEY = "EVIDENCE_WINDOW_ADMISSION_SECRET";
export const FIELD_MANAGER = "chase-sets-evidence-window";
export const ANNOTATION_KEY = "chase-sets.com/evidence-window";
export const RUNTIME_SECRET_NAME = managedPostgresCaSecretName;
export const NAMESPACE = "chase-sets-platform";
export const HELM_RELEASE = "chase-sets-platform";
export const RETENTION_SECONDS = 3600;
export const WINDOW_VERSION = 1;
export const CONSUMER_STOP_LEAD_SECONDS = 600;
export const CLOSE_LEAD_SECONDS = 300;
export const REVOCATION_BUDGET_SECONDS = 1800;
export const POLL_SECONDS = 30;
export const JOB_TIMEOUT_MINUTES = 150;
export const OBSERVER_WORKFLOW_FILE = "platform-staging-evidence-window-cleanup.yml";
export const WINDOW_JOB_NAME = "Staging Evidence Window";
export const CLEANUP_GROUP_PREFIX = "evidence-window-cleanup-";
export const CONSUMERS = Object.freeze(["rehearsal"]);
export const FAULTS = Object.freeze(["none", "fail", "hang", "runner-loss"]);
export const PAYMENTS_WEBHOOK_URL = `${STAGING_PRODUCT_ORIGIN}/api/payments/provider/webhooks`;
// Nonsecret markers planted in every credential this job generates, so a leak scan can
// find a credential in logs and artifacts without ever holding its value.
export const CREDENTIAL_MARKERS = Object.freeze(["ewadm", "ewjnl"].map((prefix) => `${prefix}_`));
const STRIPE_KEY_MARKERS = Object.freeze(["sk", "rk"].flatMap((kind) => [`${kind}_test_`, `${kind}_live_`]));
const API_COMPONENT = "platform-api";
const WORKER_COMPONENT = "platform-worker";
const API_PORT_NAME = "http";
const INGESTION_LOG_LIMIT_BYTES = 16 * 1024 * 1024;
const EVENT_WAIT_SECONDS = 600;
const RESTART_WAIT_SECONDS = 900;
const OBSERVER_CONFIRM_SECONDS = 180;

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, keys) =>
  isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isInstant = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const iso = (ms) => new Date(ms).toISOString();
const isDecimalId = (value) => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");

export class EvidenceWindowStop extends Error {
  constructor(code) {
    super(code);
    this.name = "EvidenceWindowStop";
    this.code = code;
  }
}
const stop = (code) => new EvidenceWindowStop(code);

// ---------------------------------------------------------------------------------
// Identity and inputs

/** Window id = first 32 hex of SHA-256 over the JSON tuple [repository, run id, attempt]. */
export function deriveWindowId({ repository, runId, attempt }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) throw stop("identity-repository-invalid");
  if (!isDecimalId(runId)) throw stop("identity-run-id-invalid");
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 999_999) throw stop("identity-attempt-invalid");
  return digest(JSON.stringify([repository, runId, attempt])).slice(0, 32);
}

export function cleanupGroup(runId) {
  if (!isDecimalId(runId)) throw stop("identity-run-id-invalid");
  return `${CLEANUP_GROUP_PREFIX}${runId}`;
}

export function windowIdentity({ repository, runId, attempt }) {
  const windowId = deriveWindowId({ repository, runId, attempt });
  return {
    repository,
    runId,
    attempt,
    windowId,
    version: WINDOW_VERSION,
    principal: evidenceWindowJournalPrincipal(runId, attempt).name,
    cleanupGroup: cleanupGroup(runId),
  };
}

export function parseInputs(env) {
  const consumers = String(env.CONSUMERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (consumers.length === 0 || new Set(consumers).size !== consumers.length) throw stop("consumers-invalid");
  if (!consumers.every((consumer) => CONSUMERS.includes(consumer))) throw stop("consumer-not-reviewed");
  const fault = String(env.FAULT ?? "");
  if (!FAULTS.includes(fault)) throw stop("fault-not-reviewed");
  return { consumers, fault };
}

export function runIdentityFromEnv(env) {
  if (env.GITHUB_ACTIONS !== "true") throw stop("github-actions-required");
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  return windowIdentity({ repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, attempt });
}

/** The observer's target comes from a dispatch input or a workflow_run payload; both are untrusted text. */
export function targetIdentityFromEnv(env) {
  const runId = String(env.TARGET_RUN_ID ?? "");
  const attemptText = String(env.TARGET_RUN_ATTEMPT ?? "");
  if (!isDecimalId(runId) || !/^[1-9][0-9]{0,5}$/.test(attemptText)) throw stop("observer-target-invalid");
  return windowIdentity({ repository: env.GITHUB_REPOSITORY, runId, attempt: Number(attemptText) });
}

export function windowSchedule(expiresAt) {
  const deadline = Date.parse(expiresAt);
  return {
    deadline: expiresAt,
    consumerStopAt: iso(deadline - CONSUMER_STOP_LEAD_SECONDS * 1000),
    closeBy: iso(deadline - CLOSE_LEAD_SECONDS * 1000),
    observerTakeoverAt: iso(deadline - CLOSE_LEAD_SECONDS * 1000),
  };
}

// ---------------------------------------------------------------------------------
// Credentials

export function generateAdmissionSecret(random = randomBytes) {
  return `${CREDENTIAL_MARKERS[0]}${random(32).toString("hex")}`;
}

/**
 * The journal login's password is derived from the admission secret, so any step of
 * this job can rebuild it from the runtime Secret in memory and no step needs a file,
 * an output or an argument to carry it.
 */
export function deriveJournalPassword(admissionSecret, principalName) {
  if (!admissionSecret.startsWith(CREDENTIAL_MARKERS[0])) throw stop("admission-secret-invalid");
  const mac = createHmac("sha256", admissionSecret).update(`${RECEIPT_SCHEMA} journal ${principalName}`).digest("hex");
  return `${CREDENTIAL_MARKERS[1]}${mac}`;
}

export function journalConnectionString(controlConnectionString, principalName, password) {
  let url;
  try {
    url = new URL(controlConnectionString);
  } catch {
    throw stop("journal-authority-unavailable");
  }
  if (url.searchParams.get("sslmode") !== "verify-full" || !url.searchParams.get("sslrootcert")) {
    throw stop("journal-authority-tls-unverified");
  }
  url.username = principalName;
  url.password = password;
  return url.toString();
}

export function controlDatabaseName(controlConnectionString) {
  try {
    const name = decodeURIComponent(new URL(controlConnectionString).pathname.slice(1));
    if (name.length > 0) return name;
  } catch {
    // classified below
  }
  throw stop("journal-authority-unavailable");
}

/** Returns the markers found in text; markers are nonsecret, so the result is too. */
export function credentialMarkersIn(text) {
  const source = String(text ?? "");
  return [...CREDENTIAL_MARKERS, ...STRIPE_KEY_MARKERS].filter((marker) => source.includes(marker));
}

// ---------------------------------------------------------------------------------
// Runtime Secret annotation and field-manager manifests

const ANNOTATION_KEYS = [
  "schemaVersion",
  "repository",
  "runId",
  "attempt",
  "windowId",
  "version",
  "deadline",
  "deadlineKind",
  "phase",
];
const DEADLINE_KINDS = ["unset", "lower-bound", "exact"];
const PHASES = ["installed", "key-removed"];

export function windowAnnotation(identity, { deadline = null, deadlineKind = "unset", phase = "installed" } = {}) {
  const value = {
    schemaVersion: ANNOTATION_SCHEMA,
    repository: identity.repository,
    runId: identity.runId,
    attempt: identity.attempt,
    windowId: identity.windowId,
    version: identity.version,
    deadline,
    deadlineKind,
    phase,
  };
  if (!parseWindowAnnotation(JSON.stringify(value))) throw stop("annotation-invalid");
  return value;
}

/** Strict parse; any extra, missing or inconsistent field is malformed and never reclaimed. */
export function parseWindowAnnotation(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!hasExactKeys(value, ANNOTATION_KEYS) || value.schemaVersion !== ANNOTATION_SCHEMA) return null;
  if (!DEADLINE_KINDS.includes(value.deadlineKind) || !PHASES.includes(value.phase)) return null;
  if ((value.deadlineKind === "unset") !== (value.deadline === null)) return null;
  if (value.deadline !== null && !isInstant(value.deadline)) return null;
  if (value.version !== WINDOW_VERSION) return null;
  try {
    if (deriveWindowId(value) !== value.windowId) return null;
  } catch {
    return null;
  }
  return value;
}

/**
 * The window's server-side-apply manifest. The applied set is everything this field
 * manager owns: omitting the key removes it, omitting the annotation releases it, and
 * the deploy's own manager never owns either.
 */
export function windowSecretManifest({ namespace = NAMESPACE, admissionSecret = null, annotation = null }) {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: RUNTIME_SECRET_NAME,
      namespace,
      ...(annotation ? { annotations: { [ANNOTATION_KEY]: JSON.stringify(annotation) } } : {}),
    },
    ...(admissionSecret
      ? { data: { [ADMISSION_SECRET_KEY]: Buffer.from(admissionSecret, "utf8").toString("base64") } }
      : {}),
  };
}

/** Reads the runtime Secret's window facts; the key value stays in memory only. */
export function readWindowSecretState(secret) {
  const annotationText = secret?.metadata?.annotations?.[ANNOTATION_KEY];
  const encoded = secret?.data?.[ADMISSION_SECRET_KEY];
  const managers = (secret?.metadata?.managedFields ?? []).filter((entry) =>
    JSON.stringify(entry?.fieldsV1 ?? {}).includes(`"f:${ADMISSION_SECRET_KEY}"`),
  );
  const windowManager = (secret?.metadata?.managedFields ?? []).find(
    (entry) => entry?.manager === FIELD_MANAGER && entry?.operation === "Apply",
  );
  return {
    present: Boolean(secret),
    annotationPresent: typeof annotationText === "string",
    annotation: typeof annotationText === "string" ? parseWindowAnnotation(annotationText) : null,
    admissionSecret: typeof encoded === "string" ? Buffer.from(encoded, "base64").toString("utf8") : null,
    keyManagers: managers.map((entry) => entry.manager).sort(),
    appliedAt: isInstant(windowManager?.time) ? windowManager.time : null,
  };
}

// ---------------------------------------------------------------------------------
// Binding

export function imageDigestOf(imageId) {
  const match = /@(sha256:[0-9a-f]{64})$/.exec(String(imageId ?? ""));
  return match ? match[1] : null;
}

/** Summarizes one component's pods; every live pod must be ready, on one revision and one digest. */
export function summarizeComponentPods(component, podList, { restartedAt = null } = {}) {
  const pods = (podList?.items ?? []).filter((pod) => !pod?.metadata?.deletionTimestamp);
  const terminating = (podList?.items ?? []).length - pods.length;
  const rows = pods.map((pod) => {
    const container = (pod.status?.containerStatuses ?? []).find((status) => status.name === component);
    return {
      name: pod.metadata?.name,
      createdAt: pod.metadata?.creationTimestamp,
      revision:
        pod.metadata?.labels?.["rollouts-pod-template-hash"] ?? pod.metadata?.labels?.["pod-template-hash"] ?? null,
      digest: imageDigestOf(container?.imageID),
      ready:
        pod.status?.phase === "Running" &&
        (pod.status?.conditions ?? []).some((condition) => condition.type === "Ready" && condition.status === "True"),
    };
  });
  const revisions = [...new Set(rows.map((row) => row.revision))];
  const digests = [...new Set(rows.map((row) => row.digest))];
  const restarted =
    restartedAt === null ||
    rows.every(
      (row) =>
        isInstant(row.createdAt) && Date.parse(row.createdAt) >= Math.floor(Date.parse(restartedAt) / 1000) * 1000,
    );
  const healthy =
    rows.length > 0 &&
    terminating === 0 &&
    rows.every((row) => row.ready && row.revision && row.digest) &&
    revisions.length === 1 &&
    digests.length === 1 &&
    restarted;
  return {
    component,
    healthy,
    restarted,
    pods: rows.map(({ name, createdAt }) => ({ name, createdAt })).sort((a, b) => a.name.localeCompare(b.name, "en")),
    revision: revisions.length === 1 ? revisions[0] : null,
    digest: digests.length === 1 ? digests[0] : null,
    terminating,
  };
}

const BINDING_KEYS = ["cluster", "namespace", "release", "api", "worker", "mode", "deployGeneration"];

/**
 * Evaluates one capture of the binding; `phase` names the capture so the receipt keeps
 * both the provisioning and the pre-admission observation.
 */
export function evaluateBinding(capture, { now, maxAgeSeconds = 600 }) {
  const { generation, api, worker, mode, routes, journal } = capture;
  if (!generation || generation.stop !== null || !generation.deployGeneration) {
    throw stop(`binding-deploy-generation-${generation?.stop ?? "missing"}`);
  }
  if (!capture.cluster?.context || !capture.cluster?.uid || !capture.namespace?.uid)
    throw stop("binding-cluster-unbound");
  if (!capture.release || capture.release.status !== "deployed" || !Number.isInteger(capture.release.revision)) {
    throw stop("binding-release-unbound");
  }
  if (!api.healthy || !worker.healthy) throw stop("binding-runtime-unhealthy");
  if (api.digest !== generation.deployment.imageDigest || worker.digest !== generation.deployment.imageDigest) {
    throw stop("binding-image-digest-mismatch");
  }
  if (mode?.stop) throw stop(`binding-mode-${mode.stop}`);
  if (mode?.mode !== "test") throw stop("binding-mode-not-test");
  if (mode.paymentProcessorKind !== "stripe") throw stop("binding-stripe-gateway-absent");
  const capturedAt = Date.parse(capture.capturedAt);
  if (
    !isInstant(capture.capturedAt) ||
    Date.parse(now) - capturedAt > maxAgeSeconds * 1000 ||
    capturedAt > Date.parse(now)
  ) {
    throw stop("binding-stale");
  }
  const podNames = api.pods.map((pod) => pod.name);
  if (
    routes.length !== podNames.length ||
    !routes.every((route) => podNames.includes(route.pod) && route.status === 200 && route.current === null)
  ) {
    throw stop(routes.some((route) => route.current) ? "window-already-open" : "binding-route-unreachable");
  }
  if (!journal?.connected) throw stop(`binding-journal-${journal?.failure ?? "unreachable"}`);
  if (journal.withheld !== "rejected") throw stop("binding-journal-withheld-credential-accepted");
  const mismatched = journal.probes.filter((probe) => probe.expected !== probe.observed);
  if (mismatched.length > 0 || journal.readWindow !== "ok") {
    throw stop(`binding-journal-authority-${mismatched[0]?.name ?? "read-window"}`);
  }
  return {
    phase: capture.phase,
    capturedAt: capture.capturedAt,
    cluster: capture.cluster,
    namespace: capture.namespace,
    release: capture.release,
    api: { revision: api.revision, digest: api.digest, pods: api.pods },
    worker: { revision: worker.revision, digest: worker.digest, pods: worker.pods },
    mode: {
      mode: mode.mode,
      paymentProcessorKind: mode.paymentProcessorKind,
      moneyMovementKind: mode.moneyMovementKind,
      observedAt: mode.observedAt,
    },
    deployGeneration: generation.deployGeneration,
    routes: routes.map(({ pod, status }) => ({ pod, status })),
    journal: {
      principal: journal.principal,
      probes: journal.probes,
      readWindow: journal.readWindow,
      withheld: journal.withheld,
    },
  };
}

/** The pre-admission capture must describe the same deployment as the provisioning capture. */
export function compareBindings(provisioning, preAdmission) {
  for (const key of BINDING_KEYS) {
    const left = key === "api" || key === "worker" ? { ...provisioning[key], pods: undefined } : provisioning[key];
    const right = key === "api" || key === "worker" ? { ...preAdmission[key], pods: undefined } : preAdmission[key];
    const normalize = (value) => (key === "mode" ? { ...value, observedAt: undefined } : value);
    if (JSON.stringify(normalize(left)) !== JSON.stringify(normalize(right))) throw stop(`binding-stale-${key}`);
  }
  return true;
}

// ---------------------------------------------------------------------------------
// Consumers

const fixtureId = (prefix) => new RegExp(`^${prefix}_[A-Za-z0-9]{6,64}$`);

/** The closed consumer registry: each entry is a reviewed repo command run in this job. */
export const consumerRegistry = Object.freeze({
  rehearsal: Object.freeze({
    // Sends nothing: it declares one existing Customer and its PaymentMethod and,
    // during the window, reads the window's journal rows with the step-local login.
    preflight(env) {
      const customer = String(env.STAGING_EVIDENCE_WINDOW_REHEARSAL_CUSTOMER ?? "");
      const paymentMethod = String(env.STAGING_EVIDENCE_WINDOW_REHEARSAL_PAYMENT_METHOD ?? "");
      if (!fixtureId("cus").test(customer) || !fixtureId("pm").test(paymentMethod)) {
        throw stop("rehearsal-fixtures-undeclared");
      }
      return [
        { kind: "customer", id: customer },
        { kind: "payment_method", id: paymentMethod, customer },
      ];
    },
  }),
});

export function consumerPreflights(consumers, env, registry = consumerRegistry) {
  return consumers.map((name) => {
    const consumer = registry[name];
    if (!consumer) throw stop("consumer-not-reviewed");
    return { consumer: name, fixtures: consumer.preflight(env) };
  });
}

/** The env one consumer step receives. Credentials appear here and nowhere else. */
export function consumerEnvironment({ window, journalUrl, fault, baseEnv = {} }) {
  const keep = ["PATH", "HOME", "TMPDIR", "RUNNER_TEMP", "PGSSLROOTCERT", "NODE_OPTIONS"];
  return {
    ...Object.fromEntries(keep.filter((key) => baseEnv[key] !== undefined).map((key) => [key, baseEnv[key]])),
    EVIDENCE_WINDOW_ID: window.windowId,
    EVIDENCE_WINDOW_VERSION: String(window.version),
    EVIDENCE_WINDOW_DEADLINE: window.deadline,
    EVIDENCE_WINDOW_STOP_AT: window.consumerStopAt,
    EVIDENCE_WINDOW_FAULT: fault,
    EVIDENCE_WINDOW_JOURNAL_DATABASE_URL: journalUrl,
  };
}

export function classifyConsumerExit({ code, signal, stoppedAtDeadline }) {
  if (stoppedAtDeadline) return "stopped-at-deadline";
  if (code === 0 && !signal) return "completed";
  return "failed";
}

// ---------------------------------------------------------------------------------
// Stripe attestation (read-only)

export function stripeKeyMode(key) {
  if (typeof key !== "string" || key.length < 16) return "missing";
  if (key.startsWith(STRIPE_KEY_MARKERS[0])) return "test";
  return "not-test";
}

export function webhookEndpointSnapshot(endpoint) {
  return {
    id: endpoint.id,
    status: endpoint.status,
    url: endpoint.url,
    created: endpoint.created,
    enabledEvents: [...(endpoint.enabled_events ?? [])].sort(),
  };
}

/** The sole enabled Payments endpoint on the bound origin, or a named refusal. */
export function selectPaymentsWebhookEndpoint(endpoints, { complete }) {
  if (!complete) throw stop("webhook-endpoint-inventory-incomplete");
  const matches = endpoints.filter(
    (endpoint) =>
      endpoint?.status === "enabled" && endpoint?.url === PAYMENTS_WEBHOOK_URL && endpoint?.livemode === false,
  );
  if (matches.length === 0) throw stop("webhook-endpoint-missing");
  if (matches.length > 1) throw stop("webhook-endpoint-ambiguous");
  return webhookEndpointSnapshot(matches[0]);
}

export function assertEndpointUnchanged(before, atAdmission) {
  for (const key of ["id", "status", "enabledEvents"]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(atAdmission[key])) throw stop("webhook-endpoint-changed");
  }
}

export function attestFixtures(declared, retrieved) {
  return declared.map((fixture) => {
    const object = retrieved.get(fixture.id);
    if (!object || object.id !== fixture.id || object.deleted === true) throw stop("fixture-missing");
    if (object.livemode !== false) throw stop("fixture-not-test-mode");
    if (object.object !== fixture.kind) throw stop("fixture-kind-mismatch");
    if (fixture.kind === "payment_method" && object.customer !== fixture.customer) throw stop("fixture-owner-mismatch");
    return { kind: fixture.kind, id: fixture.id, livemode: false };
  });
}

/** Ingestion records from one pod's log text; only the published fields are kept. */
export function parseIngestionRecords(logText) {
  const records = [];
  for (const line of String(logText ?? "").split("\n")) {
    if (!line.includes('"provider.webhook.ingestion"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "provider.webhook.ingestion" || entry.endpoint !== "payments") continue;
    records.push({
      providerEventId: typeof entry.provider_event_id === "string" ? entry.provider_event_id : null,
      failureClass: typeof entry.failure_class === "string" ? entry.failure_class : "unknown",
      statusCode: Number.isInteger(entry.status_code) ? entry.status_code : null,
    });
  }
  return records;
}

/**
 * Finds one test-mode event of the bound account, of a subscribed type, created after
 * the endpoint and after the restart, whose ingestion record a bound api pod wrote with
 * `failure_class=none` and status 200. Delivery counters are never read.
 */
export function attestWebhookDelivery({ account, endpoint, events, recordsByPod, boundPods, restartedAt }) {
  const subscribed = (type) => endpoint.enabledEvents.includes("*") || endpoint.enabledEvents.includes(type);
  const restartSeconds = Math.floor(Date.parse(restartedAt) / 1000);
  const candidates = events
    .filter(
      (event) =>
        event?.livemode === false &&
        (event.account === undefined || event.account === null || event.account === account) &&
        subscribed(event.type) &&
        Number.isInteger(event.created) &&
        event.created > endpoint.created &&
        event.created >= restartSeconds,
    )
    .sort((left, right) => right.created - left.created);
  const bound = new Set(boundPods);
  for (const event of candidates) {
    for (const [pod, records] of recordsByPod) {
      if (!bound.has(pod)) continue;
      const accepted = records.find(
        (record) => record.providerEventId === event.id && record.failureClass === "none" && record.statusCode === 200,
      );
      if (accepted) return { eventId: event.id, eventType: event.type, eventCreated: event.created, pod };
    }
  }
  throw stop("webhook-ingestion-unproven");
}

// ---------------------------------------------------------------------------------
// Window lifecycle

export function validateOpenResponse(response, identity) {
  if (
    !isRecord(response) ||
    response.windowId !== identity.windowId ||
    response.state !== "open" ||
    response.version !== WINDOW_VERSION ||
    !isInstant(response.openedAt) ||
    !isInstant(response.expiresAt) ||
    Date.parse(response.expiresAt) - Date.parse(response.openedAt) !== RETENTION_SECONDS * 1000
  ) {
    throw stop("window-open-response-invalid");
  }
  return {
    windowId: response.windowId,
    version: response.version,
    openedAt: response.openedAt,
    ...windowSchedule(response.expiresAt),
  };
}

/** Timed by when the close response was observed; the clamped `closed_at` never decides. */
export function classifyClose({ observedAt, schedule }) {
  const observed = Date.parse(observedAt);
  if (observed > Date.parse(schedule.deadline)) return "deadline-failed";
  if (observed > Date.parse(schedule.closeBy)) return "close-target-missed";
  return "closed-on-time";
}

export function validateCloseResponse(response, identity) {
  return (
    isRecord(response) &&
    response.windowId === identity.windowId &&
    response.state === "closed" &&
    response.version === WINDOW_VERSION + 1 &&
    isInstant(response.closedAt)
  );
}

export function observerDecision({ runStatus, now, annotation }) {
  if (runStatus === "completed") return "takeover";
  if (annotation?.deadline && Date.parse(now) >= Date.parse(annotation.deadline) - CLOSE_LEAD_SECONDS * 1000) {
    return "takeover";
  }
  return "wait";
}

const DISPLACED = "evidence-window-displaced";

/**
 * Classifies, from the listing alone, a job that never reached a runner (no runner, no
 * steps, so no log). The shared deploy group cancels a pending window job, whatever joined
 * it, so a cancelled window is displaced; a skipped sibling is not-started. Every other job
 * is left to its log. started_at is never read: GitHub sets it on jobs that never ran.
 */
export function classifyUnstartedJob(job) {
  const noRunner = (job.runner_id === null || job.runner_id === 0) && !job.runner_name;
  if (job.status !== "completed" || !noRunner || job.steps.length !== 0) return null;
  if (job.name === WINDOW_JOB_NAME) return job.conclusion === "cancelled" ? DISPLACED : null;
  return job.conclusion === "skipped" ? "not-started" : null;
}

const isListedJob = (job, identity) =>
  isRecord(job) &&
  Number.isSafeInteger(job.id) &&
  job.id > 0 &&
  String(job.run_id) === identity.runId &&
  job.run_attempt === identity.attempt &&
  typeof job.name === "string" &&
  typeof job.status === "string" &&
  (job.conclusion === null || typeof job.conclusion === "string") &&
  (job.runner_id === null || Number.isSafeInteger(job.runner_id)) &&
  (job.runner_name === null || typeof job.runner_name === "string") &&
  Array.isArray(job.steps);

/**
 * Groups residue by the run identity its names encode. Malformed identity fails closed;
 * a still-running run's residue is skipped, which still refuses admission.
 */
export function planResidue({ secretState, principals, malformedPrincipals, ownRun }) {
  if (secretState.annotationPresent && !secretState.annotation) throw stop("residue-identity-malformed");
  if (malformedPrincipals > 0) throw stop("residue-identity-malformed");
  if (secretState.admissionSecret && !secretState.annotation) throw stop("residue-identity-malformed");
  if (secretState.admissionSecret && secretState.keyManagers.join(",") !== FIELD_MANAGER) {
    throw stop("admission-key-ownership-conflict");
  }
  const runs = new Map();
  const add = (runId, attempt, part) => {
    const key = `${runId}/${attempt}`;
    const entry = runs.get(key) ?? { runId, attempt, annotation: false, key: false, principal: false };
    entry[part] = true;
    runs.set(key, entry);
  };
  if (secretState.annotation) {
    add(secretState.annotation.runId, secretState.annotation.attempt, "annotation");
    if (secretState.admissionSecret) add(secretState.annotation.runId, secretState.annotation.attempt, "key");
  }
  for (const principal of principals) add(principal.runId, principal.attempt, "principal");
  for (const entry of runs.values()) {
    if (entry.runId === ownRun.runId && entry.attempt === ownRun.attempt) throw stop("residue-identity-malformed");
  }
  return [...runs.values()].sort((a, b) => a.runId.localeCompare(b.runId, "en") || a.attempt - b.attempt);
}

export const CLEANUP_PARTS = Object.freeze([
  "window-closed",
  "key-removed",
  "runtimes-restarted",
  "old-secret-rejected",
  "sessions-ended",
  "principal-dropped",
  "annotation-released",
]);

/** Expiry, `always()` or a sweep never count: only every part proven is success. */
export function cleanupVerdict(parts) {
  const values = CLEANUP_PARTS.map((part) => parts[part] ?? "unknown");
  if (values.every((value) => value === "proven" || value === "not-needed")) return "proven";
  if (values.includes("failed")) return "failed";
  return "unknown";
}

/**
 * One revocation record. A revocation that finishes after its 30-minute budget is late,
 * which fails it even when every part is otherwise proven.
 */
export function cleanupRecord({ parts, by, budget, expiredCredential, completedAt }) {
  const partsVerdict = cleanupVerdict(parts);
  const withinBudget = budget === null || Date.parse(completedAt) <= Date.parse(budget);
  return {
    parts,
    by,
    expiredCredential,
    revocationDeadline: budget,
    completedAt,
    withinBudget,
    verdict: partsVerdict === "proven" && !withinBudget ? "late" : partsVerdict,
  };
}

export function revocationDeadline({ runEndedAt = null, deadline = null }) {
  const anchors = [runEndedAt, deadline].filter(isInstant).map(Date.parse);
  return anchors.length === 0 ? null : iso(Math.min(...anchors) + REVOCATION_BUDGET_SECONDS * 1000);
}

// ---------------------------------------------------------------------------------
// Receipt

export function buildReceipt(state) {
  const cleanup = state.cleanup?.parts ? state.cleanup : null;
  const consumers = state.consumers ?? {};
  const firstStop = state.stops?.[0] ?? null;
  const outcome =
    firstStop !== null
      ? "refused"
      : !state.window
        ? "not-opened"
        : Object.values(consumers).some((result) => result.outcome !== "completed")
          ? "consumer-failed"
          : state.close?.classification !== "closed-on-time"
            ? (state.close?.classification ?? "close-unproven")
            : cleanup?.verdict === "proven"
              ? "succeeded"
              : `cleanup-${cleanup?.verdict ?? "unknown"}`;
  return {
    schemaVersion: RECEIPT_SCHEMA,
    identity: state.identity,
    inputs: state.inputs,
    jobStartedAt: state.jobStartedAt ?? null,
    stops: state.stops ?? [],
    residue: state.residue ?? null,
    bindings: state.bindings ?? [],
    attestation: state.attestation ?? null,
    observer: state.observer ?? null,
    window: state.window ?? null,
    consumers,
    close: state.close ?? null,
    cleanup,
    providerEvidence: "none",
    outcome,
  };
}

export function assertValueFree(text, values) {
  const markers = credentialMarkersIn(text);
  if (markers.length > 0) throw stop("credential-marker-leaked");
  for (const value of values) {
    if (typeof value === "string" && value.length >= 8 && String(text).includes(value)) throw stop("credential-leaked");
  }
  return true;
}

// ---------------------------------------------------------------------------------
// I/O adapters. Each returns facts or throws a bounded stop; raw output, stderr and
// exception text never reach a log, a receipt or an error.

export function createKubectl({ spawnImpl = spawn, kubectlPath = "kubectl" } = {}) {
  const run = (args, { input = null, timeoutMs = 60_000, limitBytes = INGESTION_LOG_LIMIT_BYTES } = {}) =>
    new Promise((resolve) => {
      const child = spawnImpl(kubectlPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const chunks = [];
      let size = 0;
      let truncated = false;
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (chunk) => {
        if (size + chunk.length > limitBytes) truncated = true;
        else chunks.push(chunk);
        size += chunk.length;
      });
      child.stderr.on("data", () => undefined);
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ code: -1, stdout: "", truncated });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout: Buffer.concat(chunks).toString("utf8"), truncated });
      });
      child.stdin.end(input ?? undefined);
    });
  const json = async (args, failure) => {
    const result = await run([...args, "--output", "json"]);
    if (result.code !== 0) throw stop(failure);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw stop(failure);
    }
  };
  return { run, json };
}

const componentSelector = (component) =>
  `app.kubernetes.io/instance=${HELM_RELEASE},app.kubernetes.io/name=chase-sets-platform,app.kubernetes.io/component=${component}`;

export function createRuntime({ kubectl, namespace = NAMESPACE, clock = () => Date.now(), sleep = defaultSleep }) {
  const getSecret = async () => {
    const result = await kubectl.run([
      "get",
      "secret",
      RUNTIME_SECRET_NAME,
      "--namespace",
      namespace,
      "--show-managed-fields",
      "--output",
      "json",
    ]);
    if (result.code !== 0) throw stop("runtime-secret-unreadable");
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw stop("runtime-secret-unreadable");
    }
  };
  const apply = async (manifest) => {
    const result = await kubectl.run(
      ["apply", "--server-side", `--field-manager=${FIELD_MANAGER}`, "--namespace", namespace, "-f", "-"],
      { input: JSON.stringify(manifest) },
    );
    if (result.code !== 0) throw stop("admission-key-apply-refused");
  };
  const pods = async (component) =>
    kubectl.json(
      ["get", "pods", "--namespace", namespace, "--selector", componentSelector(component)],
      "runtime-pods-unreadable",
    );
  const workload = async (component) => {
    for (const kind of ["rollouts.argoproj.io", "deployment"]) {
      const result = await kubectl.run([
        "get",
        kind,
        "--namespace",
        namespace,
        "--selector",
        componentSelector(component),
        "--output",
        "name",
      ]);
      const names = result.code === 0 ? result.stdout.split("\n").filter(Boolean) : [];
      if (names.length === 1) return { kind, name: names[0] };
      if (names.length > 1) throw stop("runtime-workload-ambiguous");
    }
    throw stop("runtime-workload-missing");
  };
  // Pods created at or after `restartedAt` loaded the Secret as it stood when the restart began.
  const restart = async (components) => {
    await sleep(1100);
    const restartedAt = iso(clock());
    for (const component of components) {
      const { kind, name } = await workload(component);
      const patch =
        kind === "deployment"
          ? { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": restartedAt } } } } }
          : { spec: { restartAt: restartedAt } };
      const result = await kubectl.run([
        "patch",
        name,
        "--namespace",
        namespace,
        "--type",
        "merge",
        "--patch",
        JSON.stringify(patch),
      ]);
      if (result.code !== 0) throw stop("runtime-restart-refused");
    }
    const until = clock() + RESTART_WAIT_SECONDS * 1000;
    let summaries = [];
    while (clock() < until) {
      summaries = [];
      for (const component of components)
        summaries.push(summarizeComponentPods(component, await pods(component), { restartedAt }));
      if (summaries.every((summary) => summary.healthy)) return { restartedAt, summaries };
      await sleep(10_000);
    }
    throw stop("runtime-restart-unproven");
  };
  const cluster = async () => {
    const context = await kubectl.run(["config", "current-context"]);
    const system = await kubectl.json(["get", "namespace", "kube-system"], "binding-cluster-unbound");
    const own = await kubectl.json(["get", "namespace", namespace], "binding-cluster-unbound");
    return {
      cluster: { context: context.code === 0 ? context.stdout.trim() : null, uid: system?.metadata?.uid ?? null },
      namespace: { name: namespace, uid: own?.metadata?.uid ?? null },
    };
  };
  const release = async () => {
    const list = await kubectl.json(
      ["get", "secrets", "--namespace", namespace, "--selector", `owner=helm,name=${HELM_RELEASE},status=deployed`],
      "binding-release-unbound",
    );
    const items = list?.items ?? [];
    if (items.length !== 1) return null;
    return {
      name: HELM_RELEASE,
      revision: Number(items[0].metadata?.labels?.version),
      status: items[0].metadata?.labels?.status,
    };
  };
  const podLogs = async (pod, since) => {
    const result = await kubectl.run(
      [
        "logs",
        `pod/${pod}`,
        "--namespace",
        namespace,
        "--container",
        API_COMPONENT,
        `--since-time=${since}`,
        `--limit-bytes=${INGESTION_LOG_LIMIT_BYTES}`,
      ],
      { timeoutMs: 120_000 },
    );
    return result.code === 0 ? result.stdout : "";
  };
  return { getSecret, apply, pods, restart, cluster, release, podLogs, workload, kubectl, namespace };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForTcp(port, until, sleep) {
  while (Date.now() < until) {
    const open = await new Promise((resolve) => {
      const socket = connectTcp(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return true;
    await sleep(500);
  }
  return false;
}

/** Calls one api pod through a pod-scoped port-forward, closing it afterwards. */
export function createApiPodClient({
  spawnImpl = spawn,
  kubectlPath = "kubectl",
  namespace = NAMESPACE,
  sleep = defaultSleep,
  fetchImpl = fetch,
}) {
  return async (pod, request) => {
    const port = await freePort();
    const child = spawnImpl(
      kubectlPath,
      ["port-forward", "--namespace", namespace, `pod/${pod.name}`, `${port}:${pod.port}`],
      {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      },
    );
    try {
      if (!(await waitForTcp(port, Date.now() + 20_000, sleep))) return { status: null, body: null };
      try {
        const response = await fetchImpl(`http://127.0.0.1:${port}${request.path}`, {
          method: request.method ?? "GET",
          headers: request.headers ?? {},
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          signal: AbortSignal.timeout(20_000),
        });
        const text = (await response.text()).slice(0, 65_536);
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        return { status: response.status, body, observedAt: new Date().toISOString() };
      } catch {
        return { status: null, body: null };
      }
    } finally {
      child.kill("SIGTERM");
    }
  };
}

export function apiPodTargets(podList) {
  return (podList?.items ?? [])
    .filter((pod) => !pod?.metadata?.deletionTimestamp)
    .map((pod) => {
      const container = (pod.spec?.containers ?? []).find((entry) => entry.name === API_COMPONENT);
      const port = (container?.ports ?? []).find((entry) => entry.name === API_PORT_NAME)?.containerPort;
      return { name: pod.metadata?.name, port };
    })
    .filter((pod) => typeof pod.name === "string" && Number.isInteger(pod.port))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}

export function createStripeReader({ key, fetchImpl = fetch, base = "https://api.stripe.com" }) {
  // GET is the only method this reader can issue.
  const get = async (path, query = {}) => {
    const url = new URL(path, base);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw stop("stripe-unavailable");
    }
    if (response.status === 404) return null;
    if (response.status !== 200) throw stop("stripe-read-refused");
    try {
      return await response.json();
    } catch {
      throw stop("stripe-read-refused");
    }
  };
  const list = async (path, query, maxPages = 5) => {
    const items = [];
    let startingAfter = null;
    for (let page = 0; page < maxPages; page++) {
      const body = await get(path, {
        limit: 100,
        ...query,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      if (!body || !Array.isArray(body.data)) throw stop("stripe-read-refused");
      items.push(...body.data);
      if (!body.has_more) return { items, complete: true };
      startingAfter = body.data.at(-1)?.id;
      if (!startingAfter) break;
    }
    return { items, complete: false };
  };
  return { get, list };
}

export function createGitHub({ token, repository, fetchImpl = fetch }) {
  const request = async (path, { method = "GET", body = null, accept = "application/vnd.github+json" } = {}) => {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
        method,
        headers: {
          accept,
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw stop("github-unavailable");
    }
    return response;
  };
  const json = async (path, failure) => {
    const response = await request(path);
    if (response.status !== 200) throw stop(failure);
    return response.json();
  };
  return {
    runAttempt: (runId, attempt) => json(`/actions/runs/${runId}/attempts/${attempt}`, "github-run-unreadable"),
    attemptJobs: (runId, attempt) =>
      json(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, "github-jobs-unreadable"),
    jobLog: async (jobId) => {
      const response = await request(`/actions/jobs/${jobId}/logs`, { accept: "application/vnd.github+json" });
      if (response.status !== 200) throw stop("github-log-unreadable");
      return (await response.text()).slice(0, 64 * 1024 * 1024);
    },
    dispatchObserver: async (ref, inputs) => {
      const response = await request(`/actions/workflows/${OBSERVER_WORKFLOW_FILE}/dispatches`, {
        method: "POST",
        body: { ref, inputs },
      });
      if (response.status !== 204 && response.status !== 200) throw stop("observer-dispatch-refused");
    },
    observerRuns: (createdFrom) =>
      json(
        `/actions/workflows/${OBSERVER_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=50&created=${encodeURIComponent(`>=${createdFrom}`)}`,
        "observer-runs-unreadable",
      ),
  };
}

export function observerRunName(identity) {
  return `Evidence window cleanup ${identity.runId} attempt ${identity.attempt}`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------
// Composite operations shared by the job and the observer

async function withPgClient(connectionString, operation) {
  const client = new pg.Client({ ...postgresClientConfig(connectionString), connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
  } catch (error) {
    throw stop(
      error?.code === "28P01" || error?.code === "28000"
        ? "journal-credential-rejected"
        : "control-database-unreachable",
    );
  }
  try {
    return await operation(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function loginOutcome(connectionString) {
  try {
    await withPgClient(connectionString, async () => undefined);
    return "accepted";
  } catch (error) {
    return error?.code === "journal-credential-rejected" ? "rejected" : "unknown";
  }
}

/**
 * The control-database operations the window needs, behind one seam: the owner's
 * connection provisions, inspects and revokes the run-named login; the login's own
 * connection proves what it can and cannot do.
 */
export function createJournalAuthority(controlUrl, { sleep = defaultSleep, clock = () => Date.now() } = {}) {
  const owner = (operation) => {
    if (!controlUrl) throw stop("control-database-unavailable");
    return withPgClient(controlUrl, operation);
  };
  const loginUrl = (principalName, password) => journalConnectionString(controlUrl, principalName, password);
  return {
    listPrincipals: () => owner((client) => listEvidenceWindowJournalPrincipals(client)),
    byId: (windowId) => owner((client) => createPostgresEvidenceWindowById(client)(windowId)),
    provision: (principal, password, validUntil) =>
      owner(async (client) => {
        for (const statement of evidenceWindowJournalPrincipalProvisionStatements({
          principal,
          database: controlDatabaseName(controlUrl),
          verifier: scramSha256Verifier(password),
          validUntil,
        })) {
          try {
            await client.query(statement);
          } catch {
            throw stop(statement.startsWith("CREATE ROLE") ? "principal-create-refused" : "principal-grant-refused");
          }
        }
      }),
    capture: async ({ principalName, password, windowId }) => {
      const url = loginUrl(principalName, password);
      const withheld = await loginOutcome(loginUrl(principalName, `${password.slice(0, 6)}withheld`));
      try {
        return await withPgClient(url, async (client) => {
          const probes = await runEvidenceWindowJournalProbes(client, windowId);
          const pool = new pg.Pool({ ...postgresClientConfig(url), max: 1 });
          let readWindow = "failed";
          try {
            await createPostgresEvidenceWindowProviderWrite(pool).readWindow(windowId);
            readWindow = "ok";
          } catch {
            readWindow = "failed";
          } finally {
            await pool.end().catch(() => undefined);
          }
          return { connected: true, principal: principalName, probes, readWindow, withheld };
        });
      } catch (error) {
        return { connected: false, failure: error?.code ?? "unreachable", withheld };
      }
    },
    // Expires the login, proves the expired credential is refused, then ends its sessions.
    endSessions: (principal, password) =>
      owner(async (client) => {
        if (!(await evidenceWindowJournalPrincipalExists(client, principal))) {
          return { state: "not-needed", expiredCredential: "not-needed" };
        }
        await client.query(evidenceWindowJournalPrincipalExpireStatement(principal));
        const expiredCredential = password ? await loginOutcome(loginUrl(principal.name, password)) : "not-checked";
        if (expiredCredential === "accepted" || expiredCredential === "unknown")
          return { state: "failed", expiredCredential };
        const until = clock() + 60_000;
        while (clock() < until) {
          await terminateEvidenceWindowJournalSessions(client, principal).catch(() => undefined);
          if ((await countEvidenceWindowJournalSessions(client, principal)) === 0)
            return { state: "proven", expiredCredential };
          await sleep(2_000);
        }
        return { state: "failed", expiredCredential };
      }),
    drop: (principal) =>
      owner(async (client) => {
        if (!(await evidenceWindowJournalPrincipalExists(client, principal))) return "not-needed";
        if ((await countEvidenceWindowJournalSessions(client, principal)) > 0) return "failed";
        for (const statement of evidenceWindowJournalPrincipalDropStatements(
          principal,
          controlDatabaseName(controlUrl),
        )) {
          await client.query(statement);
        }
        return (await evidenceWindowJournalPrincipalExists(client, principal)) ? "failed" : "proven";
      }),
  };
}

export async function captureBinding({
  phase,
  runtime,
  apiClient,
  admissionSecret,
  generation,
  journal: journalAuthority,
  journalInput,
  now = () => new Date().toISOString(),
  modeObserver = observeProviderMode,
}) {
  const { cluster, namespace } = await runtime.cluster();
  const release = await runtime.release();
  const apiPods = await runtime.pods(API_COMPONENT);
  const api = summarizeComponentPods(API_COMPONENT, apiPods);
  const worker = summarizeComponentPods(WORKER_COMPONENT, await runtime.pods(WORKER_COMPONENT));
  const routes = [];
  for (const pod of apiPodTargets(apiPods)) {
    const response = await apiClient(pod, {
      path: "/internal/evidence-windows/current",
      headers: { [EVIDENCE_WINDOW_ADMISSION_HEADER]: admissionSecret },
    });
    routes.push({
      pod: pod.name,
      status: response.status,
      current: isRecord(response.body) ? (response.body.current ?? null) : null,
    });
  }
  const mode = await modeObserver({ timeoutMs: 20_000 });
  const journal = await journalAuthority.capture(journalInput);
  return { phase, capturedAt: now(), cluster, namespace, release, api, worker, routes, mode, journal, generation };
}

/** Closes one window through the shipped route, retrying every 30 s until proven or `until`. */
export async function closeWindow({
  identity,
  schedule,
  admissionSecret,
  apiClient,
  apiTargets,
  byId,
  until,
  sleep = defaultSleep,
  clock = () => Date.now(),
}) {
  while (true) {
    const targets = await apiTargets();
    for (const pod of targets) {
      const response = await apiClient(pod, {
        method: "POST",
        path: `/internal/evidence-windows/${identity.windowId}/close`,
        headers: { [EVIDENCE_WINDOW_ADMISSION_HEADER]: admissionSecret, "content-type": "application/json" },
        body: { expectedVersion: identity.version },
      });
      if (response.status === 200 && validateCloseResponse(response.body, identity)) {
        const recorded = await byId(identity.windowId);
        if (recorded?.state !== "closed") break;
        // `current` is only a consistency check: it must be empty after the close.
        const current = await apiClient(pod, {
          path: "/internal/evidence-windows/current",
          headers: { [EVIDENCE_WINDOW_ADMISSION_HEADER]: admissionSecret },
        });
        if (current.status !== 200 || !isRecord(current.body) || current.body.current !== null) break;
        return {
          state: "proven",
          observedAt: response.observedAt,
          classification: schedule ? classifyClose({ observedAt: response.observedAt, schedule }) : "recovered",
        };
      }
      break;
    }
    if (clock() >= Date.parse(until)) return { state: "failed", classification: "close-unproven" };
    await sleep(POLL_SECONDS * 1000);
  }
}

/** Every revocation part runs even when an earlier part failed; each reports its own state. */
export async function revokeWindow({ identity, runtime, apiClient, journal, closeProven }) {
  const parts = {};
  const attempt = async (part, operation) => {
    try {
      parts[part] = await operation();
    } catch {
      parts[part] = "failed";
    }
  };
  let secretState = null;
  try {
    secretState = readWindowSecretState(await runtime.getSecret());
  } catch {
    secretState = null;
  }
  const owned = Boolean(
    secretState?.annotation &&
    secretState.annotation.runId === identity.runId &&
    secretState.annotation.attempt === identity.attempt,
  );
  const admissionSecret = owned ? secretState.admissionSecret : null;
  const principal = evidenceWindowJournalPrincipal(identity.runId, identity.attempt);
  // A 404 from every api pod means no admission route is mounted: no key, old or new, is loaded.
  const routesUnmounted = async () => {
    const targets = apiPodTargets(await runtime.pods(API_COMPONENT));
    if (targets.length === 0) return false;
    for (const pod of targets) {
      const response = await apiClient(pod, {
        path: "/internal/evidence-windows/current",
        headers: { [EVIDENCE_WINDOW_ADMISSION_HEADER]: admissionSecret ?? "revocation-probe" },
      });
      if (response.status !== 404) return false;
    }
    return true;
  };

  await attempt("key-removed", async () => {
    if (!secretState) return "unknown";
    if (secretState.annotationPresent && !owned) return "failed";
    if (!secretState.admissionSecret) return "not-needed";
    await runtime.apply(
      windowSecretManifest({
        namespace: runtime.namespace,
        annotation: windowAnnotation(identity, { ...pick(secretState.annotation), phase: "key-removed" }),
      }),
    );
    return readWindowSecretState(await runtime.getSecret()).admissionSecret === null ? "proven" : "failed";
  });
  let restartedAt = null;
  await attempt("runtimes-restarted", async () => {
    if (parts["key-removed"] === "failed" || parts["key-removed"] === "unknown") return "unknown";
    // A key removed now, or a removal recorded earlier without its release, needs a restart;
    // so does any api pod that still answers the admission route.
    const removalPending = parts["key-removed"] === "proven" || secretState?.annotation?.phase === "key-removed";
    if (!removalPending && (await routesUnmounted())) return "not-needed";
    restartedAt = (await runtime.restart([API_COMPONENT, WORKER_COMPONENT])).restartedAt;
    return "proven";
  });
  await attempt("old-secret-rejected", async () => {
    if (parts["runtimes-restarted"] === "unknown" || parts["runtimes-restarted"] === "failed") return "unknown";
    return (await routesUnmounted()) ? "proven" : "failed";
  });
  let expiredCredential = "unknown";
  await attempt("sessions-ended", async () => {
    const ended = await journal.endSessions(
      principal,
      admissionSecret ? deriveJournalPassword(admissionSecret, principal.name) : null,
    );
    expiredCredential = ended.expiredCredential;
    return ended.state;
  });
  await attempt("principal-dropped", async () => {
    const dropped = await journal.drop(principal);
    return dropped === "not-needed" && parts["sessions-ended"] !== "not-needed" ? "proven" : dropped;
  });
  await attempt("annotation-released", async () => {
    const released = [
      "key-removed",
      "runtimes-restarted",
      "old-secret-rejected",
      "sessions-ended",
      "principal-dropped",
    ].every((part) => parts[part] === "proven" || parts[part] === "not-needed");
    if (!released || !closeProven) return "unknown";
    const current = readWindowSecretState(await runtime.getSecret());
    if (!current.annotationPresent) return "proven";
    if (current.annotation?.runId !== identity.runId || current.annotation?.attempt !== identity.attempt)
      return "failed";
    await runtime.apply(windowSecretManifest({ namespace: runtime.namespace }));
    return readWindowSecretState(await runtime.getSecret()).annotationPresent ? "failed" : "proven";
  });
  return { parts, restartedAt, expiredCredential };
}

const pick = (annotation) =>
  annotation
    ? { deadline: annotation.deadline, deadlineKind: annotation.deadlineKind }
    : { deadline: null, deadlineKind: "unset" };

// ---------------------------------------------------------------------------------
// Commands

function statePath(env) {
  return join(env.RUNNER_TEMP ?? ".", "staging-evidence-window", "state.json");
}

export function readState(env) {
  const path = statePath(env);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function writeState(env, state, secrets = []) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  assertValueFree(text, secrets);
  mkdirSync(join(env.RUNNER_TEMP ?? ".", "staging-evidence-window"), { recursive: true });
  writeFileSync(statePath(env), text);
}

const mask = (value, log) => {
  if (value) log(`::add-mask::${value}`);
};

function context(env, deps = {}) {
  const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
  const kubectl = deps.kubectl ?? createKubectl();
  const runtime =
    deps.runtime ?? createRuntime({ kubectl, namespace: env.CHASE_SETS_KUBERNETES_NAMESPACE ?? NAMESPACE });
  const apiClient = deps.apiClient ?? createApiPodClient({ namespace: runtime.namespace });
  const github =
    deps.github ??
    (env.GITHUB_TOKEN ? createGitHub({ token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY }) : null);
  const controlUrl = env.PLATFORM_CONTROL_DATABASE_URL ?? null;
  const sleep = deps.sleep ?? defaultSleep;
  const clock = deps.clock ?? (() => Date.now());
  const journal = deps.journal ?? createJournalAuthority(controlUrl, { sleep, clock });
  return {
    ...deps,
    log,
    runtime,
    apiClient,
    github,
    controlUrl,
    journal,
    byId: (windowId) => journal.byId(windowId),
    stripeReader: deps.stripeReader ?? ((key) => createStripeReader({ key })),
    sleep,
    clock,
  };
}

async function readAdmission(ctx, identity) {
  const secretState = readWindowSecretState(await ctx.runtime.getSecret());
  const owned =
    secretState.annotation?.runId === identity.runId && secretState.annotation?.attempt === identity.attempt;
  if (!owned || !secretState.admissionSecret) throw stop("admission-key-absent");
  mask(secretState.admissionSecret, ctx.log);
  return { secretState, admissionSecret: secretState.admissionSecret };
}

const apiTargetsOf = (ctx) => async () => apiPodTargets(await ctx.runtime.pods(API_COMPONENT));

export const commands = {
  async inputs(env, ctx) {
    const identity = runIdentityFromEnv(env);
    const inputs = parseInputs(env);
    const state = { schemaVersion: RECEIPT_SCHEMA, identity, inputs, jobStartedAt: iso(ctx.clock()), stops: [] };
    writeState(env, state);
    ctx.log(
      `Evidence window ${identity.windowId} version ${identity.version} for run ${identity.runId} attempt ${identity.attempt}.`,
    );
    return state;
  },

  async preflight(env, ctx, state) {
    const secretState = readWindowSecretState(await ctx.runtime.getSecret());
    const { principals, malformed } = await ctx.journal.listPrincipals();
    const residue = planResidue({ secretState, principals, malformedPrincipals: malformed, ownRun: state.identity });
    state.residue = [];
    for (const entry of residue) {
      const run = await ctx.github.runAttempt(entry.runId, entry.attempt);
      if (run?.status !== "completed") {
        state.residue.push({ ...entry, owner: "running", cleanup: "skipped" });
        continue;
      }
      const identity = windowIdentity({
        repository: state.identity.repository,
        runId: entry.runId,
        attempt: entry.attempt,
      });
      const recorded = await ctx.byId(identity.windowId);
      let windowClosed = recorded === null || recorded.state === "closed" ? "proven" : "pending";
      if (windowClosed === "pending" && entry.key) {
        const closed = await closeWindow({
          identity,
          schedule: null,
          admissionSecret: secretState.admissionSecret,
          apiClient: ctx.apiClient,
          apiTargets: apiTargetsOf(ctx),
          byId: ctx.byId,
          until: iso(ctx.clock()),
          sleep: ctx.sleep,
          clock: ctx.clock,
        });
        windowClosed = closed.state;
      }
      const { parts } = await revokeWindow({
        identity,
        runtime: ctx.runtime,
        apiClient: ctx.apiClient,
        journal: ctx.journal,
        closeProven: windowClosed === "proven",
      });
      // An open prior window, closable now or not, is retried with this run's key after install.
      parts["window-closed"] = windowClosed === "proven" ? "proven" : "unknown";
      state.residue.push({
        ...entry,
        owner: "completed",
        windowId: identity.windowId,
        cleanup: cleanupVerdict(parts),
        parts,
      });
    }
    const pendingWindows = state.residue.filter((entry) => entry.parts?.["window-closed"] === "unknown");
    state.pendingPriorWindows = pendingWindows.map((entry) => entry.windowId);
    if (state.residue.some((entry) => entry.owner === "running")) throw stop("prior-cleanup-unproven");
    // A prior window left open without its key closes with this run's key after install.
    const blocking = state.residue.filter((entry) => {
      const parts = { ...entry.parts, "window-closed": "proven", "annotation-released": "proven" };
      return cleanupVerdict(parts) !== "proven";
    });
    if (blocking.length > 0) throw stop("prior-cleanup-unproven");
    const generation = await (ctx.selectGeneration ?? selectStagingDeployGeneration)({
      token: env.GITHUB_TOKEN,
      requestTimeoutMs: 20_000,
      now: iso(ctx.clock()),
      maxAgeSeconds: 604_800,
    });
    if (generation.stop) throw stop(`binding-deploy-generation-${generation.stop}`);
    state.generation = generation;
    return state;
  },

  async provision(env, ctx, state) {
    const stripe = ctx.stripeReader(env.STRIPE_SECRET_KEY);
    if (stripeKeyMode(env.STRIPE_SECRET_KEY) !== "test") throw stop("stripe-key-not-test");
    const endpoints = await stripe.list("/v1/webhook_endpoints", {});
    state.endpointBeforeRestart = selectPaymentsWebhookEndpoint(endpoints.items, endpoints);

    // The observer is armed before any credential exists: a force cancel or a lost runner
    // skips every always() step, and from here on the observer still owns the cleanup.
    const dispatchedAt = iso(ctx.clock() - 5_000);
    await ctx.github.dispatchObserver(env.GITHUB_REF_NAME, {
      run_id: state.identity.runId,
      run_attempt: String(state.identity.attempt),
    });
    state.observer = await confirmObserver(ctx, state.identity, dispatchedAt);

    const admissionSecret = (ctx.generateSecret ?? generateAdmissionSecret)();
    mask(admissionSecret, ctx.log);
    await ctx.runtime.apply(
      windowSecretManifest({
        namespace: ctx.runtime.namespace,
        admissionSecret,
        annotation: windowAnnotation(state.identity),
      }),
    );
    const installed = readWindowSecretState(await ctx.runtime.getSecret());
    if (
      installed.admissionSecret === null ||
      !timingSafeEqual(Buffer.from(digest(installed.admissionSecret)), Buffer.from(digest(admissionSecret))) ||
      installed.keyManagers.join(",") !== FIELD_MANAGER ||
      installed.annotation?.windowId !== state.identity.windowId
    ) {
      throw stop("admission-key-ownership-unproven");
    }
    state.keyInstalledAt = installed.appliedAt;
    const restarted = await ctx.runtime.restart([API_COMPONENT, WORKER_COMPONENT]);
    state.restartedAt = restarted.restartedAt;

    for (const windowId of state.pendingPriorWindows ?? []) {
      const closed = await closeWindow({
        identity: { windowId, version: WINDOW_VERSION },
        schedule: null,
        admissionSecret,
        apiClient: ctx.apiClient,
        apiTargets: apiTargetsOf(ctx),
        byId: ctx.byId,
        until: iso(ctx.clock() + 120_000),
        sleep: ctx.sleep,
        clock: ctx.clock,
      });
      if (closed.state !== "proven") throw stop("prior-cleanup-unproven");
    }

    const principal = evidenceWindowJournalPrincipal(state.identity.runId, state.identity.attempt);
    const password = deriveJournalPassword(admissionSecret, principal.name);
    mask(password, ctx.log);
    const validUntil = iso(Date.parse(state.jobStartedAt) + JOB_TIMEOUT_MINUTES * 60_000);
    await ctx.journal.provision(principal, password, validUntil);
    state.principal = { name: principal.name, validUntil };

    state.bindings = [
      evaluateBinding(
        await captureBinding({
          phase: "provisioning",
          runtime: ctx.runtime,
          apiClient: ctx.apiClient,
          admissionSecret,
          generation: state.generation,
          journal: ctx.journal,
          journalInput: { principalName: principal.name, password, windowId: state.identity.windowId },
          now: () => iso(ctx.clock()),
          ...(ctx.modeObserver ? { modeObserver: ctx.modeObserver } : {}),
        }),
        { now: iso(ctx.clock()) },
      ),
    ];
    state.secretsFor = [admissionSecret, password];
    return state;
  },

  async attest(env, ctx, state) {
    if (stripeKeyMode(env.STRIPE_SECRET_KEY) !== "test") throw stop("stripe-key-not-test");
    const preflights = consumerPreflights(state.inputs.consumers, env, ctx.consumerRegistry ?? consumerRegistry);
    const stripe = ctx.stripeReader(env.STRIPE_SECRET_KEY);
    const account = await stripe.get("/v1/account");
    if (!account || typeof account.id !== "string" || !/^acct_[A-Za-z0-9]+$/.test(account.id))
      throw stop("stripe-account-unbound");
    const declared = preflights.flatMap((entry) => entry.fixtures);
    const retrieved = new Map();
    for (const fixture of declared) {
      const path = fixture.kind === "customer" ? `/v1/customers/${fixture.id}` : `/v1/payment_methods/${fixture.id}`;
      retrieved.set(fixture.id, await stripe.get(path));
    }
    const fixtures = attestFixtures(declared, retrieved);
    const endpoints = await stripe.list("/v1/webhook_endpoints", {});
    const endpoint = selectPaymentsWebhookEndpoint(endpoints.items, endpoints);
    assertEndpointUnchanged(state.endpointBeforeRestart, endpoint);
    const binding = state.bindings[0];
    const boundPods = binding.api.pods.map((pod) => pod.name);
    const until = ctx.clock() + EVENT_WAIT_SECONDS * 1000;
    let delivery = null;
    while (!delivery) {
      const events = await stripe.list(
        "/v1/events",
        { "created[gte]": Math.floor(Date.parse(state.restartedAt) / 1000) },
        3,
      );
      const recordsByPod = new Map();
      for (const pod of boundPods)
        recordsByPod.set(pod, parseIngestionRecords(await ctx.runtime.podLogs(pod, state.restartedAt)));
      try {
        delivery = attestWebhookDelivery({
          account: account.id,
          endpoint,
          events: events.items,
          recordsByPod,
          boundPods,
          restartedAt: state.restartedAt,
        });
      } catch (error) {
        if (error?.code !== "webhook-ingestion-unproven" || ctx.clock() >= until) throw error;
        await ctx.sleep(POLL_SECONDS * 1000);
      }
    }
    const pods = summarizeComponentPods(API_COMPONENT, await ctx.runtime.pods(API_COMPONENT));
    if (
      pods.revision !== binding.api.revision ||
      pods.digest !== binding.api.digest ||
      !pods.pods.some((pod) => pod.name === delivery.pod)
    ) {
      throw stop("webhook-ingestion-pod-unbound");
    }
    const recheck = await stripe.get("/v1/account");
    if (recheck?.id !== account.id) throw stop("stripe-account-changed");
    const atAdmission = await stripe.list("/v1/webhook_endpoints", {});
    assertEndpointUnchanged(state.endpointBeforeRestart, selectPaymentsWebhookEndpoint(atAdmission.items, atAdmission));
    state.attestation = {
      keyMode: "test",
      account: account.id,
      consumers: preflights.map((entry) => entry.consumer),
      fixtures,
      endpoint: {
        id: endpoint.id,
        status: endpoint.status,
        enabledEvents: endpoint.enabledEvents,
        created: endpoint.created,
      },
      delivery,
      capturedAt: iso(ctx.clock()),
    };
    return state;
  },

  async open(env, ctx, state) {
    const { admissionSecret } = await readAdmission(ctx, state.identity);
    const principal = evidenceWindowJournalPrincipal(state.identity.runId, state.identity.attempt);
    const password = deriveJournalPassword(admissionSecret, principal.name);
    mask(password, ctx.log);
    if (!state.attestation) throw stop("attestation-missing");
    const preAdmission = evaluateBinding(
      await captureBinding({
        phase: "pre-admission",
        runtime: ctx.runtime,
        apiClient: ctx.apiClient,
        admissionSecret,
        generation: state.generation,
        journal: ctx.journal,
        journalInput: { principalName: principal.name, password, windowId: state.identity.windowId },
        now: () => iso(ctx.clock()),
        ...(ctx.modeObserver ? { modeObserver: ctx.modeObserver } : {}),
      }),
      { now: iso(ctx.clock()), maxAgeSeconds: 120 },
    );
    compareBindings(state.bindings[0], preAdmission);
    state.bindings.push(preAdmission);
    // The account and the Payments endpoint are reread at admission, after every other capture.
    if (stripeKeyMode(env.STRIPE_SECRET_KEY) !== "test") throw stop("stripe-key-not-test");
    const stripe = ctx.stripeReader(env.STRIPE_SECRET_KEY);
    if ((await stripe.get("/v1/account"))?.id !== state.attestation.account) throw stop("stripe-account-changed");
    const endpoints = await stripe.list("/v1/webhook_endpoints", {});
    assertEndpointUnchanged(state.endpointBeforeRestart, selectPaymentsWebhookEndpoint(endpoints.items, endpoints));
    const observer = await ctx.github.runAttempt(state.observer.runId, 1).catch(() => null);
    if (observer?.status !== "in_progress") throw stop("observer-unconfirmed");

    const lowerBound = iso(ctx.clock() + RETENTION_SECONDS * 1000);
    await ctx.runtime.apply(
      windowSecretManifest({
        namespace: ctx.runtime.namespace,
        admissionSecret,
        annotation: windowAnnotation(state.identity, { deadline: lowerBound, deadlineKind: "lower-bound" }),
      }),
    );
    const armed = readWindowSecretState(await ctx.runtime.getSecret());
    if (armed.annotation?.deadline !== lowerBound || armed.admissionSecret !== admissionSecret)
      throw stop("annotation-unconfirmed");

    const [pod] = await apiTargetsOf(ctx)();
    if (!pod) throw stop("binding-route-unreachable");
    const response = await ctx.apiClient(pod, {
      method: "POST",
      path: "/internal/evidence-windows/open",
      headers: { [EVIDENCE_WINDOW_ADMISSION_HEADER]: admissionSecret, "content-type": "application/json" },
      body: { windowId: state.identity.windowId, retentionSeconds: RETENTION_SECONDS },
    });
    let window;
    if (response.status === 200) {
      window = validateOpenResponse(response.body, state.identity);
    } else {
      // An ambiguous open is resolved by reading current, never by opening again.
      const current = await ctx.apiClient(pod, {
        path: "/internal/evidence-windows/current",
        headers: { [EVIDENCE_WINDOW_ADMISSION_HEADER]: admissionSecret },
      });
      const opened = current.body?.current;
      if (
        current.status !== 200 ||
        opened?.windowId !== state.identity.windowId ||
        opened?.version !== WINDOW_VERSION
      ) {
        throw stop(`window-open-refused-${response.status ?? "unreachable"}`);
      }
      window = {
        windowId: opened.windowId,
        version: opened.version,
        openedAt: iso(Date.parse(opened.expiresAt) - RETENTION_SECONDS * 1000),
        ...windowSchedule(opened.expiresAt),
      };
    }
    state.window = window;
    await ctx.runtime.apply(
      windowSecretManifest({
        namespace: ctx.runtime.namespace,
        admissionSecret,
        annotation: windowAnnotation(state.identity, { deadline: window.deadline, deadlineKind: "exact" }),
      }),
    );
    state.secretsFor = [admissionSecret, password];
    return state;
  },

  async consume(env, ctx, state, [name]) {
    if (!state.inputs.consumers.includes(name) || !(ctx.consumerRegistry ?? consumerRegistry)[name]) {
      throw stop("consumer-not-reviewed");
    }
    if (!state.window) throw stop("window-not-open");
    if (ctx.clock() >= Date.parse(state.window.consumerStopAt)) throw stop("consumer-window-elapsed");
    const { admissionSecret } = await readAdmission(ctx, state.identity);
    const principal = evidenceWindowJournalPrincipal(state.identity.runId, state.identity.attempt);
    const password = deriveJournalPassword(admissionSecret, principal.name);
    mask(password, ctx.log);
    const childEnv = consumerEnvironment({
      window: state.window,
      journalUrl: journalConnectionString(ctx.controlUrl, principal.name, password),
      fault: state.inputs.fault,
      baseEnv: env,
    });
    const spawnConsumer = ctx.spawnConsumer ?? defaultSpawnConsumer;
    const result = await spawnConsumer(name, childEnv, Date.parse(state.window.consumerStopAt) - ctx.clock());
    state.consumers = {
      ...state.consumers,
      [name]: {
        outcome: classifyConsumerExit(result),
        stepTimeout: result.stoppedAtDeadline,
        endedAt: iso(ctx.clock()),
      },
    };
    state.secretsFor = [admissionSecret, password];
    if (state.consumers[name].outcome !== "completed") {
      state.pendingExit = `consumer-${state.consumers[name].outcome}`;
    }
    return state;
  },

  async close(env, ctx, state) {
    if (!state.window) {
      state.close = { state: "not-needed", classification: "not-opened" };
      return state;
    }
    let admissionSecret;
    try {
      ({ admissionSecret } = await readAdmission(ctx, state.identity));
    } catch {
      state.close = { state: "failed", classification: "admission-key-absent" };
      state.pendingExit = "close-unproven";
      return state;
    }
    state.close = await closeWindow({
      identity: state.identity,
      schedule: state.window,
      admissionSecret,
      apiClient: ctx.apiClient,
      apiTargets: apiTargetsOf(ctx),
      byId: ctx.byId,
      until: iso(Date.parse(state.window.deadline) + 600_000),
      sleep: ctx.sleep,
      clock: ctx.clock,
    });
    state.secretsFor = [admissionSecret];
    if (state.close.state !== "proven" || state.close.classification !== "closed-on-time") {
      state.pendingExit = state.close.state === "proven" ? state.close.classification : "close-unproven";
    }
    return state;
  },

  async revoke(env, ctx, state) {
    const closeProven = !state.window || state.close?.state === "proven";
    // The run has not ended yet, so now stands in for its end: the budget can only be stricter.
    const budget = revocationDeadline({ deadline: state.window?.deadline ?? null, runEndedAt: iso(ctx.clock()) });
    const { parts, expiredCredential } = await revokeWindow({
      identity: state.identity,
      runtime: ctx.runtime,
      apiClient: ctx.apiClient,
      journal: ctx.journal,
      closeProven,
    });
    parts["window-closed"] = !state.window ? "not-needed" : state.close?.state === "proven" ? "proven" : "failed";
    state.cleanup = cleanupRecord({ parts, by: "job", budget, expiredCredential, completedAt: iso(ctx.clock()) });
    if (state.cleanup.verdict !== "proven") state.pendingExit = `cleanup-${state.cleanup.verdict}`;
    return state;
  },

  async receipt(env, ctx, state) {
    const receipt = buildReceipt(state);
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    const directory =
      env.EVIDENCE_WINDOW_ARTIFACT_DIR ?? join(env.RUNNER_TEMP ?? ".", "staging-evidence-window", "artifact");
    mkdirSync(directory, { recursive: true });
    assertValueFree(text, []);
    writeFileSync(join(directory, "receipt.json"), text);
    const leaks = scanDirectoryForMarkers(join(env.RUNNER_TEMP ?? ".", "staging-evidence-window"));
    if (env.GITHUB_STEP_SUMMARY) {
      const summary = [
        "### Staging evidence window",
        "",
        `- Window \`${receipt.identity.windowId}\` version ${receipt.identity.version}`,
        `- Outcome: \`${receipt.outcome}\``,
        `- First stop: \`${receipt.stops[0] ?? "none"}\``,
        `- Cleanup: \`${receipt.cleanup?.verdict ?? "unknown"}\``,
        "",
      ].join("\n");
      assertValueFree(summary, []);
      appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
      leaks.push(...credentialMarkersIn(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8")));
    }
    if (leaks.length > 0) throw stop("credential-marker-leaked");
    ctx.log(`Evidence window outcome ${receipt.outcome}.`);
    if (receipt.outcome !== "succeeded") state.pendingExit = receipt.outcome;
    return state;
  },

  async observe(env, ctx) {
    const identity = targetIdentityFromEnv(env);
    const state = { schemaVersion: RECEIPT_SCHEMA, identity, inputs: null, stops: [], observer: { role: "observer" } };
    let runEndedAt = null;
    while (true) {
      const run = await ctx.github.runAttempt(identity.runId, identity.attempt);
      const secretState = readWindowSecretState(await ctx.runtime.getSecret());
      const annotation = secretState.annotation?.windowId === identity.windowId ? secretState.annotation : null;
      if (run?.status === "completed") runEndedAt = run.updated_at ?? iso(ctx.clock());
      if (observerDecision({ runStatus: run?.status, now: iso(ctx.clock()), annotation }) === "takeover") break;
      await ctx.sleep(POLL_SECONDS * 1000);
    }
    state.observer.takeoverAt = iso(ctx.clock());
    const recorded = await ctx.byId(identity.windowId);
    let windowClosed = recorded === null ? "not-needed" : recorded.state === "closed" ? "proven" : "pending";
    const annotationDeadline = readWindowSecretState(await ctx.runtime.getSecret()).annotation?.deadline ?? null;
    const budgetEnd =
      revocationDeadline({ runEndedAt, deadline: annotationDeadline ?? recorded?.expiresAt ?? null }) ??
      iso(ctx.clock() + REVOCATION_BUDGET_SECONDS * 1000);
    if (windowClosed === "pending") {
      try {
        const { admissionSecret } = await readAdmission(ctx, identity);
        const schedule = recorded?.expiresAt ? windowSchedule(recorded.expiresAt) : null;
        const closed = await closeWindow({
          identity,
          schedule,
          admissionSecret,
          apiClient: ctx.apiClient,
          apiTargets: apiTargetsOf(ctx),
          byId: ctx.byId,
          until: budgetEnd,
          sleep: ctx.sleep,
          clock: ctx.clock,
        });
        windowClosed = closed.state;
        state.close = closed;
      } catch {
        windowClosed = "failed";
      }
    }
    const { parts, expiredCredential } = await revokeWindow({
      identity,
      runtime: ctx.runtime,
      apiClient: ctx.apiClient,
      journal: ctx.journal,
      closeProven: windowClosed !== "pending" && windowClosed !== "failed",
    });
    parts["window-closed"] = windowClosed === "pending" ? "failed" : windowClosed;
    state.cleanup = cleanupRecord({
      parts,
      by: "observer",
      budget: budgetEnd,
      expiredCredential,
      completedAt: iso(ctx.clock()),
    });
    // The run's own logs are scanned once it has ended; a marker anywhere fails, and so does
    // a window the deploy group displaced before it reached a runner.
    while (!runEndedAt && ctx.clock() < Date.parse(budgetEnd)) {
      const run = await ctx.github.runAttempt(identity.runId, identity.attempt);
      if (run?.status === "completed") runEndedAt = run.updated_at ?? iso(ctx.clock());
      else await ctx.sleep(POLL_SECONDS * 1000);
    }
    const scan = runEndedAt ? await scanRunLogs(ctx.github, identity) : { logScan: "run-not-ended", jobs: [] };
    state.observer.logScan = scan.logScan;
    state.observer.jobs = scan.jobs;
    if (state.cleanup.verdict !== "proven") state.pendingExit = `cleanup-${state.cleanup.verdict}`;
    else if (scan.logScan === DISPLACED) state.pendingExit = DISPLACED;
    else if (scan.logScan !== "clean") state.pendingExit = `log-scan-${scan.logScan}`;
    return state;
  },
};

async function confirmObserver(ctx, identity, dispatchedAt) {
  const until = ctx.clock() + OBSERVER_CONFIRM_SECONDS * 1000;
  while (ctx.clock() < until) {
    const runs = await ctx.github.observerRuns(dispatchedAt);
    const matches = (runs?.workflow_runs ?? []).filter((run) => run.display_title === observerRunName(identity));
    const running = matches.find((run) => run.status === "in_progress");
    if (running) return { runId: String(running.id), status: running.status, confirmedAt: iso(ctx.clock()) };
    await ctx.sleep(10_000);
  }
  throw stop("observer-unconfirmed");
}

/**
 * One scan state per listed job, then the run's: a found marker outranks a displaced
 * window, which outranks an unreadable log. A listing that is partial, malformed, another
 * run's or without exactly one window job reads no log at all.
 */
async function scanRunLogs(github, identity) {
  let listing;
  try {
    listing = await github.attemptJobs(identity.runId, identity.attempt);
  } catch {
    return { logScan: "unreadable", jobs: [] };
  }
  const listed = Array.isArray(listing?.jobs) ? listing.jobs : [];
  if (
    listed.length === 0 ||
    listing.total_count !== listed.length ||
    !listed.every((job) => isListedJob(job, identity)) ||
    listed.filter((job) => job.name === WINDOW_JOB_NAME).length !== 1
  ) {
    return { logScan: "incomplete", jobs: [] };
  }
  const jobs = [];
  for (const job of listed) {
    let logScan = classifyUnstartedJob(job);
    if (logScan === null) {
      try {
        logScan = credentialMarkersIn(await github.jobLog(job.id)).length > 0 ? "marker-found" : "clean";
      } catch {
        logScan = "unreadable";
      }
    }
    jobs.push({ id: String(job.id), name: job.name, logScan });
  }
  const states = new Set(jobs.map((job) => job.logScan));
  return { logScan: ["marker-found", DISPLACED, "unreadable"].find((state) => states.has(state)) ?? "clean", jobs };
}

function scanDirectoryForMarkers(directory) {
  const found = [];
  if (!existsSync(directory)) return found;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const info = statSync(path);
    if (info.isDirectory()) found.push(...scanDirectoryForMarkers(path));
    else if (info.size <= 16 * 1024 * 1024) found.push(...credentialMarkersIn(readFileSync(path, "utf8")));
  }
  return found;
}

// ---------------------------------------------------------------------------------
// The rehearsal consumer process: step-local env in, a bounded result out.

export async function runRehearsalConsumer(
  env,
  { writeLine = (line) => process.stdout.write(`${line}\n`), killRunner = killRunnerWorker } = {},
) {
  const windowId = env.EVIDENCE_WINDOW_ID;
  if (!/^[0-9a-f]{32}$/.test(windowId ?? "") || !env.EVIDENCE_WINDOW_JOURNAL_DATABASE_URL) return 2;
  const pool = new pg.Pool({ ...postgresClientConfig(env.EVIDENCE_WINDOW_JOURNAL_DATABASE_URL), max: 1 });
  try {
    const rows = await createPostgresEvidenceWindowProviderWrite(pool).readWindow(windowId);
    writeLine(`rehearsal read ${rows.length} journal rows for window ${windowId}`);
  } catch {
    writeLine("rehearsal journal read failed");
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
  switch (env.EVIDENCE_WINDOW_FAULT) {
    case "none":
      return 0;
    case "fail":
      return 1;
    case "hang":
      await new Promise(() => setInterval(() => undefined, 60_000));
      return 1;
    case "runner-loss":
      killRunner();
      await new Promise(() => setInterval(() => undefined, 60_000));
      return 1;
    default:
      return 2;
  }
}

/** Ends this job's runner worker abruptly, as a lost runner would, before the job's close. */
function killRunnerWorker() {
  let pid = process.ppid;
  for (let depth = 0; depth < 16 && pid > 1; depth++) {
    let stat;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return;
    }
    const command = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    if (command.startsWith("Runner.Worker")) {
      process.kill(pid, "SIGKILL");
      return;
    }
    pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  }
}

function defaultSpawnConsumer(name, env, budgetMs) {
  return new Promise((resolve) => {
    // The consumer imports the shipped TypeScript journal, so it inherits this process's loader.
    const loader = process.execArgv.some((argument) => argument.includes("tsx"))
      ? process.execArgv
      : ["--import", "tsx"];
    const child = spawn(process.execPath, [...loader, fileURLToPath(import.meta.url), "consumer-process", name], {
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    let stoppedAtDeadline = false;
    const timer = setTimeout(
      () => {
        stoppedAtDeadline = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
      },
      Math.max(0, budgetMs),
    );
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stoppedAtDeadline });
    });
  });
}

// ---------------------------------------------------------------------------------
// Entrypoint

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const [command, ...rest] = argv;
  if (command === "consumer-process") {
    if (rest[0] !== "rehearsal") return 2;
    return runRehearsalConsumer(env);
  }
  const ctx = context(env, deps);
  if (!Object.hasOwn(commands, command)) {
    ctx.log("::error::staging-evidence-window command-not-reviewed");
    return 2;
  }
  let state = command === "inputs" || command === "observe" ? null : readState(env);
  if (!state && ["close", "revoke", "receipt"].includes(command)) {
    // Cleanup runs without registration evidence: the run identity alone names its residue.
    try {
      state = {
        schemaVersion: RECEIPT_SCHEMA,
        identity: runIdentityFromEnv(env),
        inputs: null,
        stops: ["state-missing"],
      };
    } catch {
      state = null;
    }
  }
  if (command !== "inputs" && command !== "observe" && !state) {
    ctx.log("::error::staging-evidence-window state-missing");
    return 1;
  }
  let exitCode = 0;
  try {
    state = await commands[command](env, ctx, state, rest);
  } catch (error) {
    const code = error instanceof EvidenceWindowStop ? error.code : `${command}-failed`;
    if (!state && command === "observe") {
      // An observer that cannot even read its target still leaves a receipt naming why.
      let identity = null;
      try {
        identity = targetIdentityFromEnv(env);
      } catch {
        identity = null;
      }
      state = { schemaVersion: RECEIPT_SCHEMA, identity, inputs: null, stops: [], observer: { role: "observer" } };
    }
    if (state) state.stops = [...(state.stops ?? []), code];
    ctx.log(`::error::staging-evidence-window ${code}`);
    exitCode = 1;
  }
  if (state) {
    const secrets = state.secretsFor ?? [];
    delete state.secretsFor;
    const pendingExit = state.pendingExit;
    delete state.pendingExit;
    if (pendingExit && exitCode === 0) {
      ctx.log(`::error::staging-evidence-window ${pendingExit}`);
      exitCode = 1;
    }
    try {
      if (command === "observe") {
        const directory =
          env.EVIDENCE_WINDOW_ARTIFACT_DIR ?? join(env.RUNNER_TEMP ?? ".", "staging-evidence-window", "artifact");
        mkdirSync(directory, { recursive: true });
        const text = `${JSON.stringify(buildReceipt(state), null, 2)}\n`;
        assertValueFree(text, secrets);
        writeFileSync(join(directory, "observer-receipt.json"), text);
      } else {
        writeState(env, state, secrets);
      }
    } catch (error) {
      ctx.log(
        `::error::staging-evidence-window ${error instanceof EvidenceWindowStop ? error.code : "state-write-failed"}`,
      );
      exitCode = 1;
    }
  }
  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stdout.write("::error::staging-evidence-window runner-failed\n");
      process.exitCode = 1;
    },
  );
}
