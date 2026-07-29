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

function rawClassNameJsxElementFinding(sourceFile, node) {
  if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return null;
  if (!hasJsxAttribute(node, "className")) return null;

  const tagName = jsxTagName(node);

  return {
    node: node.tagName,
    detail: tagName ?? "member JSX tag",
  };
}

export function rawClassNameHostElementFinding(sourceFile, node) {
  const finding = rawClassNameJsxElementFinding(sourceFile, node);
  if (!finding) return null;

  const tagName = jsxTagName(node);
  if (!tagName || !/^[a-z]/.test(tagName)) return null;

  return finding;
}
