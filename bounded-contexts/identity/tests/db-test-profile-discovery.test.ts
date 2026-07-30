import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Database-backed specs are discoverable in exactly one profile.
 *
 * Identity's `test:db` and `test:unit` scripts name their specs explicitly, so a
 * new `*.db.test.ts` that nobody adds to both lists would run in the unit
 * profile -- where no database is provisioned, so it silently skips -- and never
 * run in the database profile at all. That is the exact shape where a green
 * pipeline certifies a database test that was never executed.
 *
 * This test enumerates the specs from the filesystem rather than from a
 * maintained list, so the omission is what fails: adding a database spec without
 * registering it in both scripts breaks here, and no separate structural guard
 * has to know the spec exists.
 *
 * It reads only `package.json` and the directory tree; it opens no connection.
 */

const workspaceRoot = path.resolve(import.meta.dirname, "..");

function listDatabaseSpecs(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "build" || entry.name === "dist") {
        return [];
      }
      return listDatabaseSpecs(absolute);
    }
    if (!entry.name.endsWith(".db.test.ts")) {
      return [];
    }
    return [path.relative(workspaceRoot, absolute).replaceAll("\\", "/")];
  });
}

function scripts(): Readonly<Record<string, string>> {
  const manifest = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts ?? {};
}

describe("identity database test profile discovery", () => {
  const databaseSpecs = listDatabaseSpecs(workspaceRoot).sort();

  it("finds the database specs on disk", () => {
    expect(databaseSpecs.length).toBeGreaterThan(0);
    expect(databaseSpecs).toContain("features/consents/read-model/consent-bundle-acceptance.db.test.ts");
  });

  it.each(databaseSpecs)("names %s in test:db", (spec: string) => {
    expect(scripts()["test:db"]).toContain(spec);
  });

  it.each(databaseSpecs)("excludes %s from test:unit", (spec: string) => {
    expect(scripts()["test:unit"]).toContain(`--exclude ${spec}`);
  });

  it("registers no spec that does not exist on disk", () => {
    const registered = (scripts()["test:db"] ?? "")
      .split(/\s+/)
      .filter((token) => token.endsWith(".db.test.ts"))
      .sort();

    expect(registered).toEqual(databaseSpecs);
  });

  it("declares the database test profile so the workspace takes the shared heavy slot", () => {
    const manifest = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8")) as {
      chaseSets?: { testProfile?: string };
    };

    expect(manifest.chaseSets?.testProfile).toBe("db");
  });
});
