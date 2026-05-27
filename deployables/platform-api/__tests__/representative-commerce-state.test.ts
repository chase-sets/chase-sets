import { describe, expect, it } from "vitest";
import { assertRepresentativeCommerceStateRunAllowed } from "../src/representative-commerce-state";

describe("representative commerce state refresh guardrails", () => {
  it("allows confirmed staging runs", () => {
    expect(() =>
      assertRepresentativeCommerceStateRunAllowed({
        deploymentEnvironment: "staging",
        confirmation: "seed staging commerce",
      }),
    ).not.toThrow();
  });

  it("rejects production runs even when confirmed", () => {
    expect(() =>
      assertRepresentativeCommerceStateRunAllowed({
        deploymentEnvironment: "production",
        confirmation: "seed staging commerce",
      }),
    ).toThrow("representative-commerce-state cannot run when DEPLOYMENT_ENVIRONMENT=production.");
  });

  it("requires an explicit confirmation phrase", () => {
    expect(() =>
      assertRepresentativeCommerceStateRunAllowed({
        deploymentEnvironment: "staging",
        confirmation: "yes",
      }),
    ).toThrow("REPRESENTATIVE_COMMERCE_STATE_CONFIRM must exactly equal 'seed staging commerce'");
  });

  it("requires a local override outside dev, test, or staging", () => {
    expect(() =>
      assertRepresentativeCommerceStateRunAllowed({
        deploymentEnvironment: "remote-dev",
        confirmation: "seed staging commerce",
      }),
    ).toThrow(
      "representative-commerce-state requires DEPLOYMENT_ENVIRONMENT=staging, test/dev runtime, or REPRESENTATIVE_COMMERCE_STATE_ALLOW_LOCAL=true.",
    );

    expect(() =>
      assertRepresentativeCommerceStateRunAllowed({
        deploymentEnvironment: "remote-dev",
        confirmation: "seed staging commerce",
        localOverride: "true",
      }),
    ).not.toThrow();
  });
});
