import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { repoRoot } from "./lib/repo.mjs";

const workflowPath = `${repoRoot}/.github/workflows/platform-preview-cleanup.yml`;
const sweepPath = `${repoRoot}/scripts/digitalocean-preview-cleanup-sweep.mjs`;

describe("scheduled preview cleanup batching", () => {
  it("uses artifact-backed batch matrix entries and keeps the close-event matrix", () => {
    const source = readFileSync(workflowPath, "utf8");
    const workflow = parse(source);
    const discover = workflow.jobs["discover-preview-cleanup"];
    const destroy = workflow.jobs["destroy-preview"];
    expect(discover.outputs.matrix).toBe("${{ steps.targets.outputs.matrix }}");
    expect(destroy.strategy.matrix).toBe("${{ fromJSON(needs.discover-preview-cleanup.outputs.matrix) }}");
    expect(source).toContain("name: Download scheduled cleanup discovery artifact");
    expect(source).toContain("platform-preview-cleanup-sweep-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(source).toContain("record.batches?.find((candidate) => candidate.index === batchIndex)");
    expect(source).toContain("batch.targets.map((target)=>target.prNumber)");
    expect(source).toContain("while IFS= read -r pr_number");
    expect(source).toContain('--pr-number "$pr_number"');
    expect(source).toContain("--timeout 5m || failed=1");
    expect(source).toContain("terraform destroy -auto-approve || failed=1");
    expect(source).toContain('--namespace "chase-sets-pr-${{ matrix.pr_number }}"');
    expect(source).toContain('--release "chase-sets-pr-${{ matrix.pr_number }}"');
    expect(source).toContain("PREVIEW_BATCH_FAILED=1");
    expect(source).not.toContain("targets: batch.targets");
  });

  it("records bounded batches without embedding targets in the scheduled matrix", () => {
    const source = readFileSync(sweepPath, "utf8");
    expect(source).toContain("PREVIEW_CLEANUP_BATCH_SIZE = 256");
    expect(source).toContain("PREVIEW_CLEANUP_LOOKUP_WORKERS = 8");
    expect(source).toContain("record.batches = cleanupBatchesForTargets(record.targets, record.batchSize)");
    expect(source).toContain("matrix: cleanupMatrixForBatches(record.batches");
    expect(source).toContain("record.targets.length > 0");
    expect(source).toContain('"empty"');
  });
});
