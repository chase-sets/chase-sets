import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireC1Evidence,
  recheckC1Evidence,
  consumeCompleteEnvelope,
  acquireRetainedC1Evidence,
  acquireScheduledC1Evidence,
  observeC1Schedule,
  main as acquisitionMain,
  CONTEXT,
  READS,
} from "./c1-evidence-acquisition.mjs";
import { parse, stringify } from "yaml";
import {
  CERTIFY,
  DELETE,
  METHOD,
  RECEIPT,
  readTerminalEvidence,
  responseRecord,
  sha256,
} from "./census-terminal-evidence.mjs";
import {
  admitScheduleRoles,
  prepareScheduleSnapshot,
  appendScheduleTransition,
  openScheduleBridgeWriter,
  reconstructScheduleBridge,
} from "./c1-schedule-bridge.mjs";

const repository = "synthetic-owner/h6-clock-fixtures";
const headers = { "x-github-request-id": "synthetic-request", "content-type": "application/json" };
const raw = (url, value, extra = {}) =>
  responseRecord(url, JSON.stringify(value), { ...headers, ...extra }, 200, {
    captureStartedAt: "2030-01-01T01:00:10Z",
    captureCompletedAt: "2030-01-01T01:00:11Z",
  });
const runUrl = (b) => `https://api.github.com/repos/${repository}/actions/runs/${b.id}`;
const copy = (value) => structuredClone(value);
const generatedHash = (label) => sha256(`synthetic:${label}`);
const step = (name, number, conclusion = "success") => ({
  name,
  number,
  status: "completed",
  conclusion,
  started_at: "2030-01-01T00:59:00Z",
  completed_at: "2030-01-01T01:00:00Z",
});

function runs(binding, conclusion = "success") {
  const body = {
    id: binding.id,
    run_attempt: binding.attempt,
    repository: { full_name: repository },
    workflow_id: binding.workflowId,
    path: binding.path,
    head_sha: binding.head,
    event: "workflow_dispatch",
    status: "completed",
    conclusion,
    created_at: "2030-01-01T00:00:00Z",
    run_started_at: "2030-01-01T00:00:01Z",
    updated_at: "2030-01-01T01:05:00Z",
  };
  const base = runUrl(binding);
  return [raw(base, body), raw(`${base}/attempts/${binding.attempt}`, body), raw(base, body)];
}

function sealRuns(binding, conclusion = "success") {
  return runs(binding, conclusion).map((record, index) => ({
    ...record,
    captureStartedAt: `2030-01-01T00:58:00.${index}00Z`,
    captureCompletedAt: `2030-01-01T00:58:00.${index + 1}00Z`,
  }));
}

function jobSet(binding, jobs) {
  const pages = [];
  const base = `${runUrl(binding)}/attempts/${binding.attempt}/jobs?per_page=100&page=`;
  const totalPages = Math.max(1, Math.ceil(jobs.length / 100));
  for (let page = 1; page <= totalPages; page++)
    pages.push(
      raw(
        `${base}${page}`,
        { total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100) },
        page < totalPages ? { link: `<${base}${page + 1}>; rel="next", <${base}${totalPages}>; rel="last"` } : {},
      ),
    );
  return {
    pages,
    details: jobs.map((job) => raw(`https://api.github.com/repos/${repository}/actions/jobs/${job.id}`, job)),
  };
}

function syntheticJob(binding, id, name, steps) {
  return {
    id,
    run_id: binding.id,
    run_attempt: binding.attempt,
    head_sha: binding.head,
    name,
    status: "completed",
    conclusion: "success",
    started_at: "2030-01-01T00:01:00Z",
    completed_at: "2030-01-01T01:00:09Z",
    steps,
  };
}

const setupAction = `synthetic-owner/setup@${"4".repeat(40)}`;
const actionSource = stringify({
  name: "Synthetic runtime setup",
  runs: { using: "node24", pre: "dist/pre.mjs", main: "dist/main.mjs", post: "dist/post.mjs" },
});

// Trusted source expansion is constructed from source, never from the observed REST jobs/actions.
function sourceGraphs(sources) {
  const graphs = { actions: [], actionSources: [{ path: "source-action", sha256: sha256(sources.action) }] };
  for (const [role, key] of [
    ["census", "censusWorkflow"],
    ["verification", "workflow"],
  ]) {
    const workflow = parse(sources[key]);
    graphs[role] = {
      sourcePath: `source-${key}`,
      sourceHash: sha256(sources[key]),
      jobs: Object.entries(workflow.jobs).map(([jobKey, job]) => {
        if (job.if === false) return { name: job.name, skipped: true, steps: [] };
        const pre = [];
        const main = [];
        const post = [];
        for (const declaration of job.steps) {
          if (!declaration.uses) {
            main.push(declaration.name);
            continue;
          }
          expect(declaration.uses).toBe(setupAction);
          const action = parse(sources.action);
          for (const phase of ["pre", "main", "post"]) {
            const name =
              phase === "main" ? declaration.name : `${phase === "pre" ? "Pre" : "Post"} ${declaration.name}`;
            ({ pre, main, post })[phase].push(name);
            graphs.actions.push({
              role,
              jobKey,
              name,
              uses: declaration.uses,
              phase,
              entrypoint: action.runs[phase],
              sourceHash: sha256(sources.action),
            });
          }
        }
        return {
          name: job.name,
          skipped: false,
          steps: ["Set up job", ...pre, ...main, ...post.reverse(), "Complete job"].map((name) => ({ name })),
        };
      }),
    };
  }
  return graphs;
}

function fixture({ pageTwo = false } = {}) {
  const source = stringify({
    name: "Synthetic verification",
    on: "workflow_dispatch",
    jobs: {
      ...(pageTwo
        ? Object.fromEntries(
            Array.from({ length: 99 }, (_, i) => [
              `extra-${i}`,
              { name: `Synthetic extra job ${i}`, steps: [{ name: "Synthetic work", run: "synthetic-work" }] },
            ]),
          )
        : {}),
      "synthetic-skipped": {
        name: "Synthetic inapplicable route",
        if: false,
        steps: [{ name: "Inapplicable", run: "synthetic-unused" }],
      },
      "verify-release": {
        name: "Verify Release in Ephemeral Namespace",
        steps: [
          { name: "Set up synthetic runtime", uses: setupAction },
          { name: "Reset verification namespace", run: "synthetic-create" },
          { name: "Delete verification provider webhooks", if: "always()", run: "synthetic-finalize" },
          { name: "Hold for preview census", if: "always()", run: "synthetic-hold" },
          {
            name: CERTIFY,
            if: "always()",
            run: "node scripts/census-terminal-evidence.mjs",
            "working-directory": "$RUNNER_TEMP/census-terminal-source",
          },
          { name: DELETE, if: "always()", run: "synthetic-delete" },
        ],
      },
    },
  });
  const helper = readFileSync(new URL("./census-terminal-evidence.mjs", import.meta.url), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  const sources = {
    body: "synthetic:admitted issue body",
    method: "synthetic:admitted v3 method",
    helper,
    workflow: source,
    censusWorkflow: stringify({
      name: "Synthetic census",
      on: "workflow_dispatch",
      jobs: {
        census: {
          name: "Read preview-pool census",
          steps: [
            { name: "Set up synthetic runtime", uses: setupAction },
            { name: "Capture preview-pool census", run: "synthetic-capture" },
            { name: "Upload preview-pool census", if: "always()", run: "synthetic-upload" },
          ],
        },
        "synthetic-skipped": {
          name: "Synthetic census inapplicable route",
          if: false,
          steps: [{ name: "Inapplicable", run: "synthetic-unused" }],
        },
      },
    }),
    action: actionSource,
    review: "synthetic:independent complete review",
    decision: "synthetic:prospective ACCEPT_A",
  };
  const census = {
    repository,
    id: 900000000000001,
    attempt: 1,
    workflowId: 900000001,
    path: ".github/workflows/platform-preview-pool-census.yml",
    head: "1".repeat(40),
  };
  const verification = {
    repository,
    id: 900000000000002,
    attempt: 1,
    workflowId: 900000002,
    path: ".github/workflows/platform-ephemeral-verification.yml",
    head: "2".repeat(40),
  };
  const binding = {
    census,
    verification,
    workflowHead: verification.head,
    namespace: `chase-sets-verify-${verification.id}-1`,
    uid: "synthetic-created-uid",
    release: "3".repeat(40),
    digest: `sha256:${generatedHash("image")}`,
    ...Object.fromEntries(Object.entries(sources).map(([key, value]) => [`${key}Hash`, sha256(value)])),
  };
  const vSteps = [
    step("Set up job", 1),
    step("Pre Set up synthetic runtime", 2),
    step("Set up synthetic runtime", 3),
    step("Reset verification namespace", 12),
    step("Delete verification provider webhooks", 24),
    step("Hold for preview census", 40),
    { ...step(CERTIFY, 51), completed_at: "2030-01-01T00:59:00Z" },
    step(DELETE, 52),
    step("Post Set up synthetic runtime", 81),
    step("Complete job", 90),
  ];
  const bounds = [
    ["00:01:00", "00:01:01"],
    ["00:01:01", "00:01:02"],
    ["00:01:02", "00:01:03"],
    ["00:02:00", "00:02:01"],
    ["00:57:00", "00:57:01"],
    ["00:57:01", "00:58:00"],
    ["00:58:00", "00:59:00"],
    ["00:59:00", "01:00:00"],
    ["01:00:00", "01:00:08"],
    ["01:00:08", "01:00:09"],
  ];
  for (const [index, s] of vSteps.entries()) {
    s.started_at = `2030-01-01T${bounds[index][0]}Z`;
    s.completed_at = `2030-01-01T${bounds[index][1]}Z`;
  }
  const vJob = syntheticJob(verification, 900000000000202, "Verify Release in Ephemeral Namespace", vSteps);
  const cJob = syntheticJob(census, 900000000000201, "Read preview-pool census", [
    step("Set up job", 1),
    step("Pre Set up synthetic runtime", 2),
    step("Set up synthetic runtime", 3),
    step("Capture preview-pool census", 24),
    step("Upload preview-pool census", 51),
    step("Post Set up synthetic runtime", 81),
    step("Complete job", 90),
  ]);
  cJob.started_at = "2030-01-01T00:00:01Z";
  cJob.completed_at = "2030-01-01T00:57:00Z";
  for (const [index, s] of cJob.steps.entries()) {
    s.started_at = `2030-01-01T00:${String(index + 1).padStart(2, "0")}:00Z`;
    s.completed_at = `2030-01-01T00:${String(index + 1).padStart(2, "0")}:01Z`;
  }
  const skipped = {
    ...syntheticJob(verification, 900000000000203, "Synthetic inapplicable route", []),
    conclusion: "skipped",
    started_at: null,
    completed_at: null,
  };
  const vJobs = pageTwo
    ? [
        ...Array.from({ length: 99 }, (_, i) =>
          syntheticJob(verification, 900000001000000 + i, `Synthetic extra job ${i}`, [
            { ...step("Set up job", 1), started_at: "2030-01-01T00:01:00Z", completed_at: "2030-01-01T00:01:01Z" },
            { ...step("Synthetic work", 24), started_at: "2030-01-01T00:01:01Z", completed_at: "2030-01-01T00:01:02Z" },
            { ...step("Complete job", 51), started_at: "2030-01-01T00:01:02Z", completed_at: "2030-01-01T00:01:03Z" },
          ]),
        ),
        skipped,
        vJob,
      ]
    : [vJob, skipped];
  // Independent observed action expansion, with the same generated synthetic identities as the source.
  const actions = ["census", "verification"].flatMap((role) =>
    ["pre", "main", "post"].map((phase) => ({
      role,
      jobKey: role === "census" ? "census" : "verify-release",
      name:
        phase === "main" ? "Set up synthetic runtime" : `${phase === "pre" ? "Pre" : "Post"} Set up synthetic runtime`,
      uses: setupAction,
      phase,
      entrypoint: `dist/${phase}.mjs`,
      sourceHash: sha256(actionSource),
    })),
  );
  const envelope = {
    synthetic: true,
    repository,
    caseId: "synthetic:complete-positive",
    method: METHOD,
    schemaVersion: RECEIPT,
    binding,
    admission: {
      method: METHOD,
      decision: "ACCEPT_A",
      receiptId: "synthetic:admitted-receipt",
      implementationCommit: verification.head,
      dispatchHash: generatedHash("admission-dispatch"),
      controlReceiptHash: generatedHash("controls"),
      sourceGraphsHash: sha256(JSON.stringify(sourceGraphs(sources))),
    },
    custodians: {
      timestamp: "synthetic-session-timestamp",
      schedule: "synthetic-session-schedule",
      executor: "synthetic-session-executor",
    },
    dispatch: {
      verificationDispatched: true,
      verificationRunExists: true,
      bracketStarted: true,
      inputHash: generatedHash("dispatch-input"),
    },
    namespace: {
      state: "CREATED",
      name: binding.namespace,
      uid: binding.uid,
      release: binding.release,
      digest: binding.digest,
      runId: verification.id,
      attempt: 1,
      createdAt: "2030-01-01T00:02:00Z",
      deleted: true,
    },
    sourceMap: {
      jobId: vJob.id,
      jobKey: "verify-release",
      synchronous: true,
      deleteDependsOnSeal: false,
      workflowHash: binding.workflowHash,
      helperHash: binding.helperHash,
      expandedActionsHash: sha256(JSON.stringify(actions)),
      steps: vSteps.map(({ name }) => ({ name })),
    },
    seal: { schemaVersion: "h6-pre-delete-seal/v1", binding: copy(binding), responses: sealRuns(census) },
    capture: { census: runs(census), verification: runs(verification) },
    consumption: { census: runs(census), verification: runs(verification) },
    jobs: {
      census: jobSet(census, [
        cJob,
        {
          ...syntheticJob(census, 900000000000204, "Synthetic census inapplicable route", []),
          conclusion: "skipped",
          started_at: null,
          completed_at: null,
        },
      ]),
      verification: jobSet(verification, vJobs),
    },
    coverage: [
      "dispatch",
      "sources",
      "actions",
      "logs",
      "events",
      "namespace",
      "finalizers",
      "capture",
      "consumption",
    ].map((role) => ({ role, complete: true, paths: [`synthetic-${role}.json`] })),
    ack: {
      at: "2030-01-01T01:00:15Z",
      scheduleHash: generatedHash("schedule"),
      custodian: "synthetic-session-schedule",
      receiptHash: "",
    },
    schedule: {
      t0Utc: "2030-01-01T01:00:00Z",
      deadlineUtc: "2030-01-01T02:30:00Z",
      persistedAt: "2030-01-01T01:00:00Z",
      windows: [0, 1, 2].map((i) => ({
        ordinal: i + 1,
        startSlot: i === 0 ? 0 : null,
        slotLimit: 60,
        intervalSeconds: 30,
        reads: [],
        ended: false,
      })),
    },
    histories: Object.fromEntries(
      ["opportunity", "oneFreshArm", "sizingWindows", "lifetimeAttempts", "consumedHeads", "blockingRounds"].map(
        (key) => [key, generatedHash(`history-${key}`)],
      ),
    ),
  };
  return retain({ envelope, sources, actions, expectedGraphs: sourceGraphs(sources) });
}

function retain(f) {
  const e = f.envelope;
  const file = (path, value) => ({
    path,
    backupPath: `synthetic-independent-backup/${path}`,
    originalCustodian: "synthetic-original-custodian",
    backupCustodian: "synthetic-backup-custodian",
    encoding: "utf8",
    original: typeof value === "string" ? value : JSON.stringify(value),
    backup: typeof value === "string" ? value : JSON.stringify(value),
  });
  const owner = e.jobs.verification.details
    .map((record) => JSON.parse(record.body))
    .find((job) => job.name === "Verify Release in Ephemeral Namespace");
  e.ack.scheduleHash = sha256(JSON.stringify(e.schedule));
  e.ack.receiptHash = sha256(
    JSON.stringify({
      binding: e.binding,
      seal: e.seal,
      endpoint: owner?.steps?.find((s) => s.name === DELETE)?.completed_at,
    }),
  );
  e.files = Object.entries(f.sources).map(([name, value]) => file(`source-${name}`, value));
  const lifecycle = {
    dispatch: e.dispatch,
    sources: e.sourceMap,
    actions: { expanded: copy(f.actions) },
    logs: {
      safe: true,
      entire: true,
      jobId: e.sourceMap.jobId,
      text: `${e.sourceMap.steps.map((s) => `synthetic executed step ${s.name}`).join("\n")}\nnode scripts/census-terminal-evidence.mjs`,
      certification: {
        command: "node scripts/census-terminal-evidence.mjs",
        workingDirectory: "$RUNNER_TEMP/census-terminal-source",
        workflowHead: e.binding.workflowHead,
        helperHash: e.binding.helperHash,
        namespaceCreationPath: "$GITHUB_WORKSPACE/artifacts/ephemeral-verification/namespace-created.json",
        sealPath: "$GITHUB_WORKSPACE/artifacts/ephemeral-verification/census-terminal-seal.json",
      },
      checkedAt: "2030-01-01T01:00:10Z",
      emittedAtUtc: "2030-01-01T01:00:11Z",
      hold_end: "2030-01-01T00:58:00Z",
      jobs: ["census", "verification"].flatMap((role) =>
        e.jobs[role].details.map((record) => {
          const job = JSON.parse(record.body);
          return {
            role,
            jobId: job.id,
            safe: true,
            entire: true,
            steps: job.steps,
            text: job.steps?.map((s) => s.name).join("\n") ?? "",
          };
        }),
      ),
    },
    events: [
      "capture-start",
      "verification-dispatched",
      "namespace-created",
      "provider-finalized",
      "seal-written",
      "delete-started",
      "delete-completed",
    ].map((kind) => ({
      delivery: `synthetic-${kind}`,
      deliveredAt: "2030-01-01T01:00:10Z",
      receivedAt: "2030-01-01T01:00:11Z",
      polledAt: "2030-01-01T01:00:12Z",
      kind,
      uid: e.namespace.uid,
      runId: kind === "capture-start" ? e.binding.census.id : e.binding.verification.id,
      attempt: kind === "capture-start" ? e.binding.census.attempt : e.binding.verification.attempt,
    })),
    namespace: {
      creation: {
        kind: "Namespace",
        metadata: { name: e.namespace.name, uid: e.namespace.uid, creationTimestamp: e.namespace.createdAt },
      },
    },
    finalizers: { provider: "success", delete: e.namespace.deleted ? "success" : "failure" },
    capture: e.capture,
    consumption: e.consumption,
    ...f.lifecycleOverrides,
  };
  for (const [name, value] of Object.entries(lifecycle)) e.files.push(file(`synthetic-${name}.json`, value));
  e.files.push(file("seal.json", e.seal));
  for (const phase of ["capture", "consumption"])
    for (const role of ["census", "verification"])
      for (const [i, record] of e[phase][role].entries()) e.files.push(file(`${phase}-${role}-${i}`, record));
  for (const role of ["census", "verification"])
    for (const kind of ["pages", "details"])
      for (const [i, record] of e.jobs[role][kind].entries()) e.files.push(file(`${role}-${kind}-${i}`, record));
  e.files.push(
    file("facts.json", {
      binding: e.binding,
      admission: e.admission,
      dispatch: e.dispatch,
      namespace: e.namespace,
      sourceMap: e.sourceMap,
      custodians: e.custodians,
      ack: e.ack,
      coverage: e.coverage,
      schedule: e.schedule,
      histories: e.histories,
    }),
  );
  return admitFiles(f);
}

function admitFiles(f) {
  const e = f.envelope;
  const manifest = e.files.map((file) => ({
    path: file.path,
    backupPath: file.backupPath,
    originalCustodian: file.originalCustodian,
    backupCustodian: file.backupCustodian,
    bytes: Buffer.byteLength(file.original),
    sha256: sha256(file.original),
  }));
  e.externalManifestHash = sha256(JSON.stringify(manifest));
  f.admitted = copy({
    binding: e.binding,
    admission: e.admission,
    manifest,
    externalManifestHash: e.externalManifestHash,
    coverage: e.coverage,
    dispatch: e.dispatch,
    custodians: e.custodians,
    sourceMap: e.sourceMap,
    sourceGraphs: f.expectedGraphs,
    scheduleHash: e.ack?.scheduleHash,
    histories: e.histories,
  });
  return f;
}

function mutateRecord(record, mutate) {
  const value = JSON.parse(record.body);
  mutate(value);
  return raw(record.url, value, record.headers);
}

function changeDelete(f, mutate) {
  const set = f.envelope.jobs.verification;
  set.details[0] = mutateRecord(set.details[0], (job) =>
    mutate(
      job.steps.find((s) => s.name === DELETE),
      job,
    ),
  );
  set.pages[0] = mutateRecord(set.pages[0], (page) => {
    page.jobs[0] = JSON.parse(set.details[0].body);
  });
  return retain(f);
}

const read = (f) => readTerminalEvidence(f.envelope, f.admitted);

function withoutVerification(f) {
  const e = f.envelope;
  Object.assign(e.dispatch, { verificationDispatched: false, verificationRunExists: false, bracketStarted: false });
  for (const key of ["verification", "namespace", "uid"]) delete e.binding[key];
  for (const key of ["namespace", "sourceMap", "seal", "ack", "schedule"]) e[key] = null;
  for (const phase of ["capture", "consumption", "jobs"]) delete e[phase].verification;
  e.coverage = e.coverage.map((entry) =>
    ["actions", "logs", "events", "namespace", "finalizers"].includes(entry.role)
      ? { role: entry.role, complete: true, notApplicable: true, reason: "NO_VERIFICATION_RUN", paths: [] }
      : entry.role === "sources"
        ? { ...entry, paths: ["source-workflow"] }
        : entry,
  );
  const facts = Object.fromEntries(
    [
      "binding",
      "admission",
      "dispatch",
      "namespace",
      "sourceMap",
      "custodians",
      "ack",
      "coverage",
      "schedule",
      "histories",
    ].map((key) => [key, e[key]]),
  );
  const replacement = {
    "facts.json": facts,
    "synthetic-dispatch.json": e.dispatch,
    "synthetic-capture.json": e.capture,
    "synthetic-consumption.json": e.consumption,
  };
  for (const phase of ["capture", "consumption"])
    for (const [i, record] of (e[phase]?.census ?? []).entries()) replacement[`${phase}-census-${i}`] = record;
  for (const kind of ["pages", "details"])
    for (const [i, record] of (e.jobs?.census?.[kind] ?? []).entries()) replacement[`census-${kind}-${i}`] = record;
  e.files = e.files
    .filter((file) => file.path.startsWith("source-") || Object.hasOwn(replacement, file.path))
    .map((file) =>
      Object.hasOwn(replacement, file.path)
        ? { ...file, original: JSON.stringify(replacement[file.path]), backup: JSON.stringify(replacement[file.path]) }
        : file,
    );
  return admitFiles(f);
}

const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const sandbox = () => {
  const path = mkdtempSync(join(tmpdir(), "c1-acquisition-synthetic-"));
  temporary.push(path);
  return path;
};
const meta = (name, extra = {}) => ({
  name,
  uid: `synthetic-${name}`,
  creationTimestamp: "2030-01-01T00:00:00Z",
  resourceVersion: "123",
  ...extra,
});
function admissionFixture() {
  const roles = {
    pr: ["platform-pr.yml", "preview-deploy-smoke"],
    gate: ["platform-merge-gate-verification.yml", "verify"],
    stranded: ["platform-merge-gate-verification.yml", "stranded-fixture-drill"],
    ephemeral: ["platform-ephemeral-verification.yml", "verify-release"],
    automatic: ["platform-production.yml", "dispatch-ephemeral-verification"],
    observer: ["platform-merge-qualification-observer.yml", "cleanup"],
    cleanup: ["platform-preview-cleanup.yml", "destroy-preview"],
    indirect: ["synthetic-indirect.yml", "synthetic-create"],
  };
  const owners = Object.entries(roles).map(([role, [file, job]], i) => ({
    id: role,
    role,
    path: `.github/workflows/${file}`,
    job,
    workflowId: i + 100,
    url: `https://api.github.com/repos/synthetic-owner/c1-fixture/actions/workflows/${i + 100}/runs`,
  }));
  const files = [...new Set(owners.map((o) => o.path))].map((path) => {
    const bytes = stringify({
      name: `Synthetic ${path}`,
      on: "workflow_dispatch",
      jobs: Object.fromEntries(
        owners.filter((o) => o.path === path).map((o) => [o.job, { steps: [{ run: "synthetic-inert" }] }]),
      ),
    });
    return { path, bytes, sha256: sha256(bytes) };
  });
  const source = {
    repository: "synthetic-owner/c1-fixture",
    head: "a".repeat(40),
    owners,
    files,
    indirectOwners: ["indirect"],
  };
  const capability = {
    hostAdmission: "synthetic-host-admission",
    mode: "read-only",
    context: CONTEXT,
    reviewHash: generatedHash("review"),
    ownerIds: owners.map((o) => o.id),
  };
  const input = {
    source,
    capability,
    admitted: { sourceHash: sha256(JSON.stringify(source)), capabilityHash: sha256(JSON.stringify(capability)) },
    slot: { startedAt: 0, deadline: 30000 },
  };
  const list = (kind, items) => ({
    apiVersion: "v1",
    kind: `${kind}List`,
    metadata: { resourceVersion: "123" },
    items,
  });
  const node = {
    apiVersion: "v1",
    kind: "Node",
    metadata: meta("node", {
      labels: { "chase-sets.com/pool": "preview", "node.kubernetes.io/instance-type": "s-4vcpu-8gb" },
    }),
    spec: { taints: [{ key: "chase-sets.com/preview-only", value: "true", effect: "NoSchedule" }] },
    status: {
      allocatable: { cpu: "4", memory: "8Gi", pods: "110" },
      conditions: ["Ready", "MemoryPressure", "DiskPressure", "PIDPressure"].map((type) => ({
        type,
        status: type === "Ready" ? "True" : "False",
        lastTransitionTime: "2030-01-01T00:00:00Z",
      })),
    },
  };
  const bodies = {
    nodes: list("Node", [node]),
    namespaces: list("Namespace", []),
    pods: list("Pod", []),
    events: list("Event", []),
    configmap: {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: meta("cluster-autoscaler-status", { namespace: "kube-system" }),
      data: { status: "Cluster-autoscaler status\nScaleDown: NoCandidates\n" },
    },
  };
  let elapsed = 0;
  const f = {
    input,
    bodies,
    runs: {},
    trace: [],
    variable: { present: false, value: null },
    durations: {},
    clock: () => elapsed,
    now: () => "2030-01-01T00:00:00Z",
  };
  f.producers = {
    binding: capability,
    async clusterRead(request) {
      f.trace.push(request);
      elapsed += f.durations[request.resource] ?? 1;
      return { exitCode: 0, stdout: JSON.stringify(bodies[request.resource]), stderr: "SYNTHETIC_PRIVATE_STDERR" };
    },
    async automaticVariableRead(request) {
      f.trace.push(request);
      return f.variable;
    },
    async previewGateRead(request) {
      f.trace.push(request);
      const gate = f.runs.pr?.find((run) => run.id === request.runId)?.previewGate;
      return gate ? { ...gate, runId: request.runId, attempt: request.attempt, sourceHash: request.sourceHash } : null;
    },
    async inventoryRead(request) {
      f.trace.push(request);
      const owner = owners.find((o) => o.id === request.owner),
        ordinal = Number(new URL(request.url).searchParams.get("page"));
      const runs = f.runs[owner.id] ?? [],
        pages = Math.max(1, Math.ceil(runs.length / 100));
      let record = raw(
        request.url,
        {
          total_count: runs.length,
          workflow_runs: runs.slice((ordinal - 1) * 100, ordinal * 100).map(({ previewGate: _gate, ...run }) => run),
        },
        ordinal < pages
          ? {
              link: `<${owner.url}?per_page=100&page=${ordinal + 1}>; rel="next", <${owner.url}?per_page=100&page=${pages}>; rel="last"`,
            }
          : {},
      );
      if (f.mutatePage) record = f.mutatePage(record, request, ordinal);
      return record;
    },
  };
  f.run = () => acquireC1Evidence(input, f.producers, f);
  f.record = (role, id, status = "completed") => {
    const owner = owners.find((o) => o.id === role);
    return {
      id,
      status,
      conclusion: status === "completed" ? "success" : null,
      workflow_id: owner.workflowId,
      path: owner.path,
      head_sha: source.head,
      event: "workflow_dispatch",
      run_attempt: 1,
      previewGate: {
        head: source.head,
        labelPreview: false,
        clusterPreview: false,
        evidenceHash: generatedHash("gate-output"),
      },
    };
  };
  return f;
}

function filesFor(f, root = sandbox()) {
  const envelopeFile = join(root, "input-envelope.json"),
    admittedFile = join(root, "input-admitted.json"),
    custodyFile = join(root, "input-custody.json");
  const bytes = [Buffer.from(JSON.stringify(f.envelope)), Buffer.from(JSON.stringify(f.admitted))];
  writeFileSync(envelopeFile, bytes[0]);
  writeFileSync(admittedFile, bytes[1]);
  writeFileSync(
    custodyFile,
    JSON.stringify({
      inputs: [envelopeFile, admittedFile].map((path, i) => ({
        path,
        bytes: bytes[i].length,
        sha256: sha256(bytes[i]),
      })),
      manifest: f.admitted.manifest,
      externalManifestHash: f.admitted.externalManifestHash,
    }),
  );
  return {
    envelopeFile,
    admittedFile,
    custodyFile,
    outputs: {
      envelope: join(root, "envelope.json"),
      manifest: join(root, "manifest.json"),
      receipt: join(root, "receipt.json"),
    },
  };
}
function cli(plan) {
  const args = [
    fileURLToPath(new URL("./c1-evidence-acquisition.mjs", import.meta.url)),
    "--envelope-file",
    plan.envelopeFile,
    "--admitted-file",
    plan.admittedFile,
    "--custody-file",
    plan.custodyFile,
    "--out-envelope",
    plan.outputs.envelope,
    "--out-manifest",
    plan.outputs.manifest,
    "--out-receipt",
    plan.outputs.receipt,
  ];
  // Absolute native Node, no shell/PATH substitution and no inherited credential environment.
  try {
    return {
      exit: 0,
      result: JSON.parse(
        execFileSync(process.execPath, args, {
          encoding: "utf8",
          env: { SystemRoot: process.env.SystemRoot ?? "", PATH: "", SYNTHETIC_ISOLATION_SENTINEL: "fixture-only" },
        }),
      ),
    };
  } catch (error) {
    return { exit: error.status, result: JSON.parse(error.stdout) };
  }
}

function syntheticZip(entries, method = 0) {
  const local = [],
    central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name),
      bytes = Buffer.from(value);
    const compressed = method === 8 ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30),
      directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    header.copy(directory, 10, 8, 26);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function custodyFor(f) {
  const root = sandbox(),
    start = "2030-01-01T00:00:00Z",
    end = "2030-01-01T01:00:10Z",
    now = "2030-01-01T01:00:20Z";
  mkdirSync(join(root, "sources"));
  const keys = generateKeyPairSync("ed25519"),
    binding = f.envelope.binding;
  const noV = read(f).bracketState === "NO_BRACKET_NO_T0";
  const historyBinding = {
    release: "4".repeat(40),
    digest: `sha256:${generatedHash("synthetic-c1-image")}`,
    workflowHead: binding.workflowHead,
    namespace: "chase-sets-verify-900000000000099-1",
    uid: "synthetic-c1-namespace",
    nodeUid: "synthetic-c1-node",
    census: { ...binding.census, id: 900000000000098 },
    verification: { ...binding.verification, id: 900000000000099 },
  };
  const plan = {
    version: "c1-evidence-custody/v1",
    performer: "synthetic-custody-executor",
    binding,
    nodeUid: "synthetic-held-node",
    validFrom: start,
    validUntil: "2030-01-02T00:00:00Z",
    retainUntil: "2031-01-01T00:00:00Z",
    original: { custodian: "synthetic-original-custodian", prefix: join(root, "originals") },
    backup: {
      custodian: "synthetic-backup-custodian",
      prefix: join(root, "backups"),
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
    },
    manifestPath: join(root, "custody-manifest.json"),
    acknowledgementPath: join(root, "custody-ack.json"),
    planOriginalPath: join(root, "originals", "plan.json"),
    planBackupPath: join(root, "backups", "plan.json"),
    files: [],
    envelopeId: "envelope",
    admittedId: "admitted",
    clockMappings: [],
    sourceGraph: { workflowId: "", helperId: "", actionIds: [] },
    history: {
      binding: historyBinding,
      start,
      end,
      startResourceVersion: "synthetic-rv-start",
      inventoryId: "inventory",
      segments: ["history"],
      logIds: ["api-log", "worker-log"],
    },
    artifacts: [],
    consumption: {
      custodyPath: join(root, "reader-custody.json"),
      outputs: {
        envelope: join(root, "envelope.json"),
        manifest: join(root, "manifest.json"),
        receipt: join(root, "receipt.json"),
      },
    },
  };
  function add(id, value, extra = {}) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const sourceBinding = extra.scope === "lifecycle" ? historyBinding : binding;
    const file = {
      id,
      scope: "terminal",
      sourcePath: join(root, "sources", id),
      originalPath: join(root, "originals", id),
      backupPath: join(root, "backups", id),
      encoding: "utf8",
      bytes: bytes.length,
      sha256: sha256(bytes),
      safety: { reviewer: "synthetic-safety-review", sha256: sha256(bytes) },
      origin: {
        method: "GET",
        url: `https://synthetic.invalid/retained/${id}`,
        apiVersion: "synthetic/v1",
        status: 200,
        headers: { "content-type": "application/json" },
        startedAt: "2030-01-01T01:00:18Z",
        completedAt: "2030-01-01T01:00:19Z",
        expiresAt: "2030-01-02T00:00:00Z",
        sourceHash: binding.helperHash,
        workflowHead: sourceBinding.workflowHead,
        release: sourceBinding.release,
        digest: sourceBinding.digest,
        runId: noV ? binding.census.id : sourceBinding.verification.id,
        attempt: noV ? binding.census.attempt : sourceBinding.verification.attempt,
        jobId: noV ? null : f.envelope.sourceMap.jobId,
        step: noV ? null : "Synthetic retained owning source",
        namespaceUid: noV ? null : sourceBinding.uid,
        nodeUid: noV ? null : extra.scope === "lifecycle" ? historyBinding.nodeUid : plan.nodeUid,
        containerUid: noV ? null : "synthetic-api",
        evidencePointer: "",
      },
      ...extra,
    };
    if (!Buffer.isBuffer(value) && value?.url && typeof value.body === "string") {
      Object.assign(file.origin, {
        url: value.url,
        method: value.method,
        apiVersion: value.apiVersion,
        status: value.status,
        headers: value.headers,
        startedAt: value.captureStartedAt,
        completedAt: value.captureCompletedAt,
      });
    } else if (Buffer.isBuffer(value)) {
      try {
        const record = JSON.parse(value.toString("utf8"));
        if (record?.url && typeof record.body === "string")
          Object.assign(file.origin, {
            url: record.url,
            method: record.method,
            apiVersion: record.apiVersion,
            status: record.status,
            headers: record.headers,
            startedAt: record.captureStartedAt,
            completedAt: record.captureCompletedAt,
          });
      } catch {}
    }
    plan.files.push(file);
    writeFileSync(file.sourcePath, bytes);
    return file;
  }
  for (const [i, file] of f.envelope.files.entries()) {
    const added = add(`reader-${i}`, Buffer.from(file.original), { readerPath: file.path });
    if (file.path === "source-workflow") plan.sourceGraph.workflowId = added.id;
    if (file.path === "source-helper") plan.sourceGraph.helperId = added.id;
    if (file.path === "source-action") plan.sourceGraph.actionIds.push(added.id);
  }
  add("envelope", f.envelope);
  add("admitted", f.admitted);
  const events = noV ? [] : JSON.parse(f.envelope.files.find((file) => file.path === "synthetic-events.json").original);
  const eventFile = plan.files.find((file) => file.readerPath === "synthetic-events.json");
  for (const [i, event] of events.entries())
    plan.clockMappings.push({
      kind: event.kind,
      fileId: eventFile.id,
      pointer: `/${i}`,
      sourcePointer: `/${i}`,
      delivery: sha256(`${eventFile.sha256}:/${i}:${event.kind}`),
    });
  if (!noV) {
    const resources = [
      { kind: "Namespace", uid: historyBinding.uid, createdAt: start, finalizedAt: end },
      { kind: "Node", uid: historyBinding.nodeUid, createdAt: start, finalizedAt: end },
      { kind: "Pod", uid: "synthetic-pod", createdAt: start, finalizedAt: end },
      ...["api", "worker"].map((role) => {
        const log = add(`${role}-log`, Buffer.from(`synthetic whole ${role} log\n`), {
          scope: "lifecycle",
          log: { ownerUid: `synthetic-${role}`, generation: 0, rotation: 0 },
        });
        log.origin.containerUid = log.log.ownerUid;
        return {
          kind: "Container",
          uid: `synthetic-${role}`,
          createdAt: start,
          finalizedAt: end,
          generations: [{ number: 0, rotations: [{ number: 0, bytes: log.bytes, sha256: log.sha256 }] }],
        };
      }),
      { kind: "Producer", uid: "synthetic-owning-producer", createdAt: start, finalizedAt: end },
    ];
    for (const resource of resources)
      if (["Pod", "Container", "Producer"].includes(resource.kind))
        resource.identity = {
          runId: historyBinding.verification.id,
          attempt: historyBinding.verification.attempt,
          namespaceUid: historyBinding.uid,
          nodeUid: historyBinding.nodeUid,
          digest: historyBinding.digest,
        };
    const lifecycleEvents = [
      "NamespaceCreated",
      "NodeReady",
      "Scheduled",
      "Pulling",
      "Pulled",
      "Started",
      "PodReady",
      "NamespaceDeleting",
      "NamespaceDeleted",
    ];
    add(
      "inventory",
      { binding: historyBinding, resources, eventCount: lifecycleEvents.length },
      { scope: "lifecycle" },
    );
    const records = [
      ...resources.flatMap((r) => [
        { kind: r.kind, uid: r.uid, identity: r.identity, action: "created", at: start },
        { kind: r.kind, uid: r.uid, identity: r.identity, action: "finalized", at: end },
      ]),
      ...lifecycleEvents.map((reason, index) => ({
        kind: "Event",
        uid: `synthetic-c1-event-${index}`,
        action: "observed",
        at: end,
        reason,
      })),
    ];
    add(
      "history",
      {
        binding: historyBinding,
        startedAt: start,
        completedAt: end,
        retainedFrom: start,
        expiresAt: "2030-01-02T00:00:00Z",
        fromResourceVersion: "synthetic-rv-start",
        resourceVersion: "synthetic-rv-end",
        page: 1,
        totalPages: 1,
        totalCount: records.length,
        records,
      },
      { scope: "lifecycle" },
    );
  }
  for (const role of noV ? [] : ["census", "verification"]) {
    const owner = binding[role];
    const name =
      role === "census"
        ? `preview-pool-census-${owner.id}-${owner.attempt}`
        : `ephemeral-verification-${binding.release}-${owner.id}-${owner.attempt}`;
    const id = role === "census" ? 900000000000301 : 900000000000302;
    const payload = add(
      `${role}-payload`,
      role === "census"
        ? {
            schemaVersion: "preview-pool-census/v1",
            result: "success",
            mode: "sample",
            startedAt: "2030-01-01T00:12:00Z",
            finishedAt: "2030-01-01T00:57:00Z",
            containers: [{ namespace: binding.namespace }],
            errors: [],
            thinSamples: [],
            intervalSeconds: 10,
            durationMinutes: 45,
            lowerBound: "synthetic sampled lower bounds",
            nodes: [],
            namespaces: [],
            events: [],
            autoscalerStatus: null,
          }
        : {
            schemaVersion: "ephemeral-verification/v1",
            releaseCommit: binding.release,
            imageDigest: binding.digest,
            workflowRunId: String(owner.id),
            workflowRunAttempt: String(owner.attempt),
            namespace: binding.namespace,
            imageRepository: "synthetic/release",
            producerRunId: null,
            producerRunAttempt: null,
            trigger: "workflow_dispatch",
            result: "success",
            failurePhase: null,
            teardownResult: f.envelope.namespace.deleted ? "success" : "failure",
            persistentStagingResult: "not-run",
            persistentStagingRetained: true,
            workloads: ["representative-commerce-state", "platform-smoke", "stripe-money-smoke"],
            checkedAt: end,
          },
    );
    const payloadName = role === "census" ? "preview-pool-census.json" : "ephemeral-verification.json";
    const archive = add(`${role}-archive`, syntheticZip([[payloadName, readFileSync(payload.sourcePath)]]), {
      encoding: "binary",
      artifactArchive: true,
    });
    add(
      `${role}-artifacts`,
      raw(`https://api.github.com/repos/${repository}/actions/runs/${owner.id}/artifacts?per_page=100&page=1`, {
        total_count: 1,
        artifacts: [
          {
            id,
            name,
            expired: false,
            workflow_run: { id: owner.id },
            digest: `sha256:${archive.sha256}`,
            size_in_bytes: archive.bytes,
          },
        ],
      }),
    );
    plan.artifacts.push({
      role,
      id,
      name,
      runId: owner.id,
      attempt: owner.attempt,
      pages: [`${role}-artifacts`],
      archiveId: archive.id,
      archiveHash: archive.sha256,
      payloadId: `${role}-payload`,
      payloadName,
    });
  }
  if (noV) {
    delete plan.nodeUid;
    delete plan.history;
  }
  const planFile = join(root, "plan.json");
  const save = () => writeFileSync(planFile, JSON.stringify(plan));
  const replace = (id, value) => {
    const file = plan.files.find((entry) => entry.id === id);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    writeFileSync(file.sourcePath, bytes);
    file.bytes = bytes.length;
    file.sha256 = sha256(bytes);
    file.safety.sha256 = file.sha256;
  };
  const replaceArchive = (entries, method = 0) => {
    replace("verification-archive", syntheticZip(entries, method));
    const archive = plan.files.find((file) => file.id === "verification-archive");
    plan.artifacts.find((artifact) => artifact.role === "verification").archiveHash = archive.sha256;
    const page = plan.files.find((file) => file.id === "verification-artifacts");
    const response = JSON.parse(readFileSync(page.sourcePath));
    const body = JSON.parse(response.body);
    body.artifacts[0].digest = `sha256:${archive.sha256}`;
    body.artifacts[0].size_in_bytes = archive.bytes;
    replace(page.id, raw(response.url, body));
    save();
  };
  save();
  const backup = {
    custodian: plan.backup.custodian,
    async retain(request) {
      // This independent native fixture process sees only named files and an isolation sentinel.
      const files = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "-e",
            'const fs=require("node:fs"),crypto=require("node:crypto");if(process.env.SYNTHETIC_ISOLATION_SENTINEL!=="custody-only")throw Error("isolation");const files=JSON.parse(fs.readFileSync(0,"utf8"));const result=files.map(f=>{fs.writeFileSync(f.backupPath,fs.readFileSync(f.originalPath),{flag:"wx"});const b=fs.readFileSync(f.backupPath);return {path:f.backupPath,bytes:b.length,sha256:crypto.createHash("sha256").update(b).digest("hex")}});process.stdout.write(JSON.stringify(result));',
          ],
          {
            encoding: "utf8",
            input: JSON.stringify(request.files),
            env: { SystemRoot: process.env.SystemRoot ?? "", PATH: "", SYNTHETIC_ISOLATION_SENTINEL: "custody-only" },
          },
        ),
      );
      const payload = {
        planHash: request.planHash,
        custodian: plan.backup.custodian,
        captureStartedAt: request.startedAt,
        acknowledgedAt: now,
        retainUntil: plan.retainUntil,
        files,
      };
      return {
        payload,
        signature: sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString("base64"),
      };
    },
  };
  const input = () => ({
    planFile,
    authority: { approvedPlanHash: sha256(readFileSync(planFile)), performer: plan.performer },
  });
  return {
    root,
    plan,
    planFile,
    save,
    add,
    replace,
    replaceArchive,
    input,
    capabilities: { backup, now: () => now },
    run: () => acquireRetainedC1Evidence(input(), { backup, now: () => now }),
  };
}

async function scheduledFixture(change = () => {}, noV = false) {
  const f = fixture();
  f.envelope.ack.at = "2030-01-01T01:00:20Z";
  f.envelope.schedule.deadlineUtc = "2030-01-01T02:30:00.000Z";
  change(f);
  if (noV) withoutVerification(f);
  else retain(f);
  const custody = custodyFor(f),
    observation = admissionFixture(),
    root = sandbox();
  const plan = {
    root,
    oneFreshArm: { consumed: false, dispatch: null },
    roles: Object.fromEntries(
      Object.entries(f.envelope.custodians).map(([role, identity]) => [
        role,
        {
          identity,
          capabilityHash: generatedHash(`ready-${role}`),
        },
      ]),
    ),
    original: { custodian: custody.plan.original.custodian, destination: custody.plan.original.prefix },
    backup: { custodian: custody.plan.backup.custodian, destination: custody.plan.backup.prefix },
    histories: copy(f.envelope.histories),
    observationBinding: copy(observation.input.admitted),
    validFrom: "2030-01-01T00:00:00Z",
    expiresAt: "2030-01-02T00:00:00Z",
  };
  const authority = { approvedPlanHash: sha256(JSON.stringify(plan)) },
    bridge = { root, authority };
  const capability = (value) => ({
    ...value,
    acknowledge: ({ planHash }) => ({ ...value, planHash, at: plan.validFrom, expiresAt: plan.expiresAt }),
  });
  expect(
    (
      await admitScheduleRoles(
        { ...bridge, plan },
        {
          roles: Object.fromEntries(Object.entries(plan.roles).map(([key, value]) => [key, capability(value)])),
          custody: { original: capability(plan.original), backup: capability(plan.backup) },
          now: () => plan.validFrom,
        },
      )
    ).state,
  ).toBe("READY");
  delete custody.plan.history;
  custody.plan.files = custody.plan.files.filter((file) => file.scope === "terminal");
  custody.plan.handoff = {
    initialPath: join(root, "initial-snapshot.json"),
    initialHash: sha256(readFileSync(join(root, "initial-snapshot.json"))),
    readinessPath: join(root, "readiness.json"),
    readinessHash: sha256(readFileSync(join(root, "readiness.json"))),
  };
  custody.save();
  if (!noV) {
    const prepared = prepareScheduleSnapshot(
      { ...bridge, binding: f.envelope.binding, seal: f.envelope.seal, rawD: "2030-01-01T01:00:00Z" },
      { now: () => "2030-01-01T01:00:00Z" },
    );
    expect(prepared.state).toBe("PREPARED");
  }
  let at = "2030-01-01T01:00:20Z";
  let previous;
  let writer;
  return {
    f,
    custody,
    observation,
    bridge,
    plan,
    get writer() {
      return writer;
    },
    setAt: (value) => {
      at = value;
    },
    run: async () => {
      const result = await acquireScheduledC1Evidence(custody.input(), bridge, {
        ...custody.capabilities,
        now: () => at,
      });
      if (result.events) {
        previous = result.previous;
        writer = openScheduleBridgeWriter(bridge);
        expect(typeof writer.append).toBe("function");
      }
      return result;
    },
    append(kind, payload, id, time = at, expectedPrevious) {
      at = time;
      const result = writer.append(
        { ...bridge, expectedPrevious: expectedPrevious ?? previous, event: { id, kind, at, payload } },
        { now: () => at },
      );
      if (result.events) previous = result.previous;
      return result;
    },
    payload(slot, state = "REFUSED", nodeUid = "synthetic-node") {
      const at = new Date(Date.parse("2030-01-01T01:00:00Z") + slot * 30000 + 21000).toISOString();
      const snapshot = {
        ...plan.observationBinding,
        slot: { index: slot, startedAt: slot * 30000, deadline: (slot + 1) * 30000 },
        elapsedMs: 0,
        reads: ["nodes", "namespaces", "pods", "events", "configmap"].map((resource) => ({
          resource,
          startedAt: at,
          completedAt: at,
        })),
        inventory: [{ synthetic: true }],
      };
      return {
        state,
        reasons: state === "ADMITTED" ? [] : ["SYNTHETIC_NEGATIVE"],
        nodeUid,
        snapshot,
        snapshotHash: sha256(JSON.stringify(snapshot)),
      };
    },
  };
}

describe("qualified handoff state", () => {
  function oldCustody(input, custodian, mutation) {
    let source = readFileSync(new URL("./c1-evidence-custody.mjs", import.meta.url), "utf8");
    const change = mutation === "origin" ? "(noV" : 'if (Object.hasOwn(plan, "handoff"))';
    expect(source.includes(change)).toBe(true);
    source = source.replace(change, mutation === "origin" ? "(false" : "if (false)");
    for (const name of ["census-terminal-evidence.mjs", "release-health-delivery-health.mjs"])
      source = source.replace(`"./${name}"`, JSON.stringify(new URL(`./${name}`, import.meta.url).href));
    const path = join(sandbox(), "synthetic-reverted-custody.mjs");
    writeFileSync(path, source, { flag: "wx" });
    const script = `import {retainC1Evidence} from ${JSON.stringify(pathToFileURL(path).href)};
      if(process.env.SYNTHETIC_ISOLATION_SENTINEL!=="custody-mutant-only")throw Error("synthetic-isolation");
      const input=JSON.parse(process.argv[1]);
      const result=await retainC1Evidence(input,{requireConsumption:true,now:()=>"2030-01-01T01:00:20Z",
        backup:{custodian:process.argv[2],retain(){throw Error("synthetic-not-reached")}}});
      process.stdout.write(JSON.stringify(result));`;
    return JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(input), custodian], {
        encoding: "utf8",
        env: {
          SystemRoot: process.env.SystemRoot ?? "",
          PATH: "",
          SYNTHETIC_ISOLATION_SENTINEL: "custody-mutant-only",
        },
      }),
    );
  }
  it.each([false, true])("custody repair reverted is governing-predicate red for handoff no-V=%s", async (noV) => {
    const s = await scheduledFixture(() => {}, noV);
    const old = oldCustody(s.custody.input(), s.custody.plan.backup.custodian, noV ? "origin" : "history");
    expect(old.state).toBe("STOP");
    expect(old.missing).toEqual([noV ? `CAUSAL_SOURCE:${s.custody.plan.files[0].id}` : "C1_HISTORY_BINDING"]);
    expect(old.partial).toBe(false);
    console.info("CUSTODY_REPAIR_REVERTED_RED", JSON.stringify({ noV, missing: old.missing }));
    expect((await s.run()).state).toBe(noV ? "NO_BRACKET_NO_T0" : "WAITING");
  });
  function refreshTerminal(s) {
    const e = s.f.envelope,
      facts = e.files.find((f) => f.path === "facts.json");
    const value = JSON.parse(facts.original);
    for (const key of Object.keys(value)) value[key] = e[key];
    facts.original = facts.backup = JSON.stringify(value);
    const dispatch = e.files.find((f) => f.path === "synthetic-dispatch.json");
    dispatch.original = dispatch.backup = JSON.stringify(e.dispatch);
    admitFiles(s.f);
    for (const file of s.custody.plan.files.filter((f) => f.readerPath !== undefined))
      s.custody.replace(file.id, Buffer.from(e.files.find((f) => f.path === file.readerPath).original));
    s.custody.replace("envelope", e);
    s.custody.replace("admitted", s.f.admitted);
    s.custody.save();
  }
  it.each(["completed", "c-never-captured", "admission-refused", "nonterminal"])(
    "retains affirmative no-V %s through acquisition and bridge without inventing V or C producers",
    async (shape) => {
      const s = await scheduledFixture((f) => {
        if (shape === "c-never-captured") {
          for (const phase of ["capture", "consumption"]) delete f.envelope[phase].census;
          delete f.envelope.jobs.census;
        } else if (shape !== "completed") {
          for (const phase of ["capture", "consumption"])
            f.envelope[phase].census = f.envelope[phase].census.map((record) =>
              mutateRecord(record, (body) => {
                body.status = shape === "admission-refused" ? "queued" : "in_progress";
                body.conclusion = null;
              }),
            );
          if (shape === "admission-refused") {
            f.envelope.dispatch.admissionRefused = true;
            delete f.envelope.consumption.census;
            f.envelope.jobs.census = jobSet(f.envelope.binding.census, []);
          } else {
            const jobs = f.envelope.jobs.census.details.map((record) => JSON.parse(record.body));
            Object.assign(jobs[0], { status: "in_progress", conclusion: null, completed_at: null });
            jobs[0].steps = jobs[0].steps.slice(0, 4);
            Object.assign(jobs[0].steps.at(-1), { status: "in_progress", conclusion: null, completed_at: null });
            f.envelope.jobs.census = jobSet(f.envelope.binding.census, jobs);
          }
        }
      }, true);
      const acquired = await s.custody.run();
      expect(acquired.state, JSON.stringify(acquired)).toBe("MATERIALIZED");
      expect(acquired.receipt).toEqual(read(s.f));
      const manifest = JSON.parse(readFileSync(acquired.custodyManifestPath));
      expect(Object.hasOwn(manifest, "history")).toBe(false);
      expect(manifest.clocks).toEqual([]);
      for (const f of s.custody.plan.files) {
        expect(f.origin).toMatchObject({
          namespaceUid: null,
          nodeUid: null,
          containerUid: null,
          jobId: null,
          step: null,
          runId: s.f.envelope.binding.census.id,
          attempt: s.f.envelope.binding.census.attempt,
        });
      }
      for (const file of manifest.files) {
        expect(sha256(readFileSync(file.originalPath))).toBe(file.sha256);
        expect(sha256(readFileSync(file.backupPath))).toBe(file.sha256);
      }
      const result = await s.run();
      expect(result).toMatchObject({
        state: "NO_BRACKET_NO_T0",
        t0Utc: null,
        c1Schedule: "NOT_STARTED",
        newOpportunities: 0,
      });
      expect(result.receipt.c1Admission).not.toBe(true);
      expect(await s.run()).toEqual(result);
      expect(await s.custody.run()).toEqual(acquired);
    },
  );

  it.each(["namespaceUid", "nodeUid", "containerUid", "jobId", "step", "plan.nodeUid", "runId", "attempt"])(
    "no-V governing-only origin mutant %s",
    async (field) => {
      const s = await scheduledFixture(() => {}, true),
        file = s.custody.plan.files[0];
      if (field === "plan.nodeUid") s.custody.plan.nodeUid = "synthetic-invented";
      else file.origin[field] = ["runId", "attempt"].includes(field) ? 900000000000999 : "synthetic-invented";
      s.custody.save();
      const result = await s.custody.run();
      expect(result.state).toBe("STOP");
      expect(result.missing).toEqual([
        `${["runId", "attempt"].includes(field) ? "SOURCE_ATTEMPT" : "CAUSAL_SOURCE"}:${file.id}`,
      ]);
      expect(result.partial).toBe(false);
      expect((await s.run()).reasons).toEqual(["STOP_COMPLETE_CUSTODY"]);
    },
  );
  it.each(["capture-start", "verification-dispatched"])(
    "no-V invented clock %s refuses at applicability",
    async (kind) => {
      const s = await scheduledFixture(() => {}, true);
      s.custody.plan.clockMappings = [
        { kind, fileId: "envelope", pointer: "", sourcePointer: "", delivery: generatedHash(kind) },
      ];
      s.custody.save();
      expect((await s.custody.run()).missing).toEqual(["NO_V_CLOCK_SOURCES"]);
      expect((await s.run()).reasons).toEqual(["STOP_COMPLETE_CUSTODY"]);
    },
  );
  it.each(["census", "verification"])("no-V %s artifact refuses even with completed C", async (role) => {
    const s = await scheduledFixture(() => {}, true);
    s.custody.plan.artifacts = [{ role }];
    s.custody.save();
    expect((await s.custody.run()).missing).toEqual(["TERMINAL_ARTIFACT_COVERAGE"]);
    expect((await s.run()).reasons).toEqual(["STOP_COMPLETE_CUSTODY"]);
  });
  it.each([false, true])("handoff real/no-V=%s refuses any c1 history", async (noV) => {
    const s = await scheduledFixture(() => {}, noV);
    s.custody.plan.history = {};
    s.custody.save();
    expect((await s.custody.run()).missing).toEqual(["HANDOFF_HISTORY"]);
    expect((await s.run()).reasons).toEqual(["STOP_COMPLETE_CUSTODY"]);
  });
  it.each(["unbound", "consumed", "dispatch", "changed bytes"])(
    "handoff cannot be selected by absence or flag: %s",
    async (attack) => {
      const s = await scheduledFixture();
      if (attack === "unbound") delete s.custody.plan.handoff;
      else {
        const path = s.custody.plan.handoff.initialPath,
          initial = JSON.parse(readFileSync(path));
        if (attack === "consumed") initial.oneFreshArm.consumed = true;
        else if (attack === "dispatch") initial.armDispatch = { runId: 900000000000999, attempt: 1 };
        else initial.at = "2030-01-01T00:00:01Z";
        writeFileSync(path, JSON.stringify(initial));
        if (attack !== "changed bytes") s.custody.plan.handoff.initialHash = sha256(readFileSync(path));
      }
      s.custody.save();
      expect((await s.custody.run()).missing).toEqual([
        attack === "unbound"
          ? "C1_HISTORY_BINDING"
          : attack === "changed bytes"
            ? "HANDOFF_SNAPSHOT_BYTES"
            : "HANDOFF_MOMENT",
      ]);
    },
  );
  it.each(["original", "backup", "substitution", "replay"])(
    "no-V stale/conflicting custody %s is not N7",
    async (attack) => {
      const s = await scheduledFixture(() => {}, true);
      expect((await s.run()).state).toBe("NO_BRACKET_NO_T0");
      const file = s.custody.plan.files[0];
      if (attack === "original") rmSync(file.originalPath);
      else if (attack === "backup") rmSync(file.backupPath);
      else if (attack === "substitution") writeFileSync(file.originalPath, "synthetic-substitution");
      else {
        const manifest = JSON.parse(readFileSync(s.custody.plan.manifestPath));
        manifest.terminal.facts.reasons = ["synthetic-conflict"];
        writeFileSync(s.custody.plan.manifestPath, JSON.stringify(manifest));
      }
      expect((await s.run()).state).toBe("STOP");
      expect((await s.custody.run()).state).toBe("STOP");
    },
  );
  it("no-V withheld backup capability refuses before any write", async () => {
    const s = await scheduledFixture(() => {}, true);
    delete s.custody.capabilities.backup;
    expect((await s.run()).state).toBe("STOP");
    expect(existsSync(s.custody.plan.original.prefix)).toBe(false);
  });
  it.each(["unknown dispatch", "contradictory dispatch", "inserted V identity"])(
    "no-V %s refuses at reader applicability, not a missing artifact",
    async (attack) => {
      const s = await scheduledFixture(() => {}, true);
      if (attack === "unknown dispatch") s.f.envelope.dispatch.verificationDispatched = null;
      if (attack === "contradictory dispatch") s.f.envelope.dispatch.verificationDispatched = true;
      if (attack === "inserted V identity")
        s.f.envelope.binding.verification = copy(fixture().envelope.binding.verification);
      refreshTerminal(s);
      const expected = read(s.f);
      expect(expected.bracketState).toBe("STOP");
      expect((await s.custody.run()).missing).toEqual([`TERMINAL_APPLICABILITY:${expected.reasons[0]}`]);
      expect((await s.run()).reasons).toEqual(["STOP_COMPLETE_CUSTODY"]);
    },
  );
  it("each no-V eligible source omission refuses with every other input valid", async () => {
    const s = await scheduledFixture(() => {}, true);
    for (const file of s.custody.plan.files) {
      const bytes = readFileSync(file.sourcePath);
      rmSync(file.sourcePath);
      const result = await s.custody.run();
      expect(result.state, file.id).toBe("STOP");
      expect(result.partial, file.id).toBe(false);
      expect(existsSync(s.custody.plan.original.prefix)).toBe(false);
      writeFileSync(file.sourcePath, bytes, { flag: "wx" });
    }
    expect((await s.run()).state).toBe("NO_BRACKET_NO_T0");
  });
  it("each no-V independent backup omission refuses on replay without rewriting it", async () => {
    const s = await scheduledFixture(() => {}, true);
    expect((await s.run()).state).toBe("NO_BRACKET_NO_T0");
    const manifest = JSON.parse(readFileSync(s.custody.plan.manifestPath));
    for (const file of manifest.files) {
      const bytes = readFileSync(file.backupPath);
      rmSync(file.backupPath);
      expect((await s.run()).state, file.id).toBe("STOP");
      expect(existsSync(file.backupPath)).toBe(false);
      writeFileSync(file.backupPath, bytes, { flag: "wx" });
    }
    expect((await s.run()).state).toBe("NO_BRACKET_NO_T0");
  });
  it.each(["source", "artifact", "clock", "history"])(
    "real-V post-arm governing-only %s refusal stays",
    async (attack) => {
      const c = custodyFor(fixture());
      let reason;
      if (attack === "source") {
        c.plan.files[0].origin.nodeUid = "synthetic-wrong";
        reason = `CAUSAL_SOURCE:${c.plan.files[0].id}`;
      }
      if (attack === "artifact") {
        c.plan.artifacts.pop();
        reason = "TERMINAL_ARTIFACT_COVERAGE";
      }
      if (attack === "clock") {
        c.plan.clockMappings[0].pointer = "/1";
        reason = "CLOCK_CAUSALITY:capture-start";
      }
      if (attack === "history") {
        delete c.plan.history;
        c.plan.files = c.plan.files.filter((f) => f.scope === "terminal");
        reason = "C1_HISTORY_BINDING";
      }
      c.save();
      expect((await c.run()).missing).toEqual([reason]);
    },
  );
});

function advancingClock(at) {
  const base = Date.parse(at),
    started = Date.now();
  let elapsed = 0;
  return () => {
    elapsed = Math.max(elapsed + 1, Date.now() - started);
    return new Date(base + elapsed).toISOString();
  };
}

describe("D-bound receipt bridge", () => {
  it("F1 synthetic advancing clock consumes full custody and durably acknowledges within the cutoff", async () => {
    const s = await scheduledFixture();
    const advancing = advancingClock(s.f.envelope.ack.at);
    const now = () => (existsSync(s.custody.plan.manifestPath) ? advancing() : s.custody.capabilities.now());
    const result = await acquireScheduledC1Evidence(s.custody.input(), s.bridge, { ...s.custody.capabilities, now });
    expect(result.state, JSON.stringify(result.reasons)).toBe("WAITING");
    const acknowledged = JSON.parse(readFileSync(join(s.bridge.root, "acknowledgement.json")));
    expect(Date.parse(acknowledged.consumedAt)).toBeGreaterThan(Date.parse(acknowledged.ack.at));
    expect(result.ackAt).toBe(acknowledged.consumedAt);
    expect(existsSync(join(s.bridge.root, "acknowledgement-complete.json"))).toBe(true);
    expect(result).toMatchObject(reconstructScheduleBridge(s.bridge));
    expect(
      (await acquireScheduledC1Evidence(s.custody.input(), s.bridge, { ...s.custody.capabilities, now })).state,
    ).toBe("WAITING");
  });
  it.each(["2030-01-01T01:00:30Z", "2030-01-01T01:00:30.001Z"])(
    "F1 refuses final custody consumption at or past cutoff %s despite an earlier source ack",
    async (at) => {
      const s = await scheduledFixture();
      const result = await acquireScheduledC1Evidence(s.custody.input(), s.bridge, {
        ...s.custody.capabilities,
        now: () => (existsSync(s.custody.plan.manifestPath) ? at : s.custody.capabilities.now()),
      });
      expect(result.reasons).toEqual(["STOP_ACTUAL_ACK_TIME"]);
      expect(existsSync(join(s.bridge.root, "acknowledgement.json"))).toBe(false);
    },
  );
  it("F1 synthetic advancing clock tolerates the acknowledgement write crossing a millisecond", async () => {
    const s = await scheduledFixture(),
      advancing = advancingClock(s.f.envelope.ack.at);
    const result = await acquireScheduledC1Evidence(s.custody.input(), s.bridge, {
      ...s.custody.capabilities,
      now: () => (existsSync(join(s.bridge.root, "acknowledgement.json")) ? advancing() : s.f.envelope.ack.at),
    });
    expect(result.state, JSON.stringify(result.reasons)).toBe("WAITING");
    expect(existsSync(join(s.bridge.root, "acknowledgement-complete.json"))).toBe(true);
  });
  it("F1 refuses an acknowledgement durable past the cutoff with truthful partial evidence", async () => {
    const s = await scheduledFixture();
    const result = await acquireScheduledC1Evidence(s.custody.input(), s.bridge, {
      ...s.custody.capabilities,
      now: () =>
        !existsSync(s.custody.plan.manifestPath)
          ? s.custody.capabilities.now()
          : existsSync(join(s.bridge.root, "acknowledgement.json"))
            ? "2030-01-01T01:00:30.001Z"
            : "2030-01-01T01:00:29.999Z",
    });
    expect(result.reasons).toEqual(["STOP_ACK_WRITE_DELAY"]);
    expect(result.partial).toBe(true);
    expect(existsSync(join(s.bridge.root, "acknowledgement.json"))).toBe(true);
    expect(existsSync(join(s.bridge.root, "acknowledgement-complete.json"))).toBe(false);
    expect(reconstructScheduleBridge(s.bridge).state).toBe("STOP");
  });
  it("consumes full production custody and reader at actual ack, preserves exact D and null C", async () => {
    const s = await scheduledFixture(),
      result = await s.run();
    expect(result.state, JSON.stringify(result)).toBe("WAITING");
    expect(result.receipt.cRunTerminal.utc).toBe(null);
    expect(result.t0Utc).toBe("2030-01-01T01:00:00Z");
    expect(result.receipt.c1Admission).toBe(null);
    expect((await s.run()).state).toBe("WAITING");
  });
  it.each(["2030-01-01T00:59:59Z", "2030-01-01T01:00:30Z", "2030-01-01T01:00:31Z"])(
    "refuses actual consumption at %s without shifting D",
    async (at) => {
      const s = await scheduledFixture();
      s.setAt(at);
      const result = await s.run();
      expect(result.state).toBe("STOP");
      expect(result.t0Utc).toBe(null);
      expect(result.c1Schedule).toBe("NOT_STARTED");
    },
  );
  it("refuses provisional ack when independently delayed final evidence reaches the cutoff", async () => {
    const s = await scheduledFixture((f) => {
      f.envelope.ack.at = "2030-01-01T01:00:15Z";
    });
    const result = await acquireScheduledC1Evidence(s.custody.input(), s.bridge, {
      ...s.custody.capabilities,
      now: () => (existsSync(s.custody.plan.manifestPath) ? "2030-01-01T01:00:30Z" : s.custody.capabilities.now()),
    });
    expect(result.reasons).toContain("STOP_ACTUAL_ACK_TIME");
  });
  it.each(["wrong custodian", "wrong schedule", "missing final backup"])(
    "governing-only omission: %s",
    async (attack) => {
      const s = await scheduledFixture();
      if (attack === "wrong custodian") s.custody.capabilities.backup.custodian = "synthetic-impostor";
      if (attack === "wrong schedule") {
        const path = join(s.bridge.root, "snapshot.json"),
          snapshot = JSON.parse(readFileSync(path));
        snapshot.schedule.persistedAt = "2030-01-01T01:00:01Z";
        writeFileSync(path, JSON.stringify(snapshot));
      }
      if (attack === "missing final backup") {
        expect((await s.run()).state).toBe("WAITING");
        rmSync(s.custody.plan.files.at(-1).backupPath);
      }
      expect((await s.run()).state).toBe("STOP");
    },
  );
  it("qualified failed sizing and failed delete still hand off, without positive c1 admission", async () => {
    const s = await scheduledFixture((f) => {
      changeDelete(f, (step) => {
        step.conclusion = "failure";
      });
      f.envelope.namespace.deleted = false;
    });
    const result = await s.run();
    expect(result.state, JSON.stringify(result)).toBe("WAITING");
    expect(result.receipt.cleanupSucceeded).toBe(false);
    expect(result.c1Admission).toBe(false);
    const p = s.payload(0, "ADMITTED");
    expect(s.append("READ", p, "read-0", p.snapshot.reads[0].completedAt).pending).toBe(null);
  });
});

describe("window transition", () => {
  it("F2 synthetic advancing clock permits a writer READ in the same original grid slot", async () => {
    const s = await scheduledFixture();
    const initial = await s.run(),
      payload = s.payload(0);
    const now = advancingClock(payload.snapshot.reads[0].completedAt),
      at = now();
    const result = s.writer.append(
      { ...s.bridge, expectedPrevious: initial.previous, event: { id: "advancing-read", kind: "READ", at, payload } },
      { now },
    );
    expect(result.state, JSON.stringify(result.reasons)).toBe("WAITING");
    expect(result.events).toHaveLength(1);
    expect(s.writer.close()).toEqual(reconstructScheduleBridge(s.bridge));
  });
  it("F2 synthetic advancing clock permits the production no-writer observation READ", async () => {
    const s = await scheduledFixture();
    await s.run();
    s.observation.input.slot.index = 0;
    s.observation.bodies.nodes.items = [];
    const result = await observeC1Schedule(s.observation.input, s.bridge, s.observation.producers, {
      clock: s.observation.clock,
      now: advancingClock("2030-01-01T01:00:21Z"),
    });
    expect(result.state, JSON.stringify(result.reasons)).toBe("WAITING");
    expect(result.events).toHaveLength(1);
    expect(result.verification).toBeUndefined();
    expect(result).toEqual(reconstructScheduleBridge(s.bridge));
  });
  it.each(["2030-01-01T01:00:20.999Z", "2030-01-01T01:00:30Z", "2030-01-01T02:30:00Z", "2030-01-01T02:30:00.001Z"])(
    "F2 refuses future stamps or an append in a later slot or at/past deadline: %s",
    async (actual) => {
      const s = await scheduledFixture();
      const initial = await s.run(),
        payload = s.payload(0);
      const result = s.writer.append(
        {
          ...s.bridge,
          expectedPrevious: initial.previous,
          event: { id: "out-of-time", kind: "READ", at: payload.snapshot.reads[0].completedAt, payload },
        },
        { now: () => actual },
      );
      expect(result.reasons).toEqual(["STOP_STALE_PREDECESSOR_OR_TIME"]);
      expect(reconstructScheduleBridge(s.bridge).events).toHaveLength(0);
      expect(s.writer.read().state).toBe("WAITING");
    },
  );
  it("closes a no-supplied-writer non-pending production observation independently", async () => {
    const s = await scheduledFixture();
    await s.run();
    s.observation.input.slot.index = 0;
    s.observation.bodies.nodes.items = [];
    const result = await observeC1Schedule(s.observation.input, s.bridge, s.observation.producers, {
      clock: s.observation.clock,
      now: () => "2030-01-01T01:00:21.000Z",
    });
    expect(result.state).toBe("WAITING");
    expect(result.pending).toBe(null);
    expect(result.verification).toBeUndefined();
    expect(result).toEqual(reconstructScheduleBridge(s.bridge));
  });
  it("retains 180 actual complete negatives on the original grid and refuses further reads", async () => {
    const s = await scheduledFixture();
    expect((await s.run()).state).toBe("WAITING");
    let result;
    for (let slot = 0; slot < 180; slot++) {
      const p = s.payload(slot);
      result = s.append("READ", p, `read-${slot}`, p.snapshot.reads[0].completedAt);
      expect(result.state, `slot ${slot}: ${JSON.stringify(result.reasons)}`).toBe(
        slot === 179 ? "REFUSED_THREE_WINDOWS_RETURN_TO_PLANNING_C" : "WAITING",
      );
    }
    expect(result.schedule.windows.map((w) => w.startSlot)).toEqual([0, 60, 120]);
    expect(result.schedule.windows.map((w) => w.reads.length)).toEqual([60, 60, 60]);
    expect(result.verification).toBeUndefined();
    const cold = reconstructScheduleBridge(s.bridge);
    expect(cold).toEqual(result);
    expect(cold.events).toHaveLength(180);
    expect(cold.events.map((event) => event.payload)).toEqual(
      Array.from({ length: 180 }, (_, slot) => s.payload(slot)),
    );
    const p = s.payload(180);
    expect(s.append("READ", p, "too-late", p.snapshot.reads[0].completedAt).state).toBe("STOP");
  });
  it("first incomplete ends each actual window; next begins on the next original slot", async () => {
    const s = await scheduledFixture();
    await s.run();
    for (let slot = 0; slot < 3; slot++) {
      const result = s.append(
        "READ",
        { state: "STOP", reasons: ["SYNTHETIC_INCOMPLETE"], nodeUid: null },
        `error-${slot}`,
        new Date(Date.parse("2030-01-01T01:00:21Z") + slot * 30000).toISOString(),
      );
      expect(result.schedule.windows[slot].ended).toBe(true);
      expect(result.state).toBe(slot === 2 ? "REFUSED_THREE_WINDOWS_RETURN_TO_PLANNING_C" : "WAITING");
    }
  });
  it("missed slot cannot be backfilled, and stale predecessor cannot consume a slot", async () => {
    const s = await scheduledFixture();
    const initial = await s.run(),
      p = s.payload(1);
    expect(s.append("READ", p, "missed", p.snapshot.reads[0].completedAt).state).toBe("STOP");
    const zero = s.payload(0);
    s.append("READ", zero, "read-0", zero.snapshot.reads[0].completedAt);
    expect(s.append("READ", p, "stale", p.snapshot.reads[0].completedAt, initial.previous).state).toBe("STOP");
    expect(reconstructScheduleBridge(s.bridge).events).toHaveLength(1);
  });
  it("same-UID recheck failure stays on the grid; incomplete recheck ends the window", async () => {
    const s = await scheduledFixture();
    await s.run();
    let p = s.payload(0, "ADMITTED");
    s.append("READ", p, "read-0", p.snapshot.reads[0].completedAt);
    let result = s.append("RECHECK", s.payload(0, "ADMITTED", "synthetic-replaced"), "recheck-0");
    expect(result.qualified).toBe(null);
    p = s.payload(1, "ADMITTED");
    s.append("READ", p, "read-1", p.snapshot.reads[0].completedAt);
    result = s.append("RECHECK", { state: "STOP", nodeUid: null, reasons: ["SYNTHETIC_INCOMPLETE"] }, "recheck-1");
    expect(result.schedule.windows[0].ended).toBe(true);
    expect(result.schedule.windows[1].startSlot).toBe(2);
  });
  it("deduplicates identical delivery, refuses conflict, reconstructs restart and consumes only one arm", async () => {
    const s = await scheduledFixture();
    await s.run();
    const p = s.payload(0, "ADMITTED");
    const first = s.append("READ", p, "read-0", p.snapshot.reads[0].completedAt);
    expect(s.append("READ", p, "read-0").events).toHaveLength(1);
    expect(s.append("READ", { ...p, nodeUid: "synthetic-conflict" }, "read-0").state).toBe("STOP");
    expect(reconstructScheduleBridge(s.bridge).previous).toBe(first.previous);
    const rechecked = s.append("RECHECK", p, "recheck-0");
    const claim = { executor: s.plan.roles.executor.identity, recheckHash: rechecked.qualified.recheckHash };
    expect(s.append("ARM_CLAIM", claim, "claim").state).toBe("ARM_UNCERTAIN");
    expect(s.append("READ", p, "read-again").state).toBe("STOP");
    expect(
      s.append(
        "ARM_CONFIRMED",
        { claimId: "claim", executor: claim.executor, runId: 900000000000200, attempt: 1 },
        "confirmed",
      ).state,
    ).toBe("CONSUMED");
    expect(reconstructScheduleBridge(s.bridge).state).toBe("CONSUMED");
    expect(s.append("ARM_CLAIM", claim, "second-claim").state).toBe("STOP");
  });
  it("whole production five-read observation immediately rechecks before any arm claim", async () => {
    const s = await scheduledFixture();
    await s.run();
    s.observation.input.slot.index = 0;
    const result = await observeC1Schedule(
      s.observation.input,
      { ...s.bridge, writer: s.writer },
      s.observation.producers,
      {
        clock: s.observation.clock,
        now: () => "2030-01-01T01:00:21.000Z",
      },
    );
    expect(result.state, JSON.stringify(result)).toBe("WAITING");
    expect(result.events.map((e) => e.kind)).toEqual(["READ", "RECHECK"]);
    expect(result.qualified.nodeUid).toBe("synthetic-node");
  });
});

describe("bounded writer regression", () => {
  const entryPath = (s, ordinal) => join(s.bridge.root, `transition-${String(ordinal).padStart(3, "0")}.json`);
  async function acknowledged() {
    const s = await scheduledFixture();
    expect((await s.run()).state).toBe("WAITING");
    return s;
  }
  function appendRead(s, slot, state = "REFUSED", id = `read-${slot}`) {
    const payload = s.payload(slot, state);
    return s.append("READ", payload, id, payload.snapshot.reads[0].completedAt);
  }
  function claim(s, previous, recheckHash, writer = s.writer) {
    const at = "2030-01-01T01:00:21.000Z";
    return writer.append(
      {
        ...s.bridge,
        expectedPrevious: previous,
        event: {
          id: "claim",
          kind: "ARM_CLAIM",
          at,
          payload: { executor: s.plan.roles.executor.identity, recheckHash },
        },
      },
      { now: () => at },
    );
  }
  it.each(
    [
      "readiness.json",
      "initial-snapshot.json",
      "snapshot.json",
      "acknowledgement.json",
      "acknowledgement-complete.json",
    ].flatMap((name) => ["bytes", "value"].map((attack) => ({ name, attack }))),
  )("live and cold readers reject $attack changes to $name", async ({ name, attack }) => {
    const s = await acknowledged();
    const reader = openScheduleBridgeWriter(s.bridge);
    const path = join(s.bridge.root, name),
      bytes = readFileSync(path);
    if (attack === "bytes") writeFileSync(path, Buffer.concat([bytes, Buffer.from(" ")]));
    else {
      const value = JSON.parse(bytes);
      if (name === "readiness.json") value.plan.roles.executor.identity = "synthetic-other";
      if (name === "initial-snapshot.json") value.histories.opportunity = generatedHash("other");
      if (name === "snapshot.json") value.histories.opportunity = generatedHash("other");
      if (name === "acknowledgement.json") value.ack.custodian = "synthetic-other";
      if (name === "acknowledgement-complete.json") value.acknowledgementHash = generatedHash("other");
      writeFileSync(path, JSON.stringify(value));
    }
    expect(appendRead(s, 0).reasons).toEqual(["STOP_WRITER_ANCHOR"]);
    expect(reader.close().state).toBe("STOP");
    expect(reconstructScheduleBridge(s.bridge).state).toBe("STOP");
    expect(existsSync(entryPath(s, 1))).toBe(false);
  });
  it.each(
    ["opportunity", "oneFreshArm", "sizingWindows", "lifetimeAttempts", "consumedHeads", "blockingRounds"].flatMap(
      (history) => ["omitted", "changed"].map((attack) => ({ history, attack })),
    ),
  )("refuses $attack independent history $history at every read boundary", async ({ history, attack }) => {
    const s = await acknowledged();
    const reader = openScheduleBridgeWriter(s.bridge);
    const path = join(s.bridge.root, "snapshot.json"),
      value = JSON.parse(readFileSync(path));
    if (attack === "omitted") delete value.histories[history];
    else value.histories[history] = generatedHash("substituted-history");
    writeFileSync(path, JSON.stringify(value));
    expect(appendRead(s, 0).state).toBe("STOP");
    expect(reader.close().state).toBe("STOP");
    expect(reconstructScheduleBridge(s.bridge).state).toBe("STOP");
  });
  it("binds root approval and opaque cursor while isolating caller-owned inputs and outputs", async () => {
    const s = await acknowledged(),
      other = await acknowledged();
    for (const bridge of [other.bridge, { ...s.bridge, authority: { approvedPlanHash: generatedHash("other") } }])
      expect(openScheduleBridgeWriter({ ...bridge, writer: s.writer }).reasons).toEqual(["STOP_WRITER_BINDING"]);
    expect(openScheduleBridgeWriter({ ...s.bridge, writer: { ...s.writer } }).state).toBe("STOP");
    const payload = s.payload(0),
      original = copy(payload),
      at = payload.snapshot.reads[0].completedAt;
    const result = s.append("READ", payload, "read-0", at);
    payload.snapshot.inventory.length = 0;
    result.events[0].payload.snapshot.inventory.length = 0;
    result.schedule.windows[0].reads.length = 0;
    result.previous = generatedHash("caller-tip");
    const fresh = s.writer.read();
    expect(fresh.events[0].payload).toEqual(original);
    expect(fresh.schedule.windows[0].reads).toHaveLength(1);
    expect(fresh).toEqual(reconstructScheduleBridge(s.bridge));
    fresh.events.length = 0;
    expect(s.writer.close().events).toHaveLength(1);
    expect(s.writer.read().reasons).toEqual(["STOP_WRITER_CLOSED"]);
  });
  it.each([
    "same-length bytes",
    "replacement",
    "interior omission",
    "tail omission",
    "future ordinal",
    "payload",
    "predecessor",
    "snapshot",
    "history",
  ])("independent readers and pre-claim audit reject poisoned prefix: %s", async (attack) => {
    const s = await acknowledged();
    appendRead(s, 0, "ADMITTED");
    const qualified = s.append("RECHECK", s.payload(0, "ADMITTED"), "recheck-0");
    expect(qualified.verification).toBeUndefined();
    const reader = openScheduleBridgeWriter(s.bridge),
      closer = openScheduleBridgeWriter(s.bridge);
    const path = entryPath(s, 1),
      bytes = readFileSync(path),
      value = JSON.parse(bytes);
    if (attack === "same-length bytes") {
      const changed = Buffer.from(bytes.toString().replace('"read-0"', '"read-x"'));
      expect(changed.length).toBe(bytes.length);
      writeFileSync(path, changed);
    } else if (attack === "replacement") {
      rmSync(path);
      writeFileSync(path, bytes.toString() + " ", { flag: "wx" });
    } else if (attack === "interior omission") rmSync(path);
    else if (attack === "tail omission") rmSync(entryPath(s, 2));
    else if (attack === "future ordinal") writeFileSync(entryPath(s, 4), bytes, { flag: "wx" });
    else {
      if (attack === "payload") value.payloadHash = generatedHash("other");
      if (attack === "predecessor") value.previous = generatedHash("other");
      if (attack === "snapshot") value.snapshotHash = generatedHash("other");
      if (attack === "history") value.histories.opportunity = generatedHash("other");
      writeFileSync(path, JSON.stringify(value));
    }
    // A memoryless cold read cannot authenticate a deleted suffix; the retained
    // predecessor makes the restart refuse rather than treating it as fresh.
    if (attack === "tail omission") {
      expect(reconstructScheduleBridge(s.bridge).events).toHaveLength(1);
      const payload = s.payload(1),
        at = payload.snapshot.reads[0].completedAt;
      expect(
        appendScheduleTransition(
          { ...s.bridge, expectedPrevious: qualified.previous, event: { id: "restart", kind: "READ", at, payload } },
          { now: () => at },
        ).state,
      ).toBe("STOP");
    } else expect(reconstructScheduleBridge(s.bridge).state).toBe("STOP");
    const originalRead = fs.readFileSync;
    let earlyByteReads = 0;
    fs.readFileSync = (...args) => {
      if (args[0] === path) earlyByteReads++;
      return originalRead(...args);
    };
    syncBuiltinESMExports();
    let audited;
    try {
      audited = reader.read();
    } finally {
      fs.readFileSync = originalRead;
      syncBuiltinESMExports();
    }
    expect(audited.state).toBe("STOP");
    if (attack === "same-length bytes") expect(earlyByteReads).toBeGreaterThan(0);
    expect(closer.close().state).toBe("STOP");
    expect(claim(s, qualified.previous, qualified.qualified.recheckHash).state).toBe("STOP");
    expect(existsSync(entryPath(s, 3))).toBe(false);
  });
  it("rereads a non-tail duplicate and refuses conflicts without consuming a slot", async () => {
    const s = await acknowledged();
    appendRead(s, 0);
    const second = appendRead(s, 1);
    expect(appendRead(s, 0).events).toHaveLength(2);
    expect(appendRead(s, 0, "REFUSED", "read-0").previous).toBe(second.previous);
    expect(s.append("READ", s.payload(0, "ADMITTED"), "read-0").reasons).toEqual(["STOP_CONFLICTING_EVENT"]);
    const path = entryPath(s, 1),
      bytes = readFileSync(path);
    writeFileSync(path, bytes.toString().replace('"read-0"', '"read-x"'));
    expect(appendRead(s, 0).reasons).toEqual(["STOP_DUPLICATE_BYTES"]);
    expect(existsSync(entryPath(s, 3))).toBe(false);
  });
  it.each(["identical competitor", "distinct competitor", "partial next", "write failure", "reread failure"])(
    "create-new and uncertain persistence preserve the disk prefix: %s",
    async (attack) => {
      const s = await acknowledged(),
        rival = openScheduleBridgeWriter(s.bridge);
      const initial = reconstructScheduleBridge(s.bridge),
        payload = s.payload(0),
        at = payload.snapshot.reads[0].completedAt;
      const event = { id: "read-0", kind: "READ", at, payload };
      const input = { ...s.bridge, expectedPrevious: initial.previous, event };
      const path = entryPath(s, 1);
      if (attack.endsWith("competitor")) {
        expect(s.writer.append(input, { now: () => at }).state).toBe("WAITING");
        const retained = readFileSync(path);
        const result = rival.append(
          { ...input, event: attack === "identical competitor" ? event : { ...event, id: "other" } },
          { now: () => at },
        );
        expect(result.state).toBe(attack === "identical competitor" ? "WAITING" : "STOP");
        expect(readFileSync(path)).toEqual(retained);
        expect(reconstructScheduleBridge(s.bridge).events).toHaveLength(1);
        return;
      }
      if (attack === "partial next") writeFileSync(path, "{partial", { flag: "wx" });
      const originalWrite = fs.writeFileSync,
        originalRead = fs.readFileSync;
      if (attack === "write failure")
        fs.writeFileSync = (...args) => {
          if (typeof args[0] === "number") throw new Error("synthetic-write-failure");
          return originalWrite(...args);
        };
      if (attack === "reread failure")
        fs.readFileSync = (...args) => {
          if (args[0] === path) throw new Error("synthetic-reread-failure");
          return originalRead(...args);
        };
      syncBuiltinESMExports();
      let result;
      try {
        result = s.writer.append(input, { now: () => at });
      } finally {
        fs.writeFileSync = originalWrite;
        fs.readFileSync = originalRead;
        syncBuiltinESMExports();
      }
      expect(result.state).toBe("STOP");
      expect(result.partial).toBe(true);
      expect(s.writer.append(input, { now: () => at }).reasons).toEqual(["STOP_WRITER_CLOSED"]);
      const retained = readFileSync(path);
      const reopened = openScheduleBridgeWriter(s.bridge);
      if (attack === "reread failure") {
        expect(reopened.read().events).toHaveLength(1);
        expect(reopened.append(input, { now: () => at }).events).toHaveLength(1);
      } else expect(reopened.state).toBe("STOP");
      expect(readFileSync(path)).toEqual(retained);
      expect(existsSync(entryPath(s, 2))).toBe(false);
    },
  );
  it.each(["RECHECK", "ARM_CLAIM", "ARM_CONFIRMED"])(
    "post-write independent %s audit cannot report authority from poisoned history",
    async (kind) => {
      const s = await acknowledged();
      const first = appendRead(s, 0, "ADMITTED");
      let previous = first.previous,
        payload = s.payload(0, "ADMITTED"),
        id = "recheck-0";
      if (kind !== "RECHECK") {
        const qualified = s.append("RECHECK", payload, id);
        previous = qualified.previous;
        payload = { executor: s.plan.roles.executor.identity, recheckHash: qualified.qualified.recheckHash };
        id = "claim";
        if (kind === "ARM_CONFIRMED") {
          const claimed = s.append("ARM_CLAIM", payload, id);
          previous = claimed.previous;
          payload = { claimId: id, executor: payload.executor, runId: 900000000000200, attempt: 1 };
          id = "confirmed";
        }
      }
      const ordinal = kind === "RECHECK" ? 2 : kind === "ARM_CLAIM" ? 3 : 4;
      const target = entryPath(s, ordinal),
        early = entryPath(s, 1),
        originalRead = fs.readFileSync;
      fs.readFileSync = (...args) => {
        const bytes = originalRead(...args);
        if (args[0] === target) writeFileSync(early, readFileSync(early, "utf8").replace('"read-0"', '"read-x"'));
        return bytes;
      };
      syncBuiltinESMExports();
      let result;
      try {
        result = s.writer.append(
          { ...s.bridge, expectedPrevious: previous, event: { id, kind, at: "2030-01-01T01:00:21.000Z", payload } },
          { now: () => "2030-01-01T01:00:21.000Z" },
        );
      } finally {
        fs.readFileSync = originalRead;
        syncBuiltinESMExports();
      }
      expect(result.state).toBe("STOP");
      expect(result.partial).toBe(true);
      expect(existsSync(target)).toBe(true);
      expect(reconstructScheduleBridge(s.bridge).state).toBe("STOP");
      expect(s.writer.read().reasons).toEqual(["STOP_WRITER_CLOSED"]);
    },
  );
  it("terminal refusal closes independently and cannot hide a poisoned earlier window", async () => {
    const s = await acknowledged();
    const error = { state: "STOP", reasons: ["SYNTHETIC_INCOMPLETE"], nodeUid: null };
    for (let slot = 0; slot < 2; slot++)
      expect(s.append("READ", error, `error-${slot}`, s.payload(slot).snapshot.reads[0].completedAt).state).toBe(
        "WAITING",
      );
    const originalRead = fs.readFileSync,
      early = entryPath(s, 1),
      target = entryPath(s, 3);
    fs.readFileSync = (...args) => {
      const bytes = originalRead(...args);
      if (args[0] === target) writeFileSync(early, originalRead(early, "utf8").replace('"error-0"', '"error-x"'));
      return bytes;
    };
    syncBuiltinESMExports();
    let result;
    try {
      result = s.append("READ", error, "error-2", s.payload(2).snapshot.reads[0].completedAt);
    } finally {
      fs.readFileSync = originalRead;
      syncBuiltinESMExports();
    }
    expect(result.state).toBe("STOP");
    expect(result.partial).toBe(true);
    expect(result.verification).toBeUndefined();
    expect(reconstructScheduleBridge(s.bridge).state).toBe("STOP");
    expect(s.writer.close().reasons).toEqual(["STOP_WRITER_CLOSED"]);
  });
  it("legacy one-shot and writer share deadline and slot refusals without granting progress authority", async () => {
    const s = await acknowledged(),
      initial = reconstructScheduleBridge(s.bridge);
    for (const [slot, at] of [
      [1, "2030-01-01T01:00:51.000Z"],
      [180, "2030-01-01T02:30:00.000Z"],
    ]) {
      const event = { id: `read-${slot}`, kind: "READ", at, payload: s.payload(slot) };
      const input = { ...s.bridge, expectedPrevious: initial.previous, event };
      expect(appendScheduleTransition(input, { now: () => at }).state).toBe("STOP");
      const writer = openScheduleBridgeWriter(s.bridge);
      expect(writer.append(input, { now: () => at }).state).toBe("STOP");
    }
    const payload = s.payload(0),
      at = payload.snapshot.reads[0].completedAt;
    const result = appendScheduleTransition(
      { ...s.bridge, expectedPrevious: initial.previous, event: { id: "read-0", kind: "READ", at, payload } },
      { now: () => at },
    );
    expect(result.verification).toBeUndefined();
    expect(result).toEqual(reconstructScheduleBridge(s.bridge));
  });
});

describe("five-read projection production entrypoint", () => {
  it.each(
    ["initContainerStatuses", "containerStatuses", "ephemeralContainerStatuses"].flatMap((statuses) =>
      ["chase-sets-verify-synthetic", "synthetic-unselected"].flatMap((namespace) =>
        [
          ["absent history", undefined],
          ["malformed string", "synthetic-invalid-last-state"],
          ["malformed array", []],
          ["explicit null", null],
          ["empty history", {}],
          [
            "terminated history",
            {
              terminated: {
                reason: "OOMKilled",
                exitCode: 137,
                startedAt: "2030-01-01T00:00:10Z",
                finishedAt: "2030-01-01T00:00:20Z",
              },
            },
          ],
        ].map(([label, history]) => ({ statuses, namespace, label, history })),
      ),
    ),
  )(
    "validates $label in $statuses for $namespace before the next read",
    async ({ statuses, namespace, label, history }) => {
      const f = admissionFixture();
      const container = { name: "api", image: "synthetic/image:fixed" };
      const declaration = {
        initContainerStatuses: "initContainers",
        containerStatuses: "containers",
        ephemeralContainerStatuses: "ephemeralContainers",
      }[statuses];
      f.bodies.pods.items.push({
        apiVersion: "v1",
        kind: "Pod",
        metadata: meta("pod", { namespace }),
        spec: {
          nodeName: "node",
          containers: declaration === "containers" ? [container] : [{ name: "main", image: "synthetic/image:fixed" }],
          [declaration]: [container],
        },
        status: {
          phase: "Running",
          [statuses]: [
            {
              ...container,
              ready: true,
              restartCount: 1,
              state: { running: { startedAt: "2030-01-01T00:01:00Z" } },
              lastState: history,
            },
          ],
        },
      });
      const result = await f.run();
      if (label.startsWith("malformed")) {
        expect(result.state).toBe("STOP");
        expect(result.reasons).toEqual(["STOP_CONTAINER_STATE"]);
        expect(f.trace.map((request) => request.resource)).toEqual(["nodes", "namespaces", "pods"]);
      } else {
        expect(result.state).toBe("ADMITTED");
        expect(f.trace.slice(0, 5).map((request) => request.resource)).toEqual(READS.map((read) => read.resource));
        const projected = result.snapshot.reads[2].records[0].containers.find((status) => status.name === "api");
        if (label === "absent history") expect(projected).not.toHaveProperty("lastState");
        else expect(projected).toHaveProperty("lastState", history);
      }
    },
  );
  it("preserves optional absence and explicit null rather than inventing observations", async () => {
    const f = admissionFixture();
    f.bodies.nodes.items[0].metadata.deletionTimestamp = null;
    const result = await f.run();
    expect(result.snapshot.reads[0].records[0]).not.toHaveProperty("unschedulable");
    expect(result.snapshot.reads[0].records[0]).toHaveProperty("deletionTimestamp", null);
  });
  it("performs only the fixed serial reads with explicit context and request bounds", async () => {
    const f = admissionFixture(),
      result = await f.run();
    expect(result.state).toBe("ADMITTED");
    expect(f.trace.slice(0, 5).map((r) => r.resource)).toEqual(READS.map((r) => r.resource));
    for (const request of f.trace.slice(0, 5)) {
      expect(request.args.slice(0, 4)).toEqual(["--context", CONTEXT, "--request-timeout=20s", "get"]);
      expect(request.args.at(-1)).toBe("--output=json");
    }
    expect(f.trace[4].args).toContain("cluster-autoscaler-status");
    expect(f.trace[4].args).toContain("kube-system");
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_STDERR");
  });
  it.each([20000, 20001])("measures the individual %i ms boundary", async (duration) => {
    const f = admissionFixture();
    f.durations.nodes = duration;
    expect((await f.run()).state).toBe(duration === 20000 ? "ADMITTED" : "STOP");
    if (duration > 20000) expect(f.trace).toHaveLength(1);
  });
  it("refuses a full acquisition slot overrun despite individually bounded reads", async () => {
    const f = admissionFixture();
    f.durations.nodes = 16000;
    f.durations.namespaces = 14001;
    expect((await f.run()).reasons).toEqual(["STOP_SLOT_OVERRUN"]);
    expect(f.trace).toHaveLength(2);
  });
  it("includes final inventory/admission processing in the original slot bound", async () => {
    const f = admissionFixture();
    let closing = false,
      tail = 29998,
      variables = 0;
    f.clock = () => (closing ? ++tail : 0);
    f.producers.automaticVariableRead = async () => {
      if (++variables === 2) closing = true;
      return f.variable;
    };
    expect((await f.run()).reasons).toEqual(["STOP_SLOT_OVERRUN"]);
  });
  it.each([
    [
      "null",
      (b) => {
        b.nodes = null;
      },
    ],
    [
      "invalid date",
      (b) => {
        b.nodes.items[0].metadata.creationTimestamp = "2030-02-30T00:00:00Z";
      },
    ],
    [
      "missing items",
      (b) => {
        delete b.nodes.items;
      },
    ],
    [
      "wrong kind",
      (b) => {
        b.nodes.items[0].kind = "Pod";
      },
    ],
    [
      "duplicate UID",
      (b) => {
        b.nodes.items.push(copy(b.nodes.items[0]));
      },
    ],
    [
      "continuation",
      (b) => {
        b.nodes.metadata.continue = "next";
      },
    ],
    [
      "remaining",
      (b) => {
        b.nodes.metadata.remainingItemCount = 1;
      },
    ],
    [
      "unselected malformed record",
      (b) => {
        const n = copy(b.nodes.items[0]);
        n.metadata.labels["chase-sets.com/pool"] = "other";
        delete n.status;
        b.nodes.items.push(n);
      },
    ],
    [
      "missing pressure",
      (b) => {
        b.nodes.items[0].status.conditions.pop();
      },
    ],
    [
      "null taints",
      (b) => {
        b.nodes.items[0].spec.taints = null;
      },
    ],
  ])("validates %s before filtering or the next read", async (_name, mutate) => {
    const f = admissionFixture();
    mutate(f.bodies);
    expect((await f.run()).state).toBe("STOP");
    expect(f.trace).toHaveLength(1);
  });
  it("drops planted env/free-text/config markers and retains all relevant event reasons", async () => {
    const f = admissionFixture();
    f.bodies.pods.items.push({
      apiVersion: "v1",
      kind: "Pod",
      metadata: meta("pod", { namespace: "chase-sets-verify-synthetic" }),
      spec: {
        nodeName: "node",
        containers: [
          {
            name: "api",
            image: "synthetic/image:fixed",
            env: [{ name: "SYNTHETIC_PRIVATE_ENV", value: "SYNTHETIC_PRIVATE_VALUE" }],
          },
        ],
      },
      status: { phase: "Pending", containerStatuses: [] },
    });
    f.bodies.events.items.push(
      ...["NodeNotReady", "Killing", "FailedScheduling", "NamespaceDeleted"].map((reason, i) => ({
        apiVersion: "v1",
        kind: "Event",
        metadata: meta(`event-${i}`, { namespace: "chase-sets-verify-synthetic" }),
        reason,
        count: 1,
        involvedObject: { uid: "synthetic-pod", name: "pod", kind: "Pod", namespace: "chase-sets-verify-synthetic" },
        message: "SYNTHETIC_PRIVATE_EVENT",
      })),
    );
    f.bodies.configmap.data.other = "SYNTHETIC_PRIVATE_CONFIG";
    const result = await f.run();
    expect(result.state).toBe("ADMITTED");
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_PRIVATE/);
    expect(result.snapshot.reads[3].records.map((e) => e.reason)).toEqual([
      "NodeNotReady",
      "Killing",
      "FailedScheduling",
      "NamespaceDeleted",
    ]);
  });
});

describe("producer inventory", () => {
  it("retains complete safe HTTP bodies, allowlisted headers and opening/closing byte custody", async () => {
    const f = admissionFixture();
    f.runs.gate = [f.record("gate", 1)];
    const result = await f.run();
    for (const collection of result.snapshot.inventory) {
      expect(collection.openingPages).toHaveLength(collection.pageHashes.length);
      expect(collection.closingPages).toHaveLength(collection.pageHashes.length);
      for (const [i, record] of collection.openingPages.entries()) {
        expect(record.sha256).toBe(sha256(record.body));
        expect(record.bytes).toBe(Buffer.byteLength(record.body));
        expect(collection.closingPages[i].body).toBe(record.body);
        expect(record.headers["content-type"]).toBe("application/json");
      }
    }
    expect(
      JSON.parse(result.snapshot.inventory.find((c) => c.owner === "gate").openingPages[0].body).workflow_runs[0],
    ).toMatchObject({ id: 1, status: "completed" });
  });
  it("validates the whole page before a gate read and detects gate-only closing races", async () => {
    const f = admissionFixture();
    f.runs.pr = [f.record("pr", 1, "queued"), f.record("pr", 2, "queued")];
    f.runs.pr[1].head_sha = "malformed";
    expect((await f.run()).state).toBe("STOP");
    expect(f.trace.some((r) => r.runId)).toBe(false);
    f.runs.pr.pop();
    let reads = 0;
    const original = f.producers.previewGateRead;
    f.producers.previewGateRead = async (r) => ({ ...(await original(r)), clusterPreview: reads++ > 0 });
    expect((await f.run()).reasons).toEqual(["STOP_PRODUCER_GATE_RACE"]);
  });
  it("finds the decisive page-2 and last-page owner and reconciles every closing page", async () => {
    const f = admissionFixture();
    f.runs.indirect = Array.from({ length: 101 }, (_, i) =>
      f.record("indirect", i + 1, i === 100 ? "waiting" : "completed"),
    );
    const result = await f.run();
    expect(result.reasons).toContain("COMPETING_PRODUCER");
    expect(result.snapshot.inventory.at(-1)).toMatchObject({ total: 101, unique: 101 });
    expect(f.trace.filter((r) => r.owner === "indirect").map((r) => new URL(r.url).searchParams.get("page"))).toEqual([
      "1",
      "2",
      "1",
      "2",
    ]);
  });
  it.each(["queued", "requested", "waiting", "pending", "in_progress", "future_nonterminal"])(
    "does not discard nonterminal %s",
    async (status) => {
      const f = admissionFixture();
      f.runs.gate = [f.record("gate", 1, status)];
      expect((await f.run()).reasons).toContain("COMPETING_PRODUCER");
    },
  );
  it.each(["gate", "stranded", "ephemeral", "observer", "cleanup", "indirect"])(
    "reconciles the %s owner",
    async (role) => {
      const f = admissionFixture();
      f.runs[role] = [f.record(role, 1, "queued")];
      expect((await f.run()).state).toBe("REFUSED");
    },
  );
  it("absent/false automatic enable disables only automatic, never manual", async () => {
    for (const variable of [
      { present: false, value: null },
      { present: true, value: "false" },
      { present: true, value: "true" },
    ]) {
      const f = admissionFixture();
      f.variable = variable;
      f.runs.automatic = [f.record("automatic", 1, "pending")];
      expect((await f.run()).state).toBe(variable.value === "true" ? "REFUSED" : "ADMITTED");
      f.runs.ephemeral = [f.record("ephemeral", 2, "queued")];
      expect((await f.run()).state).toBe("REFUSED");
    }
  });
  it("ordinary non-preview push is not automatically a competitor; unknown gating is not inactive", async () => {
    const f = admissionFixture();
    const run = f.record("pr", 1, "in_progress");
    run.event = "push";
    f.runs.pr = [run];
    expect((await f.run()).state).toBe("ADMITTED");
    run.previewGate.clusterPreview = true;
    expect((await f.run()).state).toBe("REFUSED");
    delete run.previewGate;
    expect((await f.run()).state).toBe("STOP");
  });
  it.each([
    "missing next",
    "unsafe link",
    "extra query",
    "cycle",
    "empty page",
    "duplicate",
    "changed total",
    "missing total",
    "cap",
    "stale hash",
    "tail race",
  ])("refuses pagination failure: %s", async (attack) => {
    const f = admissionFixture();
    f.runs.pr = Array.from({ length: 101 }, (_, i) => f.record("pr", i + 1));
    let seen = 0;
    f.mutatePage = (record, request, ordinal) => {
      if (request.owner !== "pr") return record;
      seen++;
      const body = JSON.parse(record.body),
        headers = { ...record.headers };
      if (attack === "missing next") delete headers.link;
      if (attack === "unsafe link") headers.link = '<https://evil.invalid/next>; rel="next"';
      if (attack === "extra query" && headers.link) headers.link = headers.link.replace("page=2", "page=2&extra=1");
      if (attack === "cycle" && headers.link) headers.link = headers.link.replaceAll("page=2", "page=1");
      if (attack === "empty page" && ordinal === 2) body.workflow_runs = [];
      if (attack === "duplicate" && ordinal === 2) body.workflow_runs[0].id = 1;
      if (attack === "changed total" && ordinal === 2) body.total_count = 102;
      if (attack === "missing total") delete body.total_count;
      if (attack === "cap") body.total_count = 1000;
      if (attack === "tail race" && seen === 4) body.workflow_runs[0].head_sha = "b".repeat(40);
      const output = raw(record.url, body, headers);
      if (attack === "stale hash") output.sha256 = "0".repeat(64);
      return output;
    };
    expect((await f.run()).state).toBe("STOP");
  });
});

describe("admission recheck", () => {
  it("retains admitted input bytes and the original UID across mutable producer references", async () => {
    const f = admissionFixture(),
      originalHash = f.input.admitted.sourceHash,
      producer = f.producers.clusterRead;
    f.producers.clusterRead = async (request) => {
      const result = await producer(request);
      f.input.admitted.sourceHash = generatedHash("substitution");
      return result;
    };
    const observation = await f.run();
    expect(observation.state).toBe("ADMITTED");
    expect(observation.snapshot.sourceHash).toBe(originalHash);
    const g = admissionFixture(),
      prior = await g.run(),
      original = g.producers.clusterRead;
    g.producers.clusterRead = async (request) => {
      prior.nodeUid = "synthetic-race-replacement";
      g.bodies.nodes.items[0].metadata.uid = prior.nodeUid;
      return original(request);
    };
    expect((await recheckC1Evidence(g.input, prior, g.producers, g)).reasons).toEqual(["NODE_UID_REPLACED"]);
  });
  it("cross-binds the prior node UID to the retained snapshot before any I/O", async () => {
    const f = admissionFixture(),
      prior = await f.run();
    prior.nodeUid = "synthetic-substituted";
    f.trace.length = 0;
    expect((await recheckC1Evidence(f.input, prior, f.producers, f)).reasons).toEqual(["STOP_RECHECK_BINDING"]);
    expect(f.trace).toHaveLength(0);
  });
  it.each([
    "zero",
    "two",
    "wrong size",
    "cordoned",
    "pressure",
    "unknown pressure",
    "extra taint",
    "terminating namespace",
  ])("refuses %s with complete safe observations", async (attack) => {
    const f = admissionFixture(),
      n = f.bodies.nodes.items[0];
    if (attack === "zero") f.bodies.nodes.items = [];
    if (attack === "two") {
      const extra = copy(n);
      extra.metadata.uid += "-second";
      f.bodies.nodes.items.push(extra);
    }
    if (attack === "wrong size") n.metadata.labels["node.kubernetes.io/instance-type"] = "s-2vcpu-4gb";
    if (attack === "cordoned") n.spec.unschedulable = true;
    if (attack === "pressure" || attack === "unknown pressure")
      n.status.conditions[1].status = attack === "pressure" ? "True" : "Unknown";
    if (attack === "extra taint") n.spec.taints.push({ key: "other", effect: "NoSchedule" });
    if (attack === "terminating namespace")
      f.bodies.namespaces.items.push({
        kind: "Namespace",
        apiVersion: "v1",
        metadata: meta("chase-sets-pr-999", { deletionTimestamp: "2030-01-01T00:01:00Z" }),
        status: { phase: "Terminating" },
      });
    expect((await f.run()).state).toBe("REFUSED");
  });
  it("repeats inventory and all reads, refuses UID replacement, and never dispatches", async () => {
    const f = admissionFixture(),
      prior = await f.run();
    f.trace.length = 0;
    expect((await recheckC1Evidence(f.input, prior, f.producers, f)).state).toBe("ADMITTED");
    expect(f.trace.filter((r) => r.resource)).toHaveLength(5);
    expect(f.trace.filter((r) => r.owner)).toHaveLength(16);
    f.bodies.nodes.items[0].metadata.uid = "synthetic-replaced";
    expect((await recheckC1Evidence(f.input, prior, f.producers, f)).reasons).toEqual(["NODE_UID_REPLACED"]);
    expect(f.trace.every((r) => !Object.hasOwn(r, "dispatch"))).toBe(true);
  });
  it("refuses an original-slot recheck overrun and a last-page new competitor", async () => {
    const f = admissionFixture(),
      prior = await f.run();
    f.runs.stranded = Array.from({ length: 101 }, (_, i) =>
      f.record("stranded", i + 1, i === 100 ? "pending" : "completed"),
    );
    expect((await recheckC1Evidence(f.input, prior, f.producers, f)).state).toBe("REFUSED");
    f.durations.nodes = 15000;
    f.durations.namespaces = 15000;
    expect((await recheckC1Evidence(f.input, prior, f.producers, f)).state).toBe("STOP");
  });
});

describe("entrypoint refusal", () => {
  it("uses absolute native fixture doubles with an isolated sentinel, never a PATH substitute", async () => {
    const f = admissionFixture();
    const binary = resolve(process.execPath);
    const script = join(sandbox(), "synthetic-native-reader.mjs");
    writeFileSync(
      script,
      `if (process.env.SYNTHETIC_ISOLATION_SENTINEL !== "fixture-only" || process.env.PATH !== "") process.exit(7);\nconst request=JSON.parse(process.argv[2]);\nif (request.context !== ${JSON.stringify(CONTEXT)} || request.requestTimeoutMs !== 20000) process.exit(8);\nconst bodies=JSON.parse(process.argv[3]);\nprocess.stdout.write(JSON.stringify({exitCode:0,stdout:JSON.stringify(bodies[request.resource])}));\n`,
    );
    f.producers.clusterRead = async (request) =>
      JSON.parse(
        execFileSync(binary, [script, JSON.stringify(request), JSON.stringify(f.bodies)], {
          encoding: "utf8",
          env: { SystemRoot: process.env.SystemRoot ?? "", PATH: "", SYNTHETIC_ISOLATION_SENTINEL: "fixture-only" },
        }),
      );
    expect((await f.run()).state).toBe("ADMITTED");
  });
  it("does not move the original slot at recheck or accept a variable closing race", async () => {
    const f = admissionFixture(),
      prior = await f.run();
    f.input.slot = { startedAt: 1, deadline: 30001 };
    expect((await recheckC1Evidence(f.input, prior, f.producers, f)).reasons).toEqual(["STOP_RECHECK_BINDING"]);
    f.input.slot = { startedAt: 0, deadline: 30000 };
    let reads = 0;
    f.producers.automaticVariableRead = async () => ({ present: true, value: reads++ ? "true" : "false" });
    expect((await f.run()).reasons).toEqual(["STOP_AUTOMATIC_VARIABLE_RACE"]);
  });
  it.each(["withheld", "wrong capability", "stale source", "owner omission", "capability gap"])(
    "refuses %s before any external I/O",
    async (attack) => {
      const f = admissionFixture();
      if (attack === "withheld") delete f.input.admitted;
      if (attack === "wrong capability") f.producers.binding = {};
      if (attack === "stale source") f.input.source.head = "b".repeat(40);
      if (attack === "owner omission") {
        f.input.source.owners.pop();
      }
      if (attack === "capability gap") delete f.producers.inventoryRead;
      expect((await f.run()).state).toBe("STOP");
      expect(f.trace).toHaveLength(0);
    },
  );
  it("does not retry/fallback, leak a thrown producer error or invoke the reader", async () => {
    const f = admissionFixture();
    let calls = 0;
    f.producers.clusterRead = async () => {
      calls++;
      throw new Error("STOP_SYNTHETIC_PRIVATE_CRASH");
    };
    expect(await f.run()).toEqual({ state: "STOP", reasons: ["STOP_ACQUISITION"], nodeUid: null });
    expect(calls).toBe(1);
  });
  it("refuses supplied capability gaps or extra authority fields before I/O", async () => {
    for (const name of ["db", "events", "custody", "schedule", "extraAuthority"]) {
      const f = admissionFixture();
      f.input.capability[name] = "synthetic-withheld";
      f.input.admitted.capabilityHash = sha256(JSON.stringify(f.input.capability));
      expect((await f.run()).reasons).toEqual(["STOP_CAPABILITY_GAP"]);
      expect(f.trace).toHaveLength(0);
    }
  });
});

describe("complete envelope entrypoint actual CLI", () => {
  it("materializes complete synthetic v3/v2 proof and exact-byte manifests through absolute native Node", () => {
    const f = fixture({ pageTwo: true }),
      plan = filesFor(f),
      expected = read(f),
      result = cli(plan);
    expect(f.envelope.jobs.verification.pages).toHaveLength(2);
    expect(JSON.parse(f.envelope.jobs.verification.pages[0].body).total_count).toBe(101);
    expect(JSON.parse(f.envelope.jobs.verification.pages[1].body).jobs.map(({ id }) => id)).toEqual([
      f.envelope.sourceMap.jobId,
    ]);
    expect(expected.bracketState).toBe("TERMINAL_BEFORE_DELETE");
    expect(result.exit).toBe(0);
    expect(result.result.receipt).toEqual(expected);
    expect(readFileSync(plan.outputs.envelope).equals(readFileSync(plan.envelopeFile))).toBe(true);
    for (const [key, path] of Object.entries(plan.outputs))
      expect(sha256(readFileSync(path))).toBe(result.result.outputHashes[key]);
    const manifest = JSON.parse(readFileSync(plan.outputs.manifest, "utf8"));
    for (const output of manifest.outputs) expect(sha256(readFileSync(output.path))).toBe(output.sha256);
    expect(expected.cRunTerminal.utc).toBe(null);
    expect(expected.t0Utc).toBe(expected.vDeleteTerminal.utc);
  });
  it.each([
    "admission",
    "coverage",
    "sourceMap",
    "seal",
    "ack",
    "histories",
    "capture",
    "consumption",
    "jobs",
    "files",
  ])("governing-only %s omission mutant cannot bypass the production CLI", (key) => {
    const f = fixture();
    delete f.envelope[key];
    const result = cli(filesFor(f));
    expect(result.exit).toBe(1);
    expect(result.result.receipt).toEqual(read(f));
    expect(result.result.receipt.t0Utc).toBe(null);
  });
  it("keeps historical envelopes unchanged and reader STOP/null T0, rather than fabricating completeness", () => {
    const f = fixture();
    f.envelope.method = "historical/v2";
    const before = JSON.stringify(f.envelope),
      plan = filesFor(f);
    const result = cli(plan);
    expect(result.exit).toBe(1);
    expect(result.result.receipt).toEqual(read(f));
    expect(JSON.stringify(f.envelope)).toBe(before);
    expect(JSON.parse(readFileSync(plan.outputs.envelope))).toEqual(f.envelope);
  });
  it("preserves affirmative no-V without granting c1 admission", () => {
    const noV = withoutVerification(fixture());
    expect(cli(filesFor(noV)).result.receipt).toEqual(read(noV));
  });
  it("preserves coherent failed cleanup without granting c1 admission", () => {
    const failed = changeDelete(fixture(), (step) => {
      step.conclusion = "failure";
    });
    failed.envelope.namespace.deleted = false;
    retain(failed);
    const result = cli(filesFor(failed));
    expect(result.result.receipt).toEqual(read(failed));
    expect(result.result.receipt.cleanupSucceeded).toBe(false);
    expect(result.result.receipt.c1Admission).toBe(false);
  });
  it.each([
    "existing",
    "stale bytes",
    "custody omission",
    "relative input",
    "network input",
    "network destination",
    "destination directory",
  ])("refuses %s without overwriting or reporting partial success", (attack) => {
    const plan = filesFor(fixture());
    if (attack === "existing") writeFileSync(plan.outputs.receipt, "synthetic-existing");
    if (attack === "stale bytes") writeFileSync(plan.envelopeFile, "{}");
    if (attack === "custody omission") writeFileSync(plan.custodyFile, "{}");
    if (attack === "relative input") plan.envelopeFile = "relative.json";
    if (attack === "network input") plan.envelopeFile = "\\\\synthetic-invalid\\unreachable\\envelope.json";
    if (attack === "network destination") plan.outputs.manifest = "\\\\synthetic-invalid\\unreachable\\manifest.json";
    if (attack === "destination directory") mkdirSync(plan.outputs.manifest);
    const result = consumeCompleteEnvelope(plan);
    expect(result.state).toBe("STOP");
    expect(result.partial).toBe(false);
    expect(existsSync(plan.outputs.envelope)).toBe(false);
    if (attack === "existing") expect(readFileSync(plan.outputs.receipt, "utf8")).toBe("synthetic-existing");
  });
  it("reports a partial write truthfully and never emits a success receipt", () => {
    const plan = filesFor(fixture());
    plan.outputs.manifest = join(sandbox(), "missing-parent", "manifest.json");
    const result = consumeCompleteEnvelope(plan);
    expect(result).toEqual({ state: "STOP", reasons: ["STOP_PARTIAL_MATERIALIZATION"], partial: true });
    expect(existsSync(plan.outputs.receipt)).toBe(false);
  });
});

describe("terminal custody production entrypoint", () => {
  const sourceIds = [
    ...fixture().envelope.files.map((_, i) => `reader-${i}`),
    "envelope",
    "admitted",
    "api-log",
    "worker-log",
    "inventory",
    "history",
    "census-archive",
    "census-payload",
    "census-artifacts",
    "verification-archive",
    "verification-payload",
    "verification-artifacts",
  ];
  it("F1 refuses a duplicate delivery replacing an omitted lifecycle event with totals unchanged", async () => {
    const custody = custodyFor(fixture());
    const history = JSON.parse(readFileSync(custody.plan.files.find((file) => file.id === "history").sourcePath));
    const events = history.records.filter((record) => record.kind === "Event");
    expect(events).toHaveLength(9);
    expect(events.at(-1).reason).toBe("NamespaceDeleted");
    history.records[history.records.length - 1] = structuredClone(events[0]);
    custody.replace("history", history);
    custody.save();
    const result = await custody.run();
    expect(result.state, JSON.stringify(result)).toBe("STOP");
    expect(result.missing).toContain("EVENT_COVERAGE");
    expect(result.partial).toBe(false);
    expect(existsSync(custody.plan.original.prefix)).toBe(false);
    expect(existsSync(custody.plan.backup.prefix)).toBe(false);
  });
  it("F1 retains complete unique history with identical delivery overlap and replay", async () => {
    const custody = custodyFor(fixture());
    const history = JSON.parse(readFileSync(custody.plan.files.find((file) => file.id === "history").sourcePath));
    history.records.push(structuredClone(history.records.find((record) => record.kind === "Event")));
    custody.replace("history", history);
    custody.save();
    const result = await custody.run();
    expect(result.state, JSON.stringify(result)).toBe("MATERIALIZED");
    expect(await custody.run()).toEqual(result);
  });
  it("F1 refuses conflicting lifecycle deliveries without creating custody", async () => {
    const custody = custodyFor(fixture());
    const history = JSON.parse(readFileSync(custody.plan.files.find((file) => file.id === "history").sourcePath));
    const event = history.records.find((record) => record.kind === "Event");
    history.records.push({ ...event, reason: "synthetic-conflicting-reason" });
    custody.replace("history", history);
    custody.save();
    const result = await custody.run();
    expect(result.missing).toContain("DELIVERY_CONFLICT");
    expect(result.state).toBe("STOP");
    expect(result.partial).toBe(false);
  });
  it.each(["synthetic-unrelated-container", undefined])(
    "F3 refuses owning worker log provenance %s before either prefix",
    async (owner) => {
      const custody = custodyFor(fixture());
      custody.plan.files.find((file) => file.id === "worker-log").origin.containerUid = owner;
      custody.save();
      const result = await custody.run();
      expect(result.state, JSON.stringify(result)).toBe("STOP");
      expect(result.partial).toBe(false);
      expect(existsSync(custody.plan.original.prefix)).toBe(false);
      expect(existsSync(custody.plan.backup.prefix)).toBe(false);
    },
  );
  it.each(["generation", "rotation", "attempt owner", "source pointer"])(
    "F3 refuses a mismatched owning log %s",
    async (attack) => {
      const custody = custodyFor(fixture());
      const log = custody.plan.files.find((file) => file.id === "worker-log");
      if (attack === "generation") log.log.generation++;
      if (attack === "rotation") log.log.rotation++;
      if (attack === "attempt owner") log.origin.runId = custody.plan.history.binding.census.id;
      if (attack === "source pointer") log.origin.evidencePointer = "/unrelated-generation";
      custody.save();
      const result = await custody.run();
      expect(result.state, JSON.stringify(result)).toBe("STOP");
      expect(result.partial).toBe(false);
      expect(existsSync(custody.plan.original.prefix)).toBe(false);
      expect(existsSync(custody.plan.backup.prefix)).toBe(false);
    },
  );
  it.each(["diagnostics-only", "duplicate-member", "mismatching-member-bytes", "nested-canonical", "unsafe-entry"])(
    "F4 refuses %s archive despite a separately valid canonical payload",
    async (attack) => {
      const custody = custodyFor(fixture());
      const payload = readFileSync(custody.plan.files.find((file) => file.id === "verification-payload").sourcePath);
      const canonical = ["ephemeral-verification.json", payload];
      const entries =
        attack === "diagnostics-only"
          ? [["diagnostics.json", "{}"]]
          : attack === "duplicate-member"
            ? [canonical, canonical]
            : attack === "mismatching-member-bytes"
              ? [[canonical[0], Buffer.from(payload.toString().replace("2030-", "2031-"))]]
              : attack === "nested-canonical"
                ? [["nested/ephemeral-verification.json", payload]]
                : [canonical, ["../diagnostics.json", "{}"]];
      custody.replaceArchive(entries);
      const result = await custody.run();
      expect(result.state, JSON.stringify(result)).toBe("STOP");
      expect(result.missing).toContain(
        attack === "mismatching-member-bytes"
          ? "ARTIFACT_MEMBER_BYTES"
          : ["diagnostics-only", "nested-canonical"].includes(attack)
            ? "ARTIFACT_CANONICAL_MEMBER"
            : "ARTIFACT_ARCHIVE",
      );
      expect(result.partial).toBe(false);
      expect(existsSync(custody.plan.original.prefix)).toBe(false);
      expect(existsSync(custody.plan.backup.prefix)).toBe(false);
    },
  );
  it("F4 retains a deflated canonical member byte-for-byte with safe diagnostics", async () => {
    const custody = custodyFor(fixture());
    const payload = readFileSync(custody.plan.files.find((file) => file.id === "verification-payload").sourcePath);
    custody.replaceArchive(
      [
        ["ephemeral-verification.json", payload],
        ["diagnostics.json", "{}"],
      ],
      8,
    );
    const result = await custody.run();
    expect(result.state, JSON.stringify(result)).toBe("MATERIALIZED");
    const worker = custody.plan.files.find((file) => file.id === "worker-log");
    expect(worker.origin.containerUid).toBe(worker.log.ownerUid);
    expect(await custody.run()).toEqual(result);
  });
  it("consumes an independently retained plan through the existing acquisition CLI parser without recapturing", async () => {
    const custody = custodyFor(fixture()),
      expected = await custody.run();
    expect(expected.state).toBe("MATERIALIZED");
    const input = custody.input();
    const result = await acquisitionMain(
      [
        "--retained-plan-file",
        custody.planFile,
        "--approved-plan-hash",
        input.authority.approvedPlanHash,
        "--performer",
        input.authority.performer,
      ],
      { now: custody.capabilities.now },
    );
    expect(result).toEqual(expected);
  });
  it("native retained-plan CLI refuses absent durable custody before any original write", () => {
    const custody = custodyFor(fixture()),
      input = custody.input();
    let status, result;
    try {
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL("./c1-evidence-acquisition.mjs", import.meta.url)),
          "--retained-plan-file",
          custody.planFile,
          "--approved-plan-hash",
          input.authority.approvedPlanHash,
          "--performer",
          input.authority.performer,
        ],
        { env: { SystemRoot: process.env.SystemRoot ?? "", PATH: "", SYNTHETIC_ISOLATION_SENTINEL: "fixture-only" } },
      );
    } catch (error) {
      status = error.status;
      result = JSON.parse(error.stdout);
    }
    expect(status).toBe(1);
    expect(result.missing).toEqual(["RETAINED_PLAN_AUTHORITY"]);
    expect(existsSync(custody.plan.planOriginalPath)).toBe(false);
  });
  it.each([
    "withheld authorization",
    "changed release",
    "planted secret",
    "missing consumption plan",
    "cross-scope lifecycle source",
  ])("source custody admission through production: %s", async (attack) => {
    const custody = custodyFor(fixture());
    if (attack === "changed release") custody.plan.files[0].origin.release = "9".repeat(40);
    if (attack === "planted secret") writeFileSync(custody.plan.files[0].sourcePath, "synthetic-sensitive-marker");
    if (attack === "missing consumption plan") delete custody.plan.consumption;
    if (attack === "cross-scope lifecycle source")
      custody.plan.files.find((f) => f.id === "history").scope = "terminal";
    custody.save();
    const input = custody.input();
    if (attack === "withheld authorization") delete input.authority;
    const result = await acquireRetainedC1Evidence(input, custody.capabilities);
    expect(result.state).toBe("STOP");
    expect(result.partial).toBe(false);
    expect(existsSync(custody.plan.planOriginalPath)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("synthetic-sensitive-marker");
  });
  it("refuses a canonical payload reduced to identity-only JSON even with every byte hash updated", async () => {
    const custody = custodyFor(fixture()),
      file = custody.plan.files.find((f) => f.id === "verification-payload");
    const value = JSON.parse(readFileSync(file.sourcePath));
    delete value.checkedAt;
    const bytes = Buffer.from(JSON.stringify(value));
    writeFileSync(file.sourcePath, bytes);
    file.bytes = bytes.length;
    file.sha256 = sha256(bytes);
    file.safety.sha256 = file.sha256;
    custody.replaceArchive([["ephemeral-verification.json", bytes]]);
    custody.save();
    const result = await custody.run();
    expect(result.state).toBe("STOP");
    expect(result.missing).toContain("ARTIFACT_PAYLOAD_BINDING");
    expect(result.partial).toBe(false);
  });
  it("backs up the complete page-two owner envelope before calling the landed reader", async () => {
    const f = fixture({ pageTwo: true }),
      custody = custodyFor(f),
      result = await custody.run();
    expect(result.state, JSON.stringify(result)).toBe("MATERIALIZED");
    expect(result.receipt).toEqual(read(f));
    expect(result.receipt.cRunTerminal.utc).toBe(null);
    expect(result.receipt.c1Admission).not.toBe(true);
    const manifest = JSON.parse(readFileSync(result.custodyManifestPath));
    expect(manifest.terminal.facts).toEqual(read(f));
    expect(manifest.history.binding.uid).not.toBe(manifest.terminal.binding.uid);
    expect(manifest.history.binding.release).not.toBe(manifest.terminal.binding.release);
    expect(manifest.history.binding.verification.id).not.toBe(manifest.terminal.binding.verification.id);
    expect(custody.plan.clockMappings).toHaveLength(7);
    expect(manifest.files).toHaveLength(custody.plan.files.length + 1);
    for (const file of manifest.files) {
      expect(sha256(readFileSync(file.originalPath))).toBe(file.sha256);
      expect(sha256(readFileSync(file.backupPath))).toBe(file.sha256);
    }
    expect(JSON.parse(readFileSync(custody.plan.consumption.outputs.envelope))).toEqual(f.envelope);
    expect(await custody.run()).toEqual(result);
  });
  it.each(sourceIds)("custody bridge omission: removing required source %s refuses before bracket", async (id) => {
    const f = fixture(),
      custody = custodyFor(f);
    const source = custody.plan.files.find((file) => file.id === id);
    source.sourcePath = join(custody.root, "missing-source");
    custody.save();
    const result = await custody.run();
    expect(result.state, id).toBe("STOP");
    expect(result.partial, id).toBe(false);
    expect(result.missing).toContain(`SOURCE_UNAVAILABLE:${id}`);
    expect(existsSync(custody.plan.consumption.outputs.receipt)).toBe(false);
  });
  it.each(["custody-plan", ...sourceIds])(
    "custody bridge omission: removing independent backup %s refuses with unrelated predicates fixed",
    async (id) => {
      const custody = custodyFor(fixture());
      expect((await custody.run()).state).toBe("MATERIALIZED");
      const path =
        id === "custody-plan"
          ? custody.plan.planBackupPath
          : custody.plan.files.find((file) => file.id === id).backupPath;
      rmSync(path);
      const result = await custody.run();
      expect(result.state, id).toBe("STOP");
      expect(result.missing, id).toContain(`BACKUP_UNAVAILABLE:${id}`);
    },
  );
  it.each([
    "101-total/100-count",
    "canonical missing/nonempty directory",
    "mixed attempt",
    "skipped-with-time",
    "missing-finalizer",
    "creation-then-label-failure",
    "early cancellation",
    "runner loss",
  ])("preserves %s as UNKNOWN/refusal, never cleanup success", async (attack) => {
    const f = fixture({ pageTwo: attack === "101-total/100-count" });
    if (attack === "101-total/100-count") f.envelope.jobs.verification.pages.pop();
    if (attack === "mixed attempt")
      f.envelope.consumption.verification[1] = mutateRecord(
        f.envelope.consumption.verification[1],
        (r) => (r.run_attempt = 2),
      );
    if (attack === "skipped-with-time") changeDelete(f, (s) => (s.conclusion = "skipped"));
    if (attack === "missing-finalizer") changeDelete(f, (s) => (s.name = "Synthetic absent finalizer"));
    if (attack === "creation-then-label-failure") f.envelope.namespace.state = "NOT_CREATED";
    if (attack === "early cancellation")
      changeDelete(f, (s) => {
        s.conclusion = "cancelled";
        s.started_at = null;
        s.completed_at = null;
      });
    if (attack === "runner loss") f.envelope.jobs.verification.details = [];
    retain(f);
    const custody = custodyFor(f);
    if (attack === "canonical missing/nonempty directory") {
      const file = custody.plan.files.find((s) => s.id === "verification-payload");
      rmSync(file.sourcePath);
      mkdirSync(file.sourcePath);
      writeFileSync(join(file.sourcePath, "diagnostics.json"), "{}");
    }
    const result = await custody.run();
    expect(result.state, JSON.stringify(result)).toBe("STOP");
    if (attack !== "canonical missing/nonempty directory") {
      expect(result.receipt).toEqual(read(f));
      expect(result.receipt.t0Utc).toBe(null);
    } else expect(existsSync(custody.plan.consumption.outputs.receipt)).toBe(false);
  });
  it("retains executed failed-delete/Terminating as negative c1 admission, not successful cleanup", async () => {
    const f = changeDelete(fixture(), (s) => (s.conclusion = "failure"));
    f.envelope.namespace.deleted = false;
    retain(f);
    const result = await custodyFor(f).run();
    expect(result.receipt).toEqual(read(f));
    expect(result.receipt.cleanupSucceeded).toBe(false);
    expect(result.receipt.c1Admission).toBe(false);
  });
  it("withholds backup authority before any original is written", async () => {
    const custody = custodyFor(fixture());
    const result = await acquireRetainedC1Evidence(custody.input(), { now: custody.capabilities.now });
    expect(result.state).toBe("STOP");
    expect(result.missing).toContain("INDEPENDENT_CUSTODIAN");
    expect(existsSync(custody.plan.files[0].originalPath)).toBe(false);
  });
});
