import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertCheckoutObservabilityContractCoverage,
  checkoutObservabilityContractDocPath,
  checkoutObservabilityForbiddenFields,
  checkoutObservabilityMetricName,
  checkoutObservabilityProfiles,
  checkoutObservabilityRequiredDimensions,
  checkoutObservabilityRequiredStates,
} from "./checkout-observability-contract";

describe("Checkout observability contract", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCheckoutObservabilityContractCoverage()).not.toThrow();
  });

  it("defines one observability profile for every required checkout state", () => {
    const profileStates = checkoutObservabilityProfiles.map((profile) => profile.state);

    expect(new Set(profileStates).size).toBe(profileStates.length);
    expect(profileStates).toEqual(expect.arrayContaining([...checkoutObservabilityRequiredStates]));
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

  it("adds required dimensions for operator-signal and downstream states", () => {
    for (const profile of checkoutObservabilityProfiles) {
      if (profile.operatorSignalRequired) {
        expect(profile.dimensions, profile.state).toContain("capability-decision");
      }

      if (profile.scenarioStates.includes("pending-downstream")) {
        expect(profile.dimensions, profile.state).toContain("downstream-status");
      }
    }
  });

  it("closes the best-effort cart merge profile over fixed redacted dimensions", () => {
    expect(checkoutObservabilityProfiles.find((profile) => profile.state === "cart-merge-best-effort-failed")).toEqual(
      expect.objectContaining({
        eventName: "checkout.entry.cart_merge_best_effort_failed",
        telemetryClass: "checkout-entry",
        scenarioStates: ["reconciliation"],
        alertClass: "event-only",
        operatorSignalRequired: false,
      }),
    );
    expect(checkoutObservabilityForbiddenFields).toEqual(
      expect.arrayContaining([
        "anonymous-owner-key",
        "request-header",
        "request-body",
        "raw-exception-message",
        "raw-exception-stack",
      ]),
    );
  });

  it("documents the executable observability contract", () => {
    const doc = readFileSync(new URL("../../../docs/checkout-observability-contract.md", import.meta.url), "utf8");
    const checkoutReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");

    expect(checkoutObservabilityContractDocPath).toBe(
      "bounded-contexts/checkout/docs/checkout-observability-contract.md",
    );
    expect(doc).toContain("Checkout Observability Contract");
    expect(checkoutObservabilityMetricName).toBe("chase_sets_checkout_observability_events_total");
    expect(doc).toContain("chase_sets_checkout_observability_events_total");
    expect(doc).toContain("recordCheckoutObservabilityEvent");
    expect(doc).toContain("checkout-observability.json");
    expect(doc).toContain(
      "The executable contract lives in `bounded-contexts/checkout/features/sessions/api/checkout-observability-contract.ts`.",
    );
    expect(doc).toContain("No raw `afterWrite`, cookies, emails, addresses, provider payloads");
    expect(doc).toContain("raw exception messages or stacks");
    expect(doc).toContain("support-safe references");
    expect(checkoutReadme).toContain("./docs/checkout-observability-contract.md");

    for (const profile of checkoutObservabilityProfiles) {
      expect(doc, profile.state).toContain(`| ${profile.docLabel} |`);
    }
  });
});
