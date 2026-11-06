import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CERTIFY,
  DELETE,
  METHOD,
  RECEIPT,
  certifyCensusTerminal,
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
    captureStartedAt: "2030-01-01T00:58:00Z",
    captureCompletedAt: "2030-01-01T00:58:01Z",
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

function fixture() {
  const source = readFileSync(
    new URL("../.github/workflows/platform-ephemeral-verification.yml", import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const helper = readFileSync(new URL("./census-terminal-evidence.mjs", import.meta.url), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  const sources = {
    body: "synthetic:admitted issue body",
    method: "synthetic:admitted v3 method",
    helper,
    workflow: source,
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
    step("Reset verification namespace", 2),
    step("Delete verification provider webhooks", 24),
    { ...step(CERTIFY, 51), completed_at: "2030-01-01T00:59:00Z" },
    step(DELETE, 52),
    step("Post synthetic setup action", 81),
    step("Complete job", 90),
  ];
  const vJob = syntheticJob(verification, 900000000000202, "Verify Release in Ephemeral Namespace", vSteps);
  const cJob = syntheticJob(census, 900000000000201, "Read preview-pool census", [
    step("Set up job", 1),
    step("Capture preview-pool census", 24),
    step("Upload preview-pool census", 51),
    step("Complete job", 90),
  ]);
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
      expandedActionsHash: sha256(JSON.stringify(["synthetic checkout", "synthetic setup", "synthetic post"])),
      steps: vSteps.map(({ name }) => ({ name })),
    },
    seal: { schemaVersion: "h6-pre-delete-seal/v1", binding: copy(binding), responses: runs(census) },
    capture: { census: runs(census), verification: runs(verification) },
    consumption: { census: runs(census), verification: runs(verification) },
    jobs: { census: jobSet(census, [cJob]), verification: jobSet(verification, [vJob]) },
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
      at: "2030-01-01T01:00:01Z",
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
  return retain({ envelope, sources });
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
    actions: { expanded: ["synthetic checkout", "synthetic setup", "synthetic post"] },
    logs: {
      safe: true,
      entire: true,
      jobId: e.sourceMap.jobId,
      text: `${e.sourceMap.steps.map((s) => `synthetic executed step ${s.name}`).join("\n")}\nCENSUS_SEAL_SHA256=${sha256(`${JSON.stringify(e.seal)}\n`)}`,
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
    scheduleHash: e.ack.scheduleHash,
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

describe("census terminal evidence synthetic controls", () => {
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
      at: new Date(Date.parse(schedule.t0Utc) + slot * 30000 + 1000).toISOString(),
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
        at: new Date(Date.parse(f.envelope.schedule.t0Utc) + (index * 60 + offset) * 30000 + 1000).toISOString(),
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
        f.envelope.seal.responses = runs(f.envelope.binding.census, cConclusion);
        changeDelete(f, (d) => {
          d.conclusion = dConclusion;
        });
        const before = JSON.stringify(f);
        const result = read(f);
        expect(result.bracketState).toBe("TERMINAL_BEFORE_DELETE");
        expect(result.cRunTerminal.utc).toBeNull();
        expect(result.t0Utc).toBe("2030-01-01T01:00:00Z");
        expect(result.vDeleteTerminal.raw).toBe("2030-01-01T01:00:00Z");
        expect(result.vDeleteTerminal.pointer).toBe("/steps/4/completed_at");
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

  it.each(["no-namespace", "never-started", "zero-jobs"])("No run/cancel: %s stays CLOCK-2, not N7", (kind) => {
    const f = fixture();
    if (kind === "no-namespace") f.envelope.namespace.state = "NOT_CREATED";
    else f.envelope.jobs.verification = jobSet(f.envelope.binding.verification, []);
    retain(f);
    expect(read(f)).toMatchObject({ bracketState: "STOP", reasons: ["CLOCK-2"], t0Utc: null, newOpportunities: 0 });
  });

  it.each(["no-v", "c-never-captured", "admission-refused"])(
    "No run/cancel: affirmative %s is N7 only while no V was dispatched",
    () => {
      const f = fixture();
      Object.assign(f.envelope.dispatch, {
        verificationDispatched: false,
        verificationRunExists: false,
        bracketStarted: false,
      });
      retain(f);
      expect(read(f)).toMatchObject({ bracketState: "NO_BRACKET_NO_T0", newOpportunities: 0 });
      f.envelope.dispatch.verificationDispatched = true;
      retain(f);
      expect(read(f).bracketState).toBe("STOP");
    },
  );

  it("101 jobs: finds the source owner on page two with noncontiguous tail step numbers", () => {
    const f = fixture();
    const b = f.envelope.binding.verification;
    const owner = JSON.parse(f.envelope.jobs.verification.details[0].body);
    const jobs = Array.from({ length: 100 }, (_, i) =>
      syntheticJob(b, 900000001000000 + i, `Synthetic extra job ${i}`, [step("Complete job", 51)]),
    );
    jobs.push(owner);
    const set = jobSet(b, jobs);
    expect(readAttemptJobs(set.pages, set.details, b)).toHaveLength(101);
    f.envelope.jobs.verification = set;
    retain(f);
    expect(read(f).t0Utc).toBe("2030-01-01T01:00:00Z");
  });

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

  it("Surrogates: independent custody/job/hold times never move D", () => {
    for (const key of [
      "updated_at",
      "captureFinish",
      "checkedAt",
      "emittedAtUtc",
      "hold_end",
      "eventDelivery",
      "pollTime",
    ]) {
      const f = fixture();
      f.envelope[key] = "2099-01-01T00:00:00Z";
      f.envelope.seal.responses[0].headers.date = "synthetic later HTTP date";
      retain(f);
      expect(read(f).t0Utc).toBe("2030-01-01T01:00:00Z");
    }
  });

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
