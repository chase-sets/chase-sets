import { describe, expect, it } from "vitest";
import { deploymentContractMarkdown, renderDeploymentContract } from "./deployment-contract-preflight.mjs";

describe("deployment contract preflight", () => {
  it("renders a DOKS-only staging contract", () => {
    const contract = renderDeploymentContract({
      environment: "staging",
      bootstrapOwnerOverride: "doks",
      argoRolloutsEnabled: "true",
    });

    expect(contract).toMatchObject({
      schemaVersion: "deployment-contract/v3",
      environment: "staging",
      runtimeOwner: "doks",
      bootstrapOwner: "doks",
      runtimeProfile: "public",
      marketplacePublicEnabled: true,
      rolloutMode: "doks-argo-rollouts",
      result: "pass",
      errors: [],
    });
    expect(Object.keys(contract.controlPlanes)).toEqual(["doks"]);
    expect(contract.controlPlanes.doks.activeComponents).toEqual(
      expect.arrayContaining(["platform-api", "platform-worker", "platform-bootstrap"]),
    );
    expect(contract.databaseUrlKeys.runtime).toContain("DATABASE_URL_MARKETPLACE");
    expect(contract.databaseUrlKeys.bootstrap).toContain("BOOTSTRAP_DATABASE_URL_MARKETPLACE");
  });

  it("renders landing production without marketplace exposure", () => {
    const contract = renderDeploymentContract({
      environment: "production",
      bootstrapOwnerOverride: "doks",
      productionRuntimeProfileOverride: "landing",
      productionMarketplacePublicEnabled: "false",
      argoRolloutsEnabled: "false",
    });

    expect(contract.runtimeProfile).toBe("landing");
    expect(contract.marketplacePublicEnabled).toBe(false);
    expect(contract.rolloutMode).toBe("doks-helm");
  });

  it("rejects any retired bootstrap owner", () => {
    expect(() =>
      renderDeploymentContract({
        environment: "production",
        bootstrapOwnerOverride: "app-platform",
      }),
    ).toThrow("DOKS is the only supported bootstrap owner");
  });

  it("keeps production public profile and exposure atomic", () => {
    expect(() =>
      renderDeploymentContract({
        environment: "production",
        bootstrapOwnerOverride: "doks",
        productionRuntimeProfileOverride: "public",
        productionMarketplacePublicEnabled: "false",
      }),
    ).toThrow("must move together");
  });

  it("renders support-safe markdown", () => {
    const contract = renderDeploymentContract({ environment: "staging" });
    expect(deploymentContractMarkdown(contract)).toContain("Runtime owner: `doks`");
    expect(deploymentContractMarkdown(contract)).toContain("DOKS components:");
  });
});
