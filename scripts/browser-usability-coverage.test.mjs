import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  auditBrowserUsabilityRoutes,
  browserUsabilityGoalModules,
  validateBrowserUsabilityGoalModules,
} from "./browser-usability-goals.mjs";

const analyticsRoute = "bounded-contexts/discovery/routes/item-detail-rail-analytics.tsx";
const analyticsScope = "^bounded-contexts/discovery/routes/item-detail-rail-analytics\\.tsx$";

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
  it("claims shipping setup for both authenticated and existing anonymous sellers", () => {
    const route = "bounded-contexts/fulfillment/routes/seller-shipping-setup.tsx";
    const seller = browserUsabilityGoalModules.find(({ id }) => id === "seller");
    expect(
      seller.goals
        .filter((goal) => Object.hasOwn(goal.routes, route))
        .map(({ id, startSignedIn }) => ({ id, startSignedIn })),
    ).toEqual([
      { id: "seller-shipping-setup", startSignedIn: true },
      { id: "guest-seller-shipping-setup", startSignedIn: false },
    ]);
    expect(auditBrowserUsabilityRoutes([route]).coverage).toMatchObject({
      unscoped: [],
      invalid: [],
      surfaces: { seller: { inScope: 1, claimed: 1, excluded: 0, unclaimed: [] } },
    });
  });

  it("accounts for Discovery analytics with an exact scope and a reasoned fixture gap", () => {
    const guest = browserUsabilityGoalModules.find(({ id }) => id === "guest");
    expect(trackedFiles).toContain(analyticsRoute);
    expect(guest.routeScope.at(-1)).toBe(analyticsScope);
    expect(guest.excludedRoutes).toContainEqual({
      path: analyticsRoute,
      reason:
        "fixture-gap: no participant-observable analytics receipt in the usability fixture; Discovery POST-only ingestion is proven by route and bridge tests, not a standalone page goal",
    });
    expect(() => validateBrowserUsabilityGoalModules(browserUsabilityGoalModules)).not.toThrow();
    expect(auditBrowserUsabilityRoutes([analyticsRoute]).coverage).toMatchObject({
      unscoped: [],
      invalid: [],
      surfaces: { guest: { inScope: 1, claimed: 0, excluded: 1, unclaimed: [] } },
    });
  });

  it("omit-analytics-scope exposes the real unscoped route and out-of-scope exclusion", () => {
    const modules = browserUsabilityGoalModules.map((surface) =>
      surface.id === "guest"
        ? { ...surface, routeScope: surface.routeScope.filter((pattern) => pattern !== analyticsScope) }
        : surface,
    );
    expect(auditBrowserUsabilityRoutes([analyticsRoute], modules).coverage.unscoped).toEqual([analyticsRoute]);
    expect(() => validateBrowserUsabilityGoalModules(modules)).toThrow(`Exclusion outside scope: ${analyticsRoute}`);
  });

  it("omit-analytics-exclusion exposes the real unclaimed route without changing its scope", () => {
    const modules = browserUsabilityGoalModules.map((surface) =>
      surface.id === "guest"
        ? { ...surface, excludedRoutes: surface.excludedRoutes.filter(({ path }) => path !== analyticsRoute) }
        : surface,
    );
    expect(() => validateBrowserUsabilityGoalModules(modules)).not.toThrow();
    expect(auditBrowserUsabilityRoutes([analyticsRoute], modules).coverage).toMatchObject({
      unscoped: [],
      invalid: [],
      surfaces: { guest: { inScope: 1, excluded: 0, unclaimed: [analyticsRoute] } },
    });
    const sibling = analyticsRoute.replace("rail-analytics.tsx", "rail-analytics-unclaimed.tsx");
    expect(auditBrowserUsabilityRoutes([sibling]).coverage.unscoped).toEqual([sibling]);
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
