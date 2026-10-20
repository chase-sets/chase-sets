import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  cleanupBatchesForTargets,
  cleanupMatrixForBatches,
  cleanupMatrixForTargets,
  previewDatabaseClusterNameForPrNumber,
} from "./digitalocean-preview-cleanup-sweep.mjs";
import { repoRoot } from "./lib/repo.mjs";

const workflowPath = path.join(repoRoot, ".github/workflows/platform-preview-cleanup.yml");
const authorityPath = path.join(repoRoot, ".github/authority/platform-preview-cleanup/destroy-preview.json");
// 62 s worst close-event target (run 39475717987) plus two terraform init -reconfigure steps.
const measuredWorstCloseEventSeconds = 66;

function workflow() {
  return parse(readFileSync(workflowPath, "utf8"));
}

function step(jobId, name) {
  const found = workflow().jobs[jobId].steps.find((candidate) => candidate.name === name);
  expect(found, `${jobId}/${name}`).toBeDefined();
  return found;
}

function nodeHereDoc(run) {
  const match = run.match(/node - <<'NODE'(?:\s+>>[^\r\n]+)?\r?\n([\s\S]*?)\r?\nNODE/);
  expect(match).not.toBeNull();
  return match[1];
}

function runNode(script, { cwd, env }) {
  return spawnSync(process.execPath, ["-e", script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

const bashLauncher = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\bash.exe" : "bash";

function fixtureTargets(count) {
  return Array.from({ length: count }, (_, index) => {
    const prNumber = index + 1;
    return {
      prNumber,
      stateKey: `platform/previews/pr-${prNumber}.tfstate`,
      databaseClusters: [
        { clusterId: `cluster-${prNumber}`, clusterName: previewDatabaseClusterNameForPrNumber(prNumber) },
      ],
      dnsRecords: [],
      namespace: `chase-sets-pr-${prNumber}`,
    };
  });
}

describe("scheduled preview cleanup batching", () => {
  it("executes every artifact-backed batch from the 1,260-target record", () => {
    const targets = fixtureTargets(1260);
    const batches = cleanupBatchesForTargets(targets);
    const recordDir = mkdtempSync(path.join(tmpdir(), "preview-cleanup-batches-"));
    const artifactDir = path.join(recordDir, "artifacts/release-health");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(path.join(artifactDir, "platform-preview-cleanup-sweep.json"), JSON.stringify({ targets, batches }));

    const resolveRun = step("destroy-preview", "Resolve scheduled cleanup batch").run;
    const script = nodeHereDoc(resolveRun);
    const resolved = [];
    for (const batchIndex of Array.from({ length: 40 }, (_, index) => index)) {
      const result = runNode(script, {
        cwd: recordDir,
        env: { BATCH_INDEX: String(batchIndex) },
      });
      expect(result.status, result.stderr).toBe(0);
      const batch = JSON.parse(readFileSync(path.join(artifactDir, "platform-preview-cleanup-batch.json"), "utf8"));
      resolved.push(...batch.targets.map((target) => target.prNumber));
    }
    expect(resolved).toEqual(targets.map((target) => target.prNumber));
    expect(new Set(resolved).size).toBe(1260);

    const outOfRange = runNode(script, {
      cwd: recordDir,
      env: { BATCH_INDEX: "40" },
    });
    expect(outOfRange.status).not.toBe(0);
    expect(outOfRange.stderr).toContain("no targets for batch 40");
  });

  it("executes workflow import and destroy loops with the batched cleanup inputs", () => {
    const targets = fixtureTargets(5);
    const expected = cleanupMatrixForTargets(targets, { checkoutRef: "main", imageSha: "abc123" }).include;
    const root = mkdtempSync(path.join(tmpdir(), "preview-cleanup-loop-"));
    const rootPath = root.replaceAll("\\", "/");
    const bashRoot = rootPath.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
    const targetFile = `${rootPath}/runner/preview-cleanup-targets`;
    const importRun = step("destroy-preview", "Import live preview database cluster into cleanup state")
      .run.replaceAll("${{ steps.batch-targets.outputs.target_file }}", targetFile)
      .replaceAll("$RUNNER_TEMP", `${rootPath}/runner`)
      .replaceAll("$GITHUB_ENV", `${rootPath}/github-env`)
      .replaceAll("${{ matrix.image_sha }}", "abc123");
    const destroyRun = step("destroy-preview", "Terraform destroy")
      .run.replaceAll("${{ steps.batch-targets.outputs.target_file }}", targetFile)
      .replaceAll("$RUNNER_TEMP", `${rootPath}/runner`)
      .replaceAll("$GITHUB_ENV", `${rootPath}/github-env`)
      .replaceAll("${{ matrix.image_sha }}", "abc123");
    const shell = [
      "set -euo pipefail",
      `export RUNNER_TEMP="${rootPath}/runner" GITHUB_ENV="${rootPath}/github-env" PATH="${bashRoot}/bin:/usr/bin:/bin:/mingw64/bin"`,
      `mkdir -p "${rootPath}/bin" "${rootPath}/runner"`,
      `cat > "${rootPath}/bin/terraform" <<'EOF'`,
      "#!/usr/bin/env bash",
      `printf 'TERRAFORM|%s|%s|%s\\n' "$TF_VAR_preview_identifier" "$TF_VAR_platform_image_tag" "$*" >> "${rootPath}/commands.log"`,
      "exit 0",
      "EOF",
      `cat > "${rootPath}/bin/node" <<'EOF'`,
      "#!/usr/bin/env bash",
      `printf 'NODE|%s|%s|%s\\n' "$TF_VAR_preview_identifier" "$TF_VAR_platform_image_tag" "$*" >> "${rootPath}/commands.log"`,
      "exit 0",
      "EOF",
      `chmod +x "${rootPath}/bin/terraform" "${rootPath}/bin/node"`,
      `printf '1\\n2\\n3\\n4\\n5\\n' > "${targetFile}"`,
      importRun,
      destroyRun,
      `cat "${rootPath}/commands.log"`,
    ].join("\n");
    const shellPath = `${rootPath}/workflow.sh`;
    try {
      writeFileSync(shellPath, shell);
      const result = spawnSync(bashLauncher, [shellPath], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
      const log = readFileSync(path.join(root, "commands.log"), "utf8");
      for (const target of expected) {
        const prNumber = target.pr_number;
        expect(log).toContain(`--cluster-name ${target.expected_database_cluster_name}`);
        expect(log).toContain(`-backend-config=key=platform/previews/pr-${prNumber}.tfstate`);
        expect(log).toContain(`|pr-${prNumber}|`);
        expect(log).toContain(`pr-${prNumber}-abc123`);
      }
      expect(log.match(/-backend-config=key=platform\/previews\/pr-[1-5]\.tfstate/g)).toHaveLength(10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes the close-event discover logic against the base branch", () => {
    const run = step("discover-preview-cleanup", "Resolve cleanup targets").run;
    const script = nodeHereDoc(run);
    const output = runNode(script, {
      cwd: repoRoot,
      env: {
        EVENT_NAME: "pull_request_target",
        PULL_REQUEST_NUMBER: "123",
        PULL_REQUEST_MERGED: "false",
        PULL_REQUEST_MERGE_COMMIT_SHA: "",
        PULL_REQUEST_BASE_REF: "main",
        PULL_REQUEST_BASE_SHA: "a".repeat(40),
        PULL_REQUEST_HEAD_SHA: "b".repeat(40),
        DISPATCH_PR_NUMBER: "",
        CHECKOUT_REF: "main",
        IMAGE_SHA: "c".repeat(40),
      },
    });
    expect(output.status, output.stderr).toBe(0);
    expect(JSON.parse(output.stdout.match(/matrix=(.*)/)?.[1] ?? "null").include[0].checkout_ref).toBe("main");
  });

  it("aggregates a per-target failure without skipping later targets", () => {
    const root = mkdtempSync(path.join(tmpdir(), "preview-cleanup-loop-"));
    const rootPath = root.replaceAll("\\", "/");
    const bashRoot = rootPath.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
    const targetFile = `${rootPath}/runner/preview-cleanup-targets`;
    const workflowRun = step("destroy-preview", "Terraform init")
      .run.replaceAll("${{ steps.batch-targets.outputs.target_file }}", targetFile)
      .replaceAll("$RUNNER_TEMP", `${rootPath}/runner`)
      .replaceAll("$GITHUB_ENV", `${rootPath}/github-env`);
    const shell = [
      "set -uo pipefail",
      `export PATH="${bashRoot}/bin:/usr/bin:/bin:/mingw64/bin"`,
      `mkdir -p "${rootPath}/bin" "${rootPath}/runner"`,
      `cat > "${rootPath}/bin/terraform" <<'EOF'`,
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> "${rootPath}/terraform.log"`,
      'case "$*" in *pr-2.tfstate*) exit 1;; esac',
      "exit 0",
      "EOF",
      `chmod +x "${rootPath}/bin/terraform"`,
      `printf '1\\n2\\n3\\n4\\n5\\n' > "${targetFile}"`,
      "(",
      workflowRun,
      ")",
      "workflow_status=$?",
      `printf 'WORKFLOW_STATUS=%s\\n' "$workflow_status"`,
      `printf 'TERRAFORM_LOG_BEGIN\\n'; cat "${rootPath}/terraform.log"`,
      `printf 'GITHUB_ENV_BEGIN\\n'; cat "${rootPath}/github-env"`,
      `printf 'FAILED_TARGETS_BEGIN\\n'; cat "${rootPath}/runner/preview-cleanup-failed-targets"`,
    ].join("\n");
    const shellPath = `${rootPath}/workflow.sh`;
    try {
      writeFileSync(shellPath, shell);
      const result = spawnSync(bashLauncher, [shellPath], { encoding: "utf8", timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("WORKFLOW_STATUS=1");
      expect(result.stdout.match(/pr-[1-5]\.tfstate/g)).toEqual([
        "pr-1.tfstate",
        "pr-2.tfstate",
        "pr-3.tfstate",
        "pr-4.tfstate",
        "pr-5.tfstate",
      ]);
      expect(result.stdout).toContain("PREVIEW_BATCH_FAILED=1");
      expect(result.stdout).toMatch(/FAILED_TARGETS_BEGIN\n2\n/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps empty discovery as a successful no-op with no destroy matrix", () => {
    const parsed = workflow();
    const discover = parsed.jobs["discover-preview-cleanup"];
    const destroy = parsed.jobs["destroy-preview"];
    expect(destroy.if).toBe("needs.discover-preview-cleanup.outputs.target_count != '0'");
    expect(cleanupMatrixForBatches([])).toEqual({ include: [] });
    expect(discover.outputs.target_count).toBe("${{ steps.targets.outputs.target_count }}");
    expect(discover.outputs.result).toBe("${{ steps.targets.outputs.result }}");
  });

  it("guards Terraform phases, sizes batch timeouts, and carries import identity", () => {
    const destroy = workflow().jobs["destroy-preview"];
    expect(destroy["timeout-minutes"]).toBe(45);
    expect(destroy.strategy["max-parallel"]).toBe(2);
    const destroyBlock =
      readFileSync(workflowPath, "utf8").match(/  destroy-preview:[\s\S]*?\n  destroy-stale-verification:/)?.[0] ?? "";
    expect(destroyBlock).toMatch(/^    timeout-minutes:\s*\d+\s*$/m);
    expect(32 * measuredWorstCloseEventSeconds + 30).toBeLessThanOrEqual(45 * 60);
    for (const name of [
      "Disable stateful destroy guard for approved preview cleanup",
      "Terraform init",
      "Import live preview database cluster into cleanup state",
      "Terraform destroy",
    ]) {
      expect(step("destroy-preview", name).if).toBe(
        "${{ !cancelled() && steps.batch-targets.outcome == 'success' && (github.event_name == 'schedule' || success()) }}",
      );
    }
    expect(step("destroy-preview", "Import live preview database cluster into cleanup state").run).toContain(
      'TF_VAR_preview_identifier="pr-${pr_number}" node scripts/digitalocean-preview-cleanup-sweep.mjs import-database',
    );
    expect(step("destroy-preview", "Delete preview DNS records").if).toBe("always()");
    expect(step("destroy-preview", "Delete preview Kubernetes namespace").if).toBe("always()");
  });

  it("keeps all managed-postgres secret-ingress anchors aligned with the workflow", () => {
    const manifest = JSON.parse(readFileSync(authorityPath, "utf8"));
    const anchors = new Set(
      manifest.grants
        .filter(
          (grant) =>
            grant.file === ".github/workflows/platform-preview-cleanup.yml" &&
            grant.jobId === "destroy-preview" &&
            grant.stepAnchor.startsWith("name:"),
        )
        .map((grant) => grant.stepAnchor),
    );
    expect(anchors).toEqual(
      new Set([
        "name:Delete preview DNS records#10",
        "name:Configure Git defaults#1",
        "name:Install dependencies#6",
        "name:Configure preview Kubernetes context#11",
        "name:Delete preview Kubernetes namespace#12",
        "name:Disable stateful destroy guard for approved preview cleanup#13",
        "name:Terraform init#14",
        "name:Import live preview database cluster into cleanup state#15",
        "name:Terraform destroy#16",
      ]),
    );
  });
});
