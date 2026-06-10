import { describe, expect, it } from "vitest";
import {
  CATALOG_CONTROL_PLANE_CONTEXT_KEYS,
  CATALOG_CONTROL_PLANE_CURRENT_CONCEPT_DISPOSITION,
  CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS,
  CATALOG_CONTROL_PLANE_WORKFLOW_MAP,
  CATALOG_CONTROL_PLANE_WORKSPACES,
  catalogControlPlaneWorkspaceByKey,
} from "./information-architecture";

describe("Catalog Control Plane information architecture", () => {
  it("keeps import to promotion as the first navigation target and default workspace", () => {
    expect(CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS[0]).toEqual({
      key: "primary",
      accessibleName: "Primary workflow",
      items: ["import-to-promotion"],
    });

    expect(CATALOG_CONTROL_PLANE_WORKSPACES[0]).toEqual(
      expect.objectContaining({
        key: "import-to-promotion",
        accessibleName: "Import to promotion workbench",
        primaryPathRole: "default",
        keyboardOrder: 10,
      }),
    );

    expect(
      CATALOG_CONTROL_PLANE_WORKSPACES.filter((workspace) => workspace.primaryPathRole === "default"),
    ).toHaveLength(1);
  });

  it("defines stable accessible names and keyboard traversal order for grouped navigation", () => {
    const accessibleNames = new Set(CATALOG_CONTROL_PLANE_WORKSPACES.map((workspace) => workspace.accessibleName));
    expect(accessibleNames.size).toBe(CATALOG_CONTROL_PLANE_WORKSPACES.length);

    const keyboardOrder = CATALOG_CONTROL_PLANE_WORKSPACES.map((workspace) => workspace.keyboardOrder);
    expect(keyboardOrder).toEqual([...keyboardOrder].sort((left, right) => left - right));

    const groupedKeys = CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS.flatMap((group) => group.items);
    expect(groupedKeys).toEqual(CATALOG_CONTROL_PLANE_WORKSPACES.map((workspace) => workspace.key));

    for (const group of CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS) {
      expect(group.accessibleName).not.toHaveLength(0);
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it("requires every supporting workspace to preserve return context to the primary path", () => {
    for (const workspace of CATALOG_CONTROL_PLANE_WORKSPACES) {
      expect(workspace.linkBackContextKeys).toContain("returnPath");
      expect(workspace.linkBackContextKeys).toContain("section");
      expect(workspace.linkBackContextKeys).toContain("providerKey");
      expect(workspace.linkBackContextKeys).toContain("unitKey");
      expect(workspace.consumesIssues.length).toBeGreaterThan(0);
    }

    const primary = catalogControlPlaneWorkspaceByKey("import-to-promotion");
    expect(primary.linkBackContextKeys).toEqual(CATALOG_CONTROL_PLANE_CONTEXT_KEYS);
  });

  it("covers every #1031 workflow without making support workflows equal peers", () => {
    const workflows = CATALOG_CONTROL_PLANE_WORKFLOW_MAP.map((entry) => entry.workflow);

    expect(workflows).toEqual([
      "Primary import-to-promotion path",
      "Health triage",
      "Profile overview, drafting, and section editing",
      "Validation, dry run, compare, and activation readiness",
      "Imports, jobs, Source Observation review, promotion, reapply, replay",
      "Lifecycle, rollout, RBAC, observability, and audit evidence",
    ]);

    for (const workflow of CATALOG_CONTROL_PLANE_WORKFLOW_MAP) {
      expect(workflow.requiredEvidence.length).toBeGreaterThanOrEqual(3);
      if (workflow.startsIn !== "import-to-promotion") {
        expect(workflow.completesIn === "import-to-promotion" || workflow.completesIn === "audit-evidence").toBe(true);
      }
    }
  });

  it("rejects one-to-one migration of the current two-page god-page concepts", () => {
    const oldDestinations = [
      "health",
      "authoring",
      "validation",
      "operations",
      "audit",
      "provider-profile-review",
      "import-and-job-operations",
      "source-observation-review-workflow",
      "promote-and-reapply-workflow",
    ];

    const routeSegments = CATALOG_CONTROL_PLANE_WORKSPACES.map((workspace) => workspace.routeSegment);
    for (const oldDestination of oldDestinations) {
      expect(routeSegments).not.toContain(oldDestination);
    }

    expect(CATALOG_CONTROL_PLANE_CURRENT_CONCEPT_DISPOSITION).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentConcept: "Health, authoring, validation, operations, and audit segmented modules",
          disposition: "delete",
          targetWorkspace: null,
        }),
        expect.objectContaining({
          currentConcept: "/catalog/integrations two-page god page",
          disposition: "rebuild-as-clean-contract",
          targetWorkspace: "import-to-promotion",
        }),
        expect.objectContaining({
          currentConcept: "/catalog/source-observations list/import page",
          disposition: "rebuild-as-clean-contract",
          targetWorkspace: "import-to-promotion",
        }),
      ]),
    );

    for (const disposition of CATALOG_CONTROL_PLANE_CURRENT_CONCEPT_DISPOSITION) {
      expect(disposition.releaseRule).toMatch(/delete|Delete|Do not|Retain the URL only|Retain the URL/);
      expect(disposition.releaseRule).not.toMatch(/fallback|hidden|support-only|shim|alias/);
    }
  });
});
