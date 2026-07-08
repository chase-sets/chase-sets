import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBalancerName, pinned, planClusterAddons } from "./doks-cluster-addons.mjs";

const ingressNginxValues = readFileSync(
  resolve("infrastructure", "helm", "doks-ingress", "ingress-nginx-values.yaml"),
  "utf8",
);

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

  it("pins the DigitalOcean load balancer type to REGIONAL so forwarding rules target the NodePorts and PROXY protocol is supported", () => {
    // On DOKS 1.33.1-do.0+ the CCM default is REGIONAL_NETWORK (a same-port
    // passthrough network LB that forwards :80/:443 to host :80/:443, where a
    // NodePort controller has nothing listening, and that cannot do PROXY
    // protocol). Pin REGIONAL explicitly -- an absent annotation resolves to the
    // wrong default on the 1.36 cluster. See ingress-nginx-values.yaml header.
    expect(ingressNginxValues).toContain('service.beta.kubernetes.io/do-loadbalancer-type: "REGIONAL"');
    expect(ingressNginxValues).not.toContain('service.beta.kubernetes.io/do-loadbalancer-type: "REGIONAL_NETWORK"');
  });

  it("keeps load balancer and ingress-nginx PROXY protocol settings paired", () => {
    expect(ingressNginxValues).toContain('service.beta.kubernetes.io/do-loadbalancer-enable-proxy-protocol: "true"');
    expect(ingressNginxValues).toContain('use-proxy-protocol: "true"');
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
