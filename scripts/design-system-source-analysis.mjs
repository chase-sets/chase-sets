import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

const checkedRoots = ["bounded-contexts", "deployables", "packages"];

export const checkedExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);

export function sourceKindFor(filePath) {
  if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function isCheckedProductionFile(relativeFile) {
  const normalized = relativeFile.replaceAll("\\", "/");

  if (!checkedRoots.some((root) => normalized.startsWith(`${root}/`))) return false;
  if (!checkedExtensions.has(path.extname(normalized))) return false;
  if (normalized.endsWith(".d.ts")) return false;
  if (normalized.includes("/__tests__/")) return false;
  if (normalized.includes("/fixtures/")) return false;
  if (normalized.includes("/test-fixtures/")) return false;
  if (normalized.includes(".test.")) return false;
  if (normalized.includes(".spec.")) return false;
  if (normalized.includes(".stories.")) return false;
  if (normalized.includes(".test-data.")) return false;

  return true;
}

function jsxTagName(node) {
  if (ts.isIdentifier(node.tagName)) return node.tagName.text;
  return null;
}

function hasJsxAttribute(node, name) {
  return node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.text === name);
}

function unwrapExpression(expression) {
  let current = expression;

  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }

  return current;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function objectLiteralHasClassNameProperty(expression) {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isObjectLiteralExpression(unwrapped)) return false;

  return unwrapped.properties.some((property) => {
    if (ts.isPropertyAssignment(property)) {
      return propertyNameText(property.name) === "className";
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      return property.name.text === "className";
    }

    return false;
  });
}

export function collectClassNameObjectIdentifiers(sourceFile) {
  const identifiers = new Set();

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0 &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      objectLiteralHasClassNameProperty(node.initializer)
    ) {
      identifiers.add(node.name.text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return identifiers;
}

function hasClassNameSpread(node, classNameObjectIdentifiers) {
  return node.attributes.properties.some((property) => {
    if (!ts.isJsxSpreadAttribute(property)) return false;

    const expression = unwrapExpression(property.expression);
    return (
      objectLiteralHasClassNameProperty(expression) ||
      (ts.isIdentifier(expression) && classNameObjectIdentifiers.has(expression.text))
    );
  });
}

function rawClassNameJsxElementFinding(node, classNameObjectIdentifiers) {
  if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return null;

  if (!hasJsxAttribute(node, "className") && !hasClassNameSpread(node, classNameObjectIdentifiers)) return null;

  const tagName = jsxTagName(node);

  return {
    node: node.tagName,
    detail: tagName ?? "member JSX tag",
  };
}

export function rawClassNameHostElementFinding(sourceFile, node, classNameObjectIdentifiers) {
  const finding = rawClassNameJsxElementFinding(
    node,
    classNameObjectIdentifiers ?? collectClassNameObjectIdentifiers(sourceFile),
  );
  if (!finding) return null;

  const tagName = jsxTagName(node);
  if (!tagName || !/^[a-z]/.test(tagName)) return null;

  return finding;
}
