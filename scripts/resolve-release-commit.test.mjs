import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseResolveReleaseCommitArgs, resolveReleaseCommit } from "./resolve-release-commit.mjs";

const commit = "a".repeat(40);

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
    expect(resolveSteps[4]).toContain('--github-env "$GITHUB_ENV"');
    for (const step of resolveSteps.slice(2)) {
      expect(step).toContain("--checkout true");
    }
  });
});

function workflowStep(source, stepName) {
  const start = source.indexOf(`- name: ${stepName}`);
  expect(start).not.toBe(-1);
  const next = source.indexOf("\n      - name:", start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}
