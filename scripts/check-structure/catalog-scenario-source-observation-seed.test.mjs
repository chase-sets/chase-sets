import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";

// The browser-e2e scenario Source Observations (one promoted, one changed tcgdex row) are
// test-fixture data: they reach a database only through the scenario-seed profile and are
// derived only from committed TCGdex fixtures, never from the provider network.
const seedModule = "bounded-contexts/catalog/features/source-observations/api/seeding/seed.ts";
const seedBarrel = "bounded-contexts/catalog/features/source-observations/api/seed.ts";
const scenarioComposition = "bounded-contexts/catalog/support/authoring-support/seed.ts";
const scenarioSeeds = ["seedPromotedSourceObservationScenario", "seedChangedSourceObservationScenario"];

function source(file) {
  return readFileSync(path.join(repoRoot, ...file.split("/")), "utf8");
}

function productionTypescriptFiles() {
  return execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { cwd: repoRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));
}

function relativeImportTargets(file) {
  return [...source(file).matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g)].map(([, specifier]) =>
    path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.tsx?$/, ""),
  );
}

describe("catalog scenario Source Observation seed boundary", () => {
  it("is imported in production only by its barrel and the scenario-seed composition", () => {
    const seedModules = new Set([seedModule, seedBarrel].map((file) => file.replace(/\.ts$/, "")));
    const importers = productionTypescriptFiles().filter((file) =>
      relativeImportTargets(file).some((target) => seedModules.has(target)),
    );

    expect(importers.sort()).toEqual([seedBarrel, scenarioComposition].sort());
  });

  it("runs both scenario seeds once, only on the scenario-seed profile path", () => {
    const composition = source(scenarioComposition);
    const scenarioBody = composition.match(/\nasync function seedCatalogScenarioData\([\s\S]*?\n}\n/)?.[0] ?? "";

    for (const seed of scenarioSeeds) {
      expect(composition.split(`${seed}(`)).toHaveLength(2);
      expect(scenarioBody).toContain(`await ${seed}(services);`);
    }
    expect(composition).toContain('const shouldSeedScenarioData = profileEnabled(options, "scenario-seed");');
    expect(composition).toMatch(
      /if \(shouldSeedScenarioData\) \{\s*await seedCatalogScenarioData\(pool, authoring\);\s*\}/,
    );
    expect(composition.split("seedCatalogScenarioData(")).toHaveLength(3);
  });

  it("derives every provider payload from a committed TCGdex fixture, never the network", () => {
    const seed = source(seedModule);
    const providerPulls = [...seed.matchAll(/fetchTcgdexSetObservationPayloads\(\{[\s\S]*?\}\)/g)].map(
      ([call]) => call,
    );

    expect([...seed.matchAll(/\bfrom\s+["']([^"']+\.json)["']/g)].map(([, specifier]) => specifier)).toEqual([
      "../__fixtures__/tcgdex/base2-60-scenario.json",
    ]);
    expect(providerPulls).not.toHaveLength(0);
    for (const call of providerPulls) expect(call).toContain("fetch: tcgdexScenarioFixtureFetch(");
    expect(seed).not.toMatch(/https?:\/\//);
    expect(seed).not.toMatch(/\bglobalThis\.fetch\b|(?<![\w.])fetch\(/);
  });
});
