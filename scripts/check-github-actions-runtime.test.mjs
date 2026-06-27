import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkGithubActionsRuntime } from "./check-github-actions-runtime.mjs";

const tempDirs = [];
const checkoutSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const cacheSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const doctlSha = "cccccccccccccccccccccccccccccccccccccccc";
const unknownSha = "dddddddddddddddddddddddddddddddddddddddd";

function workflowRootWith(content) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "github-actions-runtime-"));
  tempDirs.push(rootDir);
  const workflowDir = path.join(rootDir, "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(path.join(workflowDir, "test.yml"), content, "utf8");
  return rootDir;
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
});
