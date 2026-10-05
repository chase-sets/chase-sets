import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

export const embeddedThemeSourcePath = "packages/design-system/src/theme/embedded-surface-theme.ts";
export const adapterSourcePath = "infrastructure/stripe-appearance/stripe-appearance.ts";
const commonDigestPaths = [
  "contracts/embedded-surface-theme/index.ts",
  embeddedThemeSourcePath,
  adapterSourcePath,
  "packages/design-system/src/theme/internal-token-values.ts",
  "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json",
  "deployables/marketplace/e2e/support/stripe-appearance-evidence-source.ts",
  "playwright.stripe-appearance-evidence.config.ts",
] as const;

export function consumedEmbeddedThemeCssInputs(root: string): string[] {
  const source = readFileSync(join(root, embeddedThemeSourcePath), "utf8");
  return parseEmbeddedThemeCssInputs(source);
}

export function parseEmbeddedThemeCssInputs(source: string): string[] {
  const ast = ts.createSourceFile(embeddedThemeSourcePath, source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations]);
  const map = declarations.find((node) => node.name.getText(ast) === "embeddedSurfaceThemeCssInputs");
  if (
    !map?.initializer ||
    !ts.isAsExpression(map.initializer) ||
    !ts.isObjectLiteralExpression(map.initializer.expression)
  )
    throw new Error("Embedded theme input literal map missing");
  const slots = new Set<string>();
  const names = map.initializer.expression.properties.map((property) => {
    if (
      !ts.isPropertyAssignment(property) ||
      !ts.isIdentifier(property.name) ||
      !ts.isStringLiteral(property.initializer) ||
      !/^--[\w-]+$/.test(property.initializer.text) ||
      slots.has(property.name.text)
    )
      throw new Error("Embedded theme input map must contain unique literal pairs");
    slots.add(property.name.text);
    return property.initializer.text;
  });
  if (
    names.length !== 34 ||
    new Set(names).size !== 34 ||
    slots.size !== 34 ||
    !slots.has("pageBackground") ||
    !slots.has("modalLayer")
  )
    throw new Error("Embedded theme input map is incomplete");
  return names.sort();
}

export function embeddedAppearanceSourceDigests(root: string, specPath: string): Record<string, string> {
  const paths = [...commonDigestPaths, specPath];
  return Object.fromEntries(
    paths.map((relativePath) => [
      relativePath,
      createHash("sha256")
        .update(readFileSync(join(root, relativePath)))
        .digest("hex"),
    ]),
  );
}
