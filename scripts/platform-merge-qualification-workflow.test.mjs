import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/repo.mjs";

// Workflow-graph contract pins for the advisory merge-group qualification
// chain (issue #5839). The chain ships behind the checked-in default-off
// policy: a definitive disabled decision skips the publisher entirely (no
// provider mutation, no qualification records, no advisory check assertion —
// the disabled note lives in the plan summary), and the required merge path
// (PR Required, post-merge persistent staging) is untouched either way.
//
// Red-run posture (corrected on review): reusable-call jobs cannot use
// continue-on-error, so once the policy is enabled a failing gate marks the
// merge-group RUN conclusion failed while remaining non-required. Only the
// runnable plan/publisher jobs carry continue-on-error.

const platformPr = readFileSync(path.join(repoRoot, ".github/workflows/platform-pr.yml"), "utf8");
const mergeGate = readFileSync(path.join(repoRoot, ".github/workflows/platform-merge-gate-verification.yml"), "utf8");
const production = readFileSync(path.join(repoRoot, ".github/workflows/platform-production.yml"), "utf8");
const terminalizer = readFileSync(
  path.join(repoRoot, ".github/workflows/platform-merge-qualification-terminalizer.yml"),
  "utf8",
);

function job(workflow, name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing job ${name}`);
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-z0-9][a-z0-9-]*:\n/mu);
  const end = nextJob < 0 ? workflow.length : start + marker.length + nextJob;
  return workflow.slice(start, end);
}

function step(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing step ${name}`);
  const end = workflow.indexOf("\n      - ", start + marker.length);
  return workflow.slice(start, end < 0 ? workflow.length : end);
}

function jobIds(workflow) {
  const jobsStart = workflow.indexOf("\njobs:\n");
  return [...workflow.slice(jobsStart).matchAll(/^  ([a-z0-9][a-z0-9-]*):\n/gmu)].map((match) => match[1]);
}

// Code-shape discovery (never name vocabulary): a job belongs to the
// advisory qualification chain if its block executes the advisory module or
// calls the reusable merge-gate workflow.
function advisoryChainJobIds(workflow) {
  return jobIds(workflow).filter((id) => {
    const block = job(workflow, id);
    return (
      block.includes("scripts/merge-qualification-advisory.mjs") ||
      block.includes("uses: ./.github/workflows/platform-merge-gate-verification.yml")
    );
  });
}

describe("advisory chain discovery (by code shape, not job names)", () => {
  const allJobs = jobIds(platformPr);
  const chainJobs = advisoryChainJobIds(platformPr);

  it("discovers the full advisory chain from an arbitrary scan of every job block", () => {
    // Scanned/total coverage: every platform-pr job block was inspected.
    expect(allJobs.length).toBeGreaterThanOrEqual(19);
    expect(chainJobs.sort()).toEqual([
      "merge-qualification-advisory",
      "merge-qualification-gate",
      "merge-qualification-plan",
    ]);
    // eslint-disable-next-line no-console
    console.log(
      `advisory chain discovery: scanned ${allJobs.length} platform-pr jobs, ${chainJobs.length} in the chain`,
    );
  });

  it("gates every discovered chain job on merge_group; runnable jobs carry continue-on-error, the reusable call cannot", () => {
    for (const id of chainJobs) {
      const block = job(platformPr, id);
      expect(block, `${id} must only run for merge groups`).toContain("github.event_name == 'merge_group'");
      if (block.includes("runs-on:")) {
        expect(block, `${id} is runnable and must not fail the run on its own errors`).toContain(
          "continue-on-error: true",
        );
      } else {
        // GitHub rejects continue-on-error on reusable-call jobs: an enabled
        // failing gate turns the run red (non-required); documented, not
        // silently claimed otherwise.
        expect(block, `${id} is a reusable call and cannot carry continue-on-error`).not.toContain("continue-on-error");
        expect(block).toContain("uses: ./.github/workflows/platform-merge-gate-verification.yml");
      }
    }
  });

  it("negative control: no other job in the workflow reaches the advisory module or the merge-gate call", () => {
    for (const id of allJobs.filter((candidate) => !chainJobs.includes(candidate))) {
      const block = job(platformPr, id);
      expect(block).not.toContain("merge-qualification-advisory.mjs");
      expect(block).not.toContain("platform-merge-gate-verification.yml");
    }
  });
});

describe("required merge path stays untouched", () => {
  it("keeps PR Required's needs list free of every advisory chain job", () => {
    const required = job(platformPr, "pr-required");
    const needs = [...required.matchAll(/^      - ([a-z0-9-]+)$/gmu)].map((match) => match[1]);
    expect(needs.length).toBeGreaterThanOrEqual(16);
    for (const id of advisoryChainJobIds(platformPr)) {
      expect(needs, `PR Required must not consume ${id}`).not.toContain(id);
      expect(required).not.toContain(id);
    }
  });

  it("keeps the release-status job free of the advisory chain", () => {
    const releaseStatus = job(platformPr, "release-status");
    for (const id of advisoryChainJobIds(platformPr)) {
      expect(releaseStatus).not.toContain(id);
    }
  });

  it("leaves post-merge persistent staging in platform-production.yml unchanged and ahead of promotion", () => {
    expect(production).not.toContain("merge-qualification");
    const stagingIndex = production.indexOf("Deploy Staging");
    const productionIndex = production.indexOf("Deploy Production");
    expect(stagingIndex).toBeGreaterThan(-1);
    expect(productionIndex).toBeGreaterThan(stagingIndex);
  });
});

describe("merge-qualification plan job (provider-inert planning)", () => {
  const plan = job(platformPr, "merge-qualification-plan");

  it("threads no secret and invokes no provider tool anywhere in the job", () => {
    expect(plan).not.toContain("secrets.");
    for (const providerTool of ["doctl", "terraform", "kubectl", "helm ", "aws "]) {
      expect(plan, `plan job must never invoke ${providerTool.trim()}`).not.toContain(providerTool);
    }
  });

  it("evaluates the checked-in default-off policy before anything else", () => {
    const policy = step(platformPr, "Evaluate merge-qualification enablement policy");
    expect(policy).toContain("--policy scripts/merge-qualification-policy.json");
    expect(plan.indexOf("Evaluate merge-qualification enablement policy")).toBeLessThan(
      plan.indexOf("Classify candidate for advisory qualification"),
    );
  });

  it("runs the classifier and route resolution only when the policy is enabled", () => {
    for (const name of [
      "Classify candidate for advisory qualification",
      "Resolve advisory qualification route",
      "Upload merge qualification plan evidence",
    ]) {
      expect(step(platformPr, name), `${name} must be gated on enablement`).toContain(
        "if: steps.policy.outputs.enabled == 'true'",
      );
    }
  });
});

describe("merge-qualification gate job (exact built digest, reused #5869 gate)", () => {
  const gate = job(platformPr, "merge-qualification-gate");
  const docker = job(platformPr, "docker-image");

  it("exposes the Docker job's immutable pushed digest as job outputs", () => {
    expect(docker).toContain("image_digest: ${{ steps.push.outputs.image_digest }}");
    expect(docker).toContain("image_pushed: ${{ steps.push.outputs.image_pushed }}");
    const push = step(platformPr, "Push boot-smoked merge-group image");
    expect(push).toContain("id: push");
    expect(push).toContain("grep -Eq '^sha256:[0-9a-f]{64}$'");
    expect(push).toContain('echo "image_digest=${digest}"');
    expect(push).toContain('echo "image_pushed=true"');
  });

  it("calls the reusable cancellation-safe merge-gate workflow with the merge-group head SHA and the built digest", () => {
    expect(gate).toContain("uses: ./.github/workflows/platform-merge-gate-verification.yml");
    expect(gate).toContain("candidate_ref: ${{ github.event.merge_group.head_sha }}");
    // The gate deploys ONLY the digest this run built — never a later
    // mutable tree-tag resolution.
    expect(gate).toContain("image_digest: ${{ needs['docker-image'].outputs.image_digest }}");
    expect(gate).not.toContain("secrets: inherit");
  });

  it("requires enablement, an isolated route, and this run's pushed image digest", () => {
    for (const condition of [
      "needs['merge-qualification-plan'].result == 'success'",
      "needs['merge-qualification-plan'].outputs.enabled == 'true'",
      "needs['merge-qualification-plan'].outputs.route == 'isolated'",
      "needs['docker-image'].result == 'success'",
      "needs['docker-image'].outputs.image_pushed == 'true'",
    ]) {
      expect(gate).toContain(condition);
    }
    expect(gate).toContain("needs: [merge-qualification-plan, docker-image]");
  });

  it("negative control: the reused gate refuses a wrong tag, digest substitution, or missing image before smoke", () => {
    const image = step(mergeGate, "Resolve exact gate image digest");
    expect(image).toContain("does not exist; qualify a candidate whose merge-group build pushed an image");
    expect(image).toContain("refusing to deploy a different digest");
    const smokeIndex = mergeGate.indexOf("- name: Smoke check");
    expect(mergeGate.indexOf("- name: Resolve exact gate image digest")).toBeLessThan(smokeIndex);
    expect(mergeGate.indexOf("- name: Prove running pod digest")).toBeLessThan(smokeIndex);
  });

  it("consumes the gate's own resolved identity through workflow_call outputs (record-writer inputs match)", () => {
    expect(mergeGate).toContain("value: ${{ jobs.verify.outputs.image_digest }}");
    expect(mergeGate).toContain("value: ${{ jobs.verify.outputs.candidate_sha }}");
    expect(mergeGate).toContain("value: ${{ jobs.verify.outputs.candidate_tree_sha }}");
    expect(mergeGate).toContain("value: ${{ jobs.preflight.outputs.headroom_runs }}");
    const verify = job(mergeGate, "verify");
    expect(verify).toContain("image_digest: ${{ steps.image.outputs.digest }}");
    expect(verify).toContain("candidate_sha: ${{ steps.candidate.outputs.candidate_sha }}");
    expect(verify).toContain("candidate_tree_sha: ${{ steps.candidate.outputs.candidate_tree }}");
    // The durable record writer reads the same step outputs the workflow_call
    // outputs expose, so candidate SHA, tree, and digest cannot diverge.
    const record = step(mergeGate, "Persist release qualification record");
    expect(record).toContain("RECORD_IMAGE_DIGEST: ${{ steps.image.outputs.digest }}");
    expect(record).toContain("RECORD_CANDIDATE_SHA: ${{ steps.candidate.outputs.candidate_sha }}");
    expect(record).toContain("RECORD_CANDIDATE_TREE: ${{ steps.candidate.outputs.candidate_tree }}");
  });
});

describe("merge-qualification advisory publisher (exactly one terminal result, never silent)", () => {
  const advisory = job(platformPr, "merge-qualification-advisory");

  it("skips entirely on a definitive disabled decision (no green advisory check while disabled)", () => {
    expect(advisory).toContain("needs['merge-qualification-plan'].result != 'success' ||");
    expect(advisory).toContain("needs['merge-qualification-plan'].outputs.enabled == 'true'");
    expect(advisory).toContain("always() &&");
    expect(advisory).toContain("needs: [merge-qualification-plan, merge-qualification-gate, docker-image]");
  });

  it("threads the full end-to-end identity into the resolver: plan, Docker digest, and gate echoes", () => {
    const publish = step(platformPr, "Publish terminal advisory result");
    expect(publish).toContain("--policy scripts/merge-qualification-policy.json");
    for (const flag of [
      "--plan-result",
      "--classifier-class",
      "--gate-result",
      "--image-result",
      "--image-available",
      "--built-image-digest",
      "--gate-image-digest",
      "--gate-candidate-sha",
      "--gate-candidate-tree",
      "--provider-headroom-runs",
    ]) {
      expect(publish).toContain(flag);
    }
    expect(publish).toContain("GATE_RESULT: ${{ needs['merge-qualification-gate'].result }}");
    expect(publish).toContain("IMAGE_AVAILABLE: ${{ needs['docker-image'].outputs.image_pushed == 'true' }}");
    expect(publish).toContain("BUILT_IMAGE_DIGEST: ${{ needs['docker-image'].outputs.image_digest }}");
    expect(publish).toContain("GATE_IMAGE_DIGEST: ${{ needs['merge-qualification-gate'].outputs.image_digest }}");
    expect(publish).toContain("GATE_CANDIDATE_SHA: ${{ needs['merge-qualification-gate'].outputs.candidate_sha }}");
    expect(publish).toContain(
      "GATE_CANDIDATE_TREE: ${{ needs['merge-qualification-gate'].outputs.candidate_tree_sha }}",
    );
    expect(publish).toContain("GATE_HEADROOM_RUNS: ${{ needs['merge-qualification-gate'].outputs.headroom_runs }}");
  });

  it("threads no provider credential: the publisher writes repository-local artifacts only", () => {
    expect(advisory).not.toContain("secrets.");
  });

  it("uploads qualification event records exactly when a record was written", () => {
    const upload = step(platformPr, "Upload merge qualification advisory events");
    expect(upload).toContain("if: steps.publish.outputs.record_written == 'true'");
    expect(upload).toContain("if-no-files-found: error");
  });
});

describe("independent merge-qualification terminalizer (workflow_run observer)", () => {
  it("observes completed Platform PR runs and only acts on merge groups", () => {
    expect(terminalizer).toContain("workflow_run:");
    expect(terminalizer).toContain('workflows: ["Platform PR"]');
    expect(terminalizer).toContain("types: [completed]");
    expect(terminalizer).toContain("if: github.event.workflow_run.event == 'merge_group'");
  });

  it("re-evaluates the checked-in policy and feeds run, jobs, and artifact inventory to the terminalizer", () => {
    const emit = step(terminalizer, "Emit missing terminal advisory result");
    expect(emit).toContain("merge-qualification-advisory.mjs terminalize");
    expect(emit).toContain("--policy scripts/merge-qualification-policy.json");
    for (const flag of ["--run ", "--jobs ", "--run-artifacts ", "--candidate-tree "]) {
      expect(emit).toContain(flag);
    }
  });

  it("uploads the terminal event only when one was written, keyed to the observed run", () => {
    const upload = step(terminalizer, "Upload terminal advisory event");
    expect(upload).toContain("if: steps.terminalize.outputs.event_written == 'true'");
    expect(upload).toContain(
      "merge-qualification-terminal-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}",
    );
  });

  it("threads no provider credential and requests only read permissions", () => {
    expect(terminalizer).not.toContain("secrets.");
    expect(terminalizer).toContain("permissions:");
    expect(terminalizer).toContain("contents: read");
    expect(terminalizer).toContain("actions: read");
    expect(terminalizer).not.toContain("write");
  });
});
