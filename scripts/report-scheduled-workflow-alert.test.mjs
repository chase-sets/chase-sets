import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

const actionPath = resolve(".github", "actions", "report-scheduled-workflow-alert", "action.yml");
const action = parse(readFileSync(actionPath, "utf8"));
const step = action.runs.steps[0];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function actionHarness(options = {}) {
  const runAttempt = Object.hasOwn(options, "runAttempt") ? options.runAttempt : "7";
  const status = options.status ?? "failure";
  const dryRun = options.dryRun ?? "true";
  const openIssue = options.openIssue ?? null;
  const notices = [];
  const failures = [];
  const calls = [];
  const markerComments = [];
  const env = {
    ALERT_WORKFLOW_NAME: "Synthetic issue 6497 workflow",
    ALERT_STATUS: status,
    ALERT_SUMMARY: "Synthetic summary",
    ALERT_DETAILS: "Synthetic details",
    ALERT_ISSUE_TITLE: "[ops-alert] Synthetic issue 6497 workflow failing",
    ALERT_LABELS: "kind:ops,area:ops",
    ALERT_DRY_RUN: dryRun,
  };
  if (runAttempt !== undefined) {
    env.ALERT_RUN_ATTEMPT = runAttempt;
  }
  for (const [name, expression] of Object.entries(step.env)) {
    const input = /^\$\{\{ inputs\.([\w-]+) \}\}$/.exec(expression)?.[1];
    if (input && Object.hasOwn(options.inputs ?? {}, input)) {
      env[name] = options.inputs[input];
    }
  }
  const github = {
    rest: {
      search: {
        issuesAndPullRequests: vi.fn(async (input) => {
          calls.push(["search", input]);
          return { data: { items: openIssue ? [openIssue] : [] } };
        }),
      },
      issues: {
        listComments: vi.fn(),
        create: vi.fn(async (input) => {
          calls.push(["create", input]);
          return { data: { number: 6497 } };
        }),
        createComment: vi.fn(async (input) => calls.push(["comment", input])),
        update: vi.fn(async (input) => calls.push(["update", input])),
      },
    },
    paginate: vi.fn(async () => markerComments),
  };
  const context = {
    repo: { owner: "synthetic-owner", repo: "synthetic-repo" },
    serverUrl: "https://github.synthetic.invalid",
    runId: 30807236942,
    eventName: "schedule",
    ref: "refs/heads/main",
    sha: "a".repeat(40),
  };
  const core = {
    setFailed: (message) => failures.push(message),
    notice: (message) => notices.push(message),
    info: vi.fn(),
  };
  return {
    calls,
    core,
    env,
    failures,
    github,
    markerComments,
    notices,
    run: async () => {
      const script = new AsyncFunction("github", "context", "core", "process", step.with.script);
      await script(github, context, core, { env });
    },
  };
}

describe("report scheduled workflow alert action", () => {
  it("does not create, comment on, or update an issue during dry run", async () => {
    const harness = actionHarness();

    await harness.run();

    expect(harness.calls.map(([operation]) => operation)).toEqual(["search"]);
    expect(harness.calls.filter(([operation]) => ["create", "comment", "update"].includes(operation))).toEqual([]);
  });

  it("passes github.run_attempt explicitly and emits synthetic attempt 7 in both marker and body during dry run", async () => {
    expect(step.env.ALERT_RUN_ATTEMPT).toBe("${{ github.run_attempt }}");
    const harness = actionHarness();

    await harness.run();

    expect(harness.failures).toEqual([]);
    expect(harness.notices).toHaveLength(1);
    const notice = JSON.parse(harness.notices[0]);
    expect(notice.marker).toBe("<!-- scheduled-workflow-alert:Synthetic issue 6497 workflow:30807236942:7:failure -->");
    expect(notice.commentBody).toContain("- Run attempt: 7");
  });

  it.each([undefined, "", "0", "-1", "1.5", "seven"])(
    "fails closed for invalid run attempt %s before any GitHub request",
    async (runAttempt) => {
      const harness = actionHarness({ runAttempt });

      await harness.run();

      expect(harness.failures).toEqual(["github.run_attempt must be a positive integer."]);
      expect(harness.calls).toEqual([]);
      expect(harness.notices).toEqual([]);
    },
  );

  it("preserves one-open-issue creation and includes the attempt marker in the issue body", async () => {
    const harness = actionHarness({ dryRun: "false" });

    await harness.run();

    expect(harness.calls.map(([operation]) => operation)).toEqual(["search", "create"]);
    expect(harness.calls[1][1].body).toContain(
      "<!-- scheduled-workflow-alert:Synthetic issue 6497 workflow:30807236942:7:failure -->",
    );
  });

  it("preserves idempotent failure comments and recovery closure", async () => {
    const openIssue = {
      number: 6497,
      title: "[ops-alert] Synthetic issue 6497 workflow failing",
    };
    const failureHarness = actionHarness({ dryRun: "false", openIssue });
    failureHarness.markerComments.push({
      body: "<!-- scheduled-workflow-alert:Synthetic issue 6497 workflow:30807236942:7:failure -->",
    });

    await failureHarness.run();

    expect(failureHarness.calls.map(([operation]) => operation)).toEqual(["search"]);

    const recoveryHarness = actionHarness({ dryRun: "false", openIssue, status: "success" });
    await recoveryHarness.run();

    expect(recoveryHarness.calls.map(([operation]) => operation)).toEqual(["search", "comment", "update"]);
    expect(recoveryHarness.calls.at(-1)[1]).toMatchObject({
      issue_number: 6497,
      state: "closed",
      state_reason: "completed",
    });
  });
});

const reporterAction = "./.github/actions/report-scheduled-workflow-alert";
const callerCases = [
  { file: "platform-ci-flake-digest.yml", producers: ["digest"], schedules: ["0 15 * * 1"] },
  {
    file: "platform-coverage.yml",
    producers: ["coverage-fast", "coverage-db", "coverage-summary"],
    schedules: ["41 9 * * *"],
    advisory: true,
  },
  { file: "platform-delivery-health.yml", producers: ["publish"], schedules: ["17 * * * *", "43 8 * * *"] },
  {
    file: "platform-digitalocean-token-rotation-reminder.yml",
    producers: ["remind"],
    schedules: ["17 14 6 1,4,7,10 *"],
  },
  { file: "platform-merge-group-failure-signatures.yml", producers: ["evaluate"], schedules: ["37 12 * * *"] },
  { file: "platform-merge-queue-posture.yml", producers: ["posture"], schedules: ["17 11 * * *"] },
  {
    file: "platform-preview-cleanup.yml",
    producers: [
      "discover-preview-cleanup",
      "discover-stale-verification",
      "destroy-preview",
      "destroy-stale-verification",
      "discover-stale-verification-webhooks",
      "delete-stale-verification-webhooks",
      "discover-stale-gate",
      "destroy-stale-gate",
      "report-stale-gate-sweep",
    ],
    schedules: ["17 10 * * *", "47 */3 * * *"],
  },
];

function dependencies(job) {
  return Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
}

// Evaluate the callers' small expression vocabulary, including Actions' implicit
// success gate. Unknown syntax fails the test rather than silently approximating it.
function condition(expression, { needs = {}, status = "success", success = status === "success" } = {}) {
  if (expression === undefined) return success;
  const source = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  function atom(value) {
    if (value === "always()") return true;
    if (value === "success()") return success;
    if (value === "failure()") return status === "failure";
    if (value === "cancelled()") return status === "cancelled";
    const contains = /^contains\(needs\.\*\.(result|outputs\.alert_status), '([^']+)'\)$/.exec(value);
    if (contains) {
      return Object.values(needs).some(
        (need) => (contains[1] === "result" ? need.result : need.outputs?.alert_status) === contains[2],
      );
    }
    throw new Error(`Unsupported caller condition: ${value}`);
  }
  const result = source
    .split(/\s+\|\|\s+/)
    .map((part) =>
      part
        .split(/\s+&&\s+/)
        .map(atom)
        .every(Boolean),
    )
    .some(Boolean);
  return (/\b(always|success|failure|cancelled)\(\)/.test(source) || success) && result;
}

function producerResult(job, { result = "success", failedStep = 0, error = "" } = {}) {
  const outputs = {};
  if (job.outputs?.alert_status) {
    const binding = /^\$\{\{ steps\.([\w-]+)\.outputs\.status \}\}$/.exec(job.outputs.alert_status);
    if (!binding) throw new Error("Unsupported alert status output binding");
    const captureIndex = job.steps.findIndex((candidate) => candidate.id === binding[1]);
    const capture = job.steps[captureIndex];
    if (capture && result !== "skipped") {
      const status = result === "failure" && failedStep >= captureIndex ? "success" : result;
      if (condition(capture.if, { status })) {
        expect(capture.run).toBe('echo "status=${{ job.status }}" >> "$GITHUB_OUTPUT"');
        outputs.alert_status = status;
      }
    }
  }
  return { result: job["continue-on-error"] && result === "failure" ? "success" : result, outputs, error };
}

function reachedAlerts(workflow, states = {}) {
  const reporter = workflow.jobs.reporter;
  const needs = Object.fromEntries(
    dependencies(reporter).map((id) => [id, producerResult(workflow.jobs[id], states[id])]),
  );
  if (!condition(reporter.if, { needs, success: Object.values(needs).every((need) => need.result === "success") })) {
    return [];
  }
  return reporter.steps.filter((candidate) => candidate.uses === reporterAction && condition(candidate.if, { needs }));
}

function assertFailureObserved(workflow, producer, failedStep = 0) {
  expect(reachedAlerts(workflow, { [producer]: { result: "failure", failedStep } })).toHaveLength(1);
}

function assertReporterBoundary(workflow, { producers, advisory }) {
  const reporter = workflow.jobs.reporter;
  expect(Object.keys(workflow.jobs).sort()).toEqual([...producers, "reporter"].sort());
  expect(dependencies(reporter).sort()).toEqual([...producers].sort());
  expect(reporter.permissions).toEqual({ contents: "read", issues: "write" });
  expect(reporter.environment).toBeUndefined();
  expect(reporter.env).toBeUndefined();
  const alertIndex = reporter.steps.findIndex((candidate) => candidate.uses === reporterAction);
  expect(alertIndex).toBeGreaterThan(0);
  const checkout = reporter.steps
    .slice(0, alertIndex)
    .find((candidate) => candidate.uses?.startsWith("actions/checkout@"));
  expect(checkout?.uses).toMatch(/^actions\/checkout@[a-f0-9]{40}$/);
  expect(checkout?.if).toBeUndefined();
  expect(checkout?.with).toBeUndefined();
  const alert = reporter.steps[alertIndex];
  expect(alert.with["github-token"]).toBe("${{ github.token }}");
  expect(alert.with["workflow-name"]).toBe(workflow.name);
  expect(alert.with["alert-status"]).toBe("failure");
  for (const key of ["alert-summary", "alert-details"]) {
    expect(alert.with[key] ?? "").not.toContain("${{");
    expect((alert.with[key] ?? "").length).toBeLessThan(256);
  }
  if (advisory) {
    for (const id of [...producers, "reporter"]) expect(workflow.jobs[id]["continue-on-error"]).toBe(true);
  }
}

describe.each(callerCases)("scheduled workflow caller $file", (entry) => {
  const workflow = parse(readFileSync(resolve(".github/workflows", entry.file), "utf8"));

  it("preserves the schedule and uses a trusted, narrowly permitted reporter boundary", () => {
    expect(workflow.on.schedule.map(({ cron }) => cron)).toEqual(entry.schedules);
    assertReporterBoundary(workflow, entry);
  });

  for (const producer of entry.producers) {
    it.each(["setup", "command", "late"])(`observes ${producer} %s failure even when the summary succeeds`, (phase) => {
      const steps = workflow.jobs[producer].steps;
      const failedStep =
        phase === "setup"
          ? 0
          : phase === "command"
            ? steps.findIndex((candidate) => candidate.run)
            : steps.length - (entry.advisory ? 2 : 1);
      expect(failedStep).toBeGreaterThanOrEqual(0);
      assertFailureObserved(workflow, producer, failedStep);
    });

    it.each(["success", "skipped", "cancelled"])(`does not classify ${producer} %s as failure`, (result) => {
      expect(reachedAlerts(workflow, { [producer]: { result } })).toEqual([]);
    });

    it(`rejects a missing ${producer} dependency edge`, () => {
      const mutant = structuredClone(workflow);
      mutant.jobs.reporter.needs = dependencies(mutant.jobs.reporter).filter((id) => id !== producer);
      expect(() => assertFailureObserved(mutant, producer)).toThrow();
    });
  }

  it("keeps an executed failure visible alongside skipped and cancelled producers", () => {
    const states = Object.fromEntries(
      entry.producers.map((id, index) => [id, { result: index % 2 ? "skipped" : "cancelled" }]),
    );
    states[entry.producers[0]] = { result: "failure" };
    expect(reachedAlerts(workflow, states)).toHaveLength(1);
  });

  it("rejects a removed alert step", () => {
    const mutant = structuredClone(workflow);
    mutant.jobs.reporter.steps = mutant.jobs.reporter.steps.filter((candidate) => candidate.uses !== reporterAction);
    expect(() => assertFailureObserved(mutant, entry.producers[0])).toThrow();
  });

  it("rejects success() in place of the failure predicate", () => {
    const mutant = structuredClone(workflow);
    mutant.jobs.reporter.steps.find((candidate) => candidate.uses === reporterAction).if = "${{ success() }}";
    expect(reachedAlerts(mutant)).toHaveLength(1);
    expect(() => expect(reachedAlerts(mutant)).toEqual([])).toThrow();
  });

  it.each(["checkout", "token", "permission"])("rejects missing %s at the actual call site", (prerequisite) => {
    const mutant = structuredClone(workflow);
    const reporter = mutant.jobs.reporter;
    if (prerequisite === "checkout")
      reporter.steps = reporter.steps.filter((candidate) => !candidate.uses?.startsWith("actions/checkout@"));
    if (prerequisite === "token")
      delete reporter.steps.find((candidate) => candidate.uses === reporterAction).with["github-token"];
    if (prerequisite === "permission") delete reporter.permissions.issues;
    expect(() => assertReporterBoundary(mutant, entry)).toThrow();
  });

  it("executes the real reporter dry run without forwarding a secret-bearing producer error", async () => {
    const secretMarker = "SYNTHETIC_PROVIDER_SECRET_MUST_NOT_LEAVE_PRODUCER";
    const [alert] = reachedAlerts(workflow, { [entry.producers[0]]: { result: "failure", error: secretMarker } });
    const harness = actionHarness({ inputs: alert.with });
    await harness.run();
    expect(harness.failures).toEqual([]);
    expect(harness.calls.map(([operation]) => operation)).toEqual(["search"]);
    const notice = JSON.parse(harness.notices[0]);
    expect(notice.commentBody).toContain(`- Workflow: ${workflow.name}`);
    expect(notice.commentBody).toContain(alert.with["alert-summary"]);
    expect(JSON.stringify(notice)).not.toContain(secretMarker);
  });

  if (entry.advisory) {
    it.each(entry.producers)("rejects missing failure containment on %s", (producer) => {
      const mutant = structuredClone(workflow);
      delete mutant.jobs[producer]["continue-on-error"];
      expect(() => assertReporterBoundary(mutant, entry)).toThrow();
    });

    it("contains reporter-service and reporter-checkout failure", () => {
      expect(producerResult(workflow.jobs.reporter, { result: "failure" }).result).toBe("success");
      const mutant = structuredClone(workflow);
      delete mutant.jobs.reporter["continue-on-error"];
      expect(() => assertReporterBoundary(mutant, entry)).toThrow();
    });

    it.each(entry.producers)(
      "captures %s failure after the last operational step, before normalization",
      (producer) => {
        const job = workflow.jobs[producer];
        expect(job.steps.at(-1).id).toBe("alert-status");
        expect(producerResult(job, { result: "failure" })).toMatchObject({
          result: "success",
          outputs: { alert_status: "failure" },
        });
        for (const change of ["output", "capture", "predicate"]) {
          const mutant = structuredClone(workflow);
          if (change === "output") delete mutant.jobs[producer].outputs.alert_status;
          if (change === "capture") mutant.jobs[producer].steps.pop();
          if (change === "predicate") mutant.jobs[producer].steps.at(-1).if = "${{ success() }}";
          expect(() => assertFailureObserved(mutant, producer)).toThrow();
        }
      },
    );

    it("leaves captured nonzero coverage-command exits advisory and unalerted", () => {
      for (const producer of ["coverage-fast", "coverage-db"]) {
        const command = workflow.jobs[producer].steps.find((candidate) => candidate.id === "coverage").run;
        expect(command).toContain("set +e");
        expect(command).toContain("status=$?");
        expect(command).not.toMatch(/exit\s+\$/);
      }
      expect(reachedAlerts(workflow)).toEqual([]);
    });
  } else {
    it("rejects removal of the reporter's always() job gate", () => {
      const mutant = structuredClone(workflow);
      delete mutant.jobs.reporter.if;
      expect(() => assertFailureObserved(mutant, entry.producers[0])).toThrow();
    });
  }

  if (entry.file === "platform-preview-cleanup.yml") {
    it.each([
      "destroy-preview",
      "destroy-stale-verification",
      "delete-stale-verification-webhooks",
      "destroy-stale-gate",
    ])("observes a failed %s matrix with a successful gate summary and keeps fail-fast disabled", (producer) => {
      expect(workflow.jobs[producer].strategy["fail-fast"]).toBe(false);
      assertFailureObserved(workflow, producer);
    });
  }
});
