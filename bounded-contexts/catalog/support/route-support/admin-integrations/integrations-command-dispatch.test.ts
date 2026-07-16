import { describe, expect, it } from "vitest";
import {
  catalogControlPlaneActionForIntent,
  catalogControlPlaneCommandRouteForAction,
} from "./integrations-command-dispatch";
import { CATALOG_CONTROL_PLANE_ACTIONS } from "../../../features/source-observations/ui/admin-control-plane/information-architecture-v2";

// The dispatcher is the single result-routing point for the Catalog control
// plane: every submitted `_intent` is resolved to its Catalog Control Plane v2
// action — the reduced per-entity `${entity}.${verb}` vocabulary — before any
// entity handler runs. An intent outside that vocabulary is rejected as
// `invalid-intent` before it reaches a handler.
describe("Catalog integrations command dispatcher — v2 action resolution", () => {
  it("routes every action id directly with no compatibility translation", () => {
    for (const action of CATALOG_CONTROL_PLANE_ACTIONS) {
      expect(catalogControlPlaneActionForIntent(action.id)).toBe(action);
      expect(catalogControlPlaneCommandRouteForAction(action.id)).toBe(action.entity);
    }
  });

  it("rejects every retired wire intent", () => {
    const retiredIntents = [
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
      "clone-provider-profile",
      "activate-provider-profile",
      "update-provider-profile-section",
      "rollback-provider-profile",
      "deprecate-provider-profile",
      "retire-provider-profile",
    ];

    for (const intent of retiredIntents) {
      expect(catalogControlPlaneActionForIntent(intent), `retired intent ${intent} should be rejected`).toBeUndefined();
    }
  });

  it("rejects intents outside the blueprint vocabulary entirely", () => {
    for (const intent of ["", "not-a-real-intent", "select-provider-scope", "view-source-observation"]) {
      expect(catalogControlPlaneActionForIntent(intent)).toBeUndefined();
    }
  });

  it("every route-reachable v2 action id is unique and entity-scoped (`${entity}.${verb}`)", () => {
    const ids = CATALOG_CONTROL_PLANE_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const action of CATALOG_CONTROL_PLANE_ACTIONS) {
      expect(action.id.startsWith(`${action.entity}.`)).toBe(true);
    }
  });
});
