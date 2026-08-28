import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validatePortableRouteContract } from "./portable-route-contract.mjs";

function portableRoute(overrides = {}) {
  return {
    routeId: "search",
    routePath: "search",
    fileExport: "./routes/search",
    routeType: "route",
    sourceContext: "discovery",
    delivery: "portable",
    authorization: { kind: "public" },
    canonicalLink: { kind: "route-derived" },
    availability: { web: true, mobile: true },
    pageComponentExport: "SearchPage",
    portableDataOperations: { load: true, mutation: false },
    ...overrides,
  };
}

function validate(route) {
  return validatePortableRouteContract({
    contextName: "discovery",
    deployable: "marketplace-web",
    route,
  });
}

describe("portable route manifest contract", () => {
  it("accepts a complete portable route contribution", () => {
    expect(validate(portableRoute())).toEqual([]);
  });

  it("fails when a mobile route omits canonical-link metadata", () => {
    expect(validate(portableRoute({ canonicalLink: undefined }))).toContainEqual(
      expect.stringContaining("canonicalLink must declare"),
    );
  });

  it("fails when a mobile route omits portable data operations", () => {
    expect(validate(portableRoute({ portableDataOperations: undefined }))).toContainEqual(
      expect.stringContaining("must declare a load operation"),
    );
  });

  it("requires unsupported inventory to name its owner and follow-up", () => {
    expect(
      validate(
        portableRoute({
          delivery: "server-only",
          availability: { web: true, mobile: false },
          portableDataOperations: undefined,
          unsupportedMobile: { owner: "", followUp: "", reason: "Server loader only." },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("identify an owner"), expect.stringContaining("follow-up")]),
    );
  });

  it("ratchets every live marketplace contribution through the portable contract", async () => {
    const contextRoot = path.resolve(import.meta.dirname, "../../bounded-contexts");
    const entries = await readdir(contextRoot, { withFileTypes: true });
    const violations = [];
    let routeCount = 0;
    let portableCount = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(contextRoot, entry.name, "context.json");
      let manifest;
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      for (const contribution of manifest.deployableContributions ?? []) {
        for (const route of contribution.routes ?? []) {
          const routeViolations = validatePortableRouteContract({
            contextName: manifest.contextName,
            deployable: contribution.deployable,
            route,
          });
          violations.push(...routeViolations.map((message) => `${manifest.contextName}/${route.routeId}: ${message}`));
          if (contribution.deployable === "marketplace-web") {
            routeCount += 1;
            if (route.delivery === "portable") portableCount += 1;
          }
        }
      }
    }

    expect(violations).toEqual([]);
    expect({ routeCount, portableCount }).toEqual({ routeCount: 79, portableCount: 3 });
  });
});
