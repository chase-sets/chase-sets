import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { expect } from "vitest";

type Replacement = readonly [needle: string, replacement: string];

// Test-only, source-derived guard-disabled mutants. The named product module is
// read, each enforcement point of exactly one guard is replaced, and the result is
// evaluated against explicit bindings for its imports. No product file or module
// binding changes.
export function guardDisabledMutant<T>(
  path: string,
  replacements: Replacement | readonly Replacement[],
  symbol: string,
  bindings: Readonly<Record<string, unknown>>,
): T {
  let source = readFileSync(new URL(path, import.meta.url), "utf8");
  const pairs = (typeof replacements[0] === "string" ? [replacements] : replacements) as readonly Replacement[];
  for (const [needle, replacement] of pairs) {
    expect(source.split(needle), `${path}: ${needle}`).toHaveLength(2);
    source = source.replace(needle, replacement);
  }
  const mutated = stripTypeScriptTypes(source, { mode: "transform" })
    .replace(/import\s*(?:\{[\s\S]*?\}|\*\s+as\s+\w+|\w+)\s*from\s*"[^"]+";/g, "")
    .replace(/^export /gm, "");
  return new Function(...Object.keys(bindings), `${mutated}\nreturn ${symbol};`)(...Object.values(bindings)) as T;
}
