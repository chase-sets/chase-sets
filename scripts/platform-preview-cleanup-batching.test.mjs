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

function renderWorkflowRun(run, replacements) {
  return Object.entries(replacements).reduce((rendered, [from, to]) => rendered.replaceAll(from, to), run);
}

function renderCleanupStep(name, rootPath, targetFile, replacements = {}) {
  return renderWorkflowRun(step("destroy-preview", name).run, {
    "${{ steps.batch-targets.outputs.target_file }}": targetFile,
    "${{ steps.preview-context.outcome }}": "success",
    "${{ github.event_name }}": "schedule",
    "${{ matrix.pr_number }}": "1",
    "${{ matrix.image_sha }}": "abc123",
    $RUNNER_TEMP: `${rootPath}/runner`,
    $GITHUB_ENV: `${rootPath}/github-env`,
    ...replacements,
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

function executeCleanup({ eventName = "schedule", failure = "none", contextOutcome = "success" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "preview-cleanup-execution-"));
  const rootPath = root.replaceAll("\\", "/");
  const bashRoot = rootPath.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  const targetFile = `${rootPath}/runner/preview-cleanup-targets`;
  const names = [
    "Delete preview DNS records",
    "Delete preview Kubernetes namespace",
    "Terraform init",
    "Disable stateful destroy guard for approved preview cleanup",
    "Import live preview database cluster into cleanup state",
    "Terraform destroy",
    "Retire empty preview Terraform state",
  ];
  const shell = [
    "set -uo pipefail",
    `export RUNNER_TEMP="${rootPath}/runner" GITHUB_ENV="${rootPath}/github-env" PATH="${bashRoot}/bin:/usr/bin:/bin:/mingw64/bin"`,
    `export FIXTURE_FAILURE="${failure}" FIXTURE_ROOT="${rootPath}"`,
    `mkdir -p "${rootPath}/bin" "${rootPath}/runner" "${rootPath}/artifacts/release-health"`,
    `printf '%s' '{"targets":[{"prNumber":1},{"prNumber":2},{"prNumber":3}]}' > "${rootPath}/artifacts/release-health/platform-preview-cleanup-batch.json"`,
    `printf '1\\n2\\n3\\n' > "${targetFile}"`,
    "node() {",
    'if [ "$1" = "-e" ]; then printf "1\\n2\\n3\\n"; return 0; fi',
    'command="$2"; shift 2; pr=""; cleanup=""',
    'while [ "$#" -gt 0 ]; do case "$1" in --pr-number) pr="$2"; shift 2;; --cleanup-succeeded) cleanup="$2"; shift 2;; *) shift;; esac; done',
    'printf "%s|%s|%s\\n" "$command" "$pr" "$cleanup" >> "$FIXTURE_ROOT/commands.log"',
    'if [ "$command" = "infrastructure/digitalocean/platform/main.tf" ] && [ "$FIXTURE_FAILURE" = disable ]; then return 1; fi',
    'if [ "$pr" = 2 ]; then case "$command:$FIXTURE_FAILURE" in destroy-dns:dns|import-database:import|retire-state:retire) return 1;; esac; fi',
    'if [ "$command" = retire-state ] && [ "$cleanup" != true ]; then return 1; fi',
    "return 0",
    "}",
    "pnpm() {",
    'if [ "$FIXTURE_FAILURE" = namespace ] && [[ "$*" = *"chase-sets-pr-2"* ]]; then return 1; fi',
    "return 0",
    "}",
    "terraform() {",
    'if [[ "$*" = *"destroy -auto-approve"* ]]; then printf "destroy|%s\\n" "$TF_VAR_preview_identifier" >> "$FIXTURE_ROOT/commands.log"; if [ "$FIXTURE_FAILURE" = destroy ] && [ "$TF_VAR_preview_identifier" = pr-2 ]; then return 1; fi; fi',
    'if [ "$FIXTURE_FAILURE" = init ] && [[ "$*" = *"pr-2.tfstate"* ]]; then return 1; fi',
    "return 0",
    "}",
    renderCleanupStep("Resolve cleanup target numbers", rootPath, targetFile, {
      "${{ github.event_name }}": eventName,
      "${{ matrix.pr_number }}": "2",
    }),
    "set +e",
    "prior_failed=0",
  ];
  for (const [index, name] of names.entries()) {
    const gate = step("destroy-preview", name).if;
    const unconditional = gate === "always()" || !gate.includes("success()");
    shell.push(
      `if [ "${eventName}" = schedule ] || [ "$prior_failed" = 0 ] || [ "${unconditional}" = true ]; then`,
      "(",
      renderCleanupStep(name, rootPath, targetFile, {
        "${{ github.event_name }}": eventName,
        "${{ matrix.pr_number }}": "2",
        "${{ steps.preview-context.outcome }}": contextOutcome,
      }),
      ")",
      "status=$?",
      `printf '${index}|%s\\n' "$status" >> "${rootPath}/statuses.log"`,
      '[ "$status" = 0 ] || prior_failed=1',
      "fi",
      `if [ -f "${rootPath}/github-env" ]; then set -a; source "${rootPath}/github-env"; set +a; fi`,
    );
  }
  const shellPath = `${rootPath}/workflow.sh`;
  try {
    writeFileSync(shellPath, shell.join("\n"));
    const result = spawnSync(bashLauncher, [shellPath], {
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: `${rootPath}/github-output` },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return {
      commands: readFileSync(path.join(root, "commands.log"), "utf8").trim().split(/\r?\n/),
      statuses: readFileSync(path.join(root, "statuses.log"), "utf8").trim().split(/\r?\n/),
      environment: readFileSync(path.join(root, "github-env"), { encoding: "utf8", flag: "a+" }),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("scheduled preview cleanup batching", () => {
  it.each(["dns", "namespace", "init", "import", "destroy", "retire"])(
    "executes the full scheduled cleanup sequence with a PR 2 %s failure",
    (failure) => {
      const result = executeCleanup({ failure });
      expect(result.commands.filter((line) => line.startsWith("retire-state|"))).toEqual([
        "retire-state|1|true",
        `retire-state|2|${failure === "retire" ? "true" : "false"}`,
        "retire-state|3|true",
      ]);
      expect(result.statuses).toContain("6|1");
      expect(result.environment).toContain("PREVIEW_BATCH_FAILED=1");
      if (["dns", "namespace", "destroy", "retire"].includes(failure)) {
        expect(result.commands.filter((line) => line.startsWith("destroy|"))).toEqual([
          "destroy|pr-1",
          "destroy|pr-2",
          "destroy|pr-3",
        ]);
      }
    },
  );

  it.each(["pull_request_target", "workflow_dispatch", "idle-draft-recheck", "schedule"])(
    "executes the %s caller target shape through the same retirement guard",
    (caller) => {
      // Idle-draft re-check dispatches workflow_dispatch for its selected PR.
      const eventName = caller === "idle-draft-recheck" ? "workflow_dispatch" : caller;
      const result = executeCleanup({ eventName });
      expect(result.commands.filter((line) => line.startsWith("retire-state|"))).toEqual(
        eventName === "schedule"
          ? ["retire-state|1|true", "retire-state|2|true", "retire-state|3|true"]
          : ["retire-state|2|true"],
      );
      expect(result.statuses).toContain("6|0");
      const refused = executeCleanup({ eventName, failure: "dns" });
      expect(refused.commands).toContain("retire-state|2|false");
      expect(refused.statuses).toContain("6|1");
    },
  );

  it("refuses every retirement target when Kubernetes context failed", () => {
    const result = executeCleanup({ contextOutcome: "failure" });
    expect(result.commands.filter((line) => line.startsWith("retire-state|"))).toEqual([
      "retire-state|1|false",
      "retire-state|2|false",
      "retire-state|3|false",
    ]);
    expect(result.statuses).toContain("6|1");
  });

  it("preserves scheduled destroy and close-event skip semantics after disable failure", () => {
    const scheduled = executeCleanup({ failure: "disable" });
    expect(scheduled.commands.filter((line) => line.startsWith("destroy|"))).toEqual([
      "destroy|pr-1",
      "destroy|pr-2",
      "destroy|pr-3",
    ]);
    expect(scheduled.commands.filter((line) => line.startsWith("retire-state|"))).toEqual([
      "retire-state|1|false",
      "retire-state|2|false",
      "retire-state|3|false",
    ]);
    expect(scheduled.statuses).toEqual(expect.arrayContaining(["3|1", "4|1", "6|1"]));
    const closed = executeCleanup({ eventName: "pull_request_target", failure: "disable" });
    expect(closed.statuses).toContain("3|1");
    expect(closed.statuses.some((line) => line.startsWith("4|") || line.startsWith("5|"))).toBe(false);
    expect(closed.commands).toContain("retire-state|2|false");
  });

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

  it.each(["Delete preview DNS records", "Delete preview Kubernetes namespace"])(
    "records %s failures in the retirement-only ledger",
    (stepName) => {
      const root = mkdtempSync(path.join(tmpdir(), "preview-cleanup-ledger-"));
      const rootPath = root.replaceAll("\\", "/");
      const bashRoot = rootPath.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
      const targetFile = `${rootPath}/runner/preview-cleanup-targets`;
      const run = renderCleanupStep(stepName, rootPath, targetFile);
      const retire = renderCleanupStep("Retire empty preview Terraform state", rootPath, targetFile);
      const shell = [
        "set -uo pipefail",
        `export RUNNER_TEMP="${rootPath}/runner" GITHUB_ENV="${rootPath}/github-env" PATH="${bashRoot}/bin:/usr/bin:/bin:/mingw64/bin"`,
        `mkdir -p "${rootPath}/bin" "${rootPath}/runner"`,
        `printf '1\\n2\\n3\\n' > "${targetFile}"`,
        `cat > "${rootPath}/bin/node" <<'EOF'`,
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> "${rootPath}/node.log"`,
        'case "$*" in *"--pr-number 2"*) if [[ "$*" != *"retire-state"* ]]; then exit 1; fi;; esac',
        "exit 0",
        "EOF",
        `chmod +x "${rootPath}/bin/node"`,
        `cat > "${rootPath}/bin/pnpm" <<'EOF'`,
        "#!/usr/bin/env bash",
        'case "$*" in *"chase-sets-pr-2"*) exit 1;; esac',
        "exit 0",
        "EOF",
        `chmod +x "${rootPath}/bin/pnpm"`,
        `(${run}) || dns_status=$?`,
        `source "${rootPath}/github-env" 2>/dev/null || true`,
        `(${retire})`,
      ].join("\n");
      const shellPath = `${rootPath}/workflow.sh`;
      try {
        writeFileSync(shellPath, shell);
        const result = spawnSync(bashLauncher, [shellPath], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
        expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(1);
        expect(readFileSync(path.join(root, "runner/preview-cleanup-incomplete-targets"), "utf8")).toContain("2");
        expect(readFileSync(path.join(root, "node.log"), "utf8")).toMatch(
          /retire-state --pr-number 2 --cleanup-succeeded false/,
        );
        expect(readFileSync(path.join(root, "node.log"), "utf8")).toMatch(
          /retire-state --pr-number 1 --cleanup-succeeded true/,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("runs Terraform destroy for a DNS or namespace failure while retirement still refuses that target", () => {
    const root = mkdtempSync(path.join(tmpdir(), "preview-cleanup-destroy-"));
    const rootPath = root.replaceAll("\\", "/");
    const bashRoot = rootPath.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
    const targetFile = `${rootPath}/runner/preview-cleanup-targets`;
    const destroy = renderCleanupStep("Terraform destroy", rootPath, targetFile);
    const shell = [
      "set -uo pipefail",
      `export RUNNER_TEMP="${rootPath}/runner" GITHUB_ENV="${rootPath}/github-env" PATH="${bashRoot}/bin:/usr/bin:/bin:/mingw64/bin"`,
      `mkdir -p "${rootPath}/bin" "${rootPath}/runner"`,
      `printf '1\\n2\\n3\\n' > "${targetFile}"`,
      `printf '2\\n' > "${rootPath}/runner/preview-cleanup-incomplete-targets"`,
      `: > "${rootPath}/runner/preview-cleanup-failed-targets"`,
      `cat > "${rootPath}/bin/terraform" <<'EOF'`,
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> "${rootPath}/terraform.log"`,
      "exit 0",
      "EOF",
      `chmod +x "${rootPath}/bin/terraform"`,
      `(${destroy})`,
    ].join("\n");
    const shellPath = `${rootPath}/workflow.sh`;
    try {
      writeFileSync(shellPath, shell);
      const result = spawnSync(bashLauncher, [shellPath], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
      const log = readFileSync(path.join(root, "terraform.log"), "utf8");
      expect(log.match(/destroy -auto-approve/g)).toHaveLength(3);
      expect(log).toContain("key=platform/previews/pr-2.tfstate");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "Disable stateful destroy guard for approved preview cleanup",
    "Import live preview database cluster into cleanup state",
  ])("keeps %s red when its command fails", (stepName) => {
    const root = mkdtempSync(path.join(tmpdir(), "preview-cleanup-step-failure-"));
    const rootPath = root.replaceAll("\\", "/");
    const bashRoot = rootPath.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
    const targetFile = `${rootPath}/runner/preview-cleanup-targets`;
    const run = renderCleanupStep(stepName, rootPath, targetFile);
    const shell = [
      "set -uo pipefail",
      `export RUNNER_TEMP="${rootPath}/runner" GITHUB_ENV="${rootPath}/github-env" PATH="${bashRoot}/bin:/usr/bin:/bin:/mingw64/bin"`,
      `mkdir -p "${rootPath}/bin" "${rootPath}/runner"`,
      `printf '1\\n2\\n3\\n' > "${targetFile}"`,
      `cat > "${rootPath}/bin/node" <<'EOF'`,
      "#!/usr/bin/env bash",
      'case "$*" in *"disable-terraform-prevent-destroy"*) exit 1;; *"import-database --pr-number 2"*) exit 1;; esac',
      "exit 0",
      "EOF",
      `chmod +x "${rootPath}/bin/node"`,
      `cat > "${rootPath}/bin/terraform" <<'EOF'`,
      "#!/usr/bin/env bash",
      "exit 0",
      "EOF",
      `chmod +x "${rootPath}/bin/terraform"`,
      `set +e; (${run}); status=$?; set -e; printf 'STATUS=%s\\n' "$status"`,
    ].join("\n");
    const shellPath = `${rootPath}/workflow.sh`;
    try {
      writeFileSync(shellPath, shell);
      const result = spawnSync(bashLauncher, [shellPath], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("STATUS=1");
      expect(readFileSync(path.join(root, "github-env"), "utf8")).toContain("PREVIEW_BATCH_FAILED=1");
      const ledger = stepName.startsWith("Disable") ? "incomplete" : "failed";
      expect(readFileSync(path.join(root, `runner/preview-cleanup-${ledger}-targets`), "utf8")).toContain("2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("continues retirement after one target fails and preserves aggregate failure", () => {
    const root = mkdtempSync(path.join(tmpdir(), "preview-cleanup-retirement-"));
    const rootPath = root.replaceAll("\\", "/");
    const bashRoot = rootPath.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
    const targetFile = `${rootPath}/runner/preview-cleanup-targets`;
    const retire = renderCleanupStep("Retire empty preview Terraform state", rootPath, targetFile);
    const shell = [
      "set -uo pipefail",
      `export RUNNER_TEMP="${rootPath}/runner" GITHUB_ENV="${rootPath}/github-env" PATH="${bashRoot}/bin:/usr/bin:/bin:/mingw64/bin"`,
      `mkdir -p "${rootPath}/bin" "${rootPath}/runner"`,
      `printf '1\\n2\\n3\\n' > "${targetFile}"`,
      `cat > "${rootPath}/bin/node" <<'EOF'`,
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> "${rootPath}/node.log"`,
      'case "$*" in *"retire-state --pr-number 2"*) exit 1;; esac',
      "exit 0",
      "EOF",
      `chmod +x "${rootPath}/bin/node"`,
      `set +e; (${retire}); status=$?; set -e; printf 'STATUS=%s\\n' "$status"`,
    ].join("\n");
    const shellPath = `${rootPath}/workflow.sh`;
    try {
      writeFileSync(shellPath, shell);
      const result = spawnSync(bashLauncher, [shellPath], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("STATUS=1");
      const log = readFileSync(path.join(root, "node.log"), "utf8");
      expect(log).toMatch(/retire-state --pr-number 1/);
      expect(log).toMatch(/retire-state --pr-number 2/);
      expect(log).toMatch(/retire-state --pr-number 3/);
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
      "Terraform init",
      "Disable stateful destroy guard for approved preview cleanup",
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
    const steps = destroy.steps.map(({ name }) => name).filter(Boolean);
    expect(steps.indexOf("Terraform init")).toBeLessThan(
      steps.indexOf("Disable stateful destroy guard for approved preview cleanup"),
    );
  });

  it("records per-target cleanup failures before the shared retirement guard", () => {
    const source = readFileSync(workflowPath, "utf8");
    const retirement = step("destroy-preview", "Retire empty preview Terraform state");
    expect(retirement.if).toBe("${{ !cancelled() && steps.batch-targets.outcome == 'success' }}");
    expect(retirement.run).toContain('grep -Fxq "$pr_number" "$failed_targets"');
    expect(retirement.run).toContain('grep -Fxq "$pr_number" "$incomplete_targets"');
    expect(retirement.run).toContain('--cleanup-succeeded "$cleanup_succeeded"');
    expect(retirement.run).toContain('--out "$record_path"');
    expect(source).toContain('echo "$pr_number" >> "$RUNNER_TEMP/preview-cleanup-incomplete-targets"');
    expect(step("destroy-preview", "Upload preview state retirement record").if).toBe("always()");
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
        "name:Terraform init#13",
        "name:Disable stateful destroy guard for approved preview cleanup#14",
        "name:Import live preview database cluster into cleanup state#15",
        "name:Terraform destroy#16",
        "name:Retire empty preview Terraform state#17",
      ]),
    );
  });
});
