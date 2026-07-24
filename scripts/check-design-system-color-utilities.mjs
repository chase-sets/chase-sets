import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { collectFiles } from "./lib/files.mjs";
import { normalizeRelative, repoRoot } from "./lib/repo.mjs";

const sourceExtensions = new Set([".ts", ".tsx"]);
const nonColorUtilityValues = new Set([
  "base",
  "balance",
  "b",
  "black",
  "box",
  "center",
  "clip",
  "collapse",
  "current",
  "currentcolor",
  "dashed",
  "hidden",
  "inherit",
  "l",
  "left",
  "lg",
  "none",
  "pre-wrap",
  "pretty",
  "r",
  "right",
  "solid",
  "sm",
  "t",
  "tokenLg",
  "tokenMd",
  "tokenNone",
  "tokenSm",
  "transparent",
  "white",
  "wrap",
  "xl",
  "xs",
  "2xs",
  "3xs",
]);

export const allowedDesignSystemColorUtilityValues = Object.freeze(
  new Set([
    "accent",
    "accent-2",
    "accent-active",
    "accent-contrast",
    "accent-foreground",
    "accent-hover",
    "accent-soft",
    "background",
    "border",
    "brand",
    "brand-2",
    "danger",
    "danger-active",
    "danger-contrast",
    "danger-hover",
    "danger-soft",
    "deal",
    "deal-soft",
    "disabled",
    "elevated",
    "focus",
    "foreground",
    "info",
    "info-active",
    "info-contrast",
    "info-hover",
    "info-soft",
    "input",
    "inverse",
    "link",
    "muted",
    "overlay",
    "primary",
    "primary-soft",
    "rating",
    "rating-soft",
    "secondary",
    "success",
    "success-active",
    "success-contrast",
    "success-hover",
    "success-soft",
    "surface",
    "surface-2",
    "surface-3",
    "tertiary",
    "trust",
    "trust-soft",
    "warning",
    "warning-active",
    "warning-contrast",
    "warning-hover",
    "warning-soft",
  ]),
);

function stripVariantPrefix(className) {
  let bracketDepth = 0;

  for (let index = className.length - 1; index >= 0; index -= 1) {
    const char = className[index];
    if (char === "]") {
      bracketDepth += 1;
      continue;
    }
    if (char === "[") {
      bracketDepth -= 1;
      continue;
    }
    if (char === ":" && bracketDepth === 0) {
      return className.slice(index + 1);
    }
  }

  return className;
}

function parseColorUtility(className) {
  const utility = stripVariantPrefix(className)
    .replace(/^!/, "")
    .replace(/[),.;]+$/, "");
  if (utility.startsWith("[") || utility.includes("[") || utility.includes("]") || utility.includes("{")) {
    return null;
  }

  const match = /^(accent|bg|border|divide|ring|text)-(.+)$/.exec(utility);
  if (!match) {
    return null;
  }

  const [, prefix, rawValue] = match;
  if (prefix === "divide" && ["x", "y"].includes(rawValue)) {
    return null;
  }

  const directionalBorderMatch = prefix === "border" ? /^(t|r|b|l|x|y)-(.+)$/.exec(rawValue) : null;
  const directionalBorderValue = directionalBorderMatch?.[2];
  const value = (directionalBorderValue ?? rawValue).split("/")[0];
  if (!value || nonColorUtilityValues.has(value) || /^\d/.test(value)) {
    return null;
  }

  return { prefix, value, utility };
}

export function collectDesignSystemColorUtilityViolations({
  files,
  rootDir = repoRoot,
  readFile = readFileSync,
  allowedValues = allowedDesignSystemColorUtilityValues,
} = {}) {
  const violations = [];

  for (const filePath of files) {
    const content = readFile(filePath, "utf8");
    const classCandidates = content.match(/["'`]([^"'`]*\b(?:accent|bg|border|divide|ring|text)-[^"'`]*)["'`]/g) ?? [];

    for (const candidate of classCandidates) {
      const unquoted = candidate.slice(1, -1);
      for (const className of unquoted.split(/\s+/).filter(Boolean)) {
        const colorUtility = parseColorUtility(className);
        if (!colorUtility || allowedValues.has(colorUtility.value)) {
          continue;
        }

        violations.push(
          `${normalizeRelative(filePath, rootDir)}: '${colorUtility.utility}' uses unknown design-system color '${colorUtility.value}'.`,
        );
      }
    }
  }

  return [...new Set(violations)].sort((left, right) => left.localeCompare(right, "en"));
}

export async function checkDesignSystemColorUtilities(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const sourceRoot = options.sourceRoot ?? path.join(rootDir, "packages", "design-system", "src");
  const files =
    options.files ??
    (await collectFiles(sourceRoot, { extensions: sourceExtensions })).filter(
      (filePath) => !normalizeRelative(filePath, rootDir).includes("/__tests__/"),
    );
  const violations = collectDesignSystemColorUtilityViolations({ ...options, files, rootDir });

  return {
    passed: violations.length === 0,
    files: files
      .map((filePath) => normalizeRelative(filePath, rootDir))
      .sort((left, right) => left.localeCompare(right, "en")),
    violations,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkDesignSystemColorUtilities();

  if (!result.passed) {
    console.error("Design-system color utility check failed:");
    for (const violation of result.violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log(`Design-system color utility check passed (${result.files.length} source files scanned).`);
}
