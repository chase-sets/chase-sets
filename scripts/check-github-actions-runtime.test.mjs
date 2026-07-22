import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkGithubActionsRuntime } from "./check-github-actions-runtime.mjs";

const tempDirs = [];
const checkoutSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const cacheSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const doctlSha = "cccccccccccccccccccccccccccccccccccccccc";
const githubScriptSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const unknownSha = "dddddddddddddddddddddddddddddddddddddddd";

function workflowRootWith(content, fileName = "test.yml") {
  const rootDir = mkdtempSync(path.join(tmpdir(), "github-actions-runtime-"));
  tempDirs.push(rootDir);
  const workflowDir = path.join(rootDir, "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(path.join(workflowDir, fileName), content, "utf8");
  return rootDir;
}

function previewCleanupWorkflow({
  timeoutLine = "    timeout-minutes: 45",
  checkoutComment = `        # pull_request_target has repo secrets. Closed PR cleanup never checks
        # out PR head code: merged PRs use the trusted merge commit, unmerged
        # PRs fall back to the base branch, and manual runs use the selected ref.`,
  checkoutRef = "${{ github.event_name == 'workflow_dispatch' && github.ref || github.event.pull_request.merged && github.event.pull_request.merge_commit_sha || github.event.pull_request.base.ref }}",
} = {}) {
  return `
name: Platform Preview Cleanup

on:
  pull_request_target:
    types:
      - closed
  workflow_dispatch:

permissions:
  contents: read

jobs:
  destroy-preview:
    name: Destroy Preview
    runs-on: ubuntu-latest
${timeoutLine}
    steps:
      - uses: actions/checkout@${checkoutSha} # v6.0.0
${checkoutComment}
        with:
          ref: ${checkoutRef}
`;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("check-github-actions-runtime", () => {
  it("accepts local, Docker, and SHA-pinned allowlisted Node 24 actions", () => {
    const rootDir = workflowRootWith(`
name: Test
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/setup-pnpm-workspace
      - uses: docker://rhysd/actionlint:1.7.12
      - uses: actions/checkout@${checkoutSha} # v6.0.0
      - uses: actions/github-script@${githubScriptSha} # v8.0.0
      - uses: digitalocean/action-doctl@${doctlSha} # v2.5.2
`);

    expect(checkGithubActionsRuntime({ rootDir })).toEqual({ passed: true, violations: [] });
  });

  it("rejects known actions documented below the Node 24-compatible version", () => {
    const rootDir = workflowRootWith(`
name: Test
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@${cacheSha} # v4.2.4
`);

    const result = checkGithubActionsRuntime({ rootDir });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining("is documented as v4.2.4; keep the release comment on v5.0.0 or newer"),
    ]);
  });

  it("rejects unknown external actions until their Node 24 metadata is verified", () => {
    const rootDir = workflowRootWith(`
name: Test
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: third-party/example-action@${unknownSha} # v1.0.0
`);

    const result = checkGithubActionsRuntime({ rootDir });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining(
        "external action 'third-party/example-action' is not in the Node 24 compatibility allowlist",
      ),
    ]);
  });

  it("rejects mutable action tags even when they include a version comment", () => {
    const rootDir = workflowRootWith(`
name: Test
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6 # v6.0.0
`);

    const result = checkGithubActionsRuntime({ rootDir });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([expect.stringContaining("must be pinned to a full 40-character commit SHA")]);
  });

  it("rejects SHA-pinned actions without an inline version comment", () => {
    const rootDir = workflowRootWith(`
name: Test
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${checkoutSha}
`);

    const result = checkGithubActionsRuntime({ rootDir });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([expect.stringContaining("must include an inline '# vX.Y.Z' release comment")]);
  });

  it("rejects actions without an explicit ref", () => {
    const rootDir = workflowRootWith(`
name: Test
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout
`);

    const result = checkGithubActionsRuntime({ rootDir });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([expect.stringContaining("must be pinned with an explicit @ref")]);
  });

  it("accepts preview cleanup when pull_request_target is closed-only, timed out, and checks out trusted refs", () => {
    const rootDir = workflowRootWith(previewCleanupWorkflow(), "platform-preview-cleanup.yml");

    expect(checkGithubActionsRuntime({ rootDir })).toEqual({ passed: true, violations: [] });
  });

  it("rejects preview cleanup without an explicit bounded job timeout", () => {
    const rootDir = workflowRootWith(previewCleanupWorkflow({ timeoutLine: "" }), "platform-preview-cleanup.yml");

    const result = checkGithubActionsRuntime({ rootDir });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining("destroy-preview must have an explicit job timeout of 60 minutes or less"),
    ]);
  });

  it("rejects preview cleanup checkout of untrusted PR head refs", () => {
    const rootDir = workflowRootWith(
      previewCleanupWorkflow({ checkoutRef: "${{ github.event.pull_request.head.sha }}" }),
      "platform-preview-cleanup.yml",
    );

    const result = checkGithubActionsRuntime({ rootDir });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining("checkout ref must not use untrusted pull_request.head code"),
    ]);
  });

  it("rejects preview cleanup without the pull_request_target safety rationale", () => {
    const rootDir = workflowRootWith(previewCleanupWorkflow({ checkoutComment: "" }), "platform-preview-cleanup.yml");

    const result = checkGithubActionsRuntime({ rootDir });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining("checkout step must document why pull_request_target is safe"),
    ]);
  });

  it("discovers risk-review semantics under an arbitrary workflow filename and accepts the trusted advisory shape", () => {
    const rootDir = workflowRootWith(
      `
name: Risk Review Advisory
on:
  pull_request_target: {}
  pull_request_review: {}
  merge_group: {}
permissions: {}
jobs:
  advisory:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - continue-on-error: true
        uses: actions/github-script@${githubScriptSha} # v8.0.0
        with:
          script: |
            const sourcePaths = ["scripts/platform-risk-review.mjs"];
            const options = { ref: context.payload.repository.default_branch };
      - run: exit 0
`,
      "arbitrary-safety-surface.yml",
    );

    expect(checkGithubActionsRuntime({ rootDir })).toEqual({ passed: true, violations: [] });
  });

  it("rejects semantically discovered risk review that executes head code or propagates advisory failure", () => {
    const rootDir = workflowRootWith(
      `
name: Renamed Workflow
on:
  pull_request_target: {}
  pull_request_review: {}
  merge_group: {}
jobs:
  advisory:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@${checkoutSha} # v6.0.0
        with:
          ref: context.payload.pull_request.head.sha
      - uses: actions/github-script@${githubScriptSha} # v8.0.0
        with:
          script: const source = "scripts/platform-risk-review.mjs";
`,
      "another-name.yml",
    );

    const result = checkGithubActionsRuntime({ rootDir });
    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("must not checkout code"),
        expect.stringContaining("trusted base"),
        expect.stringContaining("must not make its workflow red"),
      ]),
    );
  });
});
