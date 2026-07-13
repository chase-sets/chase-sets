import { describe, expect, it } from "vitest";
import { catalogControlPlaneActionForIntent } from "./integrations-command-dispatch";
import { CATALOG_CONTROL_PLANE_ACTIONS } from "../../../features/source-observations/ui/admin-control-plane/information-architecture-v2";

// The dispatcher is the single result-routing point for the Catalog control
// plane: every submitted `_intent` is resolved to its Catalog Control Plane v2
// action — the reduced per-entity `${entity}.${verb}` vocabulary — before any
// surface handler runs. An intent outside that vocabulary is rejected as
// `invalid-intent` before it reaches a handler (see
// `dispatchIntegrationsCommand`'s use of `catalogControlPlaneActionByLegacyIntent`).
describe("Catalog integrations command dispatcher — v2 action resolution", () => {
  it("resolves every legacy intent every current handler recognizes to exactly one v2 action", () => {
    const legacyIntents = [
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
      "alias.accept",
      "alias.reject",
      "alias.revoke",
      "alias.defer",
      "clone-provider-profile",
      "activate-provider-profile",
      "update-provider-profile-section",
      "rollback-provider-profile",
      "deprecate-provider-profile",
      "retire-provider-profile",
    ];

    for (const intent of legacyIntents) {
      const action = catalogControlPlaneActionForIntent(intent);
      expect(action, `intent ${intent} should resolve to a v2 action`).toBeDefined();
    }
  });

  it("rejects intents outside the blueprint vocabulary entirely", () => {
    for (const intent of ["", "not-a-real-intent", "select-provider-scope", "view-source-observation"]) {
      expect(catalogControlPlaneActionForIntent(intent)).toBeUndefined();
    }
  });

  it("resolves an already-migrated v2 action id submitted directly on the wire (alias-review's surface)", () => {
    for (const id of ["alias.accept", "alias.reject", "alias.revoke", "alias.defer"]) {
      expect(catalogControlPlaneActionForIntent(id)?.id).toBe(id);
    }
  });

  it("collapses preview-promotion and execute-promotion onto one observation.promote action", () => {
    expect(catalogControlPlaneActionForIntent("preview-promotion")?.id).toBe("observation.promote");
    expect(catalogControlPlaneActionForIntent("execute-promotion")?.id).toBe("observation.promote");
  });

  it("collapses the alias accept vocabulary onto one alias.accept action", () => {
    expect(catalogControlPlaneActionForIntent("alias.accept")?.id).toBe("alias.accept");
  });

  it("every route-reachable v2 action id is unique and entity-scoped (`${entity}.${verb}`)", () => {
    const ids = CATALOG_CONTROL_PLANE_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const action of CATALOG_CONTROL_PLANE_ACTIONS) {
      expect(action.id.startsWith(`${action.entity}.`)).toBe(true);
    }
  });
});
