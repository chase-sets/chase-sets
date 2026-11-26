import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  auditBrowserUsabilityRoutes,
  browserUsabilityGoalModules,
  validateBrowserUsabilityGoalModules,
} from "./browser-usability-goals.mjs";

const excludedRoute = "deployables/public-web/app/routes/not-found.tsx";
const publicWebScope = "^deployables/public-web/app/routes/";

const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  cwd: new URL("../", import.meta.url),
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

function assertRouteCoverage(files) {
  const { coverage } = auditBrowserUsabilityRoutes(files);
  const offenses = [
    ...coverage.unscoped.map((path) => `${path} (surface: unscoped): no route scope`),
    ...coverage.invalid.map(({ path, surfaces, reason }) => `${path} (surface: ${surfaces.join(", ")}): ${reason}`),
    ...Object.entries(coverage.surfaces).flatMap(([surface, { unclaimed }]) =>
      unclaimed.map((path) => `${path} (surface: ${surface}): unclaimed`),
    ),
  ];
  if (offenses.length) {
    throw new Error(
      `Browser usability route coverage failed:\n${offenses.join("\n")}\n` +
        "Claim each route in a goal's routes map or record an exclusion in excludedRoutes with a reason. " +
        "See docs/contributing/browser-usability.md.",
    );
  }
}

describe("browser usability route coverage", () => {
  it("omitting the public-web scope exposes the real unscoped route and out-of-scope exclusion", () => {
    const modules = browserUsabilityGoalModules.map((surface) =>
      surface.id === "guest"
        ? { ...surface, routeScope: surface.routeScope.filter((pattern) => pattern !== publicWebScope) }
        : surface,
    );
    expect(trackedFiles).toContain(excludedRoute);
    expect(auditBrowserUsabilityRoutes([excludedRoute], modules).coverage.unscoped).toEqual([excludedRoute]);
    expect(() => validateBrowserUsabilityGoalModules(modules)).toThrow(`Exclusion outside scope: ${excludedRoute}`);
  });

  it("omitting an exclusion exposes the real unclaimed route without changing its scope", () => {
    const modules = browserUsabilityGoalModules.map((surface) =>
      surface.id === "guest"
        ? { ...surface, excludedRoutes: surface.excludedRoutes.filter(({ path }) => path !== excludedRoute) }
        : surface,
    );
    expect(() => validateBrowserUsabilityGoalModules(modules)).not.toThrow();
    expect(auditBrowserUsabilityRoutes([excludedRoute], modules).coverage).toMatchObject({
      unscoped: [],
      invalid: [],
      surfaces: { guest: { inScope: 1, excluded: 0, unclaimed: [excludedRoute] } },
    });
  });

  it("claims and excludes only route modules that are tracked", () => {
    const claimedOrExcluded = browserUsabilityGoalModules.flatMap((surface) => [
      ...surface.goals.flatMap((goal) => Object.keys(goal.routes ?? {})),
      ...surface.excludedRoutes.map(({ path }) => path),
    ]);
    expect(claimedOrExcluded.filter((path) => !trackedFiles.includes(path))).toEqual([]);
  });

  it("accounts for every tracked route in the live tree", () => {
    expect(() => assertRouteCoverage(trackedFiles)).not.toThrow();
  });

  it("rejects a synthetic unclaimed route with its surface and both fixes", () => {
    const route = "bounded-contexts/public-presence/routes/marketplace/synthetic-unclaimed-coverage.tsx";
    expect(trackedFiles).not.toContain(route);
    expect(() => assertRouteCoverage([...trackedFiles, route])).toThrow(
      `Browser usability route coverage failed:\n${route} (surface: guest): unclaimed\n` +
        "Claim each route in a goal's routes map or record an exclusion in excludedRoutes with a reason. " +
        "See docs/contributing/browser-usability.md.",
    );
  });
});
