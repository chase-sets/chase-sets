import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkGithubActionsRuntime } from "./check-github-actions-runtime.mjs";

const tempDirs = [];

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
  it("accepts local, Docker, and allowlisted Node 24 actions", () => {
    const rootDir = workflowRootWith(`
name: Test
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/setup-pnpm-workspace
      - uses: docker://rhysd/actionlint:1.7.12
      - uses: actions/checkout@v6
      - uses: digitalocean/action-doctl@v2.5.2
`);

    expect(checkGithubActionsRuntime({ rootDir })).toEqual({ passed: true, violations: [] });
  });

  it("rejects known actions pinned below the Node 24-compatible major", () => {
    const rootDir = workflowRootWith(`
name: Test
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
`);

    const result = checkGithubActionsRuntime({ rootDir });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining("actions/cache@v4 targets an older JavaScript action runtime"),
    ]);
  });

  it("rejects unknown external actions until their Node 24 metadata is verified", () => {
    const rootDir = workflowRootWith(`
name: Test
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: third-party/example-action@v1
`);

    const result = checkGithubActionsRuntime({ rootDir });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining(
        "external action 'third-party/example-action' is not in the Node 24 compatibility allowlist",
      ),
    ]);
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
