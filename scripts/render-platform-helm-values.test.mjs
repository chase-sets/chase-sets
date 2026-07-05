import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeTopologyBaselines } from "./digitalocean-runtime-topology.mjs";
import {
  buildPlatformHelmValues,
  chartValuesRelativePath,
  extractDigitalOceanPlatformComponents,
  readPlatformSources,
  syncPlatformHelmValues,
} from "./render-platform-helm-values.mjs";

const repoRoot = path.resolve(".");
const sources = readPlatformSources(repoRoot);

function componentNames(collections) {
  return [...collections.services, ...collections.workers, ...collections.jobs]
    .map((component) => component.name)
    .sort();
}

function componentEnvKeys(component) {
  return component.env.map((entry) => entry.name).sort();
}

describe("render platform Helm values", () => {
  it("keeps generated values current", () => {
    expect(() => syncPlatformHelmValues({ repoRoot, check: true })).not.toThrow();
  });

  it("scaffolds the six current full-platform App Platform components", () => {
    const values = buildPlatformHelmValues({ repoRoot });
    const expectedNames = componentNames(runtimeTopologyBaselines.staging.expectedComponents);

    expect(Object.keys(values.components).sort()).toEqual(expectedNames);
    expect(Object.values(values.components).filter((component) => component.kind === "service")).toHaveLength(4);
    expect(Object.values(values.components).filter((component) => component.kind === "worker")).toHaveLength(1);
    expect(Object.values(values.components).filter((component) => component.kind === "job")).toHaveLength(1);
  });

  it("derives commands, ports, and source count expressions from the DigitalOcean app spec", () => {
    const terraformComponents = extractDigitalOceanPlatformComponents(sources);
    const values = buildPlatformHelmValues({ repoRoot });

    for (const terraformComponent of terraformComponents) {
      const helmComponent = values.components[terraformComponent.name];
      expect(helmComponent.command).toBe(terraformComponent.command);
      expect(helmComponent.port ?? null).toBe(terraformComponent.port ?? null);
      expect(helmComponent.source.instanceCountExpression).toBe(terraformComponent.instanceCountExpression);
    }

    expect(values.components["public-web"].source.instanceCountExpression).toBe("local.public_web_instances");
    expect(values.components.marketplace.source.instanceCountExpression).toBe("local.marketplace_web_instances");
    expect(values.components["platform-api"].source.instanceCountExpression).toBe("local.api_instances");
    expect(values.components["platform-worker"].source.instanceCountExpression).toBe("local.worker_instances");
    expect(values.components["platform-bootstrap"].source.instanceCountExpression).toBe("1");
  });

  it("keeps Helm env keys and counts aligned with DigitalOcean component env", () => {
    const terraformComponents = extractDigitalOceanPlatformComponents(sources);
    const values = buildPlatformHelmValues({ repoRoot });

    for (const terraformComponent of terraformComponents) {
      expect(componentEnvKeys(values.components[terraformComponent.name])).toEqual(
        componentEnvKeys(terraformComponent),
      );
    }

    expect(
      Object.fromEntries(Object.entries(values.components).map(([name, component]) => [name, component.env.length])),
    ).toEqual({
      "admin-web": 5,
      marketplace: 13,
      "platform-api": 80,
      "platform-bootstrap": 51,
      "platform-worker": 110,
      "public-web": 12,
    });
    expect(componentEnvKeys(values.components["platform-api"])).toContain("DATABASE_URL_COMMERCIAL_TERMS");
    expect(componentEnvKeys(values.components["platform-api"])).toContain("DATABASE_URL_INVENTORY_WAITER");
    expect(componentEnvKeys(values.components["platform-worker"])).toContain(
      "WORKER_LISTENER_DATABASE_URL_PUBLIC_PRESENCE",
    );
  });

  it("keeps live deploy wiring out of the scaffold", () => {
    const chartFiles = [
      "templates/deployment.yaml",
      "templates/job.yaml",
      "templates/service.yaml",
      "templates/serviceaccount.yaml",
    ].map((relativePath) =>
      readFileSync(path.join(repoRoot, "infrastructure", "helm", "platform", relativePath), "utf8"),
    );
    const chartText = `${readFileSync(path.join(repoRoot, chartValuesRelativePath), "utf8")}\n${chartFiles.join("\n")}`;

    expect(chartText).not.toMatch(/^kind: Ingress$/m);
    expect(chartText).not.toContain("ExternalSecret");
    expect(chartText).not.toContain("SecretProviderClass");
    expect(chartText).not.toContain("strategy: canary");
    expect(chartText).toContain("suspend: true");
  });
});
