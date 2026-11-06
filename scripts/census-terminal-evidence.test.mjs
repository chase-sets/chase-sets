import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  CERTIFY,
  DELETE,
  METHOD,
  RECEIPT,
  certifyCensusTerminal,
  certifyFromEnvironment,
  githubGet,
  instant,
  readAttemptJobs,
  readTerminalEvidence,
  responseRecord,
  sha256,
  validateCensusSeal,
  validateWindowSchedule,
} from "./census-terminal-evidence.mjs";

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

describe("census terminal evidence synthetic controls", () => {
  it("Source transport: bounded GET rejects redirects and retains no authorization headers", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return {
        status: 200,
        text: async () => '{"synthetic":true}',
        headers: new Headers({
          ...headers,
          authorization: "synthetic-not-a-credential",
          "set-cookie": "synthetic-not-a-cookie",
        }),
      };
    };
    try {
      const url = `https://api.github.com/repos/${repository}/actions/runs/900000000000001`;
      const record = await githubGet(url, "synthetic-not-a-credential");
      expect(calls).toHaveLength(1);
      expect(calls[0].options).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      });
      expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);
      expect(record.headers).not.toHaveProperty("authorization");
      expect(record.headers).not.toHaveProperty("set-cookie");
      expect(record.sha256).toBe(sha256(record.body));
      expect(instant(record.captureCompletedAt).ticks).toBeGreaterThanOrEqual(instant(record.captureStartedAt).ticks);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([
    "valid M",
    "R bytes",
    "wrong helper hash",
    "wrong workflow head",
    "wrong release",
    "wrong digest",
    "relative namespace",
    "relative seal",
  ])(
    "Source snapshot execution: %s uses only admitted self bytes and absolute workspace custody before sequential seal writes",
    async (kind) => {
      const f = fixture();
      const mBytes = readFileSync(new URL("./census-terminal-evidence.mjs", import.meta.url));
      const rBytes = Buffer.from("synthetic:distinct historical R helper, never executed");
      expect(sha256(mBytes)).not.toBe(sha256(rBytes));
      const binding = {
        ...copy(f.envelope.binding),
        helperHash: sha256(mBytes),
        verificationWorkflowId: f.envelope.binding.verification.workflowId,
      };
      const env = {
        GITHUB_WORKSPACE: "/synthetic/workspace",
        GITHUB_REPOSITORY: repository,
        GITHUB_RUN_ID: String(binding.verification.id),
        GITHUB_RUN_ATTEMPT: String(binding.verification.attempt),
        CENSUS_TERMINAL_BINDING: JSON.stringify(binding),
        FROZEN_WORKFLOW_SHA: binding.workflowHead,
        RELEASE_COMMIT: binding.release,
        RELEASE_DIGEST: binding.digest,
        NAMESPACE_CREATION_PATH: "/synthetic/workspace/artifacts/ephemeral-verification/namespace-created.json",
        CENSUS_SEAL_PATH: "/synthetic/workspace/artifacts/ephemeral-verification/census-terminal-seal.json",
      };
      if (kind === "wrong helper hash")
        env.CENSUS_TERMINAL_BINDING = JSON.stringify({ ...binding, helperHash: generatedHash("wrong M") });
      if (kind === "wrong workflow head") env.FROZEN_WORKFLOW_SHA = "9".repeat(40);
      if (kind === "wrong release") env.RELEASE_COMMIT = "9".repeat(40);
      if (kind === "wrong digest") env.RELEASE_DIGEST = `sha256:${generatedHash("wrong image")}`;
      if (kind === "relative namespace")
        env.NAMESPACE_CREATION_PATH = "artifacts/ephemeral-verification/namespace-created.json";
      if (kind === "relative seal") env.CENSUS_SEAL_PATH = "artifacts/ephemeral-verification/census-terminal-seal.json";
      const trace = [];
      const writes = [];
      let index = 0;
      const operation = certifyFromEnvironment(env, {
        readFile: (location) => {
          if (location instanceof URL) {
            expect(location.href).toBe(new URL("./census-terminal-evidence.mjs", import.meta.url).href);
            trace.push("read executing M self");
            return kind === "R bytes" ? rBytes : mBytes;
          }
          expect(location).toBe(env.NAMESPACE_CREATION_PATH);
          trace.push("read absolute namespace");
          return JSON.stringify({ metadata: { name: binding.namespace, uid: binding.uid } });
        },
        request: async (url) => {
          trace.push(`GET:${url}`);
          return f.envelope.seal.responses[index++];
        },
        writeFile: (location, value, options) => {
          expect(options).toEqual({ flag: "wx", mode: 0o600, flush: true });
          writes.push({ location, value });
          trace.push(`write:${location}`);
        },
      });
      if (kind !== "valid M") {
        await expect(operation).rejects.toThrow(
          kind.startsWith("relative") ? "STOP_CUSTODY_PATH" : "STOP_MATERIALIZATION",
        );
        expect(index).toBe(0);
        expect(writes).toEqual([]);
        return;
      }
      await operation;
      expect(index).toBe(3);
      expect(writes.map((w) => w.location)).toEqual(
        [1, 2, 3].map((n) => `${env.CENSUS_SEAL_PATH}.response-${n}.json`).concat(env.CENSUS_SEAL_PATH),
      );
      expect(trace.slice(0, 2)).toEqual(["read executing M self", "read absolute namespace"]);
      expect(trace.slice(2).map((s) => s.split(":")[0])).toEqual([
        "GET",
        "write",
        "GET",
        "write",
        "GET",
        "write",
        "write",
      ]);
      validateCensusSeal(JSON.parse(writes.at(-1).value), {
        ...binding,
        verificationWorkflowId: binding.verificationWorkflowId,
      });
    },
  );

  it.each(["command", "workingDirectory", "workflowHead", "helperHash", "namespaceCreationPath", "sealPath"])(
    "Source execution log: wrong snapshot %s cannot borrow a command substring",
    (key) => {
      const f = fixture();
      const logs = JSON.parse(f.envelope.files.find((file) => file.path === "synthetic-logs.json").original);
      logs.certification[key] = "synthetic:wrong-provenance";
      logs.text += "\nnode scripts/census-terminal-evidence.mjs\n";
      f.lifecycleOverrides = { logs };
      retain(f);
      expect(read(f).reasons).toEqual(["STOP_EXECUTION_LOG"]);
    },
  );

  it("No run/cancel: affirmative N7 has no future V identity, UID, W, D, acknowledgement or schedule precondition", () => {
    const f = fixture();
    const e = f.envelope;
    e.dispatch = {
      verificationDispatched: false,
      verificationRunExists: false,
      bracketStarted: false,
      inputHash: generatedHash("no-dispatch"),
    };
    delete e.binding.verification;
    delete e.binding.namespace;
    delete e.binding.uid;
    e.namespace = null;
    e.sourceMap = null;
    e.seal = null;
    e.ack = null;
    e.schedule = null;
    delete e.capture.verification;
    delete e.consumption.verification;
    delete e.jobs.verification;
    e.coverage = e.coverage.map((entry) =>
      ["actions", "logs", "events", "namespace", "finalizers"].includes(entry.role)
        ? { role: entry.role, complete: true, notApplicable: true, reason: "NO_VERIFICATION_RUN", paths: [] }
        : entry.role === "sources"
          ? { ...entry, paths: ["source-workflow"] }
          : entry,
    );
    const values = {
      "facts.json": {
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
      },
      "synthetic-dispatch.json": e.dispatch,
      "synthetic-capture.json": e.capture,
      "synthetic-consumption.json": e.consumption,
    };
    e.files = e.files
      .filter(
        (file) => file.path.startsWith("source-") || file.path.includes("census") || Object.hasOwn(values, file.path),
      )
      .map((file) =>
        Object.hasOwn(values, file.path)
          ? { ...file, original: JSON.stringify(values[file.path]), backup: JSON.stringify(values[file.path]) }
          : file,
      );
    const manifest = e.files.map((file) => ({
      path: file.path,
      backupPath: file.backupPath,
      originalCustodian: file.originalCustodian,
      backupCustodian: file.backupCustodian,
      bytes: Buffer.byteLength(file.original),
      sha256: sha256(file.original),
    }));
    e.externalManifestHash = sha256(JSON.stringify(manifest));
    Object.assign(
      f.admitted,
      copy({
        binding: e.binding,
        dispatch: e.dispatch,
        coverage: e.coverage,
        manifest,
        externalManifestHash: e.externalManifestHash,
      }),
    );
    expect(read(f)).toMatchObject({
      bracketState: "NO_BRACKET_NO_T0",
      reasons: ["N7"],
      t0Utc: null,
      c1Schedule: "NOT_STARTED",
      newOpportunities: 0,
    });
  });

  it.each(["events", "logs", "actions", "namespace", "finalizers"])(
    "NEW capture: missing complete %s refuses",
    (role) => {
      const f = fixture();
      f.envelope.coverage = f.envelope.coverage.filter((value) => value.role !== role);
      retain(f);
      expect(read(f).t0Utc).toBeNull();
    },
  );

  it("Identity: duplicate events are idempotent, conflicting deliveries and omitted events refuse", () => {
    const f = fixture();
    const events = JSON.parse(f.envelope.files.find((file) => file.path === "synthetic-events.json").original);
    f.lifecycleOverrides = { events: [...events, copy(events[0])] };
    retain(f);
    expect(read(f).t0Utc).toBe("2030-01-01T01:00:00Z");
    f.lifecycleOverrides.events.at(-1).kind = "synthetic-conflict";
    retain(f);
    expect(read(f).reasons).toContain("STOP_EVENT_CONFLICT");
    f.lifecycleOverrides.events = events.slice(1);
    retain(f);
    expect(read(f).reasons).toContain("STOP_EVENT_COVERAGE");
  });

  it("Schedule: three persisted windows end on first incomplete/error and resume only in the next fixed slot", () => {
    const f = fixture();
    const schedule = f.envelope.schedule;
    const reading = (slot, status = "COMPLETE") => ({
      slot,
      status,
      at: new Date(Date.parse(schedule.t0Utc) + slot * 30000 + 16000).toISOString(),
      payloadHash: generatedHash(`slot-${slot}`),
    });
    schedule.windows[0].reads = [reading(0, "INCOMPLETE")];
    schedule.windows[0].ended = true;
    schedule.windows[1].startSlot = 1;
    schedule.windows[1].reads = [reading(1, "ERROR")];
    schedule.windows[1].ended = true;
    schedule.windows[2].startSlot = 2;
    schedule.windows[2].reads = Array.from({ length: 60 }, (_, index) => reading(index + 2));
    schedule.windows[2].ended = true;
    expect(validateWindowSchedule(schedule, schedule.t0Utc, f.envelope.ack.at).windows).toHaveLength(3);
    for (const mutate of [
      (s) => {
        s.windows[1].startSlot++;
      },
      (s) => {
        s.windows[0].reads.push(reading(1));
      },
      (s) => {
        s.windows[2].reads[2].slot--;
      },
      (s) => {
        s.windows[2].reads[0].at = "2030-01-01T02:30:00Z";
      },
      (s) => {
        s.deadlineUtc = "2030-01-01T02:30:01Z";
      },
      (s) => {
        s.windows.push(copy(s.windows[2]));
      },
      (s) => {
        s.persistedAt = "2030-01-01T01:00:30Z";
      },
    ]) {
      const mutant = copy(schedule);
      mutate(mutant);
      expect(() => validateWindowSchedule(mutant, schedule.t0Utc, f.envelope.ack.at)).toThrow();
    }
  });

  it("Schedule: full 180 slots obey the unchanged absolute deadline and refuse missed slots", () => {
    const f = fixture();
    for (const [index, window] of f.envelope.schedule.windows.entries()) {
      window.startSlot = index * 60;
      window.ended = true;
      window.reads = Array.from({ length: 60 }, (_, offset) => ({
        slot: index * 60 + offset,
        status: "COMPLETE",
        at: new Date(Date.parse(f.envelope.schedule.t0Utc) + (index * 60 + offset) * 30000 + 16000).toISOString(),
        payloadHash: generatedHash(`full-slot-${index}-${offset}`),
      }));
    }
    expect(() =>
      validateWindowSchedule(f.envelope.schedule, f.envelope.schedule.t0Utc, f.envelope.ack.at),
    ).not.toThrow();
    f.envelope.schedule.windows[0].reads[0].at = "2030-01-01T01:00:30Z";
    expect(() => validateWindowSchedule(f.envelope.schedule, f.envelope.schedule.t0Utc, f.envelope.ack.at)).toThrow();
  });

  it("Schedule: historical v2 and invented two-numeric-operand methods never acquire v3 authority", () => {
    for (const method of ["h6-terminal-source-api/v2", "synthetic:future-two-numeric-clocks"]) {
      const f = fixture();
      f.envelope.method = method;
      f.envelope.cRunTerminal = "2030-01-01T01:00:00Z";
      expect(read(f).t0Utc).toBeNull();
    }
  });

  it.each(["success", "failure", "timed_out", "cancelled"])(
    "Positive: C %s before W and successful/failed executed D",
    (cConclusion) => {
      for (const dConclusion of ["success", "failure"]) {
        const f = fixture();
        for (const phase of ["capture", "consumption"])
          f.envelope[phase].census = runs(f.envelope.binding.census, cConclusion);
        f.envelope.seal.responses = sealRuns(f.envelope.binding.census, cConclusion);
        const cJobs = f.envelope.jobs.census.details.map((record) => JSON.parse(record.body));
        cJobs[0].conclusion = cConclusion;
        cJobs[0].steps.find((s) => s.name === "Capture preview-pool census").conclusion = cConclusion;
        f.envelope.jobs.census = jobSet(f.envelope.binding.census, cJobs);
        for (const phase of ["capture", "consumption"])
          f.envelope[phase].verification = runs(f.envelope.binding.verification, dConclusion);
        changeDelete(f, (d, job) => {
          d.conclusion = dConclusion;
          job.conclusion = dConclusion;
        });
        f.envelope.namespace.deleted = dConclusion === "success";
        retain(f);
        const before = JSON.stringify(f);
        const result = read(f);
        expect(result.bracketState).toBe("TERMINAL_BEFORE_DELETE");
        expect(result.cRunTerminal.utc).toBeNull();
        expect(result.t0Utc).toBe("2030-01-01T01:00:00Z");
        expect(result.vDeleteTerminal.raw).toBe("2030-01-01T01:00:00Z");
        expect(result.vDeleteTerminal.pointer).toBe("/steps/7/completed_at");
        expect(result.c1Admission).toBe(dConclusion === "success" ? null : false);
        expect(JSON.stringify(f)).toBe(before);
      }
    },
  );

  it("W seal is persisted after three foreground GETs before return, with no retry on error", async () => {
    const f = fixture();
    const trace = [];
    let count = 0;
    const seal = await certifyCensusTerminal(f.envelope.binding, {
      request: async (url) => {
        trace.push(`GET:${url}`);
        return f.envelope.seal.responses[count++];
      },
      seal: async (value) => {
        trace.push("seal");
        expect(value.responses).toHaveLength(3);
      },
    });
    trace.push("returned");
    expect(trace.slice(-2)).toEqual(["seal", "returned"]);
    expect(trace.filter((v) => v.startsWith("GET:"))).toHaveLength(3);
    validateCensusSeal(seal, f.envelope.binding);
    count = 0;
    await expect(
      certifyCensusTerminal(f.envelope.binding, {
        request: async () => {
          count++;
          throw new Error("synthetic network deadline");
        },
        seal: () => {
          throw new Error("must not seal");
        },
      }),
    ).rejects.toThrow("synthetic network deadline");
    expect(count).toBe(1);
  });

  it.each([
    [
      "missing seal",
      (f) => {
        f.envelope.seal = null;
      },
    ],
    [
      "nonterminal C",
      (f) => {
        f.envelope.seal.responses[0] = mutateRecord(f.envelope.seal.responses[0], (v) => {
          v.status = "in_progress";
        });
      },
    ],
    [
      "missing conclusion",
      (f) => {
        f.envelope.seal.responses[0] = mutateRecord(f.envelope.seal.responses[0], (v) => {
          v.conclusion = null;
        });
      },
    ],
    [
      "HTTP error",
      (f) => {
        f.envelope.seal.responses[0].status = 500;
      },
    ],
    [
      "header loss",
      (f) => {
        f.envelope.seal.responses[0].headers = {};
      },
    ],
    [
      "wrong C repository",
      (f) => {
        f.envelope.seal.responses[0] = mutateRecord(f.envelope.seal.responses[0], (v) => {
          v.repository.full_name = "synthetic-owner/impostor";
        });
      },
    ],
    [
      "wrong C workflow",
      (f) => {
        f.envelope.seal.responses[0] = mutateRecord(f.envelope.seal.responses[0], (v) => {
          v.workflow_id++;
        });
      },
    ],
    [
      "wrong C path",
      (f) => {
        f.envelope.seal.responses[0] = mutateRecord(f.envelope.seal.responses[0], (v) => {
          v.path = ".github/workflows/synthetic-impostor.yml";
        });
      },
    ],
    [
      "unknown conclusion",
      (f) => {
        f.envelope.seal.responses[0] = mutateRecord(f.envelope.seal.responses[0], (v) => {
          v.conclusion = "future";
        });
      },
    ],
    [
      "wrong current attempt",
      (f) => {
        f.envelope.seal.responses[2] = mutateRecord(f.envelope.seal.responses[2], (v) => {
          v.run_attempt++;
        });
      },
    ],
    [
      "wrong C head",
      (f) => {
        f.envelope.seal.responses[1] = mutateRecord(f.envelope.seal.responses[1], (v) => {
          v.head_sha = "9".repeat(40);
        });
      },
    ],
    [
      "wrong namespace source",
      (f) => {
        f.envelope.namespace.uid = "synthetic-impostor";
      },
    ],
    [
      "async",
      (f) => {
        f.envelope.sourceMap.synchronous = false;
      },
    ],
    [
      "W-failure gates D",
      (f) => {
        f.envelope.sourceMap.deleteDependsOnSeal = true;
      },
    ],
    [
      "wrong owner",
      (f) => {
        f.envelope.sourceMap.jobKey = "selector";
      },
    ],
    [
      "undocumented run UTC",
      (f) => {
        f.envelope.capture.census[0] = mutateRecord(f.envelope.capture.census[0], (v) => {
          v.completed_at = "2030-01-01T00:58:00Z";
        });
      },
    ],
    [
      "later rerun at consumption",
      (f) => {
        f.envelope.consumption.verification[2] = mutateRecord(f.envelope.consumption.verification[2], (v) => {
          v.run_attempt++;
        });
      },
    ],
  ])("W negatives and Identity: %s", (_name, mutate) => {
    const f = fixture();
    mutate(f);
    retain(f);
    expect(read(f).bracketState).toBe("STOP");
    expect(read(f).t0Utc).toBeNull();
    expect(read(f).c1Schedule).toBe("NOT_STARTED");
  });

  it.each(["skipped", "in_progress", "missing", "null", "after-delete"])(
    "Execution: %s delete cannot borrow a job or run clock",
    (kind) => {
      const f = fixture();
      changeDelete(f, (d, job) => {
        if (kind === "skipped") d.conclusion = "skipped";
        if (kind === "in_progress") d.status = "in_progress";
        if (kind === "missing") job.steps = job.steps.filter((s) => s !== d);
        if (kind === "null") d.completed_at = null;
        if (kind === "after-delete") job.steps.find((s) => s.name === CERTIFY).completed_at = "2030-01-01T01:01:00Z";
      });
      expect(read(f).t0Utc).toBeNull();
    },
  );

  it("Execution: created then label fails remains CREATED; failed-delete Terminating retains D", () => {
    const f = fixture();
    changeDelete(f, (d, job) => {
      d.conclusion = "failure";
      job.steps.find((s) => s.name === "Reset verification namespace").conclusion = "failure";
    });
    f.envelope.namespace.deleted = false;
    retain(f);
    expect(read(f)).toMatchObject({ t0Utc: "2030-01-01T01:00:00Z", cleanupSucceeded: false, c1Admission: false });
  });

  it.each(["provider", "delete"])(
    "Finalizers F1: coherent %s failure retains exact D and negative c1 admission",
    (kind) => {
      const f = fixture();
      const jobs = f.envelope.jobs.verification.details.map((record) => JSON.parse(record.body));
      const owner = jobs.find((job) => job.name === "Verify Release in Ephemeral Namespace");
      owner.steps.find(
        (s) => s.name === (kind === "provider" ? "Delete verification provider webhooks" : DELETE),
      ).conclusion = "failure";
      owner.conclusion = "failure";
      f.envelope.jobs.verification = jobSet(f.envelope.binding.verification, jobs);
      for (const phase of ["capture", "consumption"])
        f.envelope[phase].verification = runs(f.envelope.binding.verification, "failure");
      f.envelope.namespace.deleted = kind !== "delete";
      f.lifecycleOverrides = {
        finalizers: {
          provider: kind === "provider" ? "failure" : "success",
          delete: kind === "delete" ? "failure" : "success",
        },
      };
      retain(f);
      const detail = f.envelope.jobs.verification.details.find((record) => JSON.parse(record.body).id === owner.id);
      const result = read(f);
      expect(result).toMatchObject({
        bracketState: "TERMINAL_BEFORE_DELETE",
        cRunTerminal: { utc: null },
        t0Utc: "2030-01-01T01:00:00Z",
        cleanupSucceeded: false,
        c1Admission: false,
        c1Schedule: "HANDOFF_REQUIRED",
        vDeleteTerminal: {
          raw: "2030-01-01T01:00:00Z",
          utc: "2030-01-01T01:00:00Z",
          precision: 0,
          jobId: owner.id,
          pointer: "/steps/7/completed_at",
          payloadHash: detail.sha256,
          requestUrl: detail.url,
          responseHash: sha256(JSON.stringify(detail)),
          conclusion: kind === "delete" ? "failure" : "success",
        },
      });
      expect(result.vDeleteTerminal.retainedPath).toBe(
        f.envelope.files.find((file) => file.original === JSON.stringify(detail)).path,
      );
    },
  );

  it.each(["provider", "delete", "namespace"])(
    "Finalizers F1: contradictory %s proof refuses cleanup qualification",
    (kind) => {
      const f = fixture();
      if (kind === "provider") {
        const jobs = f.envelope.jobs.verification.details.map((record) => JSON.parse(record.body));
        jobs[0].steps.find((s) => s.name === "Delete verification provider webhooks").conclusion = "failure";
        jobs[0].conclusion = "failure";
        f.envelope.jobs.verification = jobSet(f.envelope.binding.verification, jobs);
        for (const phase of ["capture", "consumption"])
          f.envelope[phase].verification = runs(f.envelope.binding.verification, "failure");
      } else if (kind === "delete") f.lifecycleOverrides = { finalizers: { provider: "success", delete: "failure" } };
      else f.envelope.namespace.deleted = false;
      retain(f);
      expect(read(f)).toMatchObject({
        bracketState: "STOP",
        reasons: ["STOP_FINALIZER_CONFLICT"],
        t0Utc: null,
        cRunTerminal: null,
        vDeleteTerminal: null,
        c1Schedule: "NOT_STARTED",
        newOpportunities: 0,
      });
    },
  );

  it.each(["skipped", "neutral", "in_progress", "missing", "duplicate", "null-time"])(
    "Finalizers F1: %s provider teardown is not unique executed finalizer evidence",
    (kind) => {
      const f = fixture();
      const jobs = f.envelope.jobs.verification.details.map((record) => JSON.parse(record.body));
      const owner = jobs[0];
      const provider = owner.steps.find((s) => s.name === "Delete verification provider webhooks");
      if (["skipped", "neutral"].includes(kind)) provider.conclusion = kind;
      if (kind === "in_progress") {
        provider.status = "in_progress";
        provider.conclusion = null;
        provider.completed_at = null;
      }
      if (kind === "missing") owner.steps = owner.steps.filter((s) => s !== provider);
      if (kind === "duplicate") owner.steps.push({ ...provider, number: 99 });
      if (kind === "null-time") provider.completed_at = null;
      f.envelope.jobs.verification = jobSet(f.envelope.binding.verification, jobs);
      retain(f);
      expect(read(f)).toMatchObject({ bracketState: "STOP", t0Utc: null, c1Schedule: "NOT_STARTED" });
    },
  );

  it.each(["no-namespace", "never-started", "zero-jobs"])("No run/cancel: %s stays CLOCK-2, not N7", (kind) => {
    const f = fixture();
    if (kind === "no-namespace") f.envelope.namespace.state = "NOT_CREATED";
    else f.envelope.jobs.verification = jobSet(f.envelope.binding.verification, []);
    retain(f);
    expect(read(f)).toMatchObject({ bracketState: "STOP", reasons: ["CLOCK-2"], t0Utc: null, newOpportunities: 0 });
  });

  it.each(["no-v", "c-never-captured", "admission-refused"])(
    "No run/cancel: affirmative %s is N7 only while no V was dispatched",
    (kind) => {
      const f = fixture();
      if (kind === "c-never-captured") {
        for (const phase of ["capture", "consumption"]) delete f.envelope[phase].census;
        delete f.envelope.jobs.census;
      } else if (kind === "admission-refused") {
        f.envelope.dispatch.admissionRefused = true;
        f.envelope.dispatch.inputHash = generatedHash("admission-refused-before-verification-dispatch");
        f.envelope.capture.census = f.envelope.capture.census.map((record) =>
          mutateRecord(record, (body) => {
            body.status = "queued";
            body.conclusion = null;
          }),
        );
        delete f.envelope.consumption.census;
        f.envelope.jobs.census = jobSet(f.envelope.binding.census, []);
      }
      withoutVerification(f);
      expect(read(f)).toMatchObject({
        bracketState: "NO_BRACKET_NO_T0",
        reasons: ["N7"],
        t0Utc: null,
        c1Schedule: "NOT_STARTED",
        newOpportunities: 0,
      });
      f.envelope.dispatch.verificationDispatched = true;
      const file = f.envelope.files.find((file) => file.path === "facts.json");
      const facts = JSON.parse(file.original);
      facts.dispatch = copy(f.envelope.dispatch);
      file.original = file.backup = JSON.stringify(facts);
      admitFiles(f);
      expect(read(f).bracketState).toBe("STOP");
    },
  );

  it("No run/cancel F2: coherent nonterminal C and affirmative no V remains N7", () => {
    const f = fixture();
    for (const phase of ["capture", "consumption"])
      f.envelope[phase].census = f.envelope[phase].census.map((record) =>
        mutateRecord(record, (body) => {
          body.status = "in_progress";
          body.conclusion = null;
        }),
      );
    const jobs = f.envelope.jobs.census.details.map((record) => JSON.parse(record.body));
    jobs[0].status = "in_progress";
    jobs[0].conclusion = null;
    jobs[0].completed_at = null;
    jobs[0].steps = jobs[0].steps.slice(0, 4);
    Object.assign(jobs[0].steps.at(-1), { status: "in_progress", conclusion: null, completed_at: null });
    f.envelope.jobs.census = jobSet(f.envelope.binding.census, jobs);
    withoutVerification(f);
    expect(read(f)).toMatchObject({
      bracketState: "NO_BRACKET_NO_T0",
      reasons: ["N7"],
      t0Utc: null,
      c1Schedule: "NOT_STARTED",
      newOpportunities: 0,
    });
  });

  it.each(["identity", "namespace", "seal", "jobs", "capture", "unknown-dispatch", "stale-response", "stale-backup"])(
    "No run/cancel F2: no-V %s contradiction or custody defect still refuses",
    (kind) => {
      const original = fixture();
      const f = withoutVerification(fixture());
      if (kind === "identity") f.envelope.binding.verification = original.envelope.binding.verification;
      if (kind === "namespace") f.envelope.namespace = original.envelope.namespace;
      if (kind === "seal") f.envelope.seal = original.envelope.seal;
      if (kind === "jobs") f.envelope.jobs.verification = original.envelope.jobs.verification;
      if (kind === "capture") f.envelope.capture.verification = original.envelope.capture.verification;
      if (kind === "unknown-dispatch") f.envelope.dispatch.verificationDispatched = null;
      if (kind === "stale-response") {
        const record = f.envelope.capture.census[0];
        record.sha256 = generatedHash("stale no-V response");
        withoutVerification(f);
      }
      const facts = f.envelope.files.find((file) => file.path === "facts.json");
      const value = JSON.parse(facts.original);
      for (const key of Object.keys(value)) value[key] = copy(f.envelope[key]);
      facts.original = facts.backup = JSON.stringify(value);
      admitFiles(f);
      if (kind === "stale-backup") f.envelope.files[0].backup += "stale";
      expect(read(f)).toMatchObject({
        bracketState: "STOP",
        t0Utc: null,
        c1Schedule: "NOT_STARTED",
        newOpportunities: 0,
      });
    },
  );

  it("101 jobs: finds the source owner on page two with noncontiguous tail step numbers", () => {
    const f = fixture({ pageTwo: true });
    const b = f.envelope.binding.verification;
    const set = f.envelope.jobs.verification;
    expect(readAttemptJobs(set.pages, set.details, b)).toHaveLength(101);
    f.envelope.jobs.verification = set;
    retain(f);
    expect(read(f).t0Utc).toBe("2030-01-01T01:00:00Z");
  });

  it.each([
    "run-completed-field-absent",
    "success-delete",
    "failure-delete",
    "skipped-with-times",
    "no-v",
    "v-never-started",
  ])("Seed mapping: complete generated synthetic:%s envelope preserves only the accepted v3/W delta", (seed) => {
    let f = fixture();
    f.envelope.caseId = `synthetic:${seed}`;
    if (seed === "failure-delete") {
      changeDelete(f, (d, job) => {
        d.conclusion = "failure";
        job.conclusion = "failure";
      });
      f.envelope.namespace.deleted = false;
      for (const phase of ["capture", "consumption"])
        f.envelope[phase].verification = runs(f.envelope.binding.verification, "failure");
    }
    if (seed === "skipped-with-times")
      changeDelete(f, (d) => {
        d.conclusion = "skipped";
      });
    if (seed === "v-never-started") {
      f.envelope.namespace.state = "NOT_CREATED";
      f.envelope.jobs.verification = jobSet(f.envelope.binding.verification, []);
    }
    f = seed === "no-v" ? withoutVerification(f) : retain(f);
    const result = read(f);
    if (["run-completed-field-absent", "success-delete", "failure-delete"].includes(seed)) {
      expect(JSON.parse(f.envelope.capture.census[0].body)).not.toHaveProperty("completed_at");
      expect(result).toMatchObject({
        bracketState: "TERMINAL_BEFORE_DELETE",
        t0Utc: "2030-01-01T01:00:00Z",
        cRunTerminal: { utc: null },
      });
      expect(result.cleanupSucceeded).toBe(seed !== "failure-delete");
      if (seed === "failure-delete") expect(result.c1Admission).toBe(false);
      f.envelope.seal = null;
      retain(f);
      expect(read(f)).toMatchObject({ bracketState: "STOP", t0Utc: null, c1Schedule: "NOT_STARTED" });
    } else {
      expect(result).toMatchObject({
        reasons: [seed === "no-v" ? "N7" : seed === "v-never-started" ? "CLOCK-2" : "STOP_MISSING_DELETE_TERMINAL"],
        t0Utc: null,
        c1Schedule: "NOT_STARTED",
      });
    }
  });

  it.each(["census", "verification"])(
    "NEW capture: complete source-consistent %s jobs/actions/logs and applicable skipped route qualify",
    (role) => {
      const f = fixture();
      const observed = f.envelope.jobs[role].details.map((record) => JSON.parse(record.body));
      expect(observed).toHaveLength(
        Object.keys(parse(f.sources[role === "census" ? "censusWorkflow" : "workflow"]).jobs).length,
      );
      expect(read(f).bracketState).toBe("TERMINAL_BEFORE_DELETE");
      for (const job of observed)
        expect(f.admitted.sourceGraphs[role].jobs.find((declared) => declared.name === job.name)).toEqual({
          name: job.name,
          skipped: job.conclusion === "skipped",
          steps: job.steps.map(({ name }) => ({ name })),
        });
      for (const job of observed.filter((job) => job.conclusion !== "skipped")) {
        let previous = instant(job.started_at).ticks;
        for (const s of job.steps) {
          expect(instant(s.started_at).ticks).toBeGreaterThanOrEqual(previous);
          expect(instant(s.completed_at).ticks).toBeGreaterThanOrEqual(instant(s.started_at).ticks);
          previous = instant(s.completed_at).ticks;
        }
        expect(previous).toBeLessThanOrEqual(instant(job.completed_at).ticks);
      }
      const cJob = JSON.parse(f.envelope.jobs.census.details[0].body);
      expect(instant(cJob.completed_at).ticks).toBeLessThan(
        instant(f.envelope.seal.responses[0].captureStartedAt).ticks,
      );
      for (const [i, record] of f.envelope.seal.responses.entries()) {
        if (i > 0)
          expect(instant(record.captureStartedAt).ticks).toBeGreaterThanOrEqual(
            instant(f.envelope.seal.responses[i - 1].captureCompletedAt).ticks,
          );
      }
      expect(instant(f.envelope.capture.verification[0].captureStartedAt).ticks).toBeGreaterThan(
        instant(JSON.parse(f.envelope.jobs.verification.details[0].body).completed_at).ticks,
      );
    },
  );

  it.each(["omission", "substitution", "reordering", "extras"])(
    "Identity graph: %s of jobs/steps/actions/source rejects against fixed independent source admission",
    (mutation) => {
      for (const surface of [
        "census jobs",
        "verification jobs",
        "census steps",
        "verification steps",
        "actions",
        "logs",
        "source",
        "action source",
      ]) {
        const f = fixture();
        const expected = copy(f.admitted.sourceGraphs);
        const mutate = (items) => {
          if (mutation === "omission") items.splice(0, 1);
          if (mutation === "substitution") items[0] = { ...items[0], name: "Synthetic substituted declaration" };
          if (mutation === "reordering") [items[0], items[1]] = [items[1], items[0]];
          if (mutation === "extras")
            items.push({ ...items[0], name: "Synthetic extra declaration", id: 900000009999999, number: 999 });
        };
        if (surface.includes("jobs") || surface.includes("steps")) {
          const role = surface.split(" ")[0];
          const jobs = f.envelope.jobs[role].details.map((record) => JSON.parse(record.body));
          if (surface.endsWith("steps")) mutate(jobs[0].steps);
          else if (mutation === "reordering") {
            [jobs[0].name, jobs[1].name] = [jobs[1].name, jobs[0].name];
          } else mutate(jobs);
          f.envelope.jobs[role] = jobSet(f.envelope.binding[role], jobs);
        } else if (surface === "actions") {
          mutate(f.actions);
          f.envelope.sourceMap.expandedActionsHash = sha256(JSON.stringify(f.actions));
        } else if (surface === "logs") {
          const logs = JSON.parse(f.envelope.files.find((file) => file.path === "synthetic-logs.json").original);
          mutate(logs.jobs[0].steps);
          f.lifecycleOverrides = { logs };
        } else {
          const key = surface === "source" ? "workflow" : "action";
          const declaration = parse(f.sources[key]);
          if (key === "workflow") mutate(declaration.jobs["verify-release"].steps);
          else declaration.runs.main = `synthetic-${mutation}.mjs`;
          f.sources[key] = stringify(declaration);
        }
        retain(f);
        expect(f.admitted.sourceGraphs, `${surface}/${mutation}`).toEqual(expected);
        expect(read(f), `${surface}/${mutation}`).toMatchObject({
          bracketState: "STOP",
          t0Utc: null,
          c1Schedule: "NOT_STARTED",
        });
      }
    },
  );

  it.each(["pre", "main", "post"])(
    "Identity actions: omitted %s phase refuses even with a coherent replacement action hash",
    (phase) => {
      const f = fixture();
      const expected = copy(f.admitted.sourceGraphs);
      f.actions = f.actions.filter((action) => action.role !== "verification" || action.phase !== phase);
      f.envelope.sourceMap.expandedActionsHash = sha256(JSON.stringify(f.actions));
      retain(f);
      expect(f.admitted.sourceGraphs).toEqual(expected);
      expect(read(f).reasons).toEqual(["STOP_ACTION_COVERAGE"]);
    },
  );

  it.each([
    "missing-tail",
    "no-next",
    "overlap",
    "changed-total",
    "empty-middle",
    "origin",
    "attempt",
    "query",
    "repeat-cycle",
    "next-after-final",
    "bound",
  ])("Paging negatives: %s", (kind) => {
    const f = fixture();
    const b = f.envelope.binding.verification;
    const jobs = Array.from({ length: 101 }, (_, i) =>
      syntheticJob(b, 900000001000000 + i, `Synthetic job ${i}`, [step("Complete job", 51)]),
    );
    const set = jobSet(b, jobs);
    if (kind === "missing-tail") set.pages.pop();
    if (kind === "no-next") delete set.pages[0].headers.link;
    if (kind === "overlap")
      set.pages[1] = mutateRecord(set.pages[1], (v) => {
        v.jobs[0] = jobs[0];
      });
    if (kind === "changed-total")
      set.pages[1] = mutateRecord(set.pages[1], (v) => {
        v.total_count++;
      });
    if (kind === "empty-middle")
      set.pages[0] = mutateRecord(set.pages[0], (v) => {
        v.jobs = [];
      });
    if (kind === "origin")
      set.pages[0].headers.link = set.pages[0].headers.link.replaceAll("api.github.com", "synthetic.invalid");
    if (kind === "attempt")
      set.pages[0].headers.link = set.pages[0].headers.link.replaceAll("/attempts/1/", "/attempts/2/");
    if (kind === "query")
      set.pages[0].headers.link = set.pages[0].headers.link.replaceAll("per_page=100", "per_page=99");
    if (kind === "repeat-cycle") set.pages[0].headers.link = set.pages[0].headers.link.replaceAll("page=2", "page=1");
    if (kind === "next-after-final") set.pages[1].headers.link = set.pages[0].headers.link;
    if (kind === "bound") set.pages = Array(11).fill(set.pages[0]);
    expect(() => readAttemptJobs(set.pages, set.details, b)).toThrow();
  });

  it.each(["missing-array", "duplicate-number", "duplicate-owner", "wrong-job", "list-detail-conflict"])(
    "Steps: %s rejects",
    (kind) => {
      const f = fixture();
      changeDelete(f, (_d, job) => {
        if (kind === "missing-array") delete job.steps;
        if (kind === "duplicate-number") job.steps.at(-1).number = job.steps[0].number;
        if (kind === "duplicate-owner") job.steps.push(copy(job.steps.find((s) => s.name === DELETE)));
        if (kind === "wrong-job") job.name = "Select Promoted Release";
      });
      if (kind === "list-detail-conflict")
        f.envelope.jobs.verification.details[0] = mutateRecord(f.envelope.jobs.verification.details[0], (v) => {
          v.steps.at(-1).name = "synthetic conflict";
        });
      retain(f);
      expect(read(f).bracketState).toBe("STOP");
    },
  );

  const records = (f) => [
    ...f.envelope.seal.responses,
    ...["capture", "consumption"].flatMap((phase) =>
      ["census", "verification"].flatMap((role) => f.envelope[phase][role]),
    ),
    ...["census", "verification"].flatMap((role) => [...f.envelope.jobs[role].pages, ...f.envelope.jobs[role].details]),
  ];
  const lifecycle = (f, role) =>
    JSON.parse(f.envelope.files.find((file) => file.path === `synthetic-${role}.json`).original);
  const surrogates = [
    [
      "J",
      (f) => {
        changeDelete(f, (_d, job) => {
          job.completed_at = "2099-01-01T00:00:00Z";
        });
      },
    ],
    [
      "updated_at",
      (f) => {
        for (const record of records(f).filter((r) => r.url.includes("/actions/runs/") && !r.url.includes("/jobs?"))) {
          const value = JSON.parse(record.body);
          value.updated_at = "2099-01-01T00:00:00Z";
          Object.assign(
            record,
            responseRecord(record.url, JSON.stringify(value), record.headers, record.status, {
              captureStartedAt: record.captureStartedAt,
              captureCompletedAt: record.captureCompletedAt,
            }),
          );
        }
      },
    ],
    [
      "capture finish",
      (f) => {
        for (const record of records(f)) record.captureCompletedAt = "2099-01-01T00:00:00Z";
      },
    ],
    ...["checkedAt", "emittedAtUtc", "hold_end"].map((key) => [
      key,
      (f) => {
        const logs = lifecycle(f, "logs");
        logs[key] = "2099-01-01T00:00:00Z";
        f.lifecycleOverrides = { logs };
      },
    ]),
    [
      "HTTP Date",
      (f) => {
        for (const record of records(f)) record.headers.date = "Thu, 01 Jan 2099 00:00:00 GMT";
      },
    ],
    ...["deliveredAt", "receivedAt", "polledAt"].map((key) => [
      key,
      (f) => {
        const events = lifecycle(f, "events");
        for (const event of events) event[key] = "2099-01-01T00:00:00Z";
        f.lifecycleOverrides = { events };
      },
    ]),
  ];
  const semantic = (result) => ({
    bracketState: result.bracketState,
    reasons: result.reasons,
    t0Utc: result.t0Utc,
    c: { state: result.cRunTerminal?.state, utc: result.cRunTerminal?.utc },
    d: Object.fromEntries(
      ["raw", "utc", "precision", "pointer", "jobId", "requestUrl", "retainedPath", "conclusion"].map((key) => [
        key,
        result.vDeleteTerminal?.[key],
      ]),
    ),
    cleanupSucceeded: result.cleanupSucceeded,
    c1Admission: result.c1Admission,
    c1Schedule: result.c1Schedule,
    schedule: result.schedule,
    scheduleHash: result.scheduleHash,
  });

  it.each(surrogates)(
    "Surrogates: actual raw %s changes with coherent custody and invariant semantic D/eligibility/schedule",
    (_name, mutate) => {
      const f = fixture();
      const before = read(f);
      const oldFiles = copy(f.envelope.files);
      mutate(f);
      retain(f);
      expect(f.envelope.files).not.toEqual(oldFiles);
      expect(semantic(read(f))).toEqual(semantic(before));
      expect(read(f).cRunTerminal.utc).toBeNull();
      expect(read(f).vDeleteTerminal.payloadHash).toBe(f.envelope.jobs.verification.details[0].sha256);
      for (const [i, file] of f.envelope.files.entries()) {
        expect(file.backup).toBe(file.original);
        expect(f.admitted.manifest[i]).toMatchObject({
          bytes: Buffer.byteLength(file.original),
          sha256: sha256(file.original),
        });
      }
    },
  );

  it.each(["backup", "manifest", "admission", "response hash"])(
    "Surrogates: changed raw payload with stale %s refuses specifically for custody",
    (kind) => {
      const f = fixture();
      const oldFiles = copy(f.envelope.files);
      const oldAdmission = copy(f.admitted);
      surrogates[0][1](f);
      retain(f);
      if (kind === "backup") {
        const changed = f.envelope.files.findIndex((file, i) => file.original !== oldFiles[i].original);
        f.envelope.files[changed].backup = oldFiles[changed].backup;
      }
      if (kind === "manifest") f.admitted.manifest = oldAdmission.manifest;
      if (kind === "admission") f.admitted = oldAdmission;
      if (kind === "response hash") {
        f.envelope.jobs.verification.details[0].sha256 = generatedHash("stale response");
        retain(f);
      }
      expect(read(f).reasons).toEqual([kind === "response hash" ? "STOP_RESPONSE_CUSTODY" : "STOP_PAYLOAD_CUSTODY"]);
      expect(read(f)).toMatchObject({ bracketState: "STOP", t0Utc: null, c1Schedule: "NOT_STARTED" });
    },
  );

  it.each([
    "2030-02-30T00:00:00Z",
    "2030-01-01T00:00:00",
    "2030-01-01T25:00:00Z",
    "2030-01-01T00:00:00+24:00",
    "99999-01-01T00:00:00Z",
    "2030-01-01T00:00:00.1234567890Z",
    null,
    Infinity,
    0,
  ])("UTC rejects %s", (value) => {
    expect(() => instant(value)).toThrow("STOP_UTC");
  });

  it("UTC retains fractions, equivalent offsets and same-second instants without rounded ties", () => {
    expect(instant("2030-01-01T02:00:00.123456789+01:00").utc).toBe("2030-01-01T01:00:00.123456789Z");
    expect(instant("2030-01-01T01:00:00.000000001Z").ticks).toBeGreaterThan(instant("2030-01-01T01:00:00Z").ticks);
    const f = fixture();
    changeDelete(f, (d) => {
      d.started_at = d.completed_at;
    });
    expect(read(f).t0Utc).toBe("2030-01-01T01:00:00Z");
    changeDelete(f, (d) => {
      d.started_at = "2030-01-01T01:00:00.000000001Z";
    });
    expect(read(f).t0Utc).toBeNull();
  });

  it.each(["backup", "original", "body", "helper", "manifest", "coverage", "ack", "late-ack", "stale-review"])(
    "Custody: %s fails closed",
    (kind) => {
      const f = fixture();
      if (kind === "backup") delete f.envelope.files[0].backup;
      if (kind === "original") f.envelope.files[0].original += "mutated";
      if (kind === "body") f.envelope.seal.responses[0].body += " ";
      if (kind === "helper") f.envelope.binding.helperHash = generatedHash("wrong helper");
      if (kind === "manifest") f.envelope.externalManifestHash = generatedHash("wrong manifest");
      if (kind === "coverage") f.envelope.coverage.pop();
      if (kind === "ack") f.envelope.ack = null;
      if (kind === "late-ack") {
        f.envelope.ack.at = "2030-01-01T01:00:30Z";
        retain(f);
      }
      if (kind === "stale-review") f.envelope.admission.controlReceiptHash = generatedHash("stale review");
      expect(read(f).t0Utc).toBeNull();
      expect(read(f).c1Schedule).toBe("NOT_STARTED");
    },
  );
});
