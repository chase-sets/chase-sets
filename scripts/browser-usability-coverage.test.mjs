import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { auditBrowserUsabilityRoutes } from "./browser-usability-goals.mjs";

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
