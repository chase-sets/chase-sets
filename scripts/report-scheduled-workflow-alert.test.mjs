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
