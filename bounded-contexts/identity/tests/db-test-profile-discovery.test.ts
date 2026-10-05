import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverDbProfile,
  listTestFiles,
} from "../../../scripts/check-structure/db-profile-script-canonical-form.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..");

describe("identity database test profile discovery", () => {
  const databaseSpecs = listTestFiles(workspaceRoot).filter((file) => /\.db\.test\.tsx?$/.test(file));
  const inventory = discoverDbProfile(workspaceRoot);

  it("finds the database specs on disk", () => {
    expect(databaseSpecs.length).toBeGreaterThan(0);
    expect(databaseSpecs).toContain("features/consents/read-model/consent-bundle-acceptance.db.test.ts");
  });

  it.each(databaseSpecs)("discovers %s in test:db", (spec: string) => {
    expect(inventory.aggregate.files).toContain(spec);
  });

  it.each(databaseSpecs)("excludes %s from test:unit", (spec: string) => {
    expect(inventory.unit.files).not.toContain(spec);
  });

  it("registers no spec that does not exist on disk", () => {
    expect(inventory.violations).toEqual([]);
    expect(inventory.aggregate.files).toEqual(databaseSpecs);
  });

  it("declares the database test profile so the workspace takes the shared heavy slot", () => {
    const manifest = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8")) as {
      chaseSets?: { testProfile?: string };
    };

    expect(manifest.chaseSets?.testProfile).toBe("db");
  });
});
