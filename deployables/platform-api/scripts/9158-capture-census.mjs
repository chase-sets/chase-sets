import assert from "node:assert/strict";
import ts from "@chase-sets/typescript-compiler-api";

export const captureGroups = Object.freeze({
  "test:db:1": [
    "bootstrap-shared-seed-command.db.test.ts",
    "bootstrap-scenario.db.test.ts",
    "bootstrap-production-reconciliation.db.test.ts",
    "bootstrap-lock-contention.db.test.ts",
    "seed-command-full-pools.db.test.ts",
    "connector-mount-gate-isolation.db.test.ts",
  ],
  "test:db:2": [
    "authoritative-seed-resume-recovery.db.test.ts",
    "inventory-seed-resume.db.test.ts",
    "catalog-seed-aggregate-state.db.test.ts",
    "operator-session/operator-session-grant-mint.db.test.ts",
    "operator-session/operator-session-grant-lifecycle.db.test.ts",
    "operator-session/operator-session-grant-scope.db.test.ts",
    "operator-session/operator-session-push.db.test.ts",
    "operator-session/operator-extension-route-contract.db.test.ts",
    "seed-command-catalog.db.test.ts",
  ],
  "test:db:3": [
    "authoritative-seed-resume-core.db.test.ts",
    "authoritative-seed-resume-reconciliation.db.test.ts",
    "catalog-seed-interruption-resume.db.test.ts",
  ],
});

export const captureCensusFiles = Object.freeze(captureGroups["test:db:2"].slice(3));

// This accepts only the six reviewed census files and their existing literal
// tables. It never imports a test, evaluates a fixture, or executes a callback.
export function deriveCaptureCensusCaseNames(file, source, fixtureSource) {
  assert(captureCensusFiles.includes(file), "unknown capture census file");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  assert.equal(parsed.parseDiagnostics.length, 0, "census parse error");
  const names = [];
  const unwrap = (node) =>
    ts.isAsExpression(node) || ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  function table(node) {
    node = unwrap(node);
    if (ts.isArrayLiteralExpression(node)) return [...node.elements];
    assert(ts.isIdentifier(node) && node.text === "deniedOrigins", "unknown dynamic census table");
    assert.equal(file, "operator-session/operator-session-grant-mint.db.test.ts");
    const fixture = ts.createSourceFile("fixture.ts", fixtureSource, ts.ScriptTarget.Latest, true);
    const declarations = fixture.statements.flatMap((statement) =>
      ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
    );
    const declaration = declarations.filter((item) => ts.isIdentifier(item.name) && item.name.text === "deniedOrigins");
    assert.equal(declaration.length, 1, "ambiguous deniedOrigins");
    assert(ts.isArrayLiteralExpression(declaration[0].initializer), "dynamic deniedOrigins");
    return [...declaration[0].initializer.elements];
  }
  function expand(template, item, index) {
    const markers = template.match(/%./g) ?? [];
    assert.equal(markers.length, 1, "unsupported census name format");
    if (markers[0] === "%#") return template.replace("%#", String(index));
    const value = ts.isArrayLiteralExpression(item) ? item.elements[0] : item;
    if (markers[0] === "%s") {
      assert(ts.isStringLiteralLike(value), "nonliteral census name");
      return template.replace("%s", value.text);
    }
    assert.equal(markers[0], "%i", "unsupported census interpolation");
    const negative = ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken;
    const number = negative ? value.operand : value;
    assert(ts.isNumericLiteral(number), "nonliteral census numeric name");
    return template.replace("%i", String((negative ? -1 : 1) * Number(number.text)));
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "it") {
      assert(ts.isStringLiteralLike(node.arguments[0]), "nonliteral census case");
      names.push(node.arguments[0].text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === "it"
    ) {
      assert.equal(node.expression.expression.name.text, "each", "census modifier refused");
      assert(ts.isStringLiteralLike(node.arguments[0]), "nonliteral census template");
      const rows = table(node.expression.arguments[0]);
      assert(rows.length > 0 && rows.every((row) => !ts.isSpreadElement(row)), "dynamic census rows");
      names.push(...rows.map((row, index) => expand(node.arguments[0].text, row, index)));
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert(names.length > 0 && new Set(names).size === names.length, "empty or duplicate census names");
  return names;
}
