import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";
import type { EmbeddedSurfaceTheme } from "@chase-sets/embedded-surface-theme";
import { repositoryRoot } from "./token-contract";
import {
  embeddedSurfaceThemeSnapshot,
  observeEmbeddedSurfaceTheme,
  resolveEmbeddedSurfaceTheme,
} from "../theme/embedded-surface-theme";

const source = readFileSync(
  join(repositoryRoot(), "packages/design-system/src/theme/embedded-surface-theme.ts"),
  "utf8",
);
const ast = ts.createSourceFile("embedded-surface-theme.ts", source, ts.ScriptTarget.Latest, true);
const map = ast.statements.find(
  (node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(
      (declaration) => declaration.name.getText(ast) === "embeddedSurfaceThemeCssInputs",
    ),
);
if (!map || !ts.isVariableStatement(map)) throw new Error("Closed CSS input map missing");
const declaration = map.declarationList.declarations[0]!;
const expression = declaration.initializer;
if (!expression || !ts.isAsExpression(expression) || !ts.isObjectLiteralExpression(expression.expression)) {
  throw new Error("CSS input map must be a literal object");
}
const entries = expression.expression.properties.map((property) => {
  if (
    !ts.isPropertyAssignment(property) ||
    !ts.isIdentifier(property.name) ||
    !ts.isStringLiteral(property.initializer)
  ) {
    throw new Error("CSS input map must contain only literal slots and CSS names");
  }
  return [property.name.text, property.initializer.text] as const;
});

describe("embedded-surface-theme/v1", () => {
  it("has exactly 34 unique neutral slots and CSS inputs", () => {
    expect(entries).toHaveLength(34);
    expect(new Set(entries.map(([slot]) => slot)).size).toBe(34);
    expect(new Set(entries.map(([, name]) => name)).size).toBe(34);
    expect(entries[0]).toEqual(["pageBackground", "--background"]);
    expect(entries.at(-1)).toEqual(["modalLayer", "--z-modal"]);
    expect(source).not.toMatch(new RegExp(["str", "ipe"].join(""), "i"));
    expect(source).not.toMatch(/provider|Record<string, string>/);
  });

  it("resolves all slots from the nearest scope and observes mode/style changes", async () => {
    const root = document.createElement("div");
    root.dataset.chaseTheme = "";
    root.dataset.colorMode = "dark";
    const child = document.createElement("div");
    root.append(child);
    document.body.append(root);
    for (const [slot, name] of entries) root.style.setProperty(name, slot === "modalLayer" ? "61" : "#123abc");
    const theme = resolveEmbeddedSurfaceTheme({ scope: child });
    expect(theme.mode).toBe("dark");
    for (const [slot] of entries)
      expect(theme[slot as keyof EmbeddedSurfaceTheme]).toBe(slot === "modalLayer" ? "61" : "#123abc");
    const onChange = vi.fn();
    const stop = observeEmbeddedSurfaceTheme({ scope: child }, onChange);
    const previous = embeddedSurfaceThemeSnapshot({ scope: child });
    root.dataset.colorMode = "light";
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onChange).toHaveBeenCalled();
    expect(embeddedSurfaceThemeSnapshot({ scope: child })).not.toBe(previous);
    stop();
    root.remove();
  });

  it("uses light mode and empty unresolved slots without a document or scope", () => {
    expect(resolveEmbeddedSurfaceTheme().mode).toBe("light");
    expect(Object.keys(resolveEmbeddedSurfaceTheme())).toHaveLength(35);
  });
});
