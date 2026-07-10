import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Guard the non-destructive staging capacity path for #4756. Changing the
// default node_pool size on digitalocean_kubernetes_cluster.platform would
// replace the whole cluster, so runtime-xl must remain a separate resource.
const doksMain = readFileSync(resolve("infrastructure/digitalocean/doks/main.tf"), "utf8");
const doksLocals = readFileSync(resolve("infrastructure/digitalocean/doks/locals.tf"), "utf8");
const doksVariables = readFileSync(resolve("infrastructure/digitalocean/doks/variables.tf"), "utf8");
const doksOutputs = readFileSync(resolve("infrastructure/digitalocean/doks/outputs.tf"), "utf8");
const doksReadme = readFileSync(resolve("infrastructure/digitalocean/doks/README.md"), "utf8");
const doksOperationsRunbook = readFileSync(resolve("docs/runbooks/doks-platform-operations.md"), "utf8");

const runtimeXlStart = doksMain.indexOf('resource "digitalocean_kubernetes_node_pool" "runtime_xl"');
const runtimeXlEnd = doksMain.indexOf("# Dedicated PR-preview node pool", runtimeXlStart);
const runtimeXlResource = doksMain.slice(runtimeXlStart, runtimeXlEnd);

describe("DOKS runtime-xl node pool", () => {
  it("adds dedicated staging capacity without changing the default pool", () => {
    expect(doksMain).toContain("size       = var.runtime_node_pool_size");
    expect(runtimeXlStart).toBeGreaterThan(-1);
    expect(runtimeXlResource).toContain("count = local.runtime_xl_node_pool_enabled ? 1 : 0");
    expect(runtimeXlResource).toContain('name       = "runtime-xl"');
    expect(runtimeXlResource).toContain("size       = var.runtime_xl_node_pool_size");
    expect(runtimeXlResource).toContain("auto_scale = false");
    expect(runtimeXlResource).toContain("node_count = 1");
    expect(doksLocals).toContain(
      'runtime_xl_node_pool_enabled = var.environment == "staging" && var.runtime_xl_node_pool_enabled',
    );
    expect(doksVariables).toContain('variable "runtime_xl_node_pool_enabled"');
    expect(doksVariables).toContain('variable "runtime_xl_node_pool_size"');
    expect(doksVariables).toContain('default     = "s-4vcpu-8gb"');
  });

  it("lets platform workloads schedule freely on the larger pool", () => {
    expect(runtimeXlResource).toContain('"chase-sets.com/pool"        = "runtime-xl"');
    expect(runtimeXlResource).not.toContain("taint");
  });

  it("exposes and documents the migration posture", () => {
    expect(doksOutputs).toContain('output "runtime_xl_node_pool"');
    expect(doksOutputs).toContain('pool_label = "chase-sets.com/pool=runtime-xl"');
    expect(doksReadme).toContain("does not replace the cluster");
    expect(doksOperationsRunbook).toContain("## Runtime XL Node Pool");
    expect(doksOperationsRunbook).toContain("cordon and drain");
    expect(doksOperationsRunbook).toContain("Terraform intentionally does not automate this drain");
  });
});
