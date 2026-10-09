import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";

const contextRoot = resolve(import.meta.dirname, "../../..");
const productionRoots = ["server.ts", "index.ts", "client.ts"];
const fixtureExport =
  'export { failConnectorSettlementAt } from "./features/connector-feed/tests/settlement-test-support";';

function checkProductionGraph(entry: string, extraExport = "") {
  const root = resolve(contextRoot, entry);
  const visited = new Set<string>();
  function visit(path: string) {
    if (visited.has(path)) return;
    visited.add(path);
    const localPath = relative(contextRoot, path).replaceAll("\\", "/");
    if (/(^|\/)(tests|__tests__|e2e|coverage|\.turbo)(\/|$)|\.(test|spec)\./.test(localPath)) {
      throw new Error(`production dependency pruned by Dockerfile: ${localPath}`);
    }
    if (path.endsWith(".json")) {
      JSON.parse(readFileSync(path, "utf8"));
      return;
    }
    const runtime = ts.transpileModule(readFileSync(path, "utf8") + (path === root ? extraExport : ""), {
      fileName: path,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    }).outputText;
    for (const { fileName: specifier } of ts.preProcessFile(runtime).importedFiles) {
      if (!specifier.startsWith(".") && !specifier.startsWith("@chase-sets/channels/")) continue;
      const target = ts.resolveModuleName(
        specifier,
        path,
        { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true },
        ts.sys,
      ).resolvedModule;
      if (!target || target.resolvedFileName.endsWith(".d.ts")) {
        throw new Error(`unresolved Channels runtime dependency: ${specifier}`);
      }
      visit(resolve(target.resolvedFileName));
    }
  }
  visit(root);
  return visited;
}

describe("connector production server packaging", () => {
  it("publishes only the owning connector fixture through the test-only entry point", () => {
    const manifest = JSON.parse(readFileSync(resolve(contextRoot, "package.json"), "utf8"));
    expect(manifest.exports["./test-support"]).toBe("./features/connector-feed/tests/settlement-test-support.ts");
    const fixture = readFileSync(resolve(contextRoot, manifest.exports["./test-support"]), "utf8");
    const exports = ts
      .createSourceFile("fixture.ts", fixture, ts.ScriptTarget.Latest, true)
      .statements.filter(
        (statement) =>
          ts.isFunctionDeclaration(statement) &&
          statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
      )
      .map((statement) => (statement as ts.FunctionDeclaration).name?.text);
    expect(exports.sort()).toEqual([
      "connectorSettlementEffects",
      "failConnectorSettlementAt",
      "prepareConnectorBoundSettlement",
    ]);
  });

  it.each(productionRoots)("keeps the %s dependency graph out of Docker-pruned test directories", (entry) => {
    expect(checkProductionGraph(entry).size).toBeGreaterThan(1);
  });

  it.each(productionRoots)("rejects a fixture re-export planted in %s", (entry) => {
    expect(() => checkProductionGraph(entry, `\n${fixtureExport}`)).toThrow(
      "production dependency pruned by Dockerfile: features/connector-feed/tests/settlement-test-support.ts",
    );
  });
});
