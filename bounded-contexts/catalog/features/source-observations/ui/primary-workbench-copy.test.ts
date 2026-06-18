import { t } from "@chase-sets/localization";
import { describe, expect, it } from "vitest";
import {
  catalogPrimaryWorkbenchBlockers,
  catalogPrimaryWorkbenchProviderTransportCategories,
} from "../api/primary-workbench-admin-contracts";
import {
  catalogPrimaryWorkbenchActionStateCopy,
  catalogPrimaryWorkbenchBlockerCopy,
  catalogPrimaryWorkbenchCompletionCopy,
  catalogPrimaryWorkbenchCopyMessages,
  catalogPrimaryWorkbenchEmptyStateCopy,
  catalogPrimaryWorkbenchGlossaryTerms,
  catalogPrimaryWorkbenchHasOperatorCopyForCopyKey,
  catalogPrimaryWorkbenchProviderTransportCopy,
  catalogPrimaryWorkbenchResilienceCopy,
  catalogPrimaryWorkbenchProviderTransportSummary,
} from "./primary-workbench-copy";

describe("Catalog primary workbench operator copy", () => {
  it("covers every blocker category with reason, next step, and support target", () => {
    for (const blocker of catalogPrimaryWorkbenchBlockers) {
      const copy = catalogPrimaryWorkbenchBlockerCopy[blocker.category];

      expect(copy.label).toBeTruthy();
      expect(copy.reason).toBeTruthy();
      expect(copy.nextStep).toBeTruthy();
      expect(copy.supportTarget).toBeTruthy();
      expect(copy.label).not.toContain("-");
      expect(copy.reason).not.toMatch(/raw JSON|compatibility redirect|support-only|legacy selector/i);
      expect(copy.nextStep).not.toMatch(/raw JSON|compatibility redirect|support-only|legacy selector/i);
      expect(catalogPrimaryWorkbenchHasOperatorCopyForCopyKey(blocker.copyKey)).toBe(true);
    }
  });

  it("keeps every copy key mapped to operator-facing language", () => {
    for (const copy of Object.values(catalogPrimaryWorkbenchCopyMessages)) {
      expect(copy.label).toBeTruthy();
      expect(copy.reason).toBeTruthy();
      expect(copy.nextStep).toMatch(/\w/);
    }
  });

  it("distinguishes provider transport categories from #1065", () => {
    const labels = catalogPrimaryWorkbenchProviderTransportCategories.map(
      (category) => catalogPrimaryWorkbenchProviderTransportCopy[category].label,
    );

    expect(new Set(labels).size).toBe(catalogPrimaryWorkbenchProviderTransportCategories.length);
    expect(catalogPrimaryWorkbenchProviderTransportCopy["rate-limit"].reason).not.toBe(
      catalogPrimaryWorkbenchProviderTransportCopy.throttle.reason,
    );
    expect(catalogPrimaryWorkbenchProviderTransportCopy.timeout.nextStep).toContain("Retry");
    expect(catalogPrimaryWorkbenchProviderTransportSummary(["rate-limit", "timeout"])).toBe(
      "Rate limit cooldown, Provider timeout",
    );
  });

  it("separates denied, rollout, provider transport, and security/privacy language", () => {
    expect(catalogPrimaryWorkbenchBlockerCopy["permission-denied"]).toMatchObject({
      group: "permission",
      supportTarget: "governance-controls",
    });
    expect(catalogPrimaryWorkbenchBlockerCopy["rollout-disabled"]).toMatchObject({
      group: "rollout",
      supportTarget: "governance-controls",
    });
    expect(catalogPrimaryWorkbenchBlockerCopy["provider-transport-timeout"]).toMatchObject({
      group: "provider-transport",
      supportTarget: "health-triage",
    });
    expect(catalogPrimaryWorkbenchBlockerCopy["security-privacy-blocked"]).toMatchObject({
      group: "security-privacy",
      supportTarget: "governance-controls",
    });
  });

  it("covers empty, degraded, resilience, and completion states without payload escape hatches", () => {
    for (const copy of [
      ...Object.values(catalogPrimaryWorkbenchEmptyStateCopy),
      ...Object.values(catalogPrimaryWorkbenchResilienceCopy),
      ...Object.values(catalogPrimaryWorkbenchCompletionCopy),
      ...Object.values(catalogPrimaryWorkbenchActionStateCopy),
    ]) {
      expect(copy.reason).not.toMatch(/raw JSON|payload edit|bypass/i);
      expect(copy.nextStep).toMatch(/\w/);
    }

    expect(catalogPrimaryWorkbenchResilienceCopy["route-load-failure"].label).toBe("Route could not load");
    expect(catalogPrimaryWorkbenchResilienceCopy["api-failure"].label).toBe("Catalog API unavailable");
    expect(catalogPrimaryWorkbenchResilienceCopy["detail-panel-failure"].label).toBe("Evidence panel failed");
    expect(catalogPrimaryWorkbenchResilienceCopy["telemetry-unavailable"].label).toBe("Telemetry unavailable");
    expect(catalogPrimaryWorkbenchResilienceCopy["read-model-degraded"].label).toBe("Read model degraded");
    expect(catalogPrimaryWorkbenchCompletionCopy["promotion-complete"].nextStep).toContain("audit proof");
  });

  it("publishes the shared glossary terms required by #1058", () => {
    const terms = new Set(catalogPrimaryWorkbenchGlossaryTerms.map((entry) => entry.term.toLowerCase()));

    for (const requiredTerm of [
      "Source Observation",
      "Catalog Item",
      "Catalog-owned reference",
      "Provider profile",
      "Ingestion unit",
      "Provider scope",
      "Promotion",
      "Reject",
      "Defer",
      "Reapply",
      "Replay",
      "Audit evidence",
      "Provider transport",
      "Rollout stop",
      "Security/privacy blocker",
      "Retire",
    ]) {
      expect(terms.has(requiredTerm.toLowerCase())).toBe(true);
    }

    const retireTerm = catalogPrimaryWorkbenchGlossaryTerms.find((entry) => entry.term === "Retire");

    expect(retireTerm).toMatchObject({
      definition: expect.stringContaining("Full removal of the provider profile behavior"),
      avoid: expect.stringContaining("compatibility redirects"),
    });
    expect(retireTerm?.definition).toContain("mapping and promotion paths");
    expect(retireTerm?.definition).not.toMatch(/runbooks|release notes|operator instructions/i);
    expect(retireTerm?.useWhen).toContain("provider profile behavior has been fully removed");
    expect(retireTerm?.useWhen).not.toMatch(/runbooks|release notes|operator instructions/i);
  });
});

// #1747 no-confusion outcome-language gate. The internal ubiquitous terms
// ("promotion", "command plan", "Source Observation") stay in CONTRACTS and in the
// reason/group fields, but operator-facing labels that name the create-or-update
// outcome must state that outcome, action labels must not collide, and every state
// the acceptance lists (blocker / empty / denied / degraded / completion) must
// resolve to a label + reason + next step from this shared copy source.
describe("Catalog operator outcome-language contract (#1747)", () => {
  const internalOnlyJargon = /^(promotion|promote|command plan|command plan executed|promotion complete)\.?$/i;

  it("states the create-or-update outcome on the completion label that names it", () => {
    const promotionComplete = catalogPrimaryWorkbenchCompletionCopy["promotion-complete"];

    // The operator-facing label must read as the create/update OUTCOME, not bare
    // internal jargon. The contract keeps "promotion" in the reason and key name.
    expect(promotionComplete.label).toMatch(/created or updated|create or update|catalog item/i);
    expect(promotionComplete.label).not.toMatch(internalOnlyJargon);
    expect(promotionComplete.reason).toContain("Catalog Items");
    expect(promotionComplete.group).toBe("promotion");
  });

  it("uses outcome wording on the daily create/update CTA, label, and summary", () => {
    // The operator's primary commit action and stage stay outcome-framed; if these
    // localization values regress to bare "promote", the daily flow re-jargons.
    const commit = t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.commit");
    const label = t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.label");
    const summary = t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.summary", {
      count: 3,
    });

    for (const copy of [commit, label, summary]) {
      expect(copy.toLowerCase()).toMatch(/create|update/);
      expect(copy).not.toMatch(internalOnlyJargon);
    }
    expect(commit).toContain("Catalog Items");
    expect(summary).toContain("created or updated");
  });

  it("keeps operator action-state labels unambiguous (no two collide)", () => {
    const actionStateLabels = Object.values(catalogPrimaryWorkbenchActionStateCopy).map((copy) => copy.label);

    expect(new Set(actionStateLabels).size).toBe(actionStateLabels.length);
    for (const label of actionStateLabels) {
      expect(label).toBeTruthy();
      // Operator labels are human-readable, not machine slugs.
      expect(label).not.toContain("-");
    }
  });

  it("does not reuse one operator label across semantically different blocker categories", () => {
    // Distinct blocker categories must read distinctly so an operator never sees
    // two different blockers wearing the same label. Categories that intentionally
    // alias the same copy object (e.g. provider-transport-* -> transport copy) are
    // allowed because they ARE the same state.
    const labelToCopy = new Map<string, unknown>();
    for (const [category, copy] of Object.entries(catalogPrimaryWorkbenchBlockerCopy)) {
      const existing = labelToCopy.get(copy.label);
      if (existing !== undefined) {
        expect(existing, `blocker '${category}' reuses label '${copy.label}' for a different copy object`).toBe(copy);
      } else {
        labelToCopy.set(copy.label, copy);
      }
    }
    expect(labelToCopy.size).toBeGreaterThan(0);
  });

  it("resolves blocker, empty, denied, degraded, and completion states to label + reason + next step", () => {
    const blockerCopy = catalogPrimaryWorkbenchBlockers.map(
      (blocker) => catalogPrimaryWorkbenchBlockerCopy[blocker.category],
    );
    const deniedCopy = [
      catalogPrimaryWorkbenchActionStateCopy.denied,
      catalogPrimaryWorkbenchBlockerCopy["permission-denied"],
      catalogPrimaryWorkbenchBlockerCopy["authorization-denied"],
    ];
    const degradedCopy = [
      catalogPrimaryWorkbenchActionStateCopy.degraded,
      catalogPrimaryWorkbenchBlockerCopy["read-model-degraded"],
      catalogPrimaryWorkbenchProviderTransportCopy["degraded-provider"],
    ];

    for (const copy of [
      ...blockerCopy,
      ...Object.values(catalogPrimaryWorkbenchEmptyStateCopy),
      ...deniedCopy,
      ...degradedCopy,
      ...Object.values(catalogPrimaryWorkbenchCompletionCopy),
    ]) {
      expect(copy.label).toBeTruthy();
      expect(copy.reason).toMatch(/\w/);
      expect(copy.nextStep).toMatch(/\w/);
      // Operator copy never leaks machine slugs as the visible label.
      expect(copy.label).not.toContain("-");
    }

    // Denied vs degraded must stay distinguishable for the operator.
    expect(catalogPrimaryWorkbenchActionStateCopy.denied.group).toBe("permission");
    expect(catalogPrimaryWorkbenchActionStateCopy.degraded.group).toBe("resilience");
    expect(catalogPrimaryWorkbenchActionStateCopy.denied.label).not.toBe(
      catalogPrimaryWorkbenchActionStateCopy.degraded.label,
    );
  });
});
