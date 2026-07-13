// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  CATALOG_CONTROL_PLANE_CONTEXT_KEYS,
  CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS,
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
    }

    const primary = catalogControlPlaneWorkspaceByKey("import-to-promotion");
    expect(primary.linkBackContextKeys).toEqual(CATALOG_CONTROL_PLANE_CONTEXT_KEYS);
  });

  it("describes each workspace as an operator job with start and completion states", () => {
    for (const workspace of CATALOG_CONTROL_PLANE_WORKSPACES) {
      expect(workspace.operatorJob.length).toBeGreaterThan(0);
      expect(workspace.startsAt.length).toBeGreaterThan(0);
      expect(workspace.completesAt.length).toBeGreaterThan(0);
      expect(workspace.evidenceScope.length).toBeGreaterThan(0);
    }
  });

  it("covers every operator workflow without making support workflows equal peers", () => {
    const workflows = CATALOG_CONTROL_PLANE_WORKFLOW_MAP.map((entry) => entry.workflow);

    // #3832: profile authoring / validation readiness / lifecycle recovery are
    // no longer ?section= workspaces on this deprecated IA — they are the v2
    // Provider detail page's own linear draft -> validate -> activate flow
    // (information-architecture-v2.ts), so those two workflow entries retire
    // along with their workspace keys.
    expect(workflows).toEqual([
      "Primary import-to-promotion path",
      "Health triage",
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

  it("keeps retired top-level section names out of the operator route segments", () => {
    const oldDestinations = [
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
  });

  it("carries no project-management metadata on workspace entries", () => {
    for (const workspace of CATALOG_CONTROL_PLANE_WORKSPACES) {
      // The IA is an operator read model, not a launch tracker: no issue-number
      // arrays or release-tracking fields may reappear on a workspace entry.
      expect(workspace).not.toHaveProperty("consumesIssues");
      expect(workspace).not.toHaveProperty("ownerIssue");
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

  it("resolves every supportTarget in primary-workbench-copy to a renderable destination or the v2 Provider detail page", () => {
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

    // #3832: profile-authoring, validation-readiness, and lifecycle-recovery are
    // still valid supportTarget values (the copy still needs to say "this blocker
    // is a profile problem"), but they no longer resolve to a renderer in this
    // deprecated IA — WorkspaceBlockerPanel deep-links them straight to the v2
    // Provider detail page (see workbench-formatting.tsx's
    // PROVIDER_DETAIL_SUPPORT_TARGETS) instead of a ?section= workspace.
    const providerDetailSupportTargets = new Set(["profile-authoring", "validation-readiness", "lifecycle-recovery"]);

    expect(supportTargets.size).toBeGreaterThan(0);
    const unresolved = [...supportTargets].filter(
      (target) =>
        !providerDetailSupportTargets.has(target) && !rendererKeys.has(target as CatalogControlPlaneWorkspaceKey),
    );
    expect(unresolved).toEqual([]);
  });

  it("no longer exposes the retired adapter-readiness destination", () => {
    expect(workspaceKeys.has("adapter-readiness")).toBe(false);
    expect(rendererKeys.has("adapter-readiness")).toBe(false);
  });

  // #1749: the single-route section-switching shell is fully retired. No workspace
  // key, renderer key, route segment, or nav item may reintroduce a legacy/compat
  // token or one of the retired top-level section names. This fails closed if the
  // dead ?section= top-level switcher (or an alias for it) reappears anywhere in the
  // IA that the live surface routes render from.
  it("rejects retired and legacy tokens in every IA key, route segment, and nav item", () => {
    const retiredPattern = /legacy|compat|raw-json|adapter-readiness|section-switch|two-page|god-page/i;
    // The retired single page switched between these top-level destinations via
    // ?section=; they are not workspace keys in the rebuilt IA and must never return.
    // ("health" is intentionally absent: it is now the live Integration Health
    // surface's real route path segment (#1893), not the dead ?section=health page.)
    const retiredTopLevelSections = new Set([
      "authoring",
      "validation",
      "operations",
      "audit",
      "provider-profile-review",
      "import-and-job-operations",
      "source-observation-review-workflow",
      "promote-and-reapply-workflow",
      "adapter-readiness",
    ]);

    const candidateTokens = [
      ...CATALOG_CONTROL_PLANE_WORKSPACES.flatMap((workspace) => [workspace.key, workspace.routeSegment]),
      ...rendererKeys,
      ...CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS.flatMap((group) => group.items),
      ...CATALOG_CONTROL_PLANE_ROUTE_SURFACES.flatMap((surface) => [surface.pathSegment, ...surface.workspaces]),
    ];

    for (const token of candidateTokens) {
      expect(retiredPattern.test(token), `${token} matches a retired/legacy token`).toBe(false);
      expect(retiredTopLevelSections.has(token), `${token} is a retired top-level section name`).toBe(false);
    }
  });
});

describe("Catalog Control Plane route surfaces", () => {
  const rendererKeys = new Set<string>(Object.keys(CATALOG_PRIMARY_WORKBENCH_WORKSPACE_RENDERERS));

  it("describes the three remaining audience surface routes after #3832 retires the providers surface", () => {
    expect(CATALOG_CONTROL_PLANE_ROUTE_SURFACES.map((surface) => [surface.key, surface.pathSegment])).toEqual([
      ["daily", ""],
      ["governance", "governance"],
      ["health", "health"],
    ]);

    const surfaceWorkspaces = Object.fromEntries(
      CATALOG_CONTROL_PLANE_ROUTE_SURFACES.map((surface) => [surface.key, surface.workspaces]),
    );
    expect(surfaceWorkspaces.daily).toEqual(["import-to-promotion"]);
    expect(surfaceWorkspaces.governance).toEqual(["governance-controls"]);
    expect(surfaceWorkspaces.health).toEqual(["audit-evidence", "health-triage"]);
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
