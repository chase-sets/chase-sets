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
import { checkoutVisualRequiredTargets } from "./checkout-visual-targets";

describe("Checkout observability contract", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCheckoutObservabilityContractCoverage()).not.toThrow();
  });

  it("defines one observability profile for every required visual target", () => {
    const profileStates = checkoutObservabilityProfiles.map((profile) => profile.state);

    expect(new Set(profileStates).size).toBe(profileStates.length);
    expect(profileStates).toEqual(expect.arrayContaining([...checkoutVisualRequiredTargets]));
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

  it("adds required dimensions for release-health and downstream states", () => {
    for (const profile of checkoutObservabilityProfiles) {
      if (profile.releaseHealthRequired) {
        expect(profile.dimensions, profile.state).toContain("launch-decision-decision");
      }

      if (profile.scenarioStates.includes("pending-downstream")) {
        expect(profile.dimensions, profile.state).toContain("downstream-status");
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
    expect(doc).toContain("recordCheckoutObservabilityEvent");
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
