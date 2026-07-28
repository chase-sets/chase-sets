import ts from "@chase-sets/typescript-compiler-api";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { repoRoot } from "./lib/repo.mjs";
import { listTrackedLocaleModulePaths } from "./sync-workspace-metadata.mjs";

const englishFilePaths = listTrackedLocaleModulePaths(repoRoot).filter(
  (filePath) =>
    filePath === "contracts/localization/locales/en.ts" || filePath.startsWith("contracts/localization/locales/en/"),
);
const englishKeys = new Set(
  englishFilePaths.flatMap((filePath) =>
    [...fs.readFileSync(filePath, "utf8").matchAll(/^  "([^"]+)":/gm)].map((match) => match[1]),
  ),
);

const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx"], {
  encoding: "utf8",
})
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => fs.existsSync(file))
  .filter(isCheckedSourceFile);

const copyAttributes = new Set([
  "aria-label",
  "description",
  "emptyDescription",
  "emptyMessage",
  "emptyTitle",
  "eyebrow",
  "fallbackImageAlt",
  "helperText",
  "imageAlt",
  "label",
  "placeholder",
  "title",
  "total",
  "totalLabel",
]);

const copyProperties = new Set([
  "actionLabel",
  "ariaLabel",
  "body",
  "description",
  "detail",
  "emptyDescription",
  "emptyMessage",
  "emptyTitle",
  "error",
  "eyebrow",
  "fallbackImageAlt",
  "header",
  "helperText",
  "imageAlt",
  "label",
  "message",
  "placeholder",
  "subtitle",
  "summary",
  "text",
  "title",
  "total",
  "totalLabel",
]);

const allowedLiteralValues = new Set([
  "Enter",
  "US",
  "USD",
  "UTC",
  "USPS_GROUND_ADVANTAGE",
  "PRIORITY",
  "PRIORITY_EXPRESS",
  "MEDIA_MAIL",
]);

const violations = [];

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  visit(sourceFile, sourceFile);
}

if (violations.length > 0) {
  console.error("Localization check failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`Localization check passed for ${files.length} source files.`);

function isCheckedSourceFile(file) {
  const normalized = file.replaceAll("\\", "/");
  if (normalized.includes("/.react-router/")) return false;
  if (normalized.includes(".test.")) return false;
  if (normalized.includes(".test-data.")) return false;
  if (normalized.startsWith("contracts/localization/")) return false;
  if (normalized.includes("/features/") && normalized.includes("/domain/")) return false;
  if (normalized.includes("/features/") && normalized.includes("/read-model/")) return false;
  if (normalized.includes("/features/") && normalized.includes("/integrations/")) return false;
  if (normalized.includes("/features/") && normalized.endsWith("/api/seed.ts")) return false;
  if (normalized.includes("/features/") && normalized.endsWith("/api/runtime.ts")) return false;

  return (
    normalized.includes("/features/") ||
    normalized.includes("/routes/") ||
    normalized.includes("/support/api-support/") ||
    normalized.includes("/support/request-support/") ||
    normalized.includes("/support/shell-support/") ||
    normalized.startsWith("deployables/marketplace/app/") ||
    normalized.startsWith("deployables/admin-web/app/")
  );
}

function visit(sourceFile, node) {
  if (ts.isCallExpression(node) && isTranslateCall(node)) {
    const key = node.arguments[0];
    if (key && ts.isStringLiteral(key) && !englishKeys.has(key.text)) {
      report(sourceFile, key, `missing English translation for "${key.text}"`);
    }
  }

  if (ts.isJsxText(node)) {
    const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
    if (looksLikeCopy(text)) {
      report(sourceFile, node, `hardcoded JSX text "${text}"`);
    }
  }

  if (
    ts.isJsxAttribute(node) &&
    node.initializer &&
    ts.isStringLiteral(node.initializer) &&
    copyAttributes.has(propertyName(node.name)) &&
    looksLikeCopy(node.initializer.text)
  ) {
    report(sourceFile, node.initializer, `hardcoded ${propertyName(node.name)} attribute "${node.initializer.text}"`);
  }

  if (
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    !isInsideTranslateCall(node) &&
    ts.isPropertyAssignment(node.parent) &&
    copyProperties.has(propertyName(node.parent.name)) &&
    looksLikeCopy(node.text)
  ) {
    report(sourceFile, node, `hardcoded ${propertyName(node.parent.name)} property "${node.text}"`);
  }

  if (
    (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    !isInsideTranslateCall(node) &&
    isCopyBearingTemplate(node) &&
    looksLikeCopy(templateStaticText(node))
  ) {
    report(sourceFile, node, `hardcoded template copy "${templateStaticText(node)}"`);
  }

  ts.forEachChild(node, (child) => visit(sourceFile, child));
}

function isTranslateCall(node) {
  return ts.isIdentifier(node.expression) && node.expression.text === "t";
}

function isInsideTranslateCall(node) {
  let current = node.parent;
  while (current) {
    if (ts.isCallExpression(current) && isTranslateCall(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : "";
}

function isCopyBearingTemplate(node) {
  if (ts.isPropertyAssignment(node.parent) && copyProperties.has(propertyName(node.parent.name))) {
    return true;
  }

  let current = node.parent;
  while (current) {
    if (ts.isJsxExpression(current)) {
      const parent = current.parent;
      if (ts.isJsxAttribute(parent) && copyAttributes.has(propertyName(parent.name))) {
        return true;
      }
      return ts.isJsxElement(parent) || ts.isJsxFragment(parent);
    }
    if (ts.isCallExpression(current) || ts.isFunctionLike(current)) {
      return false;
    }
    current = current.parent;
  }

  return false;
}

function templateStaticText(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("{value}");
}

function looksLikeCopy(text) {
  if (!text || allowedLiteralValues.has(text)) return false;
  if (!/[A-Za-z]{2,}/.test(text)) return false;
  if (text.startsWith("/") || text.startsWith("#")) return false;
  if (/^https?:\/\//.test(text)) return false;
  if (/^[A-Z0-9_]+$/.test(text)) return false;
  if (/^[a-z0-9_./:-]+$/.test(text)) return false;
  if (text.includes("width=device-width")) return false;
  return /\s|[.!?,:()]|^[A-Z]/.test(text);
}

function report(sourceFile, node, message) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  violations.push(`${sourceFile.fileName}:${position.line + 1}:${position.character + 1} ${message}`);
}
