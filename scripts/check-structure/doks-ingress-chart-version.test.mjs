import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  discoverDoksIngressChangedFiles,
  scannedDoksIngressChartSurface,
  validateDoksIngressChartVersion,
} from "./doks-ingress-chart-version.mjs";

const chartRoot = path.join("infrastructure", "helm", "doks-ingress");
const createdRepos = [];

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

async function writeChart(
  repoRoot,
  { version = "0.1.0", template = "kind: ConfigMap\n", values = "enabled: true\n" } = {},
) {
  const root = path.join(repoRoot, chartRoot);
  await mkdir(path.join(root, "templates", "deep", "nested"), { recursive: true });
  await writeFile(
    path.join(root, "Chart.yaml"),
    `apiVersion: v2\nname: chase-sets-doks-ingress\nversion: ${version}\n`,
    "utf8",
  );
  await writeFile(path.join(root, "values.yaml"), values, "utf8");
  await writeFile(path.join(root, "templates", "deep", "nested", "issuer.yaml"), template, "utf8");
  await writeFile(path.join(root, "README.md"), "operator notes\n", "utf8");
  await writeFile(path.join(root, "ingress-nginx-values.yaml"), "controller: {}\n", "utf8");
  await writeFile(path.join(root, "cert-manager-values.yaml"), "installCRDs: true\n", "utf8");
  await writeFile(path.join(root, "argo-rollouts-values.yaml"), "controller: {}\n", "utf8");
}

async function createGitRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "chase-sets-doks-chart-version-"));
  createdRepos.push(repoRoot);
  await writeChart(repoRoot);
  git(repoRoot, ["init", "--initial-branch=main"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "base"]);
  git(repoRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(repoRoot, ["checkout", "-b", "guard-test"]);
  return repoRoot;
}

function commitChange(repoRoot) {
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "changed chart content"]);
}

afterAll(async () => {
  await Promise.all(createdRepos.splice(0).map((repoRoot) => rm(repoRoot, { recursive: true, force: true })));
});

describe("doks ingress chart version guard", () => {
  it("flags a deep real-path template change with an unchanged version", async () => {
    const repoRoot = await createGitRepo();
    await writeFile(
      path.join(repoRoot, chartRoot, "templates", "deep", "nested", "issuer.yaml"),
      "kind: Certificate\n",
      "utf8",
    );
    commitChange(repoRoot);

    await expect(validateDoksIngressChartVersion({ repoRoot, environment: {} })).resolves.toMatchObject({
      violations: [expect.stringContaining("DOKS_INGRESS_VERSION_UNCHANGED")],
      changedPackagedFiles: ["infrastructure/helm/doks-ingress/templates/deep/nested/issuer.yaml"],
    });
  });

  it("flags deletion of a deep real-path template with an unchanged version", async () => {
    const repoRoot = await createGitRepo();
    const deletedPath = "infrastructure/helm/doks-ingress/templates/deep/nested/issuer.yaml";
    await rm(path.join(repoRoot, deletedPath));
    commitChange(repoRoot);

    await expect(validateDoksIngressChartVersion({ repoRoot, environment: {} })).resolves.toMatchObject({
      violations: [expect.stringContaining("DOKS_INGRESS_VERSION_UNCHANGED")],
      changedPackagedFiles: [deletedPath],
    });
  });

  it("flags deletion of values.yaml with an unchanged version", async () => {
    const repoRoot = await createGitRepo();
    const deletedPath = "infrastructure/helm/doks-ingress/values.yaml";
    await rm(path.join(repoRoot, deletedPath));
    commitChange(repoRoot);

    await expect(validateDoksIngressChartVersion({ repoRoot, environment: {} })).resolves.toMatchObject({
      violations: [expect.stringContaining("DOKS_INGRESS_VERSION_UNCHANGED")],
      changedPackagedFiles: [deletedPath],
    });
  });

  it("passes a deep template change with a strictly increasing version", async () => {
    const repoRoot = await createGitRepo();
    await writeChart(repoRoot, { version: "0.1.1", template: "kind: Certificate\n" });
    commitChange(repoRoot);

    await expect(validateDoksIngressChartVersion({ repoRoot, environment: {} })).resolves.toMatchObject({
      violations: [],
    });
  });

  it.each([
    ["0.0.9", "DOKS_INGRESS_VERSION_NOT_INCREASING"],
    ["dev", "DOKS_INGRESS_VERSION_NON_SEMVER"],
  ])("rejects version %s with its named diagnostic", async (version, diagnostic) => {
    const repoRoot = await createGitRepo();
    await writeChart(repoRoot, { version, template: "kind: Certificate\n" });
    commitChange(repoRoot);

    await expect(validateDoksIngressChartVersion({ repoRoot, environment: {} })).resolves.toMatchObject({
      violations: [expect.stringContaining(diagnostic)],
    });
  });

  it.each(["README.md", "ingress-nginx-values.yaml", "cert-manager-values.yaml", "argo-rollouts-values.yaml"])(
    "does not trigger for excluded %s",
    async (fileName) => {
      const repoRoot = await createGitRepo();
      await writeFile(path.join(repoRoot, chartRoot, fileName), "changed only here\n", "utf8");
      commitChange(repoRoot);

      await expect(validateDoksIngressChartVersion({ repoRoot, environment: {} })).resolves.toMatchObject({
        violations: [],
        changedPackagedFiles: [],
      });
    },
  );

  it("reports its scanned and excluded packaged-content surface", async () => {
    const repoRoot = await createGitRepo();
    expect(scannedDoksIngressChartSurface({ repoRoot })).toEqual({
      scanned: expect.arrayContaining([
        "infrastructure/helm/doks-ingress/Chart.yaml",
        "infrastructure/helm/doks-ingress/values.yaml",
        "infrastructure/helm/doks-ingress/templates/deep/nested/issuer.yaml",
      ]),
      excluded: expect.arrayContaining([
        expect.objectContaining({ file: "infrastructure/helm/doks-ingress/README.md", reason: expect.any(String) }),
        expect.objectContaining({
          file: "infrastructure/helm/doks-ingress/ingress-nginx-values.yaml",
          reason: expect.any(String),
        }),
      ]),
    });
  });

  it.each([
    ["malformed explicit input", { CHANGED_FILES_JSON: "{" }, "DOKS_INGRESS_CHANGED_FILES_JSON_INVALID"],
    ["missing merge base", { CHANGED_FILES_JSON: "[]" }, "DOKS_INGRESS_MERGE_BASE_UNAVAILABLE"],
  ])("fails closed for %s even with a populated ambient input", async (_name, environment, diagnostic) => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "chase-sets-doks-chart-version-negative-"));
    createdRepos.push(repoRoot);
    await writeChart(repoRoot);
    if (diagnostic === "DOKS_INGRESS_MERGE_BASE_UNAVAILABLE") {
      git(repoRoot, ["init", "--initial-branch=main"]);
      git(repoRoot, ["config", "user.email", "test@example.com"]);
      git(repoRoot, ["config", "user.name", "Test"]);
      git(repoRoot, ["add", "."]);
      git(repoRoot, ["commit", "-m", "base"]);
    }

    for (const ambient of [undefined, '["ambient/path"]']) {
      const overriddenEnvironment = { CHANGED_FILES_JSON: environment.CHANGED_FILES_JSON ?? ambient };
      expect(() => discoverDoksIngressChangedFiles({ repoRoot, environment: overriddenEnvironment })).toThrow(
        diagnostic,
      );
    }
  });

  it("fails closed when git diff fails, even with a populated ambient input", async () => {
    const repoRoot = await createGitRepo();
    const execFileSyncImpl = (_command, args) => {
      if (args[0] === "merge-base") return "abc123";
      throw new Error("diff unavailable");
    };
    for (const environment of [{}, { CHANGED_FILES_JSON: undefined }]) {
      expect(() => discoverDoksIngressChangedFiles({ repoRoot, environment, execFileSyncImpl })).toThrow(
        "DOKS_INGRESS_DIFF_UNAVAILABLE",
      );
    }
  });

  it("fails closed outside Git, even with a populated ambient input", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "chase-sets-doks-chart-version-non-git-"));
    createdRepos.push(repoRoot);
    await writeChart(repoRoot);
    for (const environment of [{}, { CHANGED_FILES_JSON: '["ambient/path"]' }]) {
      expect(() => discoverDoksIngressChangedFiles({ repoRoot, environment })).toThrow(
        "DOKS_INGRESS_MERGE_BASE_UNAVAILABLE",
      );
    }
  });

  it("uses the explicit changed-file path only after parsing it", async () => {
    const repoRoot = await createGitRepo();
    expect(
      discoverDoksIngressChangedFiles({
        repoRoot,
        environment: { CHANGED_FILES_JSON: '["infrastructure\\\\helm\\\\doks-ingress\\\\values.yaml"]' },
      }).changedFiles,
    ).toEqual(["infrastructure/helm/doks-ingress/values.yaml"]);
  });
});
