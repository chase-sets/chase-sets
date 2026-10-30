import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Guard for the dedicated PR-preview node pool on the staging DOKS cluster
// (#4745). This file intentionally does not match the change-scope
// deployment-script patterns (scripts/digitalocean-*), so a pool-only
// Terraform PR stays plan-only and never triggers the preview deploy path.
const doksMain = readFileSync(resolve("infrastructure/digitalocean/doks/main.tf"), "utf8");
const doksLocals = readFileSync(resolve("infrastructure/digitalocean/doks/locals.tf"), "utf8");
const doksVariables = readFileSync(resolve("infrastructure/digitalocean/doks/variables.tf"), "utf8");
const doksOutputs = readFileSync(resolve("infrastructure/digitalocean/doks/outputs.tf"), "utf8");
const doksOperationsRunbook = readFileSync(resolve("docs/runbooks/doks-platform-operations.md"), "utf8");

describe("DOKS preview node pool", () => {
  it("provisions a dedicated scale-to-zero preview pool on the staging cluster only", () => {
    expect(doksMain).toContain('resource "digitalocean_kubernetes_node_pool" "preview"');
    expect(doksMain).toContain("count = local.preview_node_pool_enabled ? 1 : 0");
    expect(doksMain).toContain("auto_scale = true");
    expect(doksMain).toContain("min_nodes  = 0");
    expect(doksMain).toContain("max_nodes  = var.preview_node_pool_max_nodes");
    expect(doksMain).toContain('"chase-sets.com/pool"        = "preview"');
    expect(doksLocals).toContain(
      'preview_node_pool_enabled = var.environment == "staging" && var.preview_node_pool_enabled',
    );
    expect(doksVariables).toContain('variable "preview_node_pool_enabled"');
    expect(doksVariables).toContain('variable "preview_node_pool_size"');
    expect(doksVariables).toContain('variable "preview_node_pool_max_nodes"');
    expect(doksVariables).toContain("var.preview_node_pool_max_nodes >= 1 && var.preview_node_pool_max_nodes <= 10");
  });

  it("taints the pool preview-only so staging workloads can never schedule onto it", () => {
    expect(doksLocals).toContain("preview_node_pool_taint = {");
    expect(doksLocals).toContain('key    = "chase-sets.com/preview-only"');
    expect(doksLocals).toContain('value  = "true"');
    expect(doksLocals).toContain('effect = "NoSchedule"');
    expect(doksMain).toContain("key    = local.preview_node_pool_taint.key");
    expect(doksMain).toContain("value  = local.preview_node_pool_taint.value");
    expect(doksMain).toContain("effect = local.preview_node_pool_taint.effect");
  });

  it("exposes the pool posture as evidence and documents the isolation contract", () => {
    expect(doksOutputs).toContain('output "preview_node_pool"');
    expect(doksOutputs).toContain("taint     = local.preview_node_pool_taint");
    expect(doksOperationsRunbook).toContain("## Preview Node Pool");
    expect(doksOperationsRunbook).toContain("chase-sets.com/preview-only=true:NoSchedule");
    expect(doksOperationsRunbook).toContain("`chase-sets.com/pool=preview` nodeSelector");
    expect(doksOperationsRunbook).toContain("min_nodes = 0");
  });

  it("documents interim requests, release isolation, overflow and measured-memory handover", () => {
    const section = doksOperationsRunbook.split("## Preview Node Pool\n")[1].split("### Idle Draft Retirement")[0];
    for (const request of [
      "public-web 1024Mi",
      "marketplace 1152Mi",
      "admin-web 832Mi",
      "platform-api 640Mi",
      "platform-worker 832Mi",
      "preview-postgres 448Mi",
      "platform-bootstrap 1152Mi",
    ]) {
      expect(section).toContain(request);
    }
    for (const behavior of [
      "no CPU requests or limits",
      "cross-namespace, other-release pod anti-affinity",
      "one stack per node",
      "three-stack ceiling",
      "hook-phase requests total 1600Mi",
      "steady-state requests total 4928Mi",
      "A fourth stack stays Pending",
      "postgres does not block Helm",
      "bootstrap Job fails on its `activeDeadlineSeconds: 890`",
      "IgnoredDuringExecution",
      "Pending postgres hook survives rollback",
      "next PR deploy resets its namespace",
      "platform-preview-cleanup.yml -f pr_number=<n>",
      "counts only scheduled pods' committed requests",
      "10752Mi headroom",
      "not a required check",
      "Older BestEffort previews remain first to be evicted",
      "issues/9963",
      "rollback for this interim is a revert",
    ]) {
      expect(section).toContain(behavior);
    }
  });
});
