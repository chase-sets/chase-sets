import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  auditManagedRegistryAuthority,
  discoverTrackedExecutableWorkflows,
} from "./managed-registry-authority-guard.mjs";

const fixtureRoots = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed registry authority workflow guard", () => {
  it("discovers and clears every tracked executable workflow in the repository", () => {
    const root = path.resolve(".");
    const files = discoverTrackedExecutableWorkflows(root);
    const report = auditManagedRegistryAuthority(root);

    expect(files.length).toBeGreaterThan(40);
    expect(report.scanned).toBe(report.total);
    expect(report.total).toBe(files.length);
    expect(report.violations).toEqual([]);
    expect(report.platformPullCommands).toBe(6);
    expect(report.managedSelectors).toBe(6);
    expect(report.temporaryNamespaceReadinessPaths).toBe(3);
    console.log(
      `managed registry authority test: scanned ${report.scanned}/${report.total} tracked executable workflows`,
    );
  });

  it("rejects the current-main expiring producer and dynamic selector shape at an arbitrary tracked workflow path", async () => {
    const root = await trackedFixture({
      ".github/workflows/unrelated-vocabulary.yml": `name: synthetic historical negative
on: workflow_dispatch
jobs:
  arbitrary:
    runs-on: ubuntu-latest
    steps:
      - run: |
          generated_name="registry-\${REGISTRY_NAME}"
          doctl registry docker-config --expiry-seconds 3600 > generated.json
          kubectl create secret generic "$generated_name" --from-file=.dockerconfigjson=generated.json --type=kubernetes.io/dockerconfigjson
          echo "PULL_NAME=$generated_name" >> "$GITHUB_ENV"
      - run: |
          pnpm run platform:kubernetes-deployment -- deploy \\
            --image registry.digitalocean.com/example/private@sha256:${"a".repeat(64)} \\
            --image-pull-secret "$PULL_NAME"
`,
    });

    const report = auditManagedRegistryAuthority(root);

    expect(report.scanned).toBe(1);
    expect(report.total).toBe(1);
    expect(report.violations.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["generated-platform-pull-credential", "non-managed-pull-selector"]),
    );
  });

  it("requires bounded managed readiness between arbitrary temporary namespace creation and deployment", async () => {
    const root = await trackedFixture({
      ".github/workflows/nonsemantic.yml": managedDeploymentWorkflow({
        readiness:
          'node ./scripts/managed-registry-readiness.mjs --namespace "$TARGET_NAMESPACE" --timeout-seconds 120',
      }),
    });

    expect(auditManagedRegistryAuthority(root)).toMatchObject({
      scanned: 1,
      total: 1,
      temporaryNamespaceReadinessPaths: 1,
      violations: [],
    });
  });

  it("fails closed when temporary-namespace readiness is absent or unbounded", async () => {
    const missingRoot = await trackedFixture({
      ".github/workflows/missing.yml": managedDeploymentWorkflow({ readiness: "" }),
    });
    const unboundedRoot = await trackedFixture({
      ".github/workflows/unbounded.yml": managedDeploymentWorkflow({
        readiness:
          'node ./scripts/managed-registry-readiness.mjs --namespace "$TARGET_NAMESPACE" --timeout-seconds 999',
      }),
    });

    expect(auditManagedRegistryAuthority(missingRoot).violations.map(({ code }) => code)).toContain(
      "temporary-namespace-readiness-missing",
    );
    expect(auditManagedRegistryAuthority(unboundedRoot).violations.map(({ code }) => code)).toContain(
      "temporary-namespace-readiness-unbounded",
    );
  });

  it("excludes untracked files from the executable workflow corpus", async () => {
    const root = await trackedFixture({
      ".github/workflows/tracked.yml": managedDeploymentWorkflow(),
    });
    await writeFixture(root, ".github/workflows/untracked.yml", "name: untracked\non: workflow_dispatch\njobs: {}\n");

    expect(discoverTrackedExecutableWorkflows(root)).toEqual([".github/workflows/tracked.yml"]);
  });
});

function managedDeploymentWorkflow({ readiness = null } = {}) {
  const readinessStep =
    readiness == null ? "" : `      - run: ${JSON.stringify(readiness || "echo readiness intentionally absent")}\n`;
  return `name: managed
on: workflow_dispatch
jobs:
  arbitrary:
    runs-on: ubuntu-latest
    steps:
      - run: kubectl create namespace "$TARGET_NAMESPACE"
${readinessStep}      - run: |
          pnpm run platform:kubernetes-deployment -- deploy \\
            --image registry.digitalocean.com/example/private@sha256:${"b".repeat(64)} \\
            --image-pull-secret chase-sets \\
            --namespace "$TARGET_NAMESPACE"
`;
}

async function trackedFixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), "managed-registry-authority-"));
  fixtureRoots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    await writeFixture(root, relativePath, contents);
  }
  execFileSync("git", ["-c", "core.autocrlf=false", "add", "--all"], { cwd: root, windowsHide: true });
  return root;
}

async function writeFixture(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}
