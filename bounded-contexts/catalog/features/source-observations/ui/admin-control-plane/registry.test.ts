import { describe, expect, it } from "vitest";
import { CATALOG_INTEGRATION_MODULE_AREAS, CATALOG_INTEGRATION_WORKFLOW_MODULES, moduleAreaLabel } from "./registry";

describe("Catalog integration admin control-plane registry", () => {
  it("declares the supported module areas in shell order", () => {
    expect(CATALOG_INTEGRATION_MODULE_AREAS.map((area) => area.value)).toEqual([
      "health",
      "authoring",
      "validation",
      "operations",
      "audit",
    ]);
    expect(moduleAreaLabel("operations")).toBe("Operations");
  });

  it("maps issue 763 workflow responsibilities to named modules", () => {
    expect(CATALOG_INTEGRATION_WORKFLOW_MODULES.map((module) => module.key)).toEqual([
      "admin-control-plane-shell",
      "integration-health-dashboard",
      "profile-workspace",
      "profile-list",
      "profile-lifecycle-actions",
      "section-editors",
      "fixture-validation-workbench",
      "dry-run-workbench",
      "profile-compare-panel",
      "readiness-workflow",
      "import-workbench",
      "job-monitor-drawer",
      "source-observation-review-workbench",
      "promotion-reapply-workflows",
      "adapter-readiness-panel",
      "integration-audit-log",
      "rollback-retirement-workflow",
    ]);
    expect(new Set(CATALOG_INTEGRATION_WORKFLOW_MODULES.map((module) => module.area))).toEqual(
      new Set(["health", "authoring", "validation", "operations", "audit"]),
    );
    expect(CATALOG_INTEGRATION_WORKFLOW_MODULES.filter((module) => module.status === "planned-child-issue")).toEqual([
      expect.objectContaining({ key: "section-editors", childIssue: 765 }),
    ]);
    expect(CATALOG_INTEGRATION_WORKFLOW_MODULES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "source-observation-review-workbench",
          childIssue: 779,
          status: "implemented",
        }),
      ]),
    );
  });
});
