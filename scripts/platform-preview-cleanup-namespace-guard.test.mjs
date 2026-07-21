import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

    expect(result.record.namespaceCandidates).toEqual([{ prNumber: 4777, namespace: "chase-sets-pr-4777" }]);
    expect(result.record.targets).toEqual([]);
    expect(result.matrix.include).toEqual([]);
  });
});
