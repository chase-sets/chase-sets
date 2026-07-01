import { describe, expect, it } from "vitest";
import {
  evaluateRuntimeTopology,
  retiredProfileComponentNames,
  runtimeTopologyBaselines,
  summarizeTopologyBaseline,
} from "./digitalocean-runtime-topology.mjs";

describe("DigitalOcean runtime topology", () => {
  it("defines expected component shapes for each runtime mode", () => {
    expect(Object.keys(runtimeTopologyBaselines).sort()).toEqual([
      "preview",
      "production-landing",
      "production-proof",
      "production-public",
      "staging",
    ]);

    expect(summarizeTopologyBaseline("preview")).toMatchObject({
      environment: "preview",
      apiProfile: "public",
      workerProfile: "public",
      componentCount: 6,
    });
    expect(summarizeTopologyBaseline("production-landing")).toMatchObject({
      environment: "production",
      productionMode: "landing",
      apiProfile: "landing",
      workerProfile: "landing",
      componentCount: 5,
    });
    expect(summarizeTopologyBaseline("production-public")).toMatchObject({
      productionMode: "public",
      apiProfile: "public",
      workerProfile: "public",
      componentCount: 6,
    });
  });

  it("reports a matching production landing topology as passing", () => {
    expect(
      evaluateRuntimeTopology("production-landing", {
        services: [{ name: "public-web", instance_count: 2 }, { name: "admin-web" }, { name: "platform-api" }],
        workers: [{ name: "platform-worker" }],
        jobs: [{ name: "platform-bootstrap" }],
      }),
    ).toMatchObject({
      pass: true,
      missing: [],
      unexpected: [],
      retiredReappeared: [],
    });
  });

  it("flags retired admin-support components when they appear in the target topology", () => {
    const result = evaluateRuntimeTopology("production-landing", {
      services: [{ name: "public-web" }, { name: "admin-web" }, { name: "admin-support-api" }],
      workers: [{ name: "admin-support-worker" }],
      jobs: [{ name: "admin-support-bootstrap" }],
    });

    expect(result.pass).toBe(false);
    expect(result.missing).toEqual(["platform-api", "platform-bootstrap", "platform-worker"]);
    expect(result.retiredReappeared).toEqual(retiredProfileComponentNames);
  });

  it("rejects unknown topology modes", () => {
    expect(() => summarizeTopologyBaseline("production-marketplace")).toThrow(
      "Unknown DigitalOcean runtime topology mode 'production-marketplace'.",
    );
  });
});
