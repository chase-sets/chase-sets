import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { stagingRefreshOverlapWorkflowFiles } from "./staging-refresh-preflight-config.mjs";
import { buildReleaseHealthRecord, parseReleaseHealthArgs } from "./release-health.mjs";
import {
  buildLockIdentity,
  evaluateLockMonitorDecision,
  monitorReleaseLock,
  parseReleaseLockMonitorArgs,
  RELEASE_LOCK_MONITOR_IDENTITY_MARKER,
} from "./release-lock-monitor.mjs";

const route = JSON.stringify({
  kind: "host-revert",
  reference: "https://github.com/chase-sets/chase-sets/issues/10391",
});
const options = {
  repository: "chase-sets/chase-sets",
  token: "fixture-token",
  lockValue: "true",
  reason: "hold",
  reference: "incident",
  exitRoute: route,
  deadline: "2026-10-22T12:05:00Z",
  checkedAt: "2026-10-22T12:05:00Z",
  runId: "42",
  runAttempt: "2",
  jobUrl: "https://github.com/chase-sets/chase-sets/actions/runs/42/job/9",
  hostTarget: "host/orchestrator",
};
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const searchResponse = (items) => response({ items, total_count: items.length, incomplete_results: false });

describe("production release lock monitor", () => {
  it("retains the raw effective tuple at the CLI/environment boundary", () => {
    const parsed = parseReleaseLockMonitorArgs(["--reason", " override "], {
      PRODUCTION_RELEASE_LOCKED: " TRUE ",
      PRODUCTION_RELEASE_LOCK_REASON: "old",
      PRODUCTION_RELEASE_LOCK_REFERENCE: " ref ",
      PRODUCTION_RELEASE_LOCK_EXIT_ROUTE: ` ${route} `,
      PRODUCTION_RELEASE_LOCK_DEADLINE: ` ${options.deadline} `,
    });
    expect(buildLockIdentity(parsed).tuple).toEqual([
      " TRUE ",
      " override ",
      " ref ",
      ` ${route} `,
      ` ${options.deadline} `,
    ]);
  });

  it.each([
    { incomplete_results: true, total_count: 0, items: [] },
    { incomplete_results: false, total_count: 1001, items: [] },
    { items: [] },
    { incomplete_results: false, total_count: 1, items: [] },
    { incomplete_results: false, total_count: 1, items: [{ number: 1, state: "open" }] },
  ])("refuses unknown, truncated or overflowing lookup rather than blind creation %j", async (payload) => {
    let requests = 0;
    await expect(
      monitorReleaseLock(options, {
        fetch: async () => {
          requests += 1;
          return response(payload);
        },
      }),
    ).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it("fails visibly for a missing or malformed locked source rather than treating unknown as false", () => {
    expect(() => evaluateLockMonitorDecision({ ...options, lockValue: "" })).toThrow("unknown");
    expect(() => evaluateLockMonitorDecision({ ...options, lockValue: "maybe" })).toThrow("unknown");
  });
  it("notifies only on first executed deadline observation, not before it", () => {
    expect(evaluateLockMonitorDecision({ ...options, checkedAt: "2026-10-22T12:04:59Z" })).toMatchObject({
      state: "pending",
      shouldNotify: false,
    });
    expect(evaluateLockMonitorDecision(options)).toMatchObject({ state: "overdue", shouldNotify: true });
  });

  it("immediately escalates legacy invalid true locks and ignores false stale metadata", () => {
    expect(evaluateLockMonitorDecision({ ...options, exitRoute: "", deadline: "" })).toMatchObject({
      state: "invalid",
      shouldNotify: true,
    });
    expect(
      evaluateLockMonitorDecision({ ...options, lockValue: "false", exitRoute: "bad json", deadline: "bad" }),
    ).toMatchObject({ state: "ignored", shouldNotify: false });
  });

  it("binds identity to the raw five-field tuple, never run id or updated_at", () => {
    expect(buildLockIdentity(options).identity).toBe(
      buildLockIdentity({ ...options, runId: "new", updated_at: "new" }).identity,
    );
    for (const key of ["lockValue", "reason", "reference", "exitRoute", "deadline"]) {
      expect(buildLockIdentity({ ...options, [key]: `${options[key]} ` }).identity).not.toBe(
        buildLockIdentity(options).identity,
      );
    }
  });

  it("creates one issue without requiring any release and does not duplicate or comment on retry", async () => {
    const calls = [];
    let issues = [];
    const fetch = async (url, init) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body });
      if (!init.method) return searchResponse(issues);
      const value = JSON.parse(init.body);
      expect(value.body).toContain(
        `<!-- ${RELEASE_LOCK_MONITOR_IDENTITY_MARKER}:${buildLockIdentity(options).identity} -->`,
      );
      expect(value.body).toContain(
        "Safe failure: no unlock, bypass, deployment, or production mutation was attempted.",
      );
      expect(value.body).toContain(options.jobUrl);
      issues = [
        {
          ...value,
          id: 1000,
          number: 100,
          state: "open",
          html_url: "https://github.com/chase-sets/chase-sets/issues/100",
        },
      ];
      return response(issues[0]);
    };
    expect((await monitorReleaseLock(options, { fetch })).issue.number).toBe(100);
    expect(
      (await monitorReleaseLock({ ...options, checkedAt: "2026-10-23T12:05:00Z", runId: "43" }, { fetch })).issue
        .number,
    ).toBe(100);
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("reopens an exact closed identity while active, without adding a comment", async () => {
    const calls = [];
    const issue = {
      id: 1000,
      number: 100,
      state: "closed",
      body: `<!-- ${RELEASE_LOCK_MONITOR_IDENTITY_MARKER}:${buildLockIdentity(options).identity} -->`,
      html_url: "url",
    };
    const result = await monitorReleaseLock(options, {
      fetch: async (url, init) => {
        calls.push(init.method ?? "GET");
        return !init.method ? searchResponse([issue]) : response({ ...issue, state: "open" });
      },
    });
    expect(result.issue.state).toBe("open");
    expect(calls).toEqual(["GET", "PATCH"]);
  });

  it("fails visibly on delivery failure and leaves the lock closed for next retry", async () => {
    await expect(monitorReleaseLock(options, { fetch: async () => response({}, 403) })).rejects.toThrow("status 403");
    expect(evaluateLockMonitorDecision(options).shouldNotify).toBe(true);
    const recovered = await monitorReleaseLock(options, {
      fetch: async (url, init) =>
        !init.method
          ? searchResponse([])
          : response({
              id: 1000,
              number: 100,
              state: "open",
              html_url: "https://github.com/chase-sets/chase-sets/issues/100",
            }),
    });
    expect(recovered.issue.id).toBe(1000);
  });

  it("does no delivery after clear or during the next pending routine lock", async () => {
    const fetch = async () => {
      throw new Error("Unexpected issue I/O");
    };
    expect(
      (await monitorReleaseLock({ ...options, lockValue: "false", exitRoute: "stale" }, { fetch })).issue,
    ).toBeNull();
    const next = await monitorReleaseLock({ ...options, deadline: "2026-10-23T12:05:00Z" }, { fetch });
    expect(next.shouldNotify).toBe(false);
    expect(next.identity).not.toBe(buildLockIdentity(options).identity);
  });

  it("threads all production vars through the schedule/manual entrypoint with least privilege", () => {
    const text = readFileSync(".github/workflows/platform-production-lock-monitor.yml", "utf8");
    const workflow = parse(text);
    expect(workflow.on.schedule).toEqual([{ cron: "*/5 * * * *" }]);
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.concurrency).toEqual({
      group: "platform-production-release-lock-monitor",
      "cancel-in-progress": false,
    });
    expect(workflow.permissions).toEqual({ contents: "read", issues: "write" });
    const job = workflow.jobs["monitor-production-release-lock"];
    expect(job.environment).toBe("production");
    expect(job.needs).toBeUndefined();
    expect(job.permissions).toEqual({ contents: "read", issues: "write" });
    expect(job.env.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect(job.steps[0].uses).toMatch(/^actions\/checkout@[a-f0-9]{40}$/);
    expect(job.steps.find((step) => step.run)?.run).toBe(
      "node ./scripts/release-lock-monitor.mjs --out artifacts/release-health/production-release-lock-monitor.json",
    );
    expect(stagingRefreshOverlapWorkflowFiles).not.toContain(".github/workflows/platform-production-lock-monitor.yml");
    expect(
      JSON.parse(
        readFileSync(".github/authority/platform-production-lock-monitor/monitor-production-release-lock.json", "utf8"),
      ),
    ).toEqual({ grants: [] });
    expect(text).not.toMatch(/secrets\.|terraform|kubectl|helm|doctl/);
    const env = {};
    for (const field of [
      "PRODUCTION_RELEASE_LOCKED",
      "PRODUCTION_RELEASE_LOCK_REASON",
      "PRODUCTION_RELEASE_LOCK_REFERENCE",
      "PRODUCTION_RELEASE_LOCK_EXIT_ROUTE",
      "PRODUCTION_RELEASE_LOCK_DEADLINE",
    ]) {
      expect(job.env[field]).toContain(`vars.${field}`);
      env[field] = `${field}-effective`;
    }
    expect(parseReleaseLockMonitorArgs([], env)).toMatchObject({
      lockValue: env.PRODUCTION_RELEASE_LOCKED,
      reason: env.PRODUCTION_RELEASE_LOCK_REASON,
      reference: env.PRODUCTION_RELEASE_LOCK_REFERENCE,
      exitRoute: env.PRODUCTION_RELEASE_LOCK_EXIT_ROUTE,
      deadline: env.PRODUCTION_RELEASE_LOCK_DEADLINE,
    });
    expect(job.steps.find((step) => step.run).env.GITHUB_JOB_URL).toContain("job.check_run_id");
  });

  it("traces live variable sources through the scheduled parser, issue delivery and health consumer; each omitted source fails wiring", async () => {
    const workflow = parse(readFileSync(".github/workflows/platform-production-lock-monitor.yml", "utf8"));
    const production = parse(readFileSync(".github/workflows/platform-production.yml", "utf8")).jobs[
      "deploy-production"
    ];
    const fields = {
      PRODUCTION_RELEASE_LOCKED: options.lockValue,
      PRODUCTION_RELEASE_LOCK_REASON: options.reason,
      PRODUCTION_RELEASE_LOCK_REFERENCE: options.reference,
      PRODUCTION_RELEASE_LOCK_EXIT_ROUTE: options.exitRoute,
      PRODUCTION_RELEASE_LOCK_DEADLINE: options.deadline,
    };
    const wire = (job) =>
      Object.fromEntries(
        Object.entries(fields).map(([field, value]) => {
          if (!job.env[field]?.includes(`vars.${field}`)) throw new Error(`Missing live source ${field}`);
          return [field, value];
        }),
      );
    for (const field of Object.keys(fields)) {
      const mutant = structuredClone(workflow.jobs["monitor-production-release-lock"]);
      delete mutant.env[field];
      expect(() => wire(mutant)).toThrow(`Missing live source ${field}`);
    }
    const env = wire(workflow.jobs["monitor-production-release-lock"]);
    const parsed = {
      ...parseReleaseLockMonitorArgs([], {
        ...env,
        GITHUB_REPOSITORY: options.repository,
        GITHUB_TOKEN: options.token,
      }),
      checkedAt: options.checkedAt,
    };
    let delivered;
    const result = await monitorReleaseLock(parsed, {
      fetch: async (url, init) => {
        if (!init.method) return searchResponse([]);
        delivered = JSON.parse(init.body);
        return response({
          id: 1000,
          number: 1,
          state: "open",
          html_url: "https://github.com/chase-sets/chase-sets/issues/1",
        });
      },
    });
    expect(delivered.body).toContain(options.exitRoute);
    expect(result.identity).toBe(buildLockIdentity(options).identity);
    const healthInput = parseReleaseHealthArgs([], wire(production));
    const health = buildReleaseHealthRecord({
      ...healthInput,
      releaseCommit: "a".repeat(40),
      workflowRunId: "synthetic",
    });
    expect(health.record.releaseLock).toMatchObject({
      locked: true,
      reason: options.reason,
      reference: options.reference,
      exitRoute: JSON.parse(route),
      deadline: options.deadline,
    });
    const healthStep = production.steps.find((step) => step.name === "Write release health summary");
    for (const field of Object.keys(fields)) expect(healthStep.env[field]).toContain(`vars.${field}`);
  });
});
