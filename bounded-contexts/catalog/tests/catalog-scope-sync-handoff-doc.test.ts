import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const contextRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const handoffDocPath = resolve(contextRoot, "docs/catalog-scope-sync-merge-candidate-handoff.md");
const catalogReadmePath = resolve(contextRoot, "README.md");
const acceptanceDocPath = resolve(contextRoot, "docs/catalog-integration-operator-acceptance-journeys.md");

describe("Catalog scope sync merge-candidate handoff", () => {
  const handoffDoc = readFileSync(handoffDocPath, "utf8");

  it("anchors the required milestone scenarios and evidence packet", () => {
    for (const anchor of [
      "Candidate ready path",
      "Candidate conflict path",
      "Split path",
      "Update path",
      "Ignore path",
      "Defer path",
      "Re-sync path",
      "Partial provider failure",
      "Evidence Packet",
      "Closure Gate",
    ]) {
      expect(handoffDoc).toContain(anchor);
    }
  });

  it("documents rollout controls for import, promotion, reapply, emergency stop, and worker stops", () => {
    for (const control of [
      "CATALOG_INTEGRATION_CONTROL_PLANE_MODE=read-only",
      "CATALOG_INTEGRATION_CONTROL_PLANE_MODE=dry-run-only",
      "CATALOG_INTEGRATION_IMPORTS_DISABLED",
      "CATALOG_INTEGRATION_PROMOTION_DISABLED",
      "CATALOG_INTEGRATION_REAPPLY_DISABLED",
      "CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP",
      "CATALOG_INTEGRATION_WORKER_MODE=disabled",
    ]) {
      expect(handoffDoc).toContain(control);
    }
  });

  it("keeps the handoff discoverable from Catalog overview and acceptance docs", () => {
    const catalogReadme = readFileSync(catalogReadmePath, "utf8");
    const acceptanceDoc = readFileSync(acceptanceDocPath, "utf8");

    expect(catalogReadme).toContain("Catalog Scope Sync And Merge Candidate Handoff");
    expect(acceptanceDoc).toContain("Catalog Scope Sync And Merge Candidate Handoff");
  });
});
