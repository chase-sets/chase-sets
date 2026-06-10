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
      definition: expect.stringContaining("Complete removal"),
      avoid: expect.stringContaining("compatibility redirects"),
    });
    expect(retireTerm?.definition).toContain("associated code");
    expect(retireTerm?.definition).toContain("product patterns");
    expect(retireTerm?.definition).toContain("documentation");
    expect(retireTerm?.useWhen).toContain("associated code, product patterns");
    expect(retireTerm?.useWhen).toContain("documentation");
  });
});
