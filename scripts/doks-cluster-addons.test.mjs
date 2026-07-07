import { describe, expect, it } from "vitest";
import { loadBalancerName, pinned, planClusterAddons } from "./doks-cluster-addons.mjs";

describe("doks cluster addons planner", () => {
  it("plans repos, controller, cert-manager, and issuers in order", () => {
    const steps = planClusterAddons({ environment: "staging" });
    expect(steps.map((step) => step.name)).toEqual([
      "add ingress-nginx repo",
      "add cert-manager repo",
      "refresh repos",
      "install ingress-nginx controller and DigitalOcean load balancer",
      "install cert-manager",
      "install ACME cluster issuers",
    ]);
  });

  it("installs cert-manager before the cluster issuers that need its CRDs", () => {
    const steps = planClusterAddons({ environment: "staging" });
    const certManagerIndex = steps.findIndex((step) => step.name === "install cert-manager");
    const issuerIndex = steps.findIndex((step) => step.name === "install ACME cluster issuers");
    expect(certManagerIndex).toBeGreaterThanOrEqual(0);
    expect(issuerIndex).toBeGreaterThan(certManagerIndex);
  });

  it("pins upstream chart versions", () => {
    const steps = planClusterAddons({ environment: "staging" });
    const ingress = steps.find((step) => step.name.startsWith("install ingress-nginx"));
    const certManager = steps.find((step) => step.name === "install cert-manager");
    expect(ingress.command).toContain(pinned.ingressNginx.version);
    expect(certManager.command).toContain(pinned.certManager.version);
  });

  it("names the DigitalOcean load balancer per environment", () => {
    expect(loadBalancerName("staging")).toBe("chase-sets-staging-doks-ingress");
    expect(loadBalancerName("production")).toBe("chase-sets-production-doks-ingress");

    const staging = planClusterAddons({ environment: "staging" });
    const controller = staging.find((step) => step.name.startsWith("install ingress-nginx"));
    expect(controller.command.join(" ")).toContain("=chase-sets-staging-doks-ingress");

    const production = planClusterAddons({ environment: "production" });
    const productionController = production.find((step) => step.name.startsWith("install ingress-nginx"));
    expect(productionController.command.join(" ")).toContain("=chase-sets-production-doks-ingress");
  });

  it("installs every helm release atomically so a failed release rolls back", () => {
    const steps = planClusterAddons({ environment: "staging" });
    for (const step of steps.filter((entry) => entry.command.includes("upgrade"))) {
      expect(step.command).toContain("--atomic");
      expect(step.command).toContain("--wait");
    }
  });

  it("rejects unsupported environments", () => {
    expect(() => planClusterAddons({ environment: "preview" })).toThrow("environment must be one of");
  });
});
