import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildMergeQueuePosture, fetchRuleset, readMergeQueueReleasePolicy } from "./release-health-queue-posture.mjs";

const FIXTURE_ROOT = new URL("./fixtures/release-health-merge-queue/", import.meta.url);
const CHECKED_AT = "2026-07-12T12:00:00.000Z";

async function readFixture(name) {
  return JSON.parse(await readFile(new URL(name, FIXTURE_ROOT), "utf8"));
}

describe("merge queue posture", () => {
  it("reports no drift for a ruleset matching the checked-in release policy", async () => {
    const [policy, ruleset] = await Promise.all([readMergeQueueReleasePolicy(), readFixture("matching-ruleset.json")]);

    const result = buildMergeQueuePosture({ checkedAt: CHECKED_AT, policy, ruleset });

    expect(result.passesPostureCheck).toBe(true);
    expect(result.record).toMatchObject({
      schemaVersion: "merge-queue-posture/v1",
      mode: "advisory-read-only",
      repository: "chase-sets/chase-sets",
      ruleset: { id: 17097957 },
      drift: [],
      result: "success",
    });
    expect(result.markdown).toContain("live merge-queue settings match");
  });

  it("reports each drifted merge-queue setting with live and policy values", async () => {
    const [policy, ruleset] = await Promise.all([readMergeQueueReleasePolicy(), readFixture("drifted-ruleset.json")]);

    const result = buildMergeQueuePosture({ checkedAt: CHECKED_AT, policy, ruleset });

    expect(result.passesPostureCheck).toBe(false);
    expect(result.record.result).toBe("warning");
    expect(result.record.drift).toEqual([
      {
        parameter: "max_entries_to_build",
        label: "maximum pull requests to build",
        liveValue: 4,
        policyValue: 2,
      },
      {
        parameter: "max_entries_to_merge",
        label: "maximum pull requests to merge",
        liveValue: 4,
        policyValue: 2,
      },
    ]);
    expect(result.markdown).toContain("| maximum pull requests to build | `4` | `2` |");
    expect(result.markdown).toContain("| maximum pull requests to merge | `4` | `2` |");
  });

  it.each([
    ["merge_method", "MERGE"],
    ["min_entries_to_merge", 2],
    ["min_entries_to_merge_wait_minutes", 5],
    ["grouping_strategy", "HEADGREEN"],
    ["check_response_timeout_minutes", 30],
  ])("reports %s drift independently", async (parameter, liveValue) => {
    const [policy, ruleset] = await Promise.all([readMergeQueueReleasePolicy(), readFixture("matching-ruleset.json")]);
    const mergeQueueRule = ruleset.rules.find((rule) => rule.type === "merge_queue");
    mergeQueueRule.parameters[parameter] = liveValue;

    const result = buildMergeQueuePosture({ checkedAt: CHECKED_AT, policy, ruleset });

    expect(result.passesPostureCheck).toBe(false);
    expect(result.record.drift).toEqual([
      expect.objectContaining({
        parameter,
        liveValue,
        policyValue: policy.mergeQueue[parameter],
      }),
    ]);
  });

  it("reports missing merge-queue and required-check rules", async () => {
    const [policy, ruleset] = await Promise.all([readMergeQueueReleasePolicy(), readFixture("matching-ruleset.json")]);
    ruleset.rules = [];

    const result = buildMergeQueuePosture({ checkedAt: CHECKED_AT, policy, ruleset });

    expect(result.passesPostureCheck).toBe(false);
    expect(result.record.drift.map((finding) => finding.parameter)).toEqual([
      ...Object.keys(policy.mergeQueue),
      "required_status_checks",
    ]);
  });

  it("fetches the canonical ruleset with GET only", async () => {
    const fixture = await readFixture("matching-ruleset.json");
    const calls = [];

    const ruleset = await fetchRuleset({
      repository: "chase-sets/chase-sets",
      rulesetId: 17097957,
      token: "token",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => fixture };
      },
    });

    expect(ruleset).toEqual(fixture);
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/chase-sets/chase-sets/rulesets/17097957",
        options: expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ Authorization: "Bearer token" }),
        }),
      },
    ]);
  });

  it("keeps the scheduled posture surface read-only against GitHub", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/platform-merge-queue-posture.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("release-health:queue-posture");
    expect(workflow).not.toContain("issues: write");
    expect(workflow).not.toContain("report-scheduled-workflow-alert");
  });

  it("documents the scheduled guard and its checked-in policy as the canonical posture path", async () => {
    const runbook = await readFile(new URL("../docs/runbooks/release-process-evolution.md", import.meta.url), "utf8");

    expect(runbook).toContain("scripts/release-health-merge-queue-policy.json");
    expect(runbook).toContain("pnpm run ops -- release-health:queue-posture");
    expect(runbook).toContain(".github/workflows/platform-merge-queue-posture.yml");
    expect(runbook).toContain("| Minimum merge wait | `0 minutes` |");
  });
});
