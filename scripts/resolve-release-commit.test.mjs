import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLatestOnlyReleaseState,
  parseResolveReleaseCommitArgs,
  reduceLatestOnlyReleaseState,
  resolveReleaseCommit,
} from "./resolve-release-commit.mjs";

const commit = "a".repeat(40);
const digest = `sha256:${"d".repeat(64)}`;

function execRecorder(responses = {}) {
  const calls = [];
  return {
    calls,
    execFile: async (command, args) => {
      calls.push({ command, args });
      const key = args.join(" ");
      const response = responses[key];
      if (response instanceof Error) {
        response.code ??= 1;
        throw response;
      }
      return { stdout: response ?? "", stderr: "" };
    },
  };
}

describe("resolve release commit", () => {
  it("uses the push SHA for push-triggered releases and writes GitHub output", async () => {
    const appended = [];
    const exec = execRecorder();
    const result = await resolveReleaseCommit(
      {
        eventName: "push",
        pushCommit: commit,
        githubOutputPath: "github-output.txt",
        gitPath: "git",
      },
      {
        execFile: exec.execFile,
        appendFile: async (path, value) => appended.push({ path, value }),
        log: () => {},
      },
    );

    expect(result.releaseCommit).toBe(commit);
    expect(exec.calls.map((call) => call.args)).toEqual([
      ["fetch", "origin", "main"],
      ["merge-base", "--is-ancestor", commit, "origin/main"],
    ]);
    expect(appended).toEqual([{ path: "github-output.txt", value: `release_commit=${commit}\n` }]);
  });

  it("resolves an input ref, verifies ancestry, checks it out, and writes GitHub env", async () => {
    const appended = [];
    const exec = execRecorder({
      "rev-parse --verify --quiet release-1^{commit}": "",
      "rev-parse release-1^{commit}": `${commit}\n`,
    });

    await resolveReleaseCommit(
      {
        releaseRef: "release-1",
        checkout: true,
        githubEnvPath: "github.env",
        gitPath: "git",
      },
      {
        execFile: exec.execFile,
        appendFile: async (path, value) => appended.push({ path, value }),
        log: () => {},
      },
    );

    expect(exec.calls.map((call) => call.args)).toEqual([
      ["fetch", "origin", "main"],
      ["fetch", "origin", "release-1"],
      ["rev-parse", "--verify", "--quiet", "release-1^{commit}"],
      ["rev-parse", "release-1^{commit}"],
      ["merge-base", "--is-ancestor", commit, "origin/main"],
      ["checkout", "--detach", commit],
    ]);
    expect(appended).toEqual([{ path: "github.env", value: `release_commit=${commit}\n` }]);
  });

  it("falls back to the origin ref when the local ref does not exist", async () => {
    const missingLocalRef = new Error("missing local ref");
    missingLocalRef.code = 1;
    const exec = execRecorder({
      "rev-parse --verify --quiet feature^{commit}": missingLocalRef,
      "rev-parse --verify --quiet origin/feature^{commit}": "",
      "rev-parse origin/feature^{commit}": `${commit}\n`,
    });

    const result = await resolveReleaseCommit(
      {
        releaseRef: "feature",
        gitPath: "git",
      },
      {
        execFile: exec.execFile,
        appendFile: async () => {},
        log: () => {},
      },
    );

    expect(result.releaseCommit).toBe(commit);
  });

  it("fails when the release ref cannot be resolved", async () => {
    const missingRef = new Error("missing ref");
    missingRef.code = 1;
    const exec = execRecorder({
      "rev-parse --verify --quiet nope^{commit}": missingRef,
      "rev-parse --verify --quiet origin/nope^{commit}": missingRef,
    });

    await expect(
      resolveReleaseCommit(
        { releaseRef: "nope", gitPath: "git" },
        {
          execFile: exec.execFile,
          appendFile: async () => {},
          log: () => {},
        },
      ),
    ).rejects.toThrow("Release ref 'nope' does not resolve to a commit.");
  });

  it("parses options from CLI flags and environment", () => {
    expect(
      parseResolveReleaseCommitArgs(["--release-ref", "main", "--checkout", "true", "--github-output", "out"], {
        GITHUB_SHA: commit,
        GITHUB_ENV: "env",
      }),
    ).toMatchObject({
      releaseRef: "main",
      checkout: true,
      githubOutputPath: "out",
      githubEnvPath: "env",
      pushCommit: commit,
    });
  });

  it("wires operational workflows through the shared resolver script", () => {
    const resolveSteps = [
      ".github/workflows/platform-production.yml",
      ".github/workflows/platform-staging-reset.yml",
      ".github/workflows/platform-staging-wake-drills.yml",
      ".github/workflows/platform-staging-route-matrix-evidence.yml",
      ".github/workflows/platform-staging-representative-commerce-state.yml",
      ".github/workflows/marketplace-provider-proof-status.yml",
      ".github/workflows/checkout-order-readiness-trace.yml",
    ].map((file) => workflowStep(readFileSync(resolve(file), "utf8"), "Resolve release commit"));

    for (const step of resolveSteps) {
      expect(step).toContain("node ./scripts/resolve-release-commit.mjs");
      expect(step).not.toContain('git fetch origin "${release_ref}" || true');
      expect(step).not.toContain('git merge-base --is-ancestor "$release_commit" origin/main');
      expect(step).not.toContain('git checkout --detach "$release_commit"');
    }

    expect(resolveSteps[0]).toContain('--event-name "${{ github.event_name }}"');
    expect(resolveSteps[0]).toContain('--github-output "$GITHUB_OUTPUT"');
    expect(resolveSteps[1]).toContain('--github-output "$GITHUB_OUTPUT"');
    expect(resolveSteps[5]).toContain('--github-env "$GITHUB_ENV"');
    for (const step of resolveSteps.slice(2)) {
      expect(step).toContain("--checkout true");
    }
  });

  it("separates cancellable candidate dispatch from non-cancellable immutable active execution", () => {
    const workflow = readFileSync(resolve(".github/workflows/platform-production.yml"), "utf8");
    const dispatcherWorkflow = readFileSync(resolve(".github/workflows/platform-release-candidate.yml"), "utf8");
    const dispatcher = workflowJob(dispatcherWorkflow, "dispatch-release-candidate");
    const staging = workflowJob(workflow, "deploy-staging");
    const production = workflowJob(workflow, "deploy-production");
    const stagingHealth = workflowJob(workflow, "record-staging-release-health");

    expect(workflow).toContain(
      "group: ${{ inputs.decommission_plan_only && format('platform-production-decommission-plan-{0}', github.ref) || 'platform-registry-mutation' }}",
    );
    expect(workflow).toContain("cancel-in-progress: false");
    expect(dispatcherWorkflow).toContain("name: Platform Release Candidate Dispatch");
    expect(dispatcherWorkflow).toContain("group: platform-release-candidate");
    expect(dispatcherWorkflow).toContain("cancel-in-progress: true");
    expect(dispatcher).toContain("actions: write");
    expect(dispatcher).toContain("gh workflow run platform-production.yml");
    expect(dispatcher).toContain("--field dispatch_source=automatic");
    expect(dispatcher).toContain('--field dispatch_run_id="${{ github.run_id }}"');
    expect(dispatcher).toContain('--field dispatch_attempt="${{ github.run_attempt }}"');
    expect(dispatcher.indexOf("Collect exact release candidate linkage")).toBeLessThan(
      dispatcher.indexOf("Dispatch automatic release"),
    );
    expect(dispatcher).toContain("release-health-github-metadata.mjs");
    expect(dispatcher).toContain("release-candidate-linkage-${{ github.run_id }}-${{ github.run_attempt }}");
    for (const healthJob of [stagingHealth, production]) {
      expect(healthJob).toContain(
        'gh run download "${{ inputs.dispatch_run_id }}" --name "$linkage_name" --dir artifacts/release-candidate-linkage',
      );
      expect(healthJob).toContain("--linkage-file artifacts/release-candidate-linkage/linkage.json");
    }
    expect(workflowJob(workflow, "resolve-release")).toContain("if: github.event_name == 'workflow_dispatch'");

    const activationIndex = staging.indexOf("- name: Activate immutable release before staging mutation");
    const firstMutationIndex = staging.indexOf("- name: Terraform apply staging environment DNS");
    expect(activationIndex).toBeGreaterThan(-1);
    expect(activationIndex).toBeLessThan(firstMutationIndex);
    expect(staging).toContain("RELEASE_IMAGE_DIGEST: ${{ needs.build-image.outputs.platform_image_digest }}");
    expect(staging).not.toContain("Re-check release freshness before staging verification");
    expect(production).not.toContain("Confirm automatic deploy is latest main");
    expect(production).toContain(
      "TF_VAR_platform_image_digest: ${{ needs.deploy-staging.outputs.platform_image_digest }}",
    );
    expect(production).toContain(
      'docker buildx imagetools create --tag "$release_image" "${promoted_image}@${promoted_digest}"',
    );
    expect(production).toContain("group: platform-deploy-production");
    expect(production).toContain("cancel-in-progress: false");
    expect(production).toContain("- name: Resolve terminal release state");
  });

  it("has exactly one main-push dispatcher and one workflow-dispatch release root", () => {
    const dispatcher = readFileSync(resolve(".github/workflows/platform-release-candidate.yml"), "utf8");
    const deploy = readFileSync(resolve(".github/workflows/platform-production.yml"), "utf8");

    expect(dispatcher.match(/^  push:$/gm)).toHaveLength(1);
    expect(dispatcher).not.toContain("workflow_dispatch:");
    expect(deploy).not.toMatch(/^  push:$/m);
    expect(deploy.match(/^  workflow_dispatch:$/gm)).toHaveLength(1);
    expect(deploy).not.toContain("dispatch-release-candidate:");
  });
});

describe("latest-only release state", () => {
  it("keeps one immutable active release and coalesces ten rapid merges to the latest pending commit", () => {
    const commits = Array.from({ length: 10 }, (_, index) => (index + 1).toString(16).repeat(40));
    const events = [
      { type: "candidate", commit: commits[0], mode: "automatic" },
      { type: "activate", commit: commits[0], imageDigest: digest },
      ...commits.slice(1).map((candidateCommit) => ({
        type: "candidate",
        commit: candidateCommit,
        mode: "automatic",
      })),
    ];

    const state = reduceLatestOnlyReleaseState(events);

    expect(state.active).toEqual({ commit: commits[0], imageDigest: digest, mode: "automatic" });
    expect(state.pending).toEqual({ commit: commits[9], mode: "automatic" });
    expect(state.coalescedCount).toBe(8);
    expect(state.transitions.filter(({ type }) => type === "pending")).toHaveLength(9);
  });

  it("requires production promotion to use the staging-activated commit and image digest", () => {
    const active = reduceLatestOnlyReleaseState([
      { type: "candidate", commit, mode: "automatic" },
      { type: "activate", commit, imageDigest: digest },
    ]);

    expect(() =>
      reduceLatestOnlyReleaseState(
        [{ type: "terminal", outcome: "promoted", commit: "b".repeat(40), imageDigest: digest }],
        active,
      ),
    ).toThrow("terminal release commit must match");
    expect(() =>
      reduceLatestOnlyReleaseState(
        [{ type: "terminal", outcome: "promoted", commit, imageDigest: `sha256:${"e".repeat(64)}` }],
        active,
      ),
    ).toThrow("terminal image digest must match");

    const promoted = reduceLatestOnlyReleaseState(
      [{ type: "terminal", outcome: "promoted", commit, imageDigest: digest }],
      active,
    );
    expect(promoted.active).toBeNull();
    expect(promoted.transitions.at(-1)).toEqual({ type: "promoted", commit, imageDigest: digest, mode: "automatic" });
  });

  it("does not start a pending release until failure or rollback handling reaches a terminal outcome", () => {
    const pendingCommit = "b".repeat(40);
    const active = reduceLatestOnlyReleaseState([
      { type: "candidate", commit, mode: "automatic" },
      { type: "activate", imageDigest: digest },
      { type: "candidate", commit: pendingCommit, mode: "automatic" },
    ]);

    expect(active.active?.commit).toBe(commit);
    expect(active.candidate).toBeNull();
    expect(active.pending?.commit).toBe(pendingCommit);

    const failed = reduceLatestOnlyReleaseState([{ type: "terminal", outcome: "failed" }], active);
    expect(failed.active).toBeNull();
    expect(failed.candidate?.commit).toBe(pendingCommit);
    expect(failed.pending).toBeNull();

    const retried = reduceLatestOnlyReleaseState(
      [{ type: "activate", imageDigest: `sha256:${"f".repeat(64)}` }],
      failed,
    );
    expect(retried.active?.commit).toBe(pendingCommit);
  });

  it("gives the immutable active release precedence over newer manual, recovery, and emergency requests", () => {
    const manualCommit = "b".repeat(40);
    const recoveryCommit = "c".repeat(40);
    const emergencyCommit = "d".repeat(40);
    const state = reduceLatestOnlyReleaseState([
      { type: "candidate", commit, mode: "automatic" },
      { type: "activate", imageDigest: digest },
      { type: "candidate", commit: manualCommit, mode: "manual" },
      { type: "candidate", commit: recoveryCommit, mode: "recovery" },
      { type: "candidate", commit: emergencyCommit, mode: "emergency" },
    ]);

    expect(state.active).toEqual({ commit, imageDigest: digest, mode: "automatic" });
    expect(state.pending).toEqual({ commit: emergencyCommit, mode: "emergency" });
    expect(state.coalescedCount).toBe(2);
  });

  it("uses latest-only pending precedence regardless of automatic, manual, recovery, or emergency trigger type", () => {
    const state = reduceLatestOnlyReleaseState([
      { type: "candidate", commit, mode: "automatic" },
      { type: "activate", imageDigest: digest },
      { type: "candidate", commit: "b".repeat(40), mode: "emergency" },
      { type: "candidate", commit: "c".repeat(40), mode: "manual" },
      { type: "candidate", commit: "d".repeat(40), mode: "recovery" },
      { type: "candidate", commit: "e".repeat(40), mode: "automatic" },
    ]);

    expect(state.active?.commit).toBe(commit);
    expect(state.pending).toEqual({ commit: "e".repeat(40), mode: "automatic" });
    expect(state.coalescedCount).toBe(3);
  });

  it("starts from an explicit empty state", () => {
    expect(createLatestOnlyReleaseState()).toEqual({
      candidate: null,
      active: null,
      pending: null,
      coalescedCount: 0,
      transitions: [],
    });
  });
});

function workflowStep(source, stepName) {
  const start = source.indexOf(`- name: ${stepName}`);
  expect(start).not.toBe(-1);
  const next = source.indexOf("\n      - name:", start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

function workflowJob(source, jobName) {
  const start = source.indexOf(`  ${jobName}:`);
  expect(start).not.toBe(-1);
  const remaining = source.slice(start + `  ${jobName}:`.length);
  const nextOffset = remaining.search(/\n  [a-zA-Z0-9_-]+:\r?\n/);
  return nextOffset === -1 ? source.slice(start) : source.slice(start, start + `  ${jobName}:`.length + nextOffset);
}
