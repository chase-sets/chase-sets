// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  CATALOG_CONTROL_PLANE_CONTEXT_KEYS,
  CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS,
  CATALOG_CONTROL_PLANE_REBUILD_RELEASE_RULES,
  CATALOG_CONTROL_PLANE_ROUTE_SURFACES,
  CATALOG_CONTROL_PLANE_WORKFLOW_MAP,
  CATALOG_CONTROL_PLANE_WORKSPACES,
  catalogControlPlaneRouteSurfaceForWorkspace,
  catalogControlPlaneWorkspaceByKey,
  type CatalogControlPlaneWorkspaceKey,
} from "./information-architecture";
import { CATALOG_PRIMARY_WORKBENCH_WORKSPACE_RENDERERS } from "../workbench-workspace-renderers";
import {
  catalogPrimaryWorkbenchActionStateCopy,
  catalogPrimaryWorkbenchBlockerCopy,
  catalogPrimaryWorkbenchCompletionCopy,
  catalogPrimaryWorkbenchCopyMessages,
  catalogPrimaryWorkbenchEmptyStateCopy,
  catalogPrimaryWorkbenchProviderTransportCopy,
  catalogPrimaryWorkbenchResilienceCopy,
  type CatalogPrimaryWorkbenchOperatorCopy,
} from "../primary-workbench-copy";

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
      "Conflict resolution and source precedence",
      "Clean reset, backfill, and release evidence",
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
    expect(serializedRules).toContain("Retire means complete removal");
    expect(serializedRules).toContain("all retired code");
    expect(serializedRules).toContain("product patterns");
    expect(serializedRules).toContain("documentation");
    expect(serializedRules).toContain("operator instructions");
    expect(serializedRules).toContain("compatibility shims");
    for (const forbidden of [["two", "page"].join("-"), ["god", "page"].join(" "), ["list", "import"].join("/")]) {
      expect(serializedRules).not.toContain(forbidden);
    }
    for (const rule of CATALOG_CONTROL_PLANE_REBUILD_RELEASE_RULES) {
      expect(rule.rule).not.toHaveLength(0);
      expect(rule.verification).not.toHaveLength(0);
    }
  });
});

describe("Catalog Control Plane IA <-> render parity", () => {
  const workspaceKeys = new Set<string>(CATALOG_CONTROL_PLANE_WORKSPACES.map((workspace) => workspace.key));
  const rendererKeys = new Set<string>(Object.keys(CATALOG_PRIMARY_WORKBENCH_WORKSPACE_RENDERERS));

  it("renders every declared IA workspace (no declared-but-unrendered section)", () => {
    const declaredWithoutRenderer = [...workspaceKeys].filter((key) => !rendererKeys.has(key));
    expect(declaredWithoutRenderer).toEqual([]);
  });

  it("declares every rendered workspace in the IA (no render branch without an IA entry)", () => {
    const renderedWithoutDeclaration = [...rendererKeys].filter((key) => !workspaceKeys.has(key));
    expect(renderedWithoutDeclaration).toEqual([]);
  });

  it("backs every navigation-group item with a renderable workspace", () => {
    const navigationItems = CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS.flatMap((group) => group.items);
    for (const item of navigationItems) {
      expect(workspaceKeys.has(item), `nav item ${item} is not a declared workspace`).toBe(true);
      expect(rendererKeys.has(item), `nav item ${item} has no render branch`).toBe(true);
    }
  });

  it("resolves every supportTarget in primary-workbench-copy to a renderable destination", () => {
    const copyCollections: readonly Record<string, CatalogPrimaryWorkbenchOperatorCopy>[] = [
      catalogPrimaryWorkbenchCopyMessages,
      catalogPrimaryWorkbenchProviderTransportCopy,
      catalogPrimaryWorkbenchBlockerCopy,
      catalogPrimaryWorkbenchActionStateCopy,
      catalogPrimaryWorkbenchEmptyStateCopy,
      catalogPrimaryWorkbenchResilienceCopy,
      catalogPrimaryWorkbenchCompletionCopy,
    ];

    const supportTargets = new Set(
      copyCollections.flatMap((collection) => Object.values(collection).map((entry) => entry.supportTarget)),
    );

    expect(supportTargets.size).toBeGreaterThan(0);
    const unresolved = [...supportTargets].filter(
      (target) => !rendererKeys.has(target as CatalogControlPlaneWorkspaceKey),
    );
    expect(unresolved).toEqual([]);
  });

  it("no longer exposes the retired adapter-readiness destination", () => {
    expect(workspaceKeys.has("adapter-readiness")).toBe(false);
    expect(rendererKeys.has("adapter-readiness")).toBe(false);
  });
});

describe("Catalog Control Plane route surfaces", () => {
  const rendererKeys = new Set<string>(Object.keys(CATALOG_PRIMARY_WORKBENCH_WORKSPACE_RENDERERS));

  it("describes the four audience surface routes from the epic #1737 target IA", () => {
    expect(CATALOG_CONTROL_PLANE_ROUTE_SURFACES.map((surface) => [surface.key, surface.pathSegment])).toEqual([
      ["daily", ""],
      ["providers", "providers"],
      ["governance", "governance"],
      ["release", "release"],
    ]);

    const surfaceWorkspaces = Object.fromEntries(
      CATALOG_CONTROL_PLANE_ROUTE_SURFACES.map((surface) => [surface.key, surface.workspaces]),
    );
    expect(surfaceWorkspaces.daily).toEqual(["import-to-promotion"]);
    expect(surfaceWorkspaces.providers).toEqual(["profile-authoring", "validation-readiness"]);
    expect(surfaceWorkspaces.governance).toEqual(["conflict-resolution", "lifecycle-recovery", "governance-controls"]);
    expect(surfaceWorkspaces.release).toEqual(["clean-reset-release", "audit-evidence", "health-triage"]);
  });

  it("assigns every workspace to exactly one surface and renders every surface workspace", () => {
    const surfaceWorkspaceKeys = CATALOG_CONTROL_PLANE_ROUTE_SURFACES.flatMap((surface) => surface.workspaces);

    // Each declared workspace appears on exactly one surface.
    expect([...surfaceWorkspaceKeys].sort()).toEqual(
      [...CATALOG_CONTROL_PLANE_WORKSPACES.map((workspace) => workspace.key)].sort(),
    );
    expect(new Set(surfaceWorkspaceKeys).size).toBe(surfaceWorkspaceKeys.length);

    // Every workspace on a surface is renderable, and its IA routeSurface field
    // agrees with the surface that lists it.
    for (const surface of CATALOG_CONTROL_PLANE_ROUTE_SURFACES) {
      for (const workspaceKey of surface.workspaces) {
        expect(rendererKeys.has(workspaceKey), `surface workspace ${workspaceKey} has no render branch`).toBe(true);
        expect(catalogControlPlaneRouteSurfaceForWorkspace(workspaceKey).key).toBe(surface.key);
      }
    }
  });

  it("keeps the daily surface as the default import-to-promotion route", () => {
    const daily = CATALOG_CONTROL_PLANE_ROUTE_SURFACES[0];
    expect(daily.key).toBe("daily");
    expect(daily.pathSegment).toBe("");
    expect(daily.workspaces[0]).toBe("import-to-promotion");
    expect(catalogControlPlaneWorkspaceByKey("import-to-promotion").routeSurface).toBe("daily");
  });
});
