import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { repoRoot } from "./lib/repo.mjs";

// #4778: `Platform Preview Cleanup` destroyed only Terraform-managed
// DigitalOcean resources and reported green while every merged PR's
// in-cluster Kubernetes namespace (created by Helm, never by Terraform)
// persisted forever, eventually starving the staging node of memory. This
// regressed silently once already because nothing pinned that the
// namespace-deletion step exists, let alone that it fails the run instead of
// swallowing a surviving namespace. This file is that pin.

const workflowPath = path.join(repoRoot, ".github/workflows/platform-preview-cleanup.yml");

function readWorkflow() {
  return readFileSync(workflowPath, "utf8");
}

function extractStep(workflow, stepName) {
  const marker = `      - name: ${stepName}\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`Step "${stepName}" was not found in .github/workflows/platform-preview-cleanup.yml.`);
  }
  const afterMarker = start + marker.length;
  const nextStepIndex = workflow.indexOf("\n      - ", afterMarker);
  return workflow.slice(start, nextStepIndex === -1 ? workflow.length : nextStepIndex);
}

describe("platform preview cleanup namespace teardown guard", () => {
  it("keeps a required, unconditionally-failing namespace-deletion step in the per-merge cleanup job", () => {
    const workflow = readWorkflow();
    const step = extractStep(workflow, "Delete preview Kubernetes namespace");

    expect(step).toContain("platform:kubernetes-deployment -- teardown");
    expect(step).toContain('--namespace "chase-sets-pr-${{ matrix.pr_number }}"');
    expect(step).toContain('--release "chase-sets-pr-${{ matrix.pr_number }}"');

    // The whole point of `teardown` is that a namespace surviving the delete
    // throws instead of returning success (see teardownPlatformKubernetesNamespace
    // in platform-kubernetes-deployment.mjs). Any of these would silently
    // turn that failure back into a green run, recreating the #4778 bug.
    expect(step).not.toContain("continue-on-error");
    expect(step).not.toContain("|| true");
    expect(step).not.toContain("2>/dev/null");
    expect(step).not.toMatch(/\bset\s+\+e\b/);
  });

  it("configures Kubernetes cluster access before the namespace-deletion step runs", () => {
    const workflow = readWorkflow();
    const contextStep = extractStep(workflow, "Configure preview Kubernetes context");

    expect(contextStep).toContain("doks/staging.tfstate");
    expect(contextStep).toContain("KUBECONFIG=");

    const contextIndex = workflow.indexOf("- name: Configure preview Kubernetes context");
    const deleteIndex = workflow.indexOf("- name: Delete preview Kubernetes namespace");
    expect(contextIndex).toBeGreaterThan(-1);
    expect(contextIndex).toBeLessThan(deleteIndex);
  });

  it("keeps the scheduled sweep able to discover and reconcile live chase-sets-pr-* namespaces", () => {
    const workflow = readWorkflow();
    const sweepContextStep = extractStep(workflow, "Configure staging Kubernetes context for preview sweep");

    expect(sweepContextStep).toContain("if: github.event_name == 'schedule'");
    expect(sweepContextStep).toContain("doks/staging.tfstate");

    // The sweep must run on a schedule, not only on demand.
    expect(workflow).toMatch(/schedule:\s*\n\s*-\s*cron:/);
  });

  it("keeps a required, unconditionally-failing namespace-deletion step in the stale gate sweep (#5838)", () => {
    const workflow = readWorkflow();
    const step = extractStep(workflow, "Delete stale gate Kubernetes namespace");

    expect(step).toContain("if: always()");
    expect(step).toContain("platform:kubernetes-deployment -- teardown");
    expect(step).toContain('--namespace "${{ matrix.namespace }}"');
    expect(step).toContain('--release "${{ matrix.release }}"');
    expect(step).not.toContain("continue-on-error");
    expect(step).not.toContain("|| true");
    expect(step).not.toContain("2>/dev/null");
    expect(step).not.toMatch(/\bset\s+\+e\b/);

    const contextIndex = workflow.indexOf("- name: Configure gate cleanup Kubernetes context");
    const deleteIndex = workflow.indexOf("- name: Delete stale gate Kubernetes namespace");
    expect(contextIndex).toBeGreaterThan(-1);
    expect(contextIndex).toBeLessThan(deleteIndex);
  });

  it("never deletes a namespace for a still-open PR: the sweep only selects PRs whose state is closed", async () => {
    const { discoverPreviewCleanupTargets } = await import("./digitalocean-preview-cleanup-sweep.mjs");
    const result = await discoverPreviewCleanupTargets(
      {
        bucket: "chase-sets-terraform-state",
        endpointUrl: "https://nyc3.digitaloceanspaces.com",
        prefix: "platform/previews",
        repository: "chase-sets/chase-sets",
        githubToken: "token",
        checkoutRef: "main",
        imageSha: "abc123",
        checkedAt: "2026-07-10T12:00:00.000Z",
      },
      {
        awsJson: async () => ({ Contents: [] }),
        listDatabaseClusters: async () => [],
        listDomains: async () => [{ name: "chasesets.com" }],
        listDomainRecords: async () => [],
        listNamespaces: async () => [{ metadata: { name: "chase-sets-pr-4777" } }],
        fetchPullRequest: async () => ({ state: "open", merged: false }),
      },
    );

    expect(result.record.namespaceCandidates).toEqual([
      { prNumber: 4777, namespace: "chase-sets-pr-4777", creationTimestamp: null },
    ]);
    expect(result.record.targets).toEqual([]);
    expect(result.matrix.include).toEqual([]);
  });
});

// #9964: idle draft retirement. One scheduled job selects idle drafts and
// dispatches the existing per-PR destroy path; each dispatched run re-checks
// the rule before the unchanged destroy-preview job runs. These assertions are
// a function so each guard below has a mutant proving it bites.
const RETIRE_JOB = "retire-idle-draft-previews";
const RECHECK_GATE = '[ "${EVENT_NAME}" = "workflow_dispatch" ] && [ "${IDLE_DRAFT_RECHECK}" = "true" ]';

function assertIdleDraftRetirementWorkflow(source) {
  const workflow = parse(source);
  const problems = [];
  const check = (condition, message) => {
    if (!condition) problems.push(message);
  };

  const input = workflow.on?.workflow_dispatch?.inputs?.idle_draft_recheck;
  check(
    input?.type === "boolean" && input?.default === false && input?.required === false,
    "idle_draft_recheck must be an optional boolean input defaulting to false",
  );

  const job = workflow.jobs?.[RETIRE_JOB];
  check(job?.if === "github.event_name == 'schedule'", "the retirement job must run on schedule events only");
  check(job?.needs === undefined, "the retirement job must not depend on the timing-out discover job");
  check(job?.environment === "preview", "the retirement job must run in the preview environment");
  check(
    JSON.stringify(job?.permissions) ===
      JSON.stringify({ contents: "read", "pull-requests": "read", actions: "write" }),
    "the retirement job permissions must be exactly contents: read, pull-requests: read, actions: write",
  );
  const steps = job?.steps ?? [];
  const select = steps.find((step) => step.id === "idle-drafts");
  check(
    select?.run?.includes("node ./scripts/digitalocean-preview-cleanup-sweep.mjs discover-idle-drafts") &&
      !select.run.includes("--pr-number"),
    "the retirement job must run the full idle-draft selection",
  );
  const dispatch = steps.find((step) => step.name === "Dispatch idle draft retirements");
  check(
    dispatch?.if === "steps.idle-drafts.outputs.target_count != '0'",
    "dispatch must run only after a successful, nonempty selection",
  );
  check(
    /gh workflow run platform-preview-cleanup\.yml [^\n]*--ref main\s*\\\n\s*-f pr_number="\$\{pr_number\}" -f idle_draft_recheck=true/.test(
      dispatch?.run ?? "",
    ),
    "each dispatch must target main and set idle_draft_recheck=true",
  );
  const upload = steps.find((step) => step.name === "Upload idle draft retirement record");
  check(
    upload?.if === "always()" &&
      upload?.with?.path === "artifacts/release-health/platform-preview-idle-drafts.json" &&
      upload?.with?.["if-no-files-found"] === "error",
    "the retirement record must always upload and fail when missing",
  );
  check(workflow.jobs?.reporter?.needs?.includes(RETIRE_JOB), "the failure reporter must observe the retirement job");

  // actions: write exists only on the new job; nothing else can dispatch.
  check(workflow.permissions?.actions === undefined, "workflow-level permissions must not grant actions");
  for (const [id, other] of Object.entries(workflow.jobs ?? {})) {
    if (id !== RETIRE_JOB) {
      check(other.permissions?.actions !== "write", `job ${id} must not have actions: write`);
    }
  }
  check(
    source.split("gh workflow run").length === 2,
    "the retirement job's dispatch step must be the workflow's only gh workflow run",
  );

  // Re-check path: the dispatched run reuses the discover job and never
  // dispatches; with the input false nothing changes.
  const discover = workflow.jobs?.["discover-preview-cleanup"];
  const discoverSteps = discover?.steps ?? [];
  check(
    discoverSteps.find((step) => step.name === "Configure staging Kubernetes context for preview sweep")?.if ===
      "github.event_name == 'schedule' || inputs.idle_draft_recheck",
    "the preview sweep Kubernetes context must run only for schedules and re-checks",
  );
  check(
    discoverSteps.find((step) => step.uses?.startsWith("hashicorp/setup-terraform@"))?.if ===
      "github.event_name == 'schedule' || inputs.idle_draft_recheck",
    "Terraform setup must run only for schedules and re-checks",
  );
  const resolve = discoverSteps.find((step) => step.id === "targets");
  check(
    resolve?.env?.IDLE_DRAFT_RECHECK === "${{ inputs.idle_draft_recheck && 'true' || 'false' }}",
    "the resolve step must read the re-check input as 'true' or 'false'",
  );
  const run = resolve?.run ?? "";
  const gateIndex = run.indexOf(`if ${RECHECK_GATE}; then`);
  const recheckBlock = gateIndex === -1 ? "" : run.slice(gateIndex, run.indexOf("\nfi\n", gateIndex));
  check(
    recheckBlock.includes("discover-idle-drafts") &&
      recheckBlock.includes('--pr-number "${DISPATCH_PR_NUMBER}"') &&
      recheckBlock.includes('--github-output "$GITHUB_OUTPUT"') &&
      recheckBlock.trimEnd().endsWith("exit 0"),
    "the re-check branch must be gated on workflow_dispatch with the input true and exit before the unconditional matrix",
  );
  check(
    gateIndex !== -1 && gateIndex < run.indexOf("node - <<'NODE' >> \"$GITHUB_OUTPUT\""),
    "the re-check branch must precede the unconditional single-PR matrix",
  );
  check(
    run.includes('console.log("target_count=1");'),
    "the false-input dispatch path must keep its unconditional single-PR matrix",
  );
  check(
    discover?.outputs?.matrix === "${{ steps.targets.outputs.matrix }}" &&
      discover?.outputs?.target_count === "${{ steps.targets.outputs.target_count }}",
    "the destroy matrix must still come from the resolve step",
  );
  const recheckUpload = discoverSteps.find((step) => step.name === "Upload idle draft re-check record");
  check(
    recheckUpload?.if === "${{ always() && inputs.idle_draft_recheck }}" &&
      recheckUpload?.with?.["if-no-files-found"] === "error",
    "the re-check record must upload on re-checks only and fail when missing",
  );

  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
}

describe("idle draft preview retirement workflow (#9964)", () => {
  it("schedules one dispatch-only job and re-checks inside the dispatched run", () => {
    expect(() => assertIdleDraftRetirementWorkflow(readWorkflow())).not.toThrow();
  });

  it.each([
    [
      "the dispatched run destroys without a re-check",
      (source) => source.replace(" -f idle_draft_recheck=true", ""),
      "each dispatch must target main and set idle_draft_recheck=true",
    ],
    [
      "dispatched runs can dispatch again",
      (source) =>
        source.replace(
          `  ${RETIRE_JOB}:\n    name: Retire Idle Draft Previews\n    if: github.event_name == 'schedule'\n`,
          `  ${RETIRE_JOB}:\n    name: Retire Idle Draft Previews\n`,
        ),
      "the retirement job must run on schedule events only",
    ],
    [
      "actions: write leaks onto the discover job",
      (source) =>
        source.replace(
          "    permissions:\n      contents: read\n      pull-requests: read\n    env:\n      AWS_DEFAULT_REGION",
          "    permissions:\n      contents: read\n      pull-requests: read\n      actions: write\n    env:\n      AWS_DEFAULT_REGION",
        ),
      "job discover-preview-cleanup must not have actions: write",
    ],
    [
      "the retirement job loses actions: write",
      (source) =>
        source.replace(
          "      pull-requests: read\n      actions: write\n    steps:",
          "      pull-requests: read\n    steps:",
        ),
      "the retirement job permissions must be exactly",
    ],
    [
      "the re-check runs with the input false",
      (source) => source.replace(RECHECK_GATE, '[ "${EVENT_NAME}" = "workflow_dispatch" ]'),
      "the re-check branch must be gated on workflow_dispatch with the input true",
    ],
    [
      "the re-check falls through to the unconditional matrix",
      (source) =>
        source.replace(
          '              --out artifacts/release-health/platform-preview-idle-drafts.json \\\n              --github-output "$GITHUB_OUTPUT"\n            exit 0\n',
          '              --out artifacts/release-health/platform-preview-idle-drafts.json \\\n              --github-output "$GITHUB_OUTPUT"\n',
        ),
      "exit before the unconditional matrix",
    ],
    [
      "the input defaults to true",
      (source) =>
        source.replace(
          "        required: false\n        default: false\n        type: boolean",
          "        required: false\n        default: true\n        type: boolean",
        ),
      "idle_draft_recheck must be an optional boolean input defaulting to false",
    ],
    [
      "the retirement job waits on the timing-out discover job",
      (source) =>
        source.replace(
          "    name: Retire Idle Draft Previews\n",
          "    name: Retire Idle Draft Previews\n    needs: discover-preview-cleanup\n",
        ),
      "must not depend on the timing-out discover job",
    ],
    [
      "dispatch runs after a failed selection",
      (source) =>
        source.replace("        if: steps.idle-drafts.outputs.target_count != '0'\n", "        if: always()\n"),
      "dispatch must run only after a successful, nonempty selection",
    ],
    [
      "a missing retirement record is ignored",
      (source) =>
        source.replace(
          "path: artifacts/release-health/platform-preview-idle-drafts.json\n          if-no-files-found: error\n          retention-days: 14\n\n  reporter:",
          "path: artifacts/release-health/platform-preview-idle-drafts.json\n          if-no-files-found: ignore\n          retention-days: 14\n\n  reporter:",
        ),
      "the retirement record must always upload and fail when missing",
    ],
    [
      "the reporter stops observing the retirement job",
      (source) =>
        source.replace("      - retire-idle-draft-previews\n    if: ${{ always() }}", "    if: ${{ always() }}"),
      "the failure reporter must observe the retirement job",
    ],
  ])("bypass mutant: rejects a workflow where %s", (_label, mutate, expectedProblem) => {
    const source = readWorkflow();
    const mutant = mutate(source);
    expect(mutant, "mutation must apply").not.toBe(source);
    expect(() => assertIdleDraftRetirementWorkflow(mutant)).toThrow(expectedProblem);
  });
});
