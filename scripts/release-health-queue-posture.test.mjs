import { describe, expect, it, vi } from "vitest";
import {
  MERGE_QUEUE_POLICY,
  RELEASE_HEALTH_QUEUE_POSTURE_VERSION,
  collectMergeQueuePosture,
  evaluateMergeQueuePosture,
  formatQueuePostureText,
  parseQueuePostureArgs,
} from "./release-health-queue-posture.mjs";

// Fixture mirroring the live `GET /rules/branches/main` payload for ruleset
// 17097957 at the documented policy (2/2, SQUASH, ALLGREEN, min 1, wait 0,
// 60m, PR Required). Keep in sync with docs/runbooks/release-process-evolution.md.
function policyBranchRules() {
  return [
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: [{ context: "PR Required", integration_id: 15368 }],
      },
      ruleset_id: 17097957,
    },
    {
      type: "merge_queue",
      parameters: {
        merge_method: "SQUASH",
        max_entries_to_build: 2,
        min_entries_to_merge: 1,
        max_entries_to_merge: 2,
        min_entries_to_merge_wait_minutes: 0,
        grouping_strategy: "ALLGREEN",
        check_response_timeout_minutes: 60,
      },
      ruleset_id: 17097957,
    },
  ];
}

// The July 11 drift: speculative build/merge widths pushed to 4/4.
function driftedBranchRules() {
  const rules = policyBranchRules();
  const mergeQueue = rules.find((rule) => rule.type === "merge_queue");
  mergeQueue.parameters.max_entries_to_build = 4;
  mergeQueue.parameters.max_entries_to_merge = 4;
  return rules;
}

describe("release health queue posture", () => {
  it("exposes the documented policy as the single source of truth", () => {
    expect(MERGE_QUEUE_POLICY.mergeQueue).toMatchObject({
      max_entries_to_build: 2,
      max_entries_to_merge: 2,
      merge_method: "SQUASH",
      grouping_strategy: "ALLGREEN",
      min_entries_to_merge: 1,
      min_entries_to_merge_wait_minutes: 0,
      check_response_timeout_minutes: 60,
    });
    expect(MERGE_QUEUE_POLICY.requiredCheck).toBe("PR Required");
  });

  it("passes when the live ruleset matches the documented policy", () => {
    const report = evaluateMergeQueuePosture(policyBranchRules());

    expect(report.schemaVersion).toBe(RELEASE_HEALTH_QUEUE_POSTURE_VERSION);
    expect(report.drifted).toBe(false);
    expect(report.driftedParameters).toEqual([]);
    expect(report.mergeQueueRulePresent).toBe(true);
    expect(report.requiredChecksRulePresent).toBe(true);
    // Covers all eight required parameters.
    expect(report.checks.map((check) => check.parameter)).toEqual([
      "max_entries_to_build",
      "max_entries_to_merge",
      "merge_method",
      "grouping_strategy",
      "min_entries_to_merge",
      "min_entries_to_merge_wait_minutes",
      "check_response_timeout_minutes",
      "required_status_check",
    ]);
    expect(report.checks.every((check) => check.drifted === false)).toBe(true);
  });

  it("flags a 4/4 drift and names the drifted parameters", () => {
    const report = evaluateMergeQueuePosture(driftedBranchRules());

    expect(report.drifted).toBe(true);
    expect(report.driftedParameters).toEqual(["max_entries_to_build", "max_entries_to_merge"]);
    const build = report.checks.find((check) => check.parameter === "max_entries_to_build");
    expect(build).toMatchObject({ expected: 2, actual: 4, drifted: true });
    expect(report.summary).toContain("max_entries_to_build=4 (expected 2)");
    expect(report.summary).toContain("max_entries_to_merge=4 (expected 2)");
    // Untouched parameters must not be reported as drift.
    expect(report.checks.find((check) => check.parameter === "merge_method").drifted).toBe(false);
    expect(report.checks.find((check) => check.parameter === "required_status_check").drifted).toBe(false);
  });

  it("flags each remaining parameter individually", () => {
    const cases = [
      { key: "merge_method", value: "MERGE" },
      { key: "grouping_strategy", value: "HEADGREEN" },
      { key: "min_entries_to_merge", value: 2 },
      { key: "min_entries_to_merge_wait_minutes", value: 5 },
      { key: "check_response_timeout_minutes", value: 30 },
    ];
    for (const { key, value } of cases) {
      const rules = policyBranchRules();
      rules.find((rule) => rule.type === "merge_queue").parameters[key] = value;
      const report = evaluateMergeQueuePosture(rules);
      expect(report.drifted, `${key} should drift`).toBe(true);
      expect(report.driftedParameters).toEqual([key]);
    }
  });

  it("flags a missing PR Required status check", () => {
    const rules = policyBranchRules();
    rules.find((rule) => rule.type === "required_status_checks").parameters.required_status_checks = [
      { context: "Some Other Check" },
    ];
    const report = evaluateMergeQueuePosture(rules);

    expect(report.drifted).toBe(true);
    expect(report.driftedParameters).toEqual(["required_status_check"]);
    const check = report.checks.find((entry) => entry.parameter === "required_status_check");
    expect(check).toMatchObject({ expected: "PR Required", actual: ["Some Other Check"], drifted: true });
  });

  it("flags a missing merge queue rule entirely", () => {
    const report = evaluateMergeQueuePosture([]);

    expect(report.drifted).toBe(true);
    expect(report.mergeQueueRulePresent).toBe(false);
    expect(report.requiredChecksRulePresent).toBe(false);
    // Every merge queue parameter plus the required check is reported missing.
    expect(report.driftedParameters).toContain("max_entries_to_build");
    expect(report.driftedParameters).toContain("required_status_check");
    expect(report.checks.every((check) => check.drifted)).toBe(true);
  });

  it("renders drift as legible operator text without leaking secrets", () => {
    const report = {
      ...evaluateMergeQueuePosture(driftedBranchRules()),
      repository: "chase-sets/chase-sets",
      branch: "main",
    };
    const text = formatQueuePostureText(report);

    expect(text).toContain("Merge queue ruleset DRIFT detected on chase-sets/chase-sets#main.");
    expect(text).toContain("[DRIFT] maximum pull requests to build (max_entries_to_build): expected 2, live 4");
    expect(text).toContain("[ok] merge method (merge_method): expected SQUASH, live SQUASH");
  });

  it("fetches live rules read-only via the shared token mechanism", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => policyBranchRules() }));
    const report = await collectMergeQueuePosture(
      {
        repository: "chase-sets/chase-sets",
        branch: "main",
        token: "secret-token",
        checkedAt: "2026-07-13T00:00:00.000Z",
      },
      { fetchImpl },
    );

    expect(report.drifted).toBe(false);
    expect(report.repository).toBe("chase-sets/chase-sets");
    expect(report.checkedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    // Read-only: a GET (no method/body) against the branch rules endpoint.
    expect(url).toBe("https://api.github.com/repos/chase-sets/chase-sets/rules/branches/main?per_page=100");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers.Authorization).toBe("Bearer secret-token");
  });

  it("reads the token from GH_TOKEN or GITHUB_TOKEN like sibling release-health tooling", () => {
    expect(parseQueuePostureArgs([], { GH_TOKEN: "gh" }).token).toBe("gh");
    expect(parseQueuePostureArgs([], { GITHUB_TOKEN: "gt" }).token).toBe("gt");
    expect(parseQueuePostureArgs(["--repository", "acme/repo", "--branch", "release"], {})).toMatchObject({
      repository: "acme/repo",
      branch: "release",
    });
  });
});
