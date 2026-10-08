import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const producerDbTest = "features/outbound-sync/tests/order-pull-producer.db.test.ts";
// Built indirectly so this file does not match its own markers.
const databaseUrlMarker = ["TEST", "DATABASE", "URL"].join("_");
const transportHarnessMarker = ["transport", "test", "support"].join("-");
const dbHarnessMarker = new RegExp(`\\b${databaseUrlMarker}\\b|${transportHarnessMarker}`);

type Scripts = Readonly<Record<"test:db" | "test:unit", string>>;

/**
 * A test that reaches the DB harness must be a `.db.test.ts` file, run once by the DB profile and be
 * excluded from the URL-less unit profile. Otherwise it is either skipped everywhere or leaks into unit CI.
 */
function enrollmentViolations(files: ReadonlyMap<string, string>, scripts: Scripts): string[] {
  const dbArguments = scripts["test:db"].split(/\s+/);
  const unitArguments = scripts["test:unit"].split(/\s+/);
  const violations: string[] = [];
  for (const [file, source] of files) {
    const dbFile = file.endsWith(".db.test.ts");
    if (!dbFile && !dbHarnessMarker.test(source)) continue;
    if (!dbFile) violations.push(`${file}: imports the DB harness but is not a .db.test.ts file`);
    if (dbArguments.filter((argument) => argument === file).length !== 1)
      violations.push(`${file}: not discovered exactly once by test:db`);
    if (!unitArguments.some((argument, index) => argument === file && unitArguments[index - 1] === "--exclude"))
      violations.push(`${file}: not excluded from test:unit`);
  }
  return violations;
}

function packageTestFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string) => {
    for (const entry of readdirSync(path.join(packageRoot, directory), { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(relative);
      else if (/\.test\.tsx?$/.test(entry.name)) files.set(relative, readFileSync(path.join(packageRoot, relative), "utf8"));
    }
  };
  visit("");
  return files;
}

function packageScripts(): Scripts {
  return JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).scripts as Scripts;
}

describe("order-pull-producer-schema-and-profiles", () => {
  it("discovers the producer DB test in test:db and excludes it from the URL-less unit profile", () => {
    const files = packageTestFiles();
    expect(files.get(producerDbTest)).toContain("describeDb(");
    expect(enrollmentViolations(files, packageScripts())).toEqual([]);
  });

  it("fails enrollment for an importing-but-undiscovered DB test and for a unit leak", () => {
    const scripts = packageScripts();
    const files = new Map([[producerDbTest, `import { describeDb } from "../../connector-feed/tests/${transportHarnessMarker}";`]]);
    expect(
      enrollmentViolations(files, {
        "test:db": scripts["test:db"].replace(` ${producerDbTest}`, ""),
        "test:unit": scripts["test:unit"],
      }),
    ).toEqual([`${producerDbTest}: not discovered exactly once by test:db`]);
    expect(
      enrollmentViolations(files, {
        "test:db": scripts["test:db"],
        "test:unit": scripts["test:unit"].replace(` --exclude ${producerDbTest}`, ""),
      }),
    ).toEqual([`${producerDbTest}: not excluded from test:unit`]);
    const misnamed = "features/outbound-sync/tests/order-pull-undiscovered.test.ts";
    expect(
      enrollmentViolations(new Map([[misnamed, `const url = process.env.${databaseUrlMarker};`]]), scripts),
    ).toEqual([
      `${misnamed}: imports the DB harness but is not a .db.test.ts file`,
      `${misnamed}: not discovered exactly once by test:db`,
      `${misnamed}: not excluded from test:unit`,
    ]);
  });
});
