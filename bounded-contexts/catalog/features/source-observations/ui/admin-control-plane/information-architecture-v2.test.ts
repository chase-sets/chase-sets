import { describe, expect, it } from "vitest";
import {
  CATALOG_CONTROL_PLANE_ACTIONS,
  CATALOG_CONTROL_PLANE_CAPABILITY_MAP,
  CATALOG_CONTROL_PLANE_CONTEXT_KEYS_V2,
  CATALOG_CONTROL_PLANE_ENTITIES,
  CATALOG_CONTROL_PLANE_PAGES,
  CATALOG_CONTROL_PLANE_RETIRED_MACHINERY,
  CATALOG_CONTROL_PLANE_UTILITIES,
  catalogControlPlaneActionByLegacyIntent,
  catalogControlPlaneActionsForEntity,
  catalogControlPlaneEntityByKey,
  catalogControlPlanePageByKey,
  type CatalogControlPlaneCapabilityMapEntry,
  type CatalogControlPlaneEntityKey,
  type CatalogControlPlanePageKey,
} from "./information-architecture-v2";

// Widened view of the const map so the "dropped" disposition branch type-checks
// even while no current entry uses it.
const capabilityMap: readonly CatalogControlPlaneCapabilityMapEntry[] = CATALOG_CONTROL_PLANE_CAPABILITY_MAP;

// The complete inventory of the current (deprecated) form intents this blueprint
// replaces, sourced directly from the four command handlers:
//   daily-command-handler.ts      (16)
//   alias-review-command-handler  (5)
//   provider-setup-command-handler(3)
//   governance-command-handler    (3)
// The 2026-07-03 review estimated ~31; the live handlers carry 27. Every one must
// map to exactly one v2 action.
const CURRENT_FORM_INTENTS = [
  // daily
  "start-catalog-sync",
  "start-provider-import",
  "retry-import-job",
  "resume-import-job",
  "cancel-import-job",
  "preview-promotion",
  "execute-promotion",
  "reject-source-observations",
  "defer-source-observations",
  "promote-merge-candidate",
  "split-merge-candidate",
  "update-merge-candidate",
  "ignore-merge-candidate",
  "defer-merge-candidate",
  "start-reapply",
  "start-replay",
  // alias-review
  "accept",
  "auto-accept",
  "reject",
  "revoke",
  "defer",
  // provider-setup
  "clone-provider-profile",
  "activate-provider-profile",
  "update-provider-profile-section",
  // governance
  "rollback-provider-profile",
  "deprecate-provider-profile",
  "retire-provider-profile",
] as const;

const EIGHT_DEPRECATED_WORKSPACES = [
  "import-to-promotion",
  "health-triage",
  "profile-authoring",
  "validation-readiness",
  "conflict-resolution",
  "lifecycle-recovery",
  "governance-controls",
  "audit-evidence",
] as const;

describe("Catalog Control Plane v2 — three pages + two utilities", () => {
  it("declares exactly three journey pages plus a settings page", () => {
    const pageKeys = CATALOG_CONTROL_PLANE_PAGES.map((page) => page.key);
    expect(pageKeys).toEqual(["catalog-home", "scope-detail", "provider-detail", "settings"]);
  });

  it("keeps catalog-home as the base route with the attention queue", () => {
    const home = catalogControlPlanePageByKey("catalog-home");
    expect(home.pathSegment).toBe("");
    expect(home.hasAttentionQueue).toBe(true);
  });

  it("provides a settings page utility and an evidence drawer utility", () => {
    const utilityKeys = CATALOG_CONTROL_PLANE_UTILITIES.map((utility) => utility.key);
    expect([...utilityKeys].sort()).toEqual(["evidence", "settings"]);

    const evidence = CATALOG_CONTROL_PLANE_UTILITIES.find((utility) => utility.key === "evidence");
    expect(evidence?.kind).toBe("drawer");
    // A drawer has no route of its own — it opens over the current page.
    expect(evidence?.pathSegment).toBe("");

    const settings = CATALOG_CONTROL_PLANE_UTILITIES.find((utility) => utility.key === "settings");
    expect(settings?.kind).toBe("page");
    expect(settings?.pathSegment).toBe("settings");
  });

  it("gives every page a stable accessible name and operator purpose", () => {
    const names = new Set(CATALOG_CONTROL_PLANE_PAGES.map((page) => page.accessibleName));
    expect(names.size).toBe(CATALOG_CONTROL_PLANE_PAGES.length);
    for (const page of CATALOG_CONTROL_PLANE_PAGES) {
      expect(page.accessibleName.length).toBeGreaterThan(0);
      expect(page.purpose.length).toBeGreaterThan(0);
    }
  });
});

describe("Catalog Control Plane v2 — entities own their journey", () => {
  it("routes every entity to exactly one home page", () => {
    for (const entity of CATALOG_CONTROL_PLANE_ENTITIES) {
      const home = catalogControlPlanePageByKey(entity.homePage);
      expect(home.ownsEntities).toContain(entity.key);
    }
  });

  it("attaches at least one action to every entity, and every action to a known entity", () => {
    const entityKeys = new Set<CatalogControlPlaneEntityKey>(CATALOG_CONTROL_PLANE_ENTITIES.map((e) => e.key));
    for (const entity of CATALOG_CONTROL_PLANE_ENTITIES) {
      expect(catalogControlPlaneActionsForEntity(entity.key).length).toBeGreaterThan(0);
    }
    for (const action of CATALOG_CONTROL_PLANE_ACTIONS) {
      expect(entityKeys.has(action.entity)).toBe(true);
    }
  });

  it("names every action id as `${entity}.${verb}` and keeps ids unique", () => {
    const ids = CATALOG_CONTROL_PLANE_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const action of CATALOG_CONTROL_PLANE_ACTIONS) {
      expect(action.id.startsWith(`${action.entity}.`)).toBe(true);
    }
  });
});

describe("Catalog Control Plane v2 — action vocabulary carries entity, permission, feedback", () => {
  it("gives every action an entity, a permission, a feedback shape, and a disclosure", () => {
    for (const action of CATALOG_CONTROL_PLANE_ACTIONS) {
      expect(action.entity.length).toBeGreaterThan(0);
      expect(["catalog.view", "catalog.manage"]).toContain(action.permission);
      expect(["status-banner", "row-transition", "preview-panel", "confirmation-gate", "job-progress"]).toContain(
        action.feedbackShape,
      );
      expect(["inline", "drawer", "page"]).toContain(action.disclosure);
      expect(action.label.length).toBeGreaterThan(0);
    }
  });

  it("gates every state-changing action behind catalog.manage", () => {
    for (const action of CATALOG_CONTROL_PLANE_ACTIONS) {
      // Every action here mutates Catalog integration state, so all are manage-gated.
      expect(action.permission).toBe("catalog.manage");
    }
  });

  it("requires a confirmation gate on every destructive action and reports it as such", () => {
    for (const action of CATALOG_CONTROL_PLANE_ACTIONS) {
      if (action.requiresConfirmation) {
        expect(["confirmation-gate", "preview-panel"]).toContain(action.feedbackShape);
      }
    }
    // Provider-profile lifecycle transitions and job cancel confirm before running.
    for (const id of [
      "provider-profile.activate",
      "provider-profile.rollback",
      "provider-profile.deprecate",
      "provider-profile.retire",
      "job.cancel",
    ]) {
      const action = CATALOG_CONTROL_PLANE_ACTIONS.find((candidate) => candidate.id === id);
      expect(action?.requiresConfirmation).toBe(true);
      expect(action?.feedbackShape).toBe("confirmation-gate");
    }
  });

  it("keeps the typed preview panel for promotion and candidate edits (no stale raw JSON)", () => {
    for (const id of ["observation.promote", "candidate.edit", "candidate.split"]) {
      const action = CATALOG_CONTROL_PLANE_ACTIONS.find((candidate) => candidate.id === id);
      expect(action?.feedbackShape).toBe("preview-panel");
    }
  });
});

describe("Catalog Control Plane v2 — every current intent maps to exactly one action", () => {
  it("covers all 27 current form intents with no orphans", () => {
    for (const intent of CURRENT_FORM_INTENTS) {
      const action = catalogControlPlaneActionByLegacyIntent(intent);
      expect(action, `intent ${intent} has no v2 action`).toBeDefined();
    }
  });

  it("maps each intent to exactly one action (no intent claimed twice)", () => {
    for (const intent of CURRENT_FORM_INTENTS) {
      const matches = CATALOG_CONTROL_PLANE_ACTIONS.filter((action) =>
        (action.replacesIntents as readonly string[]).includes(intent),
      );
      expect(matches, `intent ${intent} is claimed ${matches.length} times`).toHaveLength(1);
    }
  });

  it("never references a form intent outside the known current inventory", () => {
    const known = new Set<string>(CURRENT_FORM_INTENTS);
    for (const action of CATALOG_CONTROL_PLANE_ACTIONS) {
      for (const intent of action.replacesIntents) {
        expect(known.has(intent), `action ${action.id} maps unknown intent ${intent}`).toBe(true);
      }
    }
  });
});

describe("Catalog Control Plane v2 — capability map covers all eight workspaces", () => {
  it("maps every deprecated workspace to a new home or an explicit drop", () => {
    const mapped = capabilityMap.map((entry) => entry.workspace);
    expect([...mapped].sort()).toEqual([...EIGHT_DEPRECATED_WORKSPACES].sort());
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it("gives a concrete home to every non-dropped workspace and a reason to every entry", () => {
    const pageKeys = new Set<string>(CATALOG_CONTROL_PLANE_PAGES.map((page) => page.key));
    const utilityKeys = new Set<string>(CATALOG_CONTROL_PLANE_UTILITIES.map((utility) => utility.key));
    for (const entry of capabilityMap) {
      expect(entry.rationale.length).toBeGreaterThan(0);
      if (entry.disposition === "dropped") {
        expect(entry.newHome).toBeNull();
      } else {
        expect(entry.newHome, `${entry.workspace} needs a home`).not.toBeNull();
        expect(pageKeys.has(entry.newHome as string) || utilityKeys.has(entry.newHome as string)).toBe(true);
      }
    }
  });
});

describe("Catalog Control Plane v2 — detours and the workspace router are gone", () => {
  it("excludes returnPath, section, and the detour context keys from the v2 context", () => {
    for (const forbidden of ["returnPath", "section", "importScope", "promotionPreviewId", "selectedObservationIds"]) {
      expect(CATALOG_CONTROL_PLANE_CONTEXT_KEYS_V2 as readonly string[]).not.toContain(forbidden);
    }
    // Selection is durable page state; the surviving keys are entity references.
    expect([...CATALOG_CONTROL_PLANE_CONTEXT_KEYS_V2].sort()).toEqual(
      [
        "candidateId",
        "evidenceRef",
        "jobId",
        "observationSelection",
        "profileVersion",
        "providerKey",
        "scopeId",
      ].sort(),
    );
  });

  it("resolves every blocker inline or in a drawer — never by navigating to another page", () => {
    // A blocker-resolving action is any state-changing action; none may require a
    // page-level detour to complete. `page` disclosure is reserved for forward
    // navigation into an entity's own detail, which no action uses.
    for (const action of CATALOG_CONTROL_PLANE_ACTIONS) {
      expect(["inline", "drawer"]).toContain(action.disclosure);
    }
  });

  it("records the retired detour machinery with reasons", () => {
    const retired = CATALOG_CONTROL_PLANE_RETIRED_MACHINERY.map((entry) => entry.capability);
    expect(retired).toContain("returnPath propagation");
    expect(retired).toContain("?section= workspace router");
    for (const entry of CATALOG_CONTROL_PLANE_RETIRED_MACHINERY) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("throws for unknown page and entity keys through the lookups", () => {
    expect(() => catalogControlPlanePageByKey("nope" as CatalogControlPlanePageKey)).toThrow();
    expect(() => catalogControlPlaneEntityByKey("nope" as CatalogControlPlaneEntityKey)).toThrow();
  });
});
