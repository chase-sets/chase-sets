import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertCheckoutObservabilityContractCoverage,
  checkoutObservabilityContractDocPath,
  checkoutObservabilityForbiddenFields,
  checkoutObservabilityMetricName,
  checkoutObservabilityProfiles,
  checkoutObservabilityRequiredDimensions,
} from "./checkout-observability-contract";
import { checkoutLaunchEvidenceRows } from "./checkout-launch-evidence-matrix";

describe("Checkout observability contract", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCheckoutObservabilityContractCoverage()).not.toThrow();
  });

  it("defines one observability profile for every launch evidence row", () => {
    const matrixStates = checkoutLaunchEvidenceRows.map((row) => row.state);
    const profileStates = checkoutObservabilityProfiles.map((profile) => profile.state);

    expect(new Set(profileStates).size).toBe(profileStates.length);
    expect(profileStates).toEqual(expect.arrayContaining(matrixStates));
  });

  it("uses the shared base dimensions and redaction set for every event", () => {
    for (const profile of checkoutObservabilityProfiles) {
      expect(profile.eventName, profile.state).toMatch(/^checkout\./);
      expect(profile.dimensions, profile.state).toEqual(
        expect.arrayContaining([...checkoutObservabilityRequiredDimensions]),
      );
      expect(profile.forbiddenFields, profile.state).toEqual(
        expect.arrayContaining([...checkoutObservabilityForbiddenFields]),
      );
      expect(profile.expectation, profile.state).not.toMatch(/\b(todo|tbd)\b/i);
    }
  });

  it("adds required dimensions for launch register, support, downstream, and cleanup states", () => {
    for (const row of checkoutLaunchEvidenceRows) {
      const profile = checkoutObservabilityProfiles.find((candidate) => candidate.state === row.state);

      expect(profile, row.state).toBeDefined();

      if (row.launchRegisterStatus === "required") {
        expect(profile?.dimensions, row.state).toContain("launch-register-decision");
        expect(profile?.releaseHealthRequired, row.state).toBe(true);
      }

      if (row.supportReferenceRequired) {
        expect(profile?.dimensions, row.state).toContain("support-safe-reference");
      }

      if (row.pendingDownstreamBoundaryRequired) {
        expect(profile?.dimensions, row.state).toContain("downstream-status");
      }

      if (row.state === "fresh-state-cleanup-absence") {
        expect(profile?.dimensions, row.state).toContain("fresh-state-scan-result");
        expect(profile?.alertClass, row.state).toBe("fresh-state-alert");
      }
    }
  });

  it("documents the executable observability contract", () => {
    const doc = readFileSync(new URL("../../../docs/checkout-observability-contract.md", import.meta.url), "utf8");
    const checkoutReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const docsIndex = readFileSync(new URL("../../../../../docs/README.md", import.meta.url), "utf8");

    expect(checkoutObservabilityContractDocPath).toBe(
      "bounded-contexts/checkout/docs/checkout-observability-contract.md",
    );
    expect(doc).toContain("Checkout Observability Contract");
    expect(checkoutObservabilityMetricName).toBe("chase_sets_checkout_observability_events_total");
    expect(doc).toContain("chase_sets_checkout_observability_events_total");
    expect(doc).toContain("checkout-launch-observability.json");
    expect(doc).toContain(
      "The executable contract lives in `bounded-contexts/checkout/features/sessions/api/checkout-observability-contract.ts`.",
    );
    expect(doc).toContain("No raw `afterWrite`, cookies, emails, addresses, provider payloads");
    expect(doc).toContain("support-safe references");
    expect(checkoutReadme).toContain("./docs/checkout-observability-contract.md");
    expect(docsIndex).toContain("../bounded-contexts/checkout/docs/checkout-observability-contract.md");

    for (const profile of checkoutObservabilityProfiles) {
      expect(doc, profile.state).toContain(`| ${profile.docLabel} |`);
    }
  });
});
