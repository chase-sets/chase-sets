import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";

const root = fileURLToPath(new URL("../..", import.meta.url));
const devSourceTag = "@browser-e2e-dev-source";
const e2eDirectories = ["marketplace", "admin-web", "public-web"];

function sourceImportsInDeployedSpec(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      imports.push(`dynamic import at ${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
    }
    if ((ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) && node.text.includes("/@fs/")) {
      imports.push(`repository source URL at ${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return imports;
}

function allTestsExcluded(source, file, excludedTags) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let count = 0;
  let allExcluded = true;
  const visit = (node, inheritedTag = false) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(ast) === "test" &&
      node.expression.name.text === "describe"
    ) {
      const title = node.arguments[0];
      const tagged = ts.isStringLiteral(title) && excludedTags.some((tag) => title.text.includes(tag));
      ts.forEachChild(node, (child) => visit(child, inheritedTag || tagged));
      return;
    }
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "test") {
      count += 1;
      const title = node.arguments[0];
      allExcluded &&=
        inheritedTag || (ts.isStringLiteral(title) && excludedTags.some((tag) => title.text.includes(tag)));
    }
    ts.forEachChild(node, (child) => visit(child, inheritedTag));
  };
  visit(ast);
  return count > 0 && allExcluded;
}

function deployedViolations(specs, excludedTags) {
  return specs.flatMap(([file, source]) => {
    if (allTestsExcluded(source, file, excludedTags)) return [];
    return sourceImportsInDeployedSpec(source, file).map((reason) => `${file}: ${reason}`);
  });
}

describe("deployed browser E2E profile", () => {
  it("deployed profile matches no spec importing repository source", () => {
    const config = readFileSync(path.join(root, "playwright.config.ts"), "utf8");
    const specs = e2eDirectories.flatMap((project) => {
      const directory = path.join(root, "deployables", project, "e2e");
      return readdirSync(directory)
        .filter((name) => name.endsWith(".spec.ts"))
        .map((name) => [
          path.join("deployables", project, "e2e", name),
          readFileSync(path.join(directory, name), "utf8"),
        ]);
    });
    expect(deployedViolations(specs, ["@browser-e2e-seed", devSourceTag])).toEqual([]);
    expect(config).toMatch(/grepInvert:\s*skipWebServer\s*\?\s*\/@browser-e2e-\(\?:seed\|dev-source\)\//);
  });

  it("rejects source URLs and variable or literal dynamic imports without a declared exclusion", () => {
    const specs = [
      ["variable.spec.ts", 'test("live", async ({ page }) => page.evaluate(async (url) => import(url), moduleUrl));'],
      ["literal.spec.ts", 'test("live", async ({ page }) => page.evaluate(() => import("../../../packages/x.ts")));'],
      [
        "url.spec.ts",
        'const moduleUrl = `/@fs/${fileURLToPath(new URL("../../../bounded-contexts/x.ts", import.meta.url))}`;',
      ],
    ];
    expect(deployedViolations(specs, [devSourceTag]).map((violation) => violation.split(":")[0])).toEqual([
      "variable.spec.ts",
      "literal.spec.ts",
      "url.spec.ts",
    ]);
    expect(
      deployedViolations(
        [
          [
            "excluded.spec.ts",
            `test.describe("storage ${devSourceTag}", () => { test("internal", () => import(path)); });`,
          ],
        ],
        [devSourceTag],
      ),
    ).toEqual([]);
    expect(
      deployedViolations(
        [["comment.spec.ts", `// ${devSourceTag}\ntest("live", () => import(path));`]],
        [devSourceTag],
      ),
    ).toHaveLength(1);
  });
});
