import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceWindowStop,
  ADMISSION_SECRET_KEY,
  ANNOTATION_KEY,
  CREDENTIAL_MARKERS,
  FAULTS,
  FIELD_MANAGER,
  JOB_TIMEOUT_MINUTES,
  PAYMENTS_WEBHOOK_URL,
  RETENTION_SECONDS,
  WINDOW_JOB_NAME,
  assertEndpointUnchanged,
  attestFixtures,
  attestWebhookDelivery,
  buildReceipt,
  classifyClose,
  classifyUnstartedJob,
  cleanupGroup,
  cleanupRecord,
  cleanupVerdict,
  compareBindings,
  consumerPreflights,
  createStripeReader,
  credentialMarkersIn,
  deriveJournalPassword,
  deriveWindowId,
  evaluateBinding,
  generateAdmissionSecret,
  journalConnectionString,
  main,
  observerDecision,
  observerRunName,
  parseIngestionRecords,
  parseInputs,
  parseWindowAnnotation,
  planResidue,
  readWindowSecretState,
  selectPaymentsWebhookEndpoint,
  stripeKeyMode,
  summarizeComponentPods,
  validateOpenResponse,
  windowAnnotation,
  windowIdentity,
  windowSchedule,
  windowSecretManifest,
} from "./staging-evidence-window.mjs";

const repository = "chase-sets/chase-sets";
const digestA = `sha256:${"a".repeat(64)}`;
const stripeTestKey = ["sk", "test", "synthetic0000000000000000"].join("_");
const plantedSecret = generateAdmissionSecret(() => Buffer.alloc(32, 0xab));
const t0 = Date.parse("2026-10-20T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const temporary = [];

// The displaced incident run's attempt 1 job listing (GET .../runs/39493081143/attempts/1/jobs,
// re-read 2026-10-21), reduced to the fields the observer reads; values are never edited.
const incidentRun = { runId: "39493081143", attempt: 1 };
const incidentJobs = Object.freeze([
  {
    id: 118871022858,
    run_id: 39493081143,
    run_attempt: 1,
    name: "Refuse Unconfirmed Evidence Window",
    status: "completed",
    conclusion: "skipped",
    created_at: "2026-10-20T20:34:08Z",
    started_at: "2026-10-20T20:34:08Z",
    completed_at: "2026-10-20T20:34:08Z",
    runner_id: null,
    runner_name: null,
    steps: [],
  },
  {
    id: 118871022912,
    run_id: 39493081143,
    run_attempt: 1,
    name: "Staging Evidence Window",
    status: "completed",
    conclusion: "cancelled",
    created_at: "2026-10-20T20:34:08Z",
    started_at: "2026-10-20T20:34:08Z",
    completed_at: "2026-10-20T20:39:57Z",
    runner_id: 0,
    runner_name: "",
    steps: [],
  },
]);

// Synthetic jobs for fake runs, shaped like the retained listings: a started job has a runner and steps.
function syntheticJob({ id, runId = "7001", attempt = 1, name, conclusion, started }) {
  return {
    id,
    run_id: Number(runId),
    run_attempt: attempt,
    name,
    status: "completed",
    conclusion,
    created_at: "2026-10-20T12:00:00Z",
    started_at: "2026-10-20T12:00:00Z",
    completed_at: "2026-10-20T12:30:00Z",
    runner_id: started ? 1_000_000_000 + id : null,
    runner_name: started ? `GitHub Actions ${1_000_000_000 + id}` : null,
    steps: started ? [{ name: "Set up job", status: "completed", conclusion: "success", number: 1 }] : [],
  };
}

// A confirmed window run: the refusal sibling is skipped and never reaches a runner.
const runJobs = (runId, attempt) => [
  syntheticJob({ id: 2, runId, attempt, name: "Refuse Unconfirmed Evidence Window", conclusion: "skipped" }),
  syntheticJob({ id: 1, runId, attempt, name: "Staging Evidence Window", conclusion: "success", started: true }),
];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// --------------------------------------------------------------------------------
// A fake staging: one runtime Secret with server-side-apply ownership, api/worker pods
// that load the key only when restarted, the shipped registration semantics behind the
// api routes, a run-named journal login, GitHub runs and a GET-only Stripe account.

function fakeStaging(options = {}) {
  const state = {
    now: options.now ?? t0,
    data: { ...(options.data ?? {}) },
    annotations: { ...(options.annotations ?? {}) },
    owned: {
      data: Boolean(options.data?.[ADMISSION_SECRET_KEY]),
      annotation: Boolean(options.annotations?.[ANNOTATION_KEY]),
    },
    otherKeyManager: options.otherKeyManager ?? null,
    loaded: options.loaded ?? null,
    restartedAt: options.restartedAt ?? t0 - 3_600_000,
    generation: 0,
    windows: new Map(options.windows ?? []),
    principals: new Set(options.principals ?? []),
    malformedPrincipals: options.malformedPrincipals ?? 0,
    runs: new Map(options.runs ?? []),
    calls: [],
    logs: [],
    logReads: [],
    applies: [],
  };
  const clock = () => state.now;
  const sleep = async (ms) => {
    state.now += ms;
  };
  const pods = (component) => ({
    items: ["a", "b"].map((suffix) => ({
      metadata: {
        name: `${component}-${state.generation}-${suffix}`,
        creationTimestamp: iso(Math.ceil((state.restartedAt + 5_000) / 1000) * 1000),
        labels:
          component === "platform-api"
            ? { "rollouts-pod-template-hash": "api-rev" }
            : { "pod-template-hash": `worker-${state.generation}` },
      },
      spec: { containers: [{ name: component, ports: [{ name: "http", containerPort: 8080 }] }] },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: [
          { name: component, imageID: `registry.example/chase-sets-platform@${options.podDigest ?? digestA}` },
        ],
      },
    })),
  });
  const runtime = {
    namespace: "chase-sets-platform",
    getSecret: async () => ({
      metadata: {
        name: "chase-sets-platform-runtime",
        annotations: { ...state.annotations },
        managedFields: [
          {
            manager: "chase-sets-platform-runtime",
            operation: "Apply",
            fieldsV1: { "f:data": { "f:STRIPE_SECRET_KEY": {} } },
          },
          ...(state.otherKeyManager
            ? [
                {
                  manager: state.otherKeyManager,
                  operation: "Apply",
                  fieldsV1: { "f:data": { [`f:${ADMISSION_SECRET_KEY}`]: {} } },
                },
              ]
            : []),
          ...(state.owned.data || state.owned.annotation
            ? [
                {
                  manager: FIELD_MANAGER,
                  operation: "Apply",
                  time: iso(Math.floor(state.now / 1000) * 1000),
                  fieldsV1: {
                    ...(state.owned.data ? { "f:data": { [`f:${ADMISSION_SECRET_KEY}`]: {} } } : {}),
                    ...(state.owned.annotation
                      ? { "f:metadata": { "f:annotations": { [`f:${ANNOTATION_KEY}`]: {} } } }
                      : {}),
                  },
                },
              ]
            : []),
        ],
      },
      data: { STRIPE_SECRET_KEY: "c3RyaXBl", ...state.data },
    }),
    apply: async (manifest) => {
      state.applies.push({ at: state.now, manifest: JSON.parse(JSON.stringify(manifest)) });
      const key = manifest.data?.[ADMISSION_SECRET_KEY];
      if (key) {
        if (state.otherKeyManager) throw new EvidenceWindowStop("admission-key-apply-refused");
        state.data[ADMISSION_SECRET_KEY] = key;
        state.owned.data = true;
      } else if (state.owned.data) {
        delete state.data[ADMISSION_SECRET_KEY];
        state.owned.data = false;
      }
      const annotation = manifest.metadata.annotations?.[ANNOTATION_KEY];
      if (annotation) {
        state.annotations[ANNOTATION_KEY] = annotation;
        state.owned.annotation = true;
      } else if (state.owned.annotation) {
        delete state.annotations[ANNOTATION_KEY];
        state.owned.annotation = false;
      }
    },
    pods: async (component) => pods(component),
    restart: async () => {
      state.now += 1_100;
      state.restartedAt = state.now;
      state.generation += 1;
      const encoded = state.data[ADMISSION_SECRET_KEY];
      state.loaded = encoded ? Buffer.from(encoded, "base64").toString("utf8") : null;
      state.now += 30_000;
      state.calls.push("restart");
      return { restartedAt: iso(state.restartedAt), summaries: [] };
    },
    cluster: async () => ({
      cluster: { context: "do-nyc3-chase-sets-staging", uid: "kube-system-uid" },
      namespace: { name: "chase-sets-platform", uid: "namespace-uid" },
    }),
    release: async () => ({ name: "chase-sets-platform", revision: 42, status: "deployed" }),
    podLogs: async (pod) => (options.podLogs ?? defaultPodLogs)(pod, state),
  };
  const openWindow = () =>
    [...state.windows.values()].find((window) => window.state === "open" && Date.parse(window.expiresAt) > state.now) ??
    null;
  const apiClient = async (pod, request) => {
    const observedAt = iso(state.now);
    if (!request.path.startsWith("/internal/evidence-windows/")) return { status: 404, body: null, observedAt };
    if (state.loaded === null) return { status: 404, body: null, observedAt };
    if (request.headers?.["x-evidence-window-admission"] !== state.loaded) {
      return { status: 403, body: { error: { code: "evidence-window-admission-rejected" } }, observedAt };
    }
    if (request.path === "/internal/evidence-windows/current") {
      const window = openWindow();
      return {
        status: 200,
        body: {
          current: window ? { windowId: window.windowId, expiresAt: window.expiresAt, version: window.version } : null,
        },
        observedAt,
      };
    }
    if (request.path === "/internal/evidence-windows/open") {
      state.calls.push("open");
      if (openWindow()) return { status: 409, body: { error: { code: "evidence-window-already-open" } }, observedAt };
      const window = {
        windowId: request.body.windowId,
        state: "open",
        openedAt: iso(state.now),
        expiresAt: iso(state.now + request.body.retentionSeconds * 1000),
        version: 1,
      };
      state.windows.set(window.windowId, window);
      return { status: 200, body: { ...window }, observedAt };
    }
    const closeMatch = /^\/internal\/evidence-windows\/([0-9a-f]{32})\/close$/.exec(request.path);
    if (closeMatch) {
      state.calls.push("close");
      const window = state.windows.get(closeMatch[1]);
      if (!window) return { status: 404, body: { error: { code: "evidence-window-unknown" } }, observedAt };
      if (window.state === "open" && window.version === request.body.expectedVersion) {
        window.state = "closed";
        window.closedAt = iso(Math.min(Date.parse(window.expiresAt), state.now));
        window.version += 1;
      }
      if (window.state !== "closed")
        return { status: 409, body: { error: { code: "evidence-window-stale-write-rejected" } }, observedAt };
      return {
        status: 200,
        body: { windowId: window.windowId, state: "closed", closedAt: window.closedAt, version: window.version },
        observedAt,
      };
    }
    return { status: 404, body: null, observedAt };
  };
  const journal = {
    listPrincipals: async () => ({
      principals: [...state.principals].map((name) => {
        const [runId, attempt] = name.slice("evidence_window_journal_".length).split("_");
        return { name, runId, attempt: Number(attempt) };
      }),
      malformed: state.malformedPrincipals,
    }),
    byId: async (windowId) => {
      const window = state.windows.get(windowId);
      return window
        ? {
            windowId,
            openedAt: window.openedAt,
            expiresAt: window.expiresAt,
            state: window.state,
            observedMode: "test",
          }
        : null;
    },
    provision: async (principal) => {
      if (options.principalCreateRefused) throw new EvidenceWindowStop("principal-create-refused");
      state.principals.add(principal.name);
      state.calls.push("principal");
    },
    capture: async ({ principalName }) =>
      options.journalCapture ?? {
        connected: true,
        principal: principalName,
        probes: [
          { name: "window-lock", expected: "allowed", observed: "allowed" },
          { name: "evidence-window-update", expected: "refused", observed: "refused" },
        ],
        readWindow: "ok",
        withheld: "rejected",
      },
    endSessions: async (principal, password) =>
      state.principals.has(principal.name)
        ? { state: "proven", expiredCredential: password ? "rejected" : "not-checked" }
        : { state: "not-needed", expiredCredential: "not-needed" },
    drop: async (principal) => {
      if (options.dropFails?.()) throw new Error("drop refused");
      return state.principals.delete(principal.name) ? "proven" : "not-needed";
    },
  };
  const github = {
    runAttempt: async (runId, attempt) => ({
      status: state.runs.get(`${runId}/${attempt}`) ?? (runId === "900" ? "in_progress" : "completed"),
      updated_at: iso(state.now),
    }),
    attemptJobs: async (runId, attempt) => {
      const jobs = options.jobs ?? runJobs(runId, attempt);
      return options.listing?.(jobs) ?? { total_count: jobs.length, jobs };
    },
    // GitHub serves no log for a job that never reached a runner (404), as the retained listings show.
    jobLog: async (jobId) => {
      state.logReads.push(jobId);
      const job = (options.jobs ?? runJobs("7001", 1)).find((candidate) => candidate.id === jobId);
      if (!job?.runner_id || options.missingLog?.(jobId)) throw new EvidenceWindowStop("github-log-unreadable");
      return options.jobLog ?? "2026-10-20T12:00:00Z ***\n";
    },
    dispatchObserver: async (ref, inputs) => {
      state.calls.push("dispatch");
      state.dispatched = { ref, inputs };
    },
    observerRuns: async () => ({
      workflow_runs: state.dispatched
        ? [
            {
              id: 900,
              status: "in_progress",
              display_title: `Evidence window cleanup ${state.dispatched.inputs.run_id} attempt ${state.dispatched.inputs.run_attempt}`,
            },
          ]
        : [],
    }),
  };
  const fixtures = options.fixtures ?? {
    cus_rehearsal01: { object: "customer", id: "cus_rehearsal01", livemode: false },
    pm_rehearsal01: { object: "payment_method", id: "pm_rehearsal01", livemode: false, customer: "cus_rehearsal01" },
  };
  const endpoint = () => ({
    id: "we_staging01",
    object: "webhook_endpoint",
    url: PAYMENTS_WEBHOOK_URL,
    status: "enabled",
    livemode: false,
    created: Math.floor(t0 / 1000) - 86_400,
    enabled_events: options.endpointEvents?.(state) ?? ["payment_intent.succeeded", "setup_intent.succeeded"],
  });
  const stripeMethods = [];
  const stripeReader = () =>
    createStripeReader({
      key: stripeTestKey,
      fetchImpl: async (url, init) => {
        stripeMethods.push(init.method);
        const { pathname } = new URL(url);
        const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
        if (pathname === "/v1/account")
          return json({ id: options.accountId?.(state) ?? "acct_staging01", object: "account" });
        if (pathname.startsWith("/v1/customers/") || pathname.startsWith("/v1/payment_methods/")) {
          const object = fixtures[pathname.split("/").at(-1)];
          return object ? json(object) : json({ error: {} }, 404);
        }
        if (pathname === "/v1/webhook_endpoints") return json({ object: "list", has_more: false, data: [endpoint()] });
        if (pathname === "/v1/events") {
          return json({
            object: "list",
            has_more: false,
            data: [
              {
                id: "evt_delivered01",
                object: "event",
                type: "payment_intent.succeeded",
                livemode: false,
                created: Math.floor(state.restartedAt / 1000) + 10,
                pending_webhooks: 0,
                ...(options.eventAccount ? { account: options.eventAccount } : {}),
              },
            ],
          });
        }
        return json({ error: {} }, 404);
      },
    });
  const spawned = [];
  const deps = {
    log: (line) => state.logs.push(line),
    runtime,
    apiClient,
    journal,
    github,
    stripeReader,
    clock,
    sleep,
    generateSecret: () => options.secret ?? plantedSecret,
    selectGeneration: async () =>
      options.generation ?? {
        stop: null,
        deployment: { imageDigest: digestA },
        deployGeneration: {
          runId: "500",
          runAttempt: 1,
          jobId: "600",
          jobCompletedAt: "2026-10-20T11:00:00Z",
          deployedHead: "b".repeat(40),
        },
      },
    modeObserver: async () =>
      options.mode ?? {
        mode: "test",
        paymentProcessorKind: "stripe",
        moneyMovementKind: "stripe",
        deploymentEnvironment: "staging",
        observedAt: iso(state.now),
      },
    spawnConsumer: async (name, env, budgetMs) => {
      state.calls.push(`consume:${name}`);
      spawned.push({ name, env, budgetMs });
      return options.consumerResult ?? { code: 0, signal: null, stoppedAtDeadline: false };
    },
    ...(options.consumerRegistry ? { consumerRegistry: options.consumerRegistry } : {}),
  };
  return { state, deps, spawned, stripeMethods };
}

function defaultPodLogs(pod) {
  if (!pod.endsWith("-a")) return '{"type":"http.request"}\n';
  return `${JSON.stringify({
    timestamp: "2026-10-20T12:00:00.000Z",
    level: "info",
    message: "Provider webhook ingestion completed.",
    type: "provider.webhook.ingestion",
    endpoint: "payments",
    failure_class: "none",
    outcome: "completed",
    status_code: 200,
    retryable: false,
    provider_event_id: "evt_delivered01",
  })}\n`;
}

function runEnv(overrides = {}) {
  const runnerTemp = mkdtempSync(join(tmpdir(), "staging-evidence-window-"));
  temporary.push(runnerTemp);
  const summary = join(runnerTemp, "summary.md");
  writeFileSync(summary, "");
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ID: "7001",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REF_NAME: "main",
    GITHUB_TOKEN: "synthetic-github-token",
    GITHUB_STEP_SUMMARY: summary,
    RUNNER_TEMP: runnerTemp,
    CONSUMERS: "rehearsal",
    FAULT: "none",
    STRIPE_SECRET_KEY: stripeTestKey,
    STAGING_EVIDENCE_WINDOW_REHEARSAL_CUSTOMER: "cus_rehearsal01",
    STAGING_EVIDENCE_WINDOW_REHEARSAL_PAYMENT_METHOD: "pm_rehearsal01",
    PLATFORM_CONTROL_DATABASE_URL:
      "postgresql://control_owner:owner-password@db.staging.example:25060/control?sslmode=verify-full&sslrootcert=%2Ftmp%2Fca.pem&uselibpqcompat=true",
    ...overrides,
  };
}

async function runSteps(env, deps, steps) {
  const codes = {};
  for (const step of steps) {
    const argv = Array.isArray(step) ? step : [step];
    codes[argv.join(" ")] = await main(argv, env, deps);
  }
  return codes;
}

const lifecycle = [
  "inputs",
  "preflight",
  "provision",
  "attest",
  "open",
  ["consume", "rehearsal"],
  "close",
  "revoke",
  "receipt",
];
const receiptOf = (env) =>
  JSON.parse(readFileSync(join(env.RUNNER_TEMP, "staging-evidence-window", "artifact", "receipt.json"), "utf8"));
const stateOf = (env) =>
  JSON.parse(readFileSync(join(env.RUNNER_TEMP, "staging-evidence-window", "state.json"), "utf8"));

function allFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? allFiles(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

// --------------------------------------------------------------------------------

describe("staging evidence window identity and inputs", () => {
  it("derives a 32-hex window id from repository, run id and attempt, each of which it binds", () => {
    const id = deriveWindowId({ repository, runId: "7001", attempt: 1 });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveWindowId({ repository, runId: "7001", attempt: 1 })).toBe(id);
    for (const changed of [
      { repository: "chase-sets/other", runId: "7001", attempt: 1 },
      { repository, runId: "7002", attempt: 1 },
      { repository, runId: "7001", attempt: 2 },
    ]) {
      expect(deriveWindowId(changed)).not.toBe(id);
    }
    expect(() => deriveWindowId({ repository, runId: "7001; rm", attempt: 1 })).toThrow("identity-run-id-invalid");
    expect(windowIdentity({ repository, runId: "7001", attempt: 1 })).toEqual({
      repository,
      runId: "7001",
      attempt: 1,
      windowId: id,
      version: 1,
      principal: "evidence_window_journal_7001_1",
      cleanupGroup: "evidence-window-cleanup-7001",
    });
    expect(cleanupGroup("7001")).toBe("evidence-window-cleanup-7001");
  });

  it("accepts only the closed consumer and fault enums", () => {
    expect(parseInputs({ CONSUMERS: "rehearsal", FAULT: "none" })).toEqual({ consumers: ["rehearsal"], fault: "none" });
    for (const fault of FAULTS) expect(parseInputs({ CONSUMERS: "rehearsal", FAULT: fault }).fault).toBe(fault);
    expect(() => parseInputs({ CONSUMERS: "card", FAULT: "none" })).toThrow("consumer-not-reviewed");
    expect(() => parseInputs({ CONSUMERS: "rehearsal,rehearsal", FAULT: "none" })).toThrow("consumers-invalid");
    expect(() => parseInputs({ CONSUMERS: "", FAULT: "none" })).toThrow("consumers-invalid");
    expect(() => parseInputs({ CONSUMERS: "rehearsal", FAULT: "exit 0; curl" })).toThrow("fault-not-reviewed");
  });

  it("plants a nonsecret marker in every generated credential and derives the journal password", () => {
    expect(plantedSecret.startsWith(CREDENTIAL_MARKERS[0])).toBe(true);
    const password = deriveJournalPassword(plantedSecret, "evidence_window_journal_7001_1");
    expect(password.startsWith(CREDENTIAL_MARKERS[1])).toBe(true);
    expect(password).not.toContain(plantedSecret.slice(CREDENTIAL_MARKERS[0].length));
    expect(deriveJournalPassword(plantedSecret, "evidence_window_journal_7001_2")).not.toBe(password);
    expect(credentialMarkersIn(`x ${password} y`)).toEqual([CREDENTIAL_MARKERS[1]]);
    expect(credentialMarkersIn(`key ${stripeTestKey}`)).toHaveLength(1);
  });

  it("keeps the managed CA's verified TLS on the journal login's connection", () => {
    const url = journalConnectionString(
      runEnv().PLATFORM_CONTROL_DATABASE_URL,
      "evidence_window_journal_7001_1",
      "ewjnl_x",
    );
    const parsed = new URL(url);
    expect(parsed.username).toBe("evidence_window_journal_7001_1");
    expect(parsed.searchParams.get("sslmode")).toBe("verify-full");
    expect(parsed.searchParams.get("sslrootcert")).toBe("/tmp/ca.pem");
    expect(() =>
      journalConnectionString(runEnv().PLATFORM_CONTROL_DATABASE_URL.replace("verify-full", "prefer"), "u", "p"),
    ).toThrow("journal-authority-tls-unverified");
  });
});

describe("runtime Secret field-manager state", () => {
  const identity = windowIdentity({ repository, runId: "7001", attempt: 1 });

  it("round-trips the strict annotation and rejects any malformed identity", () => {
    const annotation = windowAnnotation(identity, { deadline: "2026-10-20T13:00:00.000Z", deadlineKind: "exact" });
    expect(parseWindowAnnotation(JSON.stringify(annotation))).toEqual(annotation);
    for (const malformed of [
      { ...annotation, extra: true },
      { ...annotation, windowId: "f".repeat(32) },
      { ...annotation, deadlineKind: "unset" },
      { ...annotation, version: 2 },
      { ...annotation, runId: "0" },
    ]) {
      expect(parseWindowAnnotation(JSON.stringify(malformed))).toBeNull();
    }
    expect(parseWindowAnnotation("not json")).toBeNull();
  });

  it("applies the key and annotation only through the window's own manifest", () => {
    const annotation = windowAnnotation(identity);
    const install = windowSecretManifest({ admissionSecret: plantedSecret, annotation });
    expect(install.metadata).toEqual({
      name: "chase-sets-platform-runtime",
      namespace: "chase-sets-platform",
      annotations: { [ANNOTATION_KEY]: JSON.stringify(annotation) },
    });
    expect(Object.keys(install.data)).toEqual([ADMISSION_SECRET_KEY]);
    expect(windowSecretManifest({ annotation })).not.toHaveProperty("data");
    expect(windowSecretManifest({})).toEqual({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "chase-sets-platform-runtime", namespace: "chase-sets-platform" },
    });
  });

  it("reads which managers own the key", () => {
    const secret = {
      metadata: {
        annotations: { [ANNOTATION_KEY]: JSON.stringify(windowAnnotation(identity)) },
        managedFields: [
          {
            manager: FIELD_MANAGER,
            operation: "Apply",
            time: "2026-10-20T12:00:00Z",
            fieldsV1: { "f:data": { [`f:${ADMISSION_SECRET_KEY}`]: {} } },
          },
        ],
      },
      data: { [ADMISSION_SECRET_KEY]: Buffer.from(plantedSecret).toString("base64") },
    };
    expect(readWindowSecretState(secret)).toMatchObject({
      annotationPresent: true,
      admissionSecret: plantedSecret,
      keyManagers: [FIELD_MANAGER],
      appliedAt: "2026-10-20T12:00:00Z",
    });
  });
});

describe("residue planning", () => {
  const own = { runId: "7001", attempt: 1 };
  const prior = windowIdentity({ repository, runId: "6900", attempt: 2 });
  const priorState = (overrides = {}) => ({
    annotationPresent: true,
    annotation: windowAnnotation(prior),
    admissionSecret: plantedSecret,
    keyManagers: [FIELD_MANAGER],
    ...overrides,
  });

  it("groups residue by the run identity its names encode", () => {
    expect(
      planResidue({
        secretState: priorState(),
        principals: [
          { name: "evidence_window_journal_6900_2", runId: "6900", attempt: 2 },
          { name: "evidence_window_journal_6800_1", runId: "6800", attempt: 1 },
        ],
        malformedPrincipals: 0,
        ownRun: own,
      }),
    ).toEqual([
      { runId: "6800", attempt: 1, annotation: false, key: false, principal: true },
      { runId: "6900", attempt: 2, annotation: true, key: true, principal: true },
    ]);
  });

  it("fails closed on malformed identity rather than reclaiming it", () => {
    const base = { principals: [], malformedPrincipals: 0, ownRun: own };
    expect(() => planResidue({ ...base, secretState: priorState({ annotation: null }) })).toThrow(
      "residue-identity-malformed",
    );
    expect(() => planResidue({ ...base, secretState: priorState(), malformedPrincipals: 1 })).toThrow(
      "residue-identity-malformed",
    );
    expect(() =>
      planResidue({
        ...base,
        secretState: {
          annotationPresent: false,
          annotation: null,
          admissionSecret: plantedSecret,
          keyManagers: [FIELD_MANAGER],
        },
      }),
    ).toThrow("residue-identity-malformed");
    expect(() =>
      planResidue({ ...base, secretState: priorState({ keyManagers: ["chase-sets-platform-runtime"] }) }),
    ).toThrow("admission-key-ownership-conflict");
    expect(() =>
      planResidue({
        ...base,
        secretState: { annotationPresent: false, annotation: null, admissionSecret: null, keyManagers: [] },
        principals: [{ name: "evidence_window_journal_7001_1", runId: "7001", attempt: 1 }],
      }),
    ).toThrow("residue-identity-malformed");
  });
});

describe("binding", () => {
  const generation = {
    stop: null,
    deployment: { imageDigest: digestA },
    deployGeneration: {
      runId: "500",
      runAttempt: 1,
      jobId: "600",
      jobCompletedAt: "2026-10-20T11:00:00Z",
      deployedHead: "b".repeat(40),
    },
  };
  const pod = (name, overrides = {}) => ({
    metadata: {
      name,
      creationTimestamp: "2026-10-20T12:00:10Z",
      labels: { "rollouts-pod-template-hash": "rev1" },
      ...overrides.metadata,
    },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ name: "platform-api", imageID: `registry.example/x@${overrides.digest ?? digestA}` }],
    },
  });
  const capture = (overrides = {}) => ({
    phase: "provisioning",
    capturedAt: "2026-10-20T12:01:00.000Z",
    cluster: { context: "do-nyc3-staging", uid: "u1" },
    namespace: { name: "chase-sets-platform", uid: "u2" },
    release: { name: "chase-sets-platform", revision: 42, status: "deployed" },
    api: summarizeComponentPods("platform-api", { items: [pod("api-a"), pod("api-b")] }),
    worker: { ...summarizeComponentPods("platform-api", { items: [pod("worker-a")] }), component: "platform-worker" },
    mode: {
      mode: "test",
      paymentProcessorKind: "stripe",
      moneyMovementKind: "stripe",
      observedAt: "2026-10-20T12:01:00.000Z",
    },
    routes: [
      { pod: "api-a", status: 200, current: null },
      { pod: "api-b", status: 200, current: null },
    ],
    journal: {
      connected: true,
      principal: "evidence_window_journal_7001_1",
      probes: [{ name: "evidence-window-update", expected: "refused", observed: "refused" }],
      readWindow: "ok",
      withheld: "rejected",
    },
    generation,
    ...overrides,
  });
  const now = "2026-10-20T12:02:00.000Z";

  it("binds cluster, namespace, release, both runtimes, mode, gateway and the owning deploy generation", () => {
    const binding = evaluateBinding(capture(), { now });
    expect(binding).toMatchObject({
      cluster: { context: "do-nyc3-staging", uid: "u1" },
      release: { revision: 42, status: "deployed" },
      api: { digest: digestA, revision: "rev1" },
      mode: { mode: "test", paymentProcessorKind: "stripe" },
      deployGeneration: generation.deployGeneration,
    });
  });

  it.each([
    [
      "the deploy generation stopped",
      { generation: { stop: "deploy-in-progress", deployment: null, deployGeneration: null } },
      "binding-deploy-generation-deploy-in-progress",
    ],
    [
      "an api pod runs another digest",
      {
        api: summarizeComponentPods("platform-api", { items: [pod("api-a", { digest: `sha256:${"c".repeat(64)}` })] }),
      },
      "binding-image-digest-mismatch",
    ],
    [
      "a terminating pod remains",
      {
        api: summarizeComponentPods("platform-api", {
          items: [pod("api-a"), pod("api-old", { metadata: { deletionTimestamp: "x" } })],
        }),
      },
      "binding-runtime-unhealthy",
    ],
    ["the mode is live", { mode: { stop: "live-mode-detected" } }, "binding-mode-live-mode-detected"],
    [
      "the processor is fake",
      { mode: { mode: "test", paymentProcessorKind: "fake", moneyMovementKind: "stripe" } },
      "binding-stripe-gateway-absent",
    ],
    ["the capture is stale", { capturedAt: "2026-10-20T11:40:00.000Z" }, "binding-stale"],
    [
      "a route is unreachable",
      {
        routes: [
          { pod: "api-a", status: 404, current: null },
          { pod: "api-b", status: 200, current: null },
        ],
      },
      "binding-route-unreachable",
    ],
    [
      "another window is open",
      {
        routes: [
          { pod: "api-a", status: 200, current: { windowId: "f".repeat(32) } },
          { pod: "api-b", status: 200, current: null },
        ],
      },
      "window-already-open",
    ],
    [
      "the journal is unreachable",
      { journal: { connected: false, failure: "control-database-unreachable" } },
      "binding-journal-control-database-unreachable",
    ],
    [
      "a withheld credential is accepted",
      { journal: { ...capture().journal, withheld: "accepted" } },
      "binding-journal-withheld-credential-accepted",
    ],
    [
      "a journal write is permitted",
      {
        journal: {
          ...capture().journal,
          probes: [{ name: "evidence-window-update", expected: "refused", observed: "allowed" }],
        },
      },
      "binding-journal-authority-evidence-window-update",
    ],
    ["the cluster is unbound", { cluster: { context: null, uid: null } }, "binding-cluster-unbound"],
    [
      "the release is not deployed",
      { release: { name: "chase-sets-platform", revision: 42, status: "pending-upgrade" } },
      "binding-release-unbound",
    ],
  ])("refuses before open when %s", (_label, overrides, code) => {
    expect(() => evaluateBinding(capture(overrides), { now })).toThrow(code);
  });

  it("refuses a pre-admission capture that describes another deployment", () => {
    const provisioning = evaluateBinding(capture(), { now });
    const sameDeployment = evaluateBinding(
      capture({ phase: "pre-admission", mode: { ...capture().mode, observedAt: now } }),
      { now },
    );
    expect(compareBindings(provisioning, sameDeployment)).toBe(true);
    const moved = evaluateBinding(
      capture({ release: { name: "chase-sets-platform", revision: 43, status: "deployed" } }),
      { now },
    );
    expect(() => compareBindings(provisioning, moved)).toThrow("binding-stale-release");
  });

  it("summarizes a restart only when every live pod started after it", () => {
    const items = [pod("api-a"), pod("api-b", { metadata: { creationTimestamp: "2026-10-20T11:59:59Z" } })];
    expect(
      summarizeComponentPods("platform-api", { items }, { restartedAt: "2026-10-20T12:00:00.500Z" }),
    ).toMatchObject({
      healthy: false,
      restarted: false,
    });
    expect(
      summarizeComponentPods("platform-api", { items: [pod("api-a")] }, { restartedAt: "2026-10-20T12:00:00.500Z" })
        .healthy,
    ).toBe(true);
  });
});

describe("read-only Stripe attestation", () => {
  const endpoint = selectPaymentsWebhookEndpoint(
    [
      {
        id: "we_1",
        url: PAYMENTS_WEBHOOK_URL,
        status: "enabled",
        livemode: false,
        created: 1000,
        enabled_events: ["setup_intent.succeeded", "payment_intent.succeeded"],
      },
    ],
    { complete: true },
  );
  const event = (overrides = {}) => ({
    id: "evt_1",
    type: "payment_intent.succeeded",
    livemode: false,
    created: 2_000,
    pending_webhooks: 0,
    ...overrides,
  });
  const record = (overrides = {}) => ({
    providerEventId: "evt_1",
    failureClass: "none",
    statusCode: 200,
    ...overrides,
  });
  const delivery = (overrides = {}) =>
    attestWebhookDelivery({
      account: "acct_1",
      endpoint,
      events: [event()],
      recordsByPod: new Map([["api-a", [record()]]]),
      boundPods: ["api-a", "api-b"],
      restartedAt: iso(1_900_000),
      ...overrides,
    });

  it("keeps the key's test prefix distinct from the loaded runtime mode", () => {
    expect(stripeKeyMode(stripeTestKey)).toBe("test");
    expect(stripeKeyMode(stripeTestKey.replace("_test_", "_live_"))).toBe("not-test");
    expect(stripeKeyMode(undefined)).toBe("missing");
  });

  it("selects the sole enabled Payments endpoint on the bound origin", () => {
    expect(endpoint).toEqual({
      id: "we_1",
      status: "enabled",
      url: PAYMENTS_WEBHOOK_URL,
      created: 1000,
      enabledEvents: ["payment_intent.succeeded", "setup_intent.succeeded"],
    });
    const other = {
      id: "we_2",
      url: PAYMENTS_WEBHOOK_URL,
      status: "enabled",
      livemode: false,
      created: 1,
      enabled_events: [],
    };
    expect(() => selectPaymentsWebhookEndpoint([], { complete: true })).toThrow("webhook-endpoint-missing");
    expect(() => selectPaymentsWebhookEndpoint([other, { ...other, id: "we_3" }], { complete: true })).toThrow(
      "webhook-endpoint-ambiguous",
    );
    expect(() => selectPaymentsWebhookEndpoint([other], { complete: false })).toThrow(
      "webhook-endpoint-inventory-incomplete",
    );
    expect(() =>
      selectPaymentsWebhookEndpoint(
        [{ ...other, url: "https://marketplace.chasesets.com/api/payments/provider/webhooks" }],
        { complete: true },
      ),
    ).toThrow("webhook-endpoint-missing");
  });

  it("rejects an endpoint changed between the pre-restart read and admission", () => {
    expect(() => assertEndpointUnchanged(endpoint, { ...endpoint, enabledEvents: ["*"] })).toThrow(
      "webhook-endpoint-changed",
    );
    expect(() => assertEndpointUnchanged(endpoint, { ...endpoint, status: "disabled" })).toThrow(
      "webhook-endpoint-changed",
    );
    expect(() => assertEndpointUnchanged(endpoint, { ...endpoint, id: "we_9" })).toThrow("webhook-endpoint-changed");
    expect(() => assertEndpointUnchanged(endpoint, { ...endpoint })).not.toThrow();
  });

  it("rejects a wrong fixture owner, a live fixture and a missing fixture", () => {
    const declared = [
      { kind: "customer", id: "cus_1" },
      { kind: "payment_method", id: "pm_1", customer: "cus_1" },
    ];
    const retrieved = (pm) =>
      new Map([
        ["cus_1", { object: "customer", id: "cus_1", livemode: false }],
        ["pm_1", { object: "payment_method", id: "pm_1", livemode: false, customer: "cus_1", ...pm }],
      ]);
    expect(attestFixtures(declared, retrieved())).toHaveLength(2);
    expect(() => attestFixtures(declared, retrieved({ customer: "cus_other" }))).toThrow("fixture-owner-mismatch");
    expect(() => attestFixtures(declared, retrieved({ livemode: true }))).toThrow("fixture-not-test-mode");
    expect(() => attestFixtures(declared, new Map())).toThrow("fixture-missing");
  });

  it("binds one subscribed test-mode event of the account to a bound pod's verified ingestion record", () => {
    expect(delivery()).toEqual({
      eventId: "evt_1",
      eventType: "payment_intent.succeeded",
      eventCreated: 2_000,
      pod: "api-a",
    });
  });

  it.each([
    ["another account's event", { events: [event({ account: "acct_other" })] }],
    // Restarted before the event, so only the endpoint's creation time can reject it.
    ["an endpoint created after the event", { events: [event({ created: 900 })], restartedAt: iso(800_000) }],
    ["an event before the restart", { events: [event({ created: 1_800 })] }],
    ["an unsubscribed type", { events: [event({ type: "charge.refunded" })] }],
    ["a live-mode event", { events: [event({ livemode: true })] }],
    [
      "a signature-rejected record despite another destination's success",
      {
        recordsByPod: new Map([
          ["api-a", [record({ providerEventId: null, failureClass: "signature-invalid", statusCode: 400 })]],
        ]),
      },
    ],
    ["a classified record", { recordsByPod: new Map([["api-a", [record({ failureClass: "duplicate" })]]]) }],
    ["another pod revision's record", { recordsByPod: new Map([["api-old-revision", [record()]]]) }],
  ])("refuses admission for %s", (_label, overrides) => {
    expect(() => delivery(overrides)).toThrow("webhook-ingestion-unproven");
  });

  it("reads only the published ingestion fields from pod logs", () => {
    const records = parseIngestionRecords(
      [
        "not json provider.webhook.ingestion",
        JSON.stringify({
          type: "provider.webhook.ingestion",
          endpoint: "connect",
          provider_event_id: "evt_c",
          status_code: 200,
        }),
        JSON.stringify({
          type: "provider.webhook.ingestion",
          endpoint: "payments",
          provider_event_id: "evt_1",
          failure_class: "none",
          status_code: 200,
          message: "raw",
        }),
      ].join("\n"),
    );
    expect(records).toEqual([{ providerEventId: "evt_1", failureClass: "none", statusCode: 200 }]);
  });

  it("can only issue GET requests", async () => {
    const methods = [];
    const reader = createStripeReader({
      key: stripeTestKey,
      fetchImpl: async (_url, init) => {
        methods.push([init.method, init.body]);
        return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
      },
    });
    await reader.get("/v1/account");
    await reader.list("/v1/events", { "created[gte]": 1 });
    expect(Object.keys(reader).sort()).toEqual(["get", "list"]);
    expect(methods).toEqual([
      ["GET", undefined],
      ["GET", undefined],
    ]);
  });
});

describe("window schedule and deadline", () => {
  const identity = windowIdentity({ repository, runId: "7001", attempt: 1 });
  const opened = {
    windowId: identity.windowId,
    state: "open",
    openedAt: iso(t0),
    expiresAt: iso(t0 + RETENTION_SECONDS * 1000),
    version: 1,
  };

  it("accepts exactly one 3600 s version-1 window and derives D, D-10 and D-5", () => {
    expect(validateOpenResponse(opened, identity)).toEqual({
      windowId: identity.windowId,
      version: 1,
      openedAt: iso(t0),
      deadline: iso(t0 + 3_600_000),
      consumerStopAt: iso(t0 + 3_000_000),
      closeBy: iso(t0 + 3_300_000),
      observerTakeoverAt: iso(t0 + 3_300_000),
    });
    expect(() => validateOpenResponse({ ...opened, expiresAt: iso(t0 + 7_200_000) }, identity)).toThrow(
      "window-open-response-invalid",
    );
    expect(() => validateOpenResponse({ ...opened, version: 2 }, identity)).toThrow("window-open-response-invalid");
    expect(() => validateOpenResponse({ ...opened, windowId: "f".repeat(32) }, identity)).toThrow(
      "window-open-response-invalid",
    );
  });

  it("times a close by its observed response, never by the clamped closed_at", () => {
    const schedule = windowSchedule(iso(t0 + 3_600_000));
    expect(classifyClose({ observedAt: iso(t0 + 3_000_000), schedule })).toBe("closed-on-time");
    expect(classifyClose({ observedAt: iso(t0 + 3_400_000), schedule })).toBe("close-target-missed");
    expect(classifyClose({ observedAt: iso(t0 + 3_600_001), schedule })).toBe("deadline-failed");
  });

  it("takes over at the earlier of run end and D-5 min", () => {
    const annotation = windowAnnotation(identity, { deadline: iso(t0 + 3_600_000), deadlineKind: "exact" });
    expect(observerDecision({ runStatus: "in_progress", now: iso(t0 + 3_299_000), annotation })).toBe("wait");
    expect(observerDecision({ runStatus: "in_progress", now: iso(t0 + 3_300_000), annotation })).toBe("takeover");
    expect(observerDecision({ runStatus: "completed", now: iso(t0), annotation: null })).toBe("takeover");
    expect(observerDecision({ runStatus: "queued", now: iso(t0), annotation: null })).toBe("wait");
  });

  it("counts cleanup only when every part is proven", () => {
    const proven = Object.fromEntries(
      [
        "window-closed",
        "key-removed",
        "runtimes-restarted",
        "old-secret-rejected",
        "sessions-ended",
        "principal-dropped",
        "annotation-released",
      ].map((part) => [part, "proven"]),
    );
    expect(cleanupVerdict(proven)).toBe("proven");
    expect(cleanupVerdict({ ...proven, "window-closed": "not-needed" })).toBe("proven");
    expect(cleanupVerdict({ ...proven, "principal-dropped": "failed" })).toBe("failed");
    expect(cleanupVerdict({ ...proven, "sessions-ended": undefined })).toBe("unknown");
    const record = (completedAt) =>
      cleanupRecord({
        parts: proven,
        by: "job",
        budget: iso(t0 + 1_800_000),
        expiredCredential: "rejected",
        completedAt,
      });
    expect(record(iso(t0 + 1_800_000))).toMatchObject({ verdict: "proven", withinBudget: true });
    expect(record(iso(t0 + 1_800_001))).toMatchObject({ verdict: "late", withinBudget: false });
  });
});

describe("consumers", () => {
  it("runs every preflight before any run with two fixture consumers, and a refused preflight opens nothing", async () => {
    const order = [];
    const registry = {
      alpha: { preflight: () => (order.push("preflight:alpha"), [{ kind: "customer", id: "cus_rehearsal01" }]) },
      beta: {
        preflight: () => (
          order.push("preflight:beta"),
          [{ kind: "payment_method", id: "pm_rehearsal01", customer: "cus_rehearsal01" }]
        ),
      },
    };
    const staging = fakeStaging({ consumerRegistry: registry });
    const env = runEnv();
    expect(await runSteps(env, staging.deps, ["inputs", "preflight", "provision"])).toEqual({
      inputs: 0,
      preflight: 0,
      provision: 0,
    });
    const state = stateOf(env);
    state.inputs.consumers = ["alpha", "beta"];
    writeFileSync(join(env.RUNNER_TEMP, "staging-evidence-window", "state.json"), JSON.stringify(state));
    expect(await runSteps(env, staging.deps, ["attest", "open", ["consume", "alpha"], ["consume", "beta"]])).toEqual({
      attest: 0,
      open: 0,
      "consume alpha": 0,
      "consume beta": 0,
    });
    expect(order).toEqual(["preflight:alpha", "preflight:beta"]);
    const opened = staging.state.calls.indexOf("open");
    expect(staging.state.calls.slice(opened)).toEqual(["open", "consume:alpha", "consume:beta"]);
    for (const { env: consumerEnv } of staging.spawned) {
      expect(consumerEnv).toMatchObject({ EVIDENCE_WINDOW_ID: state.identity.windowId, EVIDENCE_WINDOW_VERSION: "1" });
      expect(consumerEnv.EVIDENCE_WINDOW_DEADLINE).toBe(stateOf(env).window.deadline);
      expect(consumerEnv).not.toHaveProperty("STRIPE_SECRET_KEY");
      expect(consumerEnv).not.toHaveProperty("PLATFORM_CONTROL_DATABASE_URL");
      expect(consumerEnv).not.toHaveProperty("GITHUB_TOKEN");
    }

    const refused = fakeStaging({
      consumerRegistry: {
        ...registry,
        beta: {
          preflight: () => {
            throw new Error("raw beta failure");
          },
        },
      },
    });
    const refusedEnv = runEnv();
    await runSteps(refusedEnv, refused.deps, ["inputs", "preflight", "provision"]);
    const refusedState = stateOf(refusedEnv);
    refusedState.inputs.consumers = ["alpha", "beta"];
    writeFileSync(join(refusedEnv.RUNNER_TEMP, "staging-evidence-window", "state.json"), JSON.stringify(refusedState));
    expect(await main(["attest"], refusedEnv, refused.deps)).toBe(1);
    expect(refused.state.calls).not.toContain("open");
    expect(refused.state.logs.join("\n")).not.toContain("raw beta failure");
  });

  it("declares the rehearsal's existing Customer and PaymentMethod and refuses undeclared fixtures", () => {
    expect(consumerPreflights(["rehearsal"], runEnv())).toEqual([
      {
        consumer: "rehearsal",
        fixtures: [
          { kind: "customer", id: "cus_rehearsal01" },
          { kind: "payment_method", id: "pm_rehearsal01", customer: "cus_rehearsal01" },
        ],
      },
    ]);
    expect(() => consumerPreflights(["rehearsal"], runEnv({ STAGING_EVIDENCE_WINDOW_REHEARSAL_CUSTOMER: "" }))).toThrow(
      "rehearsal-fixtures-undeclared",
    );
  });
});

describe("governed lifecycle against a fake staging", () => {
  it("provisions, admits, holds, closes by D-5 and proves every revocation part", async () => {
    const staging = fakeStaging();
    const env = runEnv();
    const codes = await runSteps(env, staging.deps, lifecycle);
    expect(Object.values(codes)).toEqual(lifecycle.map(() => 0));
    const receipt = receiptOf(env);
    expect(receipt).toMatchObject({
      schemaVersion: "staging-evidence-window/v1",
      outcome: "succeeded",
      providerEvidence: "none",
      close: { state: "proven", classification: "closed-on-time" },
      cleanup: { verdict: "proven", by: "job", expiredCredential: "rejected", withinBudget: true },
      consumers: { rehearsal: { outcome: "completed" } },
      attestation: {
        keyMode: "test",
        account: "acct_staging01",
        delivery: { eventId: "evt_delivered01", pod: "platform-api-1-a" },
      },
    });
    expect(receipt.bindings.map((binding) => binding.phase)).toEqual(["provisioning", "pre-admission"]);
    expect(staging.state.calls.filter((call) => call === "open")).toHaveLength(1);
    expect(staging.state.calls.indexOf("dispatch")).toBeLessThan(staging.state.calls.indexOf("open"));
    expect(staging.stripeMethods.every((method) => method === "GET")).toBe(true);

    // Before open the annotation carries D's lower bound; after open, the exact D.
    const annotations = staging.state.applies
      .map(({ manifest }) => manifest.metadata.annotations?.[ANNOTATION_KEY])
      .filter(Boolean)
      .map((text) => JSON.parse(text));
    expect(annotations.map((annotation) => `${annotation.deadlineKind}:${annotation.phase}`)).toEqual([
      "unset:installed",
      "lower-bound:installed",
      "exact:installed",
      "exact:key-removed",
    ]);
    expect(annotations[2].deadline).toBe(receipt.window.deadline);

    // Nothing remains: no key, no annotation, no login, no window, no loaded route.
    expect(staging.state.data).not.toHaveProperty(ADMISSION_SECRET_KEY);
    expect(staging.state.annotations).not.toHaveProperty(ANNOTATION_KEY);
    expect(staging.state.principals.size).toBe(0);
    expect(staging.state.loaded).toBeNull();
    expect([...staging.state.windows.values()].map((window) => window.state)).toEqual(["closed"]);
  });

  it("keeps a planted marker in each credential out of logs, summary, state and artifacts on success, refusal and crash", async () => {
    const scenarios = [
      ["success", {}, lifecycle],
      ["refusal", { fixtures: {} }, lifecycle],
      ["crash", { journalCapture: null }, ["inputs", "preflight", "provision", "close", "revoke", "receipt"]],
    ];
    for (const [label, options, steps] of scenarios) {
      const staging = fakeStaging(options);
      if (label === "crash")
        staging.deps.journal.capture = async () => {
          throw new Error(`raw crash ${plantedSecret}`);
        };
      const env = runEnv();
      await runSteps(env, staging.deps, steps);
      const password = deriveJournalPassword(plantedSecret, "evidence_window_journal_7001_1");
      const surfaces = [
        ...staging.state.logs.filter((line) => !line.startsWith("::add-mask::")),
        readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"),
        ...allFiles(join(env.RUNNER_TEMP, "staging-evidence-window")).map((file) => readFileSync(file, "utf8")),
      ].join("\n");
      expect(credentialMarkersIn(surfaces), label).toEqual([]);
      expect(surfaces, label).not.toContain(plantedSecret);
      expect(surfaces, label).not.toContain(password);
      expect(surfaces, label).not.toContain("raw crash");
      expect(staging.state.logs.filter((line) => line.startsWith("::add-mask::")).length, label).toBeGreaterThan(0);
      expect(staging.state.principals.size, label).toBe(0);
    }
  });

  it.each([
    [
      "consumer failure",
      { consumerResult: { code: 1, signal: null, stoppedAtDeadline: false } },
      "consumer-failed",
      "failed",
    ],
    [
      "step timeout at D-10",
      { consumerResult: { code: null, signal: "SIGTERM", stoppedAtDeadline: true } },
      "consumer-failed",
      "stopped-at-deadline",
    ],
  ])("still closes and revokes after a %s", async (_label, options, outcome, consumerOutcome) => {
    const staging = fakeStaging(options);
    const env = runEnv();
    const codes = await runSteps(env, staging.deps, lifecycle);
    expect(codes["consume rehearsal"]).toBe(1);
    expect(codes.close).toBe(0);
    expect(codes.revoke).toBe(0);
    expect(receiptOf(env)).toMatchObject({
      outcome,
      consumers: { rehearsal: { outcome: consumerOutcome } },
      cleanup: { verdict: "proven" },
    });
  });

  it("revokes after a cancel before open without restarting runtimes that never loaded a key", async () => {
    const staging = fakeStaging();
    const env = runEnv();
    expect(await runSteps(env, staging.deps, ["inputs", "preflight", "close", "revoke", "receipt"])).toEqual({
      inputs: 0,
      preflight: 0,
      close: 0,
      revoke: 0,
      receipt: 1,
    });
    expect(receiptOf(env)).toMatchObject({
      outcome: "not-opened",
      close: { classification: "not-opened" },
      cleanup: { verdict: "proven" },
    });
    expect(staging.state.calls).not.toContain("restart");
  });

  it("refuses with a named classification when the login cannot be created, and still revokes the key", async () => {
    const staging = fakeStaging({ principalCreateRefused: true });
    const env = runEnv();
    const codes = await runSteps(env, staging.deps, ["inputs", "preflight", "provision", "close", "revoke", "receipt"]);
    expect(codes.provision).toBe(1);
    expect(receiptOf(env)).toMatchObject({
      outcome: "refused",
      stops: ["principal-create-refused"],
      cleanup: { verdict: "proven" },
    });
    expect(staging.state.data).not.toHaveProperty(ADMISSION_SECRET_KEY);
    expect(staging.state.loaded).toBeNull();
  });

  it("refuses an admission key some other field manager owns", async () => {
    const staging = fakeStaging({ otherKeyManager: "chase-sets-platform-runtime" });
    const env = runEnv();
    expect(await runSteps(env, staging.deps, ["inputs", "provision"])).toEqual({ inputs: 0, provision: 1 });
    expect(stateOf(env).stops).toEqual(["admission-key-apply-refused"]);
  });

  it("refuses before installing any credential when the cleanup observer is never confirmed", async () => {
    const staging = fakeStaging();
    staging.deps.github.observerRuns = async () => ({ workflow_runs: [] });
    const env = runEnv();
    expect(await runSteps(env, staging.deps, ["inputs", "preflight", "provision"])).toEqual({
      inputs: 0,
      preflight: 0,
      provision: 1,
    });
    expect(stateOf(env).stops).toEqual(["observer-unconfirmed"]);
    expect(staging.state.calls).toEqual(["dispatch"]);
    expect(staging.state.applies).toEqual([]);
    expect(staging.state.data).not.toHaveProperty(ADMISSION_SECRET_KEY);
  });

  it("fails a close observed after D even though closed_at is clamped", async () => {
    const staging = fakeStaging();
    const env = runEnv();
    await runSteps(env, staging.deps, ["inputs", "preflight", "provision", "attest", "open", ["consume", "rehearsal"]]);
    staging.state.now = Date.parse(stateOf(env).window.deadline) - 1_000;
    const window = [...staging.state.windows.values()][0];
    const realClose = staging.deps.apiClient;
    staging.deps.apiClient = async (pod, request) => {
      const response = await realClose(pod, request);
      if (request.path.endsWith("/close")) staging.state.now += 5_000;
      return {
        ...response,
        observedAt: request.path.endsWith("/close") ? iso(staging.state.now) : response.observedAt,
      };
    };
    expect(await main(["close"], env, staging.deps)).toBe(1);
    expect(stateOf(env).close).toMatchObject({ state: "proven", classification: "deadline-failed" });
    expect(Date.parse(window.closedAt)).toBeLessThanOrEqual(Date.parse(window.expiresAt));
  });
});

describe("cleanup observer and next-preflight takeover", () => {
  const observerEnv = (env) => ({ ...env, TARGET_RUN_ID: "7001", TARGET_RUN_ATTEMPT: "1" });
  const observerReceipt = (env) =>
    JSON.parse(
      readFileSync(join(env.RUNNER_TEMP, "staging-evidence-window", "artifact", "observer-receipt.json"), "utf8"),
    );

  it("takes over after runner loss before the job's close", async () => {
    const staging = fakeStaging();
    const env = runEnv();
    await runSteps(env, staging.deps, ["inputs", "preflight", "provision", "attest", "open"]);
    staging.state.runs.set("7001/1", "completed");
    expect(await main(["observe"], observerEnv(env), staging.deps)).toBe(0);
    expect(observerReceipt(env)).toMatchObject({
      cleanup: { verdict: "proven" },
      close: { state: "proven", classification: "closed-on-time" },
      observer: { logScan: "clean" },
    });
    expect(staging.state.principals.size).toBe(0);
    expect(staging.state.annotations).not.toHaveProperty(ANNOTATION_KEY);
  });

  it.each([
    ["after install and restart, before the login exists", false, "not-needed"],
    ["while the login is being created", true, "proven"],
  ])(
    "is armed before any credential, so a force cancel %s still has a cleanup owner",
    async (_label, loginCreated, loginPart) => {
      const staging = fakeStaging();
      const env = runEnv();
      await runSteps(env, staging.deps, ["inputs", "preflight"]);
      const install = staging.deps.runtime.apply;
      staging.deps.runtime.apply = async (manifest) => {
        staging.state.calls.push("apply");
        return install(manifest);
      };
      // The runner is lost inside provision: no later step, not even an always() close or revoke, runs.
      const lost = new Promise((resolve) => {
        staging.deps.journal.provision = async (principal) => {
          if (loginCreated) staging.state.principals.add(principal.name);
          resolve();
          return new Promise(() => undefined);
        };
      });
      const provisioning = main(["provision"], env, staging.deps);
      await Promise.race([
        lost,
        provisioning.then((code) => {
          throw new Error(`provision ended with ${code} before the runner was lost`);
        }),
      ]);
      expect(staging.state.calls).toEqual(["dispatch", "apply", "restart"]);
      expect(staging.state.dispatched).toEqual({ ref: "main", inputs: { run_id: "7001", run_attempt: "1" } });
      expect(staging.state.data).toHaveProperty(ADMISSION_SECRET_KEY);
      expect(staging.state.loaded).toBe(plantedSecret);

      staging.state.runs.set("7001/1", "completed");
      expect(await main(["observe"], observerEnv(env), staging.deps)).toBe(0);
      expect(observerReceipt(env).cleanup).toMatchObject({
        by: "observer",
        verdict: "proven",
        parts: {
          "window-closed": "not-needed",
          "key-removed": "proven",
          "runtimes-restarted": "proven",
          "old-secret-rejected": "proven",
          "sessions-ended": loginPart,
          "principal-dropped": loginPart,
          "annotation-released": "proven",
        },
      });
      expect(staging.state.data).not.toHaveProperty(ADMISSION_SECRET_KEY);
      expect(staging.state.annotations).not.toHaveProperty(ANNOTATION_KEY);
      expect(staging.state.loaded).toBeNull();
      expect(staging.state.principals.size).toBe(0);
    },
  );

  it("takes over at D-5 min when the run's terminal notification is delayed", async () => {
    const staging = fakeStaging();
    const env = runEnv();
    await runSteps(env, staging.deps, ["inputs", "preflight", "provision", "attest", "open"]);
    staging.state.runs.set("7001/1", "in_progress");
    const { deadline } = stateOf(env).window;
    const finishing = staging.deps.github.runAttempt;
    staging.deps.github.runAttempt = async (runId, attempt) => {
      if (staging.state.now > Date.parse(deadline)) staging.state.runs.set("7001/1", "completed");
      return finishing(runId, attempt);
    };
    expect(await main(["observe"], observerEnv(env), staging.deps)).toBe(0);
    const receipt = observerReceipt(env);
    expect(Date.parse(receipt.observer.takeoverAt)).toBeGreaterThanOrEqual(Date.parse(deadline) - 300_000);
    expect(Date.parse(receipt.observer.takeoverAt)).toBeLessThan(Date.parse(deadline) - 270_000);
    expect(receipt.close.state).toBe("proven");
    expect(["closed-on-time", "close-target-missed"]).toContain(receipt.close.classification);
    expect(receipt.cleanup.verdict).toBe("proven");
  });

  it("lets a later observer take over from a displaced one that left residue", async () => {
    let failDrop = true;
    const staging = fakeStaging({ dropFails: () => failDrop });
    const env = runEnv();
    await runSteps(env, staging.deps, ["inputs", "preflight", "provision", "attest", "open"]);
    staging.state.runs.set("7001/1", "completed");
    expect(await main(["observe"], observerEnv(env), staging.deps)).toBe(1);
    expect(observerReceipt(env).cleanup.verdict).toBe("failed");
    expect(staging.state.annotations).toHaveProperty(ANNOTATION_KEY);
    failDrop = false;
    expect(await main(["observe"], observerEnv(env), staging.deps)).toBe(0);
    expect(observerReceipt(env).cleanup.verdict).toBe("proven");
    expect(staging.state.principals.size).toBe(0);
  });

  it("fails the observer when a credential marker appears in the run's logs", async () => {
    const staging = fakeStaging({ jobLog: `leaked ${CREDENTIAL_MARKERS[0]}deadbeef` });
    const env = runEnv();
    await runSteps(env, staging.deps, lifecycle);
    expect(await main(["observe"], observerEnv(env), staging.deps)).toBe(1);
    expect(observerReceipt(env).observer.logScan).toBe("marker-found");
  });

  it("keeps a confirmed run clean when its only unstarted job is the skipped refusal sibling", async () => {
    const staging = fakeStaging();
    const env = runEnv();
    await runSteps(env, staging.deps, lifecycle);
    expect(await main(["observe"], observerEnv(env), staging.deps)).toBe(0);
    expect(observerReceipt(env).observer).toMatchObject({
      logScan: "clean",
      jobs: [
        { id: "2", name: "Refuse Unconfirmed Evidence Window", logScan: "not-started" },
        { id: "1", name: "Staging Evidence Window", logScan: "clean" },
      ],
    });
    expect(staging.state.logReads).toEqual([1]);
  });

  describe("a window displaced before it reached a runner", () => {
    const incidentEnv = (env) => ({
      ...env,
      TARGET_RUN_ID: incidentRun.runId,
      TARGET_RUN_ATTEMPT: String(incidentRun.attempt),
    });
    const displacedObserve = async () => {
      const staging = fakeStaging({ jobs: incidentJobs });
      const env = runEnv();
      const code = await main(["observe"], incidentEnv(env), staging.deps);
      return { staging, env, code, receipt: observerReceipt(env) };
    };

    it("is evidence-window-displaced, fail-closed, never log-scan-unreadable or success", async () => {
      const { staging, code, receipt } = await displacedObserve();
      expect(code).toBe(1);
      expect(staging.state.logs).toContain("::error::staging-evidence-window evidence-window-displaced");
      expect(staging.state.logs.join("\n")).not.toMatch(/log-scan-/);
      expect(receipt).toMatchObject({
        stops: [],
        window: null,
        outcome: "not-opened",
        providerEvidence: "none",
        observer: {
          logScan: "evidence-window-displaced",
          jobs: [
            { id: "118871022858", name: "Refuse Unconfirmed Evidence Window", logScan: "not-started" },
            { id: "118871022912", name: "Staging Evidence Window", logScan: "evidence-window-displaced" },
          ],
        },
      });
    });

    it("reads no log, creates no credential and claims only cleanup it proved", async () => {
      const { staging, receipt } = await displacedObserve();
      expect(staging.state.logReads).toEqual([]);
      expect(staging.state.calls).toEqual([]);
      expect(staging.state.data).not.toHaveProperty(ADMISSION_SECRET_KEY);
      expect(staging.state.principals.size).toBe(0);
      expect(receipt.close).toBeNull();
      expect(receipt.cleanup).toMatchObject({ by: "observer", verdict: "proven" });
      for (const value of Object.values(receipt.cleanup.parts)) expect(["proven", "not-needed"]).toContain(value);
    });

    it("writes one receipt per owning run attempt, identical when the observer is re-driven", async () => {
      const first = await displacedObserve();
      const again = fakeStaging({ jobs: incidentJobs });
      expect(await main(["observe"], incidentEnv(first.env), again.deps)).toBe(1);
      const artifact = join(first.env.RUNNER_TEMP, "staging-evidence-window", "artifact");
      expect(readdirSync(artifact)).toEqual(["observer-receipt.json"]);
      const second = observerReceipt(first.env);
      expect(second.identity).toEqual(windowIdentity({ repository, ...incidentRun }));
      for (const field of ["identity", "outcome", "stops"]) expect(second[field]).toEqual(first.receipt[field]);
      expect(second.observer.jobs).toEqual(first.receipt.observer.jobs);
      expect(second.observer.logScan).toBe(first.receipt.observer.logScan);
    });

    it("still fails a cleanup it cannot prove ahead of the displacement", async () => {
      const staging = fakeStaging({
        jobs: incidentJobs,
        principals: ["evidence_window_journal_39493081143_1"],
        dropFails: () => true,
      });
      const env = runEnv();
      expect(await main(["observe"], incidentEnv(env), staging.deps)).toBe(1);
      expect(staging.state.logs).toContain("::error::staging-evidence-window cleanup-failed");
      expect(observerReceipt(env)).toMatchObject({
        cleanup: { verdict: "failed" },
        observer: { logScan: "evidence-window-displaced" },
      });
    });
  });

  it.each([
    ["a started job whose log is missing", { missingLog: (id) => id === 1 }, "unreadable", [1]],
    [
      "a listing whose total_count exceeds its listed jobs",
      { listing: (jobs) => ({ total_count: 3, jobs }) },
      "incomplete",
      [],
    ],
    ["an empty listing", { listing: () => ({ total_count: 0, jobs: [] }) }, "incomplete", []],
    ["a listing without jobs", { listing: () => ({ total_count: 2 }) }, "incomplete", []],
    [
      "a job without steps",
      { listing: (jobs) => ({ total_count: 2, jobs: jobs.map(({ steps: _steps, ...job }) => job) }) },
      "incomplete",
      [],
    ],
    [
      "a job from another run",
      { listing: (jobs) => ({ total_count: 2, jobs: [jobs[0], { ...jobs[1], run_id: 7002 }] }) },
      "incomplete",
      [],
    ],
    [
      "a job from another attempt",
      { listing: (jobs) => ({ total_count: 2, jobs: [jobs[0], { ...jobs[1], run_attempt: 2 }] }) },
      "incomplete",
      [],
    ],
    [
      "a listing without the window job",
      { listing: (jobs) => ({ total_count: 1, jobs: [jobs[0]] }) },
      "incomplete",
      [],
    ],
    ["a total_count below its listed jobs", { listing: (jobs) => ({ total_count: 1, jobs }) }, "incomplete", []],
  ])("fails the scan on %s", async (_label, options, logScan, logReads) => {
    const staging = fakeStaging(options);
    const env = runEnv();
    await runSteps(env, staging.deps, lifecycle);
    expect(await main(["observe"], observerEnv(env), staging.deps)).toBe(1);
    expect(staging.state.logs).toContain(`::error::staging-evidence-window log-scan-${logScan}`);
    expect(observerReceipt(env).observer.logScan).toBe(logScan);
    expect(staging.state.logReads).toEqual(logReads);
  });

  it("recovers an expired, still-open window in the next run's preflight and only then admits", async () => {
    const prior = fakeStaging();
    const priorEnv = runEnv({ GITHUB_RUN_ID: "6900" });
    await runSteps(priorEnv, prior.deps, ["inputs", "preflight", "provision", "attest", "open"]);
    prior.state.now = Date.parse(stateOf(priorEnv).window.deadline) + 60_000;
    prior.state.runs.set("6900/1", "completed");
    const env = runEnv();
    const codes = await runSteps(env, prior.deps, lifecycle);
    expect(codes.preflight).toBe(0);
    const priorWindow = prior.state.windows.get(stateOf(priorEnv).identity.windowId);
    expect(priorWindow).toMatchObject({ state: "closed", closedAt: priorWindow.expiresAt });
    expect(stateOf(env).residue).toMatchObject([{ runId: "6900", attempt: 1, owner: "completed", cleanup: "proven" }]);
    expect(receiptOf(env).outcome).toBe("succeeded");
  });

  it("skips a still-running run's residue and refuses admission until it is proven", async () => {
    const staging = fakeStaging({ principals: ["evidence_window_journal_6900_1"], runs: [["6900/1", "in_progress"]] });
    const env = runEnv();
    expect(await runSteps(env, staging.deps, ["inputs", "preflight"])).toEqual({ inputs: 0, preflight: 1 });
    expect(stateOf(env)).toMatchObject({
      stops: ["prior-cleanup-unproven"],
      residue: [{ runId: "6900", owner: "running", cleanup: "skipped" }],
    });
    expect(staging.state.principals.has("evidence_window_journal_6900_1")).toBe(true);
  });

  it("leaves a receipt naming why when the observer cannot read its target", async () => {
    const env = runEnv({ TARGET_RUN_ID: "7001; rm -rf /", TARGET_RUN_ATTEMPT: "1" });
    expect(await main(["observe"], env, fakeStaging().deps)).toBe(1);
    expect(observerReceipt(env)).toMatchObject({
      identity: null,
      stops: ["observer-target-invalid"],
      outcome: "refused",
    });
  });

  // Synthetic: this workflow never starts its sibling beside a pending window; these pin precedence only.
  it.each([
    ["a found marker over a displaced window", { jobLog: `leaked ${CREDENTIAL_MARKERS[1]}feed` }, "marker-found"],
    ["a displaced window over an unreadable log", { missingLog: (id) => id === 2 }, "evidence-window-displaced"],
  ])("ranks %s", async (_label, options, logScan) => {
    const displacedWindow = {
      ...syntheticJob({ id: 1, name: "Staging Evidence Window", conclusion: "cancelled" }),
      runner_id: 0,
      runner_name: "",
    };
    const startedSibling = syntheticJob({
      id: 2,
      name: "Refuse Unconfirmed Evidence Window",
      conclusion: "failure",
      started: true,
    });
    const staging = fakeStaging({ ...options, jobs: [startedSibling, displacedWindow] });
    const env = runEnv();
    expect(await main(["observe"], observerEnv(env), staging.deps)).toBe(1);
    expect(observerReceipt(env).observer.logScan).toBe(logScan);
    expect(staging.state.logReads).toEqual([2]);
  });

  describe("never-started jobs, one producer per state", () => {
    const [sibling, window] = incidentJobs;
    const started = { runner_id: 1000193063, runner_name: "GitHub Actions 1000193063", steps: [{ number: 1 }] };

    it("classifies the incident jobs from the listing alone", () => {
      expect(classifyUnstartedJob(sibling)).toBe("not-started");
      expect(classifyUnstartedJob(window)).toBe("evidence-window-displaced");
    });

    it("treats a null or empty runner name, and a null or zero runner id, as no runner", () => {
      for (const runner of [
        { runner_id: null, runner_name: null },
        { runner_id: null, runner_name: "" },
        { runner_id: 0, runner_name: null },
        { runner_id: 0, runner_name: "" },
      ]) {
        expect(classifyUnstartedJob({ ...sibling, ...runner })).toBe("not-started");
        expect(classifyUnstartedJob({ ...window, ...runner })).toBe("evidence-window-displaced");
      }
    });

    it.each([
      ["a runner", { runner_id: 1000193063 }],
      ["a runner name", { runner_name: "GitHub Actions 1000193063" }],
      ["a step", { steps: [{ number: 1 }] }],
      ["an unfinished status", { status: "in_progress" }],
    ])("leaves a job with %s to its log", (_label, change) => {
      expect(classifyUnstartedJob({ ...sibling, ...change })).toBeNull();
      expect(classifyUnstartedJob({ ...window, ...change })).toBeNull();
    });

    it("gives not-started only to a skipped sibling and displacement only to a cancelled window", () => {
      expect(classifyUnstartedJob({ ...sibling, conclusion: "cancelled" })).toBeNull();
      expect(classifyUnstartedJob({ ...window, conclusion: "skipped" })).toBeNull();
      expect(classifyUnstartedJob({ ...window, conclusion: "success" })).toBeNull();
    });

    it("never reads started_at", () => {
      const { started_at: _siblingStart, ...siblingWithout } = sibling;
      const { started_at: _windowStart, ...windowWithout } = window;
      expect(classifyUnstartedJob(siblingWithout)).toBe("not-started");
      expect(classifyUnstartedJob({ ...window, started_at: "2026-10-20T20:35:00Z" })).toBe("evidence-window-displaced");
      expect(classifyUnstartedJob(windowWithout)).toBe("evidence-window-displaced");
      // started_at equal to created_at does not make a job that ran unstarted.
      expect(classifyUnstartedJob({ ...window, ...started })).toBeNull();
    });
  });

  it("names the observer run so the job can confirm it before open", () => {
    expect(observerRunName(windowIdentity({ repository, runId: "7001", attempt: 2 }))).toBe(
      "Evidence window cleanup 7001 attempt 2",
    );
  });
});

describe("receipt", () => {
  it("is value-free and never claims provider evidence", () => {
    const receipt = buildReceipt({
      identity: windowIdentity({ repository, runId: "7001", attempt: 1 }),
      inputs: null,
      stops: ["binding-stale"],
    });
    expect(receipt).toMatchObject({ outcome: "refused", providerEvidence: "none", stops: ["binding-stale"] });
    expect(credentialMarkersIn(JSON.stringify(receipt))).toEqual([]);
  });
});

describe("workflows", () => {
  const read = (name) => parseYaml(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));
  const windowWorkflow = read("platform-staging-evidence-window.yml");
  const observerWorkflow = read("platform-staging-evidence-window-cleanup.yml");
  const windowJob = windowWorkflow.jobs["staging-evidence-window"];
  const observerJob = observerWorkflow.jobs["evidence-window-cleanup"];
  const steps = Object.fromEntries(windowJob.steps.filter((step) => step.id).map((step) => [step.id, step]));

  it("takes only closed, nonsecret inputs and holds the deploy lock from install to revoke", () => {
    const inputs = windowWorkflow.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs).sort()).toEqual(["confirm", "consumers", "fault"]);
    expect(inputs.consumers).toMatchObject({ type: "choice", options: ["rehearsal"] });
    expect(inputs.fault).toMatchObject({ type: "choice", options: [...FAULTS] });
    expect(windowJob.concurrency).toEqual({ group: "platform-deploy-staging", "cancel-in-progress": false });
    expect(windowJob["timeout-minutes"]).toBe(JOB_TIMEOUT_MINUTES);
    expect(windowJob.environment).toBe("staging");
    for (const job of Object.values(windowWorkflow.jobs)) {
      for (const step of job.steps ?? []) expect(step.run ?? "").not.toMatch(/\$\{\{\s*inputs\./);
    }
  });

  it("names the window job the observer classifies", () => {
    expect(windowJob.name).toBe(WINDOW_JOB_NAME);
    expect(WINDOW_JOB_NAME).toBe(incidentJobs[1].name);
    expect(windowWorkflow.jobs["refuse-unconfirmed"].name).toBe(incidentJobs[0].name);
  });

  it("keeps every staging deploy lock serialized, without claiming a pending window survives", () => {
    const directory = new URL("../.github/workflows/", import.meta.url);
    const declarations = [];
    for (const file of readdirSync(directory)
      .filter((name) => /^platform-.*\.ya?ml$/.test(name))
      .sort()) {
      const workflow = read(file);
      const scopes = [
        ["workflow", workflow.concurrency],
        ...Object.entries(workflow.jobs ?? {}).map(([id, job]) => [id, job.concurrency]),
      ];
      for (const [scope, concurrency] of scopes) {
        if (concurrency?.group !== "platform-deploy-staging") continue;
        declarations.push(`${file}#${scope}`);
        expect(concurrency["cancel-in-progress"], `${file}#${scope}`).toBe(false);
      }
    }
    expect(declarations).toEqual([
      "platform-preview-wildcard-tls.yml#workflow",
      "platform-production.yml#reconcile-managed-postgres-ca-staging",
      "platform-production.yml#deploy-staging",
      "platform-staging-admin-qa-actor-fixtures.yml#provision-admin-qa-actor-fixtures",
      "platform-staging-bootstrap-hook-drill.yml#workflow",
      "platform-staging-cluster-addons.yml#apply-staging-cluster-addons",
      "platform-staging-evidence-window.yml#staging-evidence-window",
      "platform-staging-helm-recovery.yml#workflow",
      "platform-staging-representative-commerce-state.yml#refresh-representative-commerce-state",
      "platform-staging-reset.yml#reset-staging",
      "platform-staging-rollback-drill.yml#workflow",
    ]);
    expect(new Set(declarations.map((entry) => entry.split("#")[0])).size).toBe(10);
  });

  it("adds no admission or queue state the observer cannot produce", () => {
    const script = readFileSync(new URL("./staging-evidence-window.mjs", import.meta.url), "utf8");
    expect(script).not.toMatch(/queue-unavailable|admission-refus/);
    expect(JSON.stringify(observerJob.concurrency)).toBe(
      JSON.stringify({
        group: "evidence-window-cleanup-${{ inputs.run_id || github.event.workflow_run.id }}",
        "cancel-in-progress": false,
      }),
    );
  });

  it("runs every lifecycle command in order and every cleanup step even after failure", () => {
    const commands = windowJob.steps
      .map((step) => /staging-evidence-window\.mjs (\w+)/.exec(step.run ?? "")?.[1])
      .filter(Boolean);
    expect(commands).toEqual([
      "inputs",
      "preflight",
      "provision",
      "attest",
      "open",
      "consume",
      "close",
      "revoke",
      "receipt",
    ]);
    for (const id of ["close", "revoke", "receipt", "remove-ca", "upload"]) expect(steps[id].if, id).toBe("always()");
  });

  it("gives the Stripe key only to the read-only steps and no credential to the consumer step", () => {
    const withStripe = windowJob.steps.filter((step) =>
      JSON.stringify(step.env ?? {}).includes("secrets.STRIPE_SECRET_KEY"),
    );
    expect(withStripe.map((step) => step.id)).toEqual(["provision", "attest", "open"]);
    expect(JSON.stringify(windowJob.env ?? {})).not.toContain("secrets.");
    expect(JSON.stringify(steps.consume.env ?? {})).not.toContain("secrets.");
  });

  it("arms an observer outside the deploy lock, keyed by run id and re-drivable", () => {
    expect(Object.keys(observerWorkflow.on).sort()).toEqual(["workflow_dispatch", "workflow_run"]);
    expect(observerWorkflow.on.workflow_run).toEqual({ workflows: [windowWorkflow.name], types: ["completed"] });
    expect(Object.keys(observerWorkflow.on.workflow_dispatch.inputs).sort()).toEqual(["run_attempt", "run_id"]);
    expect(observerWorkflow["run-name"]).toContain("Evidence window cleanup");
    expect(JSON.stringify(observerJob.concurrency ?? observerWorkflow.concurrency)).toContain(
      "evidence-window-cleanup-",
    );
    expect(JSON.stringify(observerWorkflow)).not.toContain("platform-deploy-staging");
    const observe = observerJob.steps.find((step) => /staging-evidence-window\.mjs observe/.test(step.run ?? ""));
    expect(JSON.stringify(observe.env)).not.toContain("STRIPE");
    for (const step of observerJob.steps) expect(step.run ?? "").not.toMatch(/\$\{\{\s*(inputs|github\.event)\./);
  });
});
