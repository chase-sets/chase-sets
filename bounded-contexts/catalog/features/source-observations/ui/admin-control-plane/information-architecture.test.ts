import { describe, expect, it } from "vitest";
import {
  CATALOG_CONTROL_PLANE_CONTEXT_KEYS,
  CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS,
  CATALOG_CONTROL_PLANE_REBUILD_RELEASE_RULES,
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

  it("defines launch release rules without preserving retired page concepts", () => {
    const oldDestinations = [
      "health",
      "authoring",
      "validation",
      "operations",
      "audit",
      ["provider", "profile", "review"].join("-"),
      ["import", "and", "job", "operations"].join("-"),
      ["source", "observation", "review", "workflow"].join("-"),
      ["promote", "and", "reapply", "workflow"].join("-"),
    ];

    const routeSegments = CATALOG_CONTROL_PLANE_WORKSPACES.map((workspace) => workspace.routeSegment);
    for (const oldDestination of oldDestinations) {
      expect(routeSegments).not.toContain(oldDestination);
    }

    expect(CATALOG_CONTROL_PLANE_REBUILD_RELEASE_RULES.map((rule) => rule.key)).toEqual([
      "single-primary-workbench",
      "support-detours",
      "complete-retirement",
    ]);

    const serializedRules = JSON.stringify(CATALOG_CONTROL_PLANE_REBUILD_RELEASE_RULES);
    expect(serializedRules).toContain("removed from code");
    for (const forbidden of [
      "fallback",
      "hidden",
      "support-only",
      "shim",
      "alias",
      ["two", "page"].join("-"),
      ["god", "page"].join(" "),
      ["list", "import"].join("/"),
    ]) {
      expect(serializedRules).not.toContain(forbidden);
    }
    for (const rule of CATALOG_CONTROL_PLANE_REBUILD_RELEASE_RULES) {
      expect(rule.rule).not.toHaveLength(0);
      expect(rule.verification).not.toHaveLength(0);
    }
  });
});
