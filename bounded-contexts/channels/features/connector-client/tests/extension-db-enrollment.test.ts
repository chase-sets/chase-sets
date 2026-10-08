import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dbFile = "features/connector-client/tests/extension-connector-scope-separation.db.test.ts";
type Scripts = { "test:db": string; "test:unit": string };
function selection(scripts: Scripts) {
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
  it("unnumbered DB caller lists the exact file and ordinary units exclude it without a DB URL", () => {
    expect(selection(pkg.scripts)).toEqual({ dbListed: true, unitExcluded: true });
    const dbSource = readFileSync(
      resolve(import.meta.dirname, "extension-connector-scope-separation.db.test.ts"),
      "utf8",
    );
    expect(dbSource).toContain('from "@chase-sets/auth/server"');
    expect(dbSource).toContain("createConnectorOAuthService(");
    expect(dbSource).toContain("createConnectorCredentialRoutes(feed, pools.channels)");
    expect(dbSource).not.toContain("deployables/");
  });
  it("unlisted-importer control and missing unit exclusion cannot certify enrollment", () => {
    const unlisted = {
      ...pkg.scripts,
      "test:db": pkg.scripts["test:db"]
        .split(" ")
        .filter((arg) => arg !== dbFile)
        .join(" "),
    };
    expect(selection(unlisted).dbListed).toBe(false);
    const unexcluded = { ...pkg.scripts, "test:unit": pkg.scripts["test:unit"].replace(` --exclude ${dbFile}`, "") };
    expect(selection(unexcluded).unitExcluded).toBe(false);
  });
});
