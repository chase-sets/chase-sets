import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dbFiles = [
  "features/connector-client/tests/extension-connector-scope-separation.db.test.ts",
  "features/connector-client/tests/extension-pairing-redirect-and-scope.db.test.ts",
];
type Scripts = { "test:db": string; "test:unit": string };
function selection(scripts: Scripts, dbFile: string) {
  const dbArgs = scripts["test:db"].split(" ");
  const unitArgs = scripts["test:unit"].split(" ");
  return {
    dbListed: dbArgs.includes(dbFile),
    unitExcluded: unitArgs.some((arg, index) => arg === "--exclude" && unitArgs[index + 1] === dbFile),
  };
}
const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf8")) as {
  scripts: Scripts;
};

describe("extension-db-enrollment", () => {
  it.each(dbFiles)("unnumbered DB caller lists %s and ordinary units exclude it without a DB URL", (dbFile) => {
    expect(selection(pkg.scripts, dbFile)).toEqual({ dbListed: true, unitExcluded: true });
    const dbSource = readFileSync(resolve(import.meta.dirname, "../../../", dbFile), "utf8");
    expect(dbSource).toContain('from "@chase-sets/auth/server"');
    expect(dbSource).toContain("createConnectorOAuthService(");
    expect(dbSource).toContain("createConnectorCredentialRoutes(feed, pools.channels)");
    expect(dbSource).not.toContain("deployables/");
    if (dbFile.includes("pairing-redirect")) {
      const support = readFileSync(resolve(import.meta.dirname, "connector-background-test-support.ts"), "utf8");
      expect(support).toContain("createConnectorBackground(ports)");
      expect(dbSource).toContain("backgroundFixture(");
    }
  });
  it.each(dbFiles)("unlisted-importer control and missing unit exclusion cannot certify %s enrollment", (dbFile) => {
    const unlisted = {
      ...pkg.scripts,
      "test:db": pkg.scripts["test:db"]
        .split(" ")
        .filter((arg) => arg !== dbFile)
        .join(" "),
    };
    expect(selection(unlisted, dbFile).dbListed).toBe(false);
    const unexcluded = { ...pkg.scripts, "test:unit": pkg.scripts["test:unit"].replace(` --exclude ${dbFile}`, "") };
    expect(selection(unexcluded, dbFile).unitExcluded).toBe(false);
  });
});
