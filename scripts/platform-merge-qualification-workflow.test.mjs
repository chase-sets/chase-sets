import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/repo.mjs";

// Workflow-graph contract pins for the advisory merge-group qualification
// chain (issue #5839). The chain ships behind the checked-in default-off
// policy: disabled means a visible summary note, no provider mutation, no
// qualification records, no advisory assertion — and the required merge path
// (PR Required, post-merge persistent staging) is untouched either way.

const platformPr = readFileSync(path.join(repoRoot, ".github/workflows/platform-pr.yml"), "utf8");
const mergeGate = readFileSync(path.join(repoRoot, ".github/workflows/platform-merge-gate-verification.yml"), "utf8");
const production = readFileSync(path.join(repoRoot, ".github/workflows/platform-production.yml"), "utf8");

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

  it("gates every discovered chain job on merge_group and keeps runnable jobs continue-on-error", () => {
    for (const id of chainJobs) {
      const block = job(platformPr, id);
      expect(block, `${id} must only run for merge groups`).toContain("github.event_name == 'merge_group'");
      if (block.includes("runs-on:")) {
        expect(block, `${id} must never turn a merge-group run red`).toContain("continue-on-error: true");
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

describe("merge-qualification gate job (exact published tree image, reused #5869 gate)", () => {
  const gate = job(platformPr, "merge-qualification-gate");

  it("calls the reusable cancellation-safe merge-gate workflow with the merge-group head SHA", () => {
    expect(gate).toContain("uses: ./.github/workflows/platform-merge-gate-verification.yml");
    expect(gate).toContain("candidate_ref: ${{ github.event.merge_group.head_sha }}");
    // The gate resolves the candidate's own tree tag: no digest override and
    // no foreign ref may be injected from the caller.
    expect(gate).not.toContain("image_digest:");
    expect(gate).not.toContain("secrets: inherit");
  });

  it("requires enablement, an isolated route, and this run's pushed image", () => {
    for (const condition of [
      "needs['merge-qualification-plan'].result == 'success'",
      "needs['merge-qualification-plan'].outputs.enabled == 'true'",
      "needs['merge-qualification-plan'].outputs.route == 'isolated'",
      "needs['docker-image'].result == 'success'",
    ]) {
      expect(gate).toContain(condition);
    }
    expect(gate).toContain("needs: [merge-qualification-plan, docker-image]");
  });

  it("negative control: the reused gate fails before smoke on a wrong tag, digest substitution, or missing image", () => {
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

  it("always runs for merge groups so a crashed or skipped upstream still lands a terminal result", () => {
    expect(advisory).toContain("if: always() && github.event_name == 'merge_group'");
    expect(advisory).toContain("needs: [merge-qualification-plan, merge-qualification-gate, docker-image]");
  });

  it("re-evaluates the checked-in policy itself and threads plan/gate/image results into the resolver", () => {
    const publish = step(platformPr, "Publish terminal advisory result");
    expect(publish).toContain("--policy scripts/merge-qualification-policy.json");
    for (const flag of ["--plan-result", "--classifier-class", "--gate-result", "--image-available"]) {
      expect(publish).toContain(flag);
    }
    expect(publish).toContain("GATE_RESULT: ${{ needs['merge-qualification-gate'].result }}");
    expect(publish).toContain("IMAGE_AVAILABLE: ${{ needs['docker-image'].result == 'success' }}");
    expect(publish).toContain("GATE_IMAGE_DIGEST: ${{ needs['merge-qualification-gate'].outputs.image_digest }}");
  });

  it("threads no provider credential: the publisher writes repository-local artifacts only", () => {
    expect(advisory).not.toContain("secrets.");
  });

  it("uploads qualification event records only when the policy is enabled (disabled = no records)", () => {
    const upload = step(platformPr, "Upload merge qualification advisory events");
    expect(upload).toContain("if: needs['merge-qualification-plan'].outputs.enabled == 'true'");
  });
});
