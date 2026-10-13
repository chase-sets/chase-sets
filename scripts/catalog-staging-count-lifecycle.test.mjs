import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("isolates capture", () => {
  const source = readFileSync(".github/workflows/catalog-staging-provider-uat.yml", "utf8");
  function assertIsolated(document) {
    const job = document.jobs["scope-sync-count-lifecycle"];
    expect(job).toBeDefined();
    expect(job.permissions).toEqual({ contents: "read", actions: "read" });
    expect(job.if).toContain("inputs.journey_scope == 'scope-sync-count-lifecycle'");
    expect(document.jobs["staging-provider-uat"].if).toContain("inputs.journey_scope != 'scope-sync-count-lifecycle'");
    expect(document.concurrency).toEqual({
      group: "platform-staging-mutating-operations",
      "cancel-in-progress": false,
    });
    const run = job.steps.find((step) => step.id === "capture");
    expect(run.run).toContain("catalog-staging-count-lifecycle");
    const validate = job.steps.find((step) => step.id === "capture-receipt");
    expect(validate.run).toContain("validate");
    const uploads = job.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(uploads).toHaveLength(1);
    expect(uploads[0].if).toContain("steps.capture-receipt.outcome == 'success'");
    expect(uploads[0].with.path).toBe("artifacts/catalog-count-lifecycle/receipt.json");
  }
  it("has a dedicated permission and upload boundary rather than a matrix grant", () => {
    assertIsolated(parse(source));
  });
  it("rejects validation-deleted and discovery/import selector bypass mutants", () => {
    const validationDeleted = parse(source);
    const job = validationDeleted.jobs["scope-sync-count-lifecycle"];
    expect(job).toBeDefined();
    job.steps = job.steps.filter((step) => step.id !== "capture-receipt");
    expect(() => assertIsolated(validationDeleted)).toThrow();
    for (const scope of ["scope-sync-batch-preview-probe", "full-game-start"]) {
      const mutant = parse(source);
      mutant.jobs["scope-sync-count-lifecycle"].if = `inputs.journey_scope == '${scope}'`;
      expect(() => assertIsolated(mutant)).toThrow();
    }
  });
});
