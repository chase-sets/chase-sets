import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConnectorBackground } from "../domain/connector-background";
import { backgroundFixture } from "./connector-background-test-support";

vi.mock("../domain/connector-background", { spy: true });

const dbFiles = [
  "features/connector-client/tests/extension-connector-scope-separation.db.test.ts",
  "features/connector-client/tests/extension-pairing-redirect-and-scope.db.test.ts",
];
type Scripts = Readonly<Record<string, string>>;
function selection(scripts: Scripts, dbFile: string) {
  const dbArgs = Object.entries(scripts)
    .filter(([name]) => /^test:db:\d+$/.test(name))
    .flatMap(([, script]) => script.split(/\s+/));
  const unitArgs = scripts["test:unit"].split(" ");
  return {
    dbListed: dbArgs.filter((argument) => argument === dbFile).length === 1,
    unitExcluded: unitArgs.some((arg, index) => arg === "--exclude" && unitArgs[index + 1] === dbFile),
  };
}
const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf8")) as {
  scripts: Scripts;
};

describe("extension-db-enrollment", () => {
  it.each(dbFiles)("numbered DB partitions list %s once and ordinary units exclude it without a DB URL", (dbFile) => {
    expect(selection(pkg.scripts, dbFile)).toEqual({ dbListed: true, unitExcluded: true });
    const dbSource = readFileSync(resolve(import.meta.dirname, "../../../", dbFile), "utf8");
    expect(dbSource).toContain('from "@chase-sets/auth/server"');
    expect(dbSource).toContain("createConnectorOAuthService(");
    expect(dbSource).toContain("createConnectorCredentialRoutes(feed, pools.channels)");
    expect(dbSource).not.toContain("deployables/");
    if (dbFile.includes("pairing-redirect")) {
      const support = readFileSync(resolve(import.meta.dirname, "connector-background-test-support.ts"), "utf8");
      expect(support).toContain('import { createConnectorBackground } from "../domain/connector-background"');
      expect(support).toContain("factory = createConnectorBackground");
      expect(support).toContain("const background = factory(ports)");
      expect(dbSource).toContain("backgroundFixture(");
    }
  });
  it("enrolls the real background as the default even when factory injection is supported", async () => {
    vi.mocked(createConnectorBackground).mockClear();
    const fixture = backgroundFixture("unpaired");
    expect(createConnectorBackground).toHaveBeenCalledExactlyOnceWith(fixture.ports);
    expect(vi.mocked(createConnectorBackground).mock.results[0]?.value).toBe(fixture.background);
    expect((await fixture.background.boot()).state).toBe("unpaired");
    expect((await fixture.background.status()).state).toBe("unpaired");
  });
  it.each(dbFiles)("unlisted-importer control and missing unit exclusion cannot certify %s enrollment", (dbFile) => {
    const unlisted = Object.fromEntries(
      Object.entries(pkg.scripts).map(([name, script]) => [
        name,
        /^test:db:\d+$/.test(name)
          ? script
              .split(/\s+/)
              .filter((arg) => arg !== dbFile)
              .join(" ")
          : script,
      ]),
    );
    expect(selection(unlisted, dbFile).dbListed).toBe(false);
    const duplicated = { ...pkg.scripts, "test:db:999": `vitest run ${dbFile}` };
    expect(selection(duplicated, dbFile).dbListed).toBe(false);
    const unexcluded = { ...pkg.scripts, "test:unit": pkg.scripts["test:unit"].replace(` --exclude ${dbFile}`, "") };
    expect(selection(unexcluded, dbFile).unitExcluded).toBe(false);
  });
});
