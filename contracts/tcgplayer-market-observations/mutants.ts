import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { expect } from "vitest";

type Replacement = readonly [needle: string | RegExp, replacement: string];

// Test-only source-derived mutants. The contract has no imports, so the stripped
// source can be evaluated with an empty binding list without adding a dependency.
export function sourceMutant<T>(replacements: readonly Replacement[], symbol: string): T {
  let source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  for (const [needle, replacement] of replacements) {
    if (typeof needle === "string") {
      expect(source.split(needle), needle).toHaveLength(2);
    } else {
      const globalNeedle = new RegExp(needle.source, needle.flags.includes("g") ? needle.flags : `${needle.flags}g`);
      expect(Array.from(source.matchAll(globalNeedle)), needle.toString()).toHaveLength(1);
    }
    source = source.replace(needle, replacement);
  }
  const mutated = stripTypeScriptTypes(source, { mode: "transform" }).replace(/^export /gm, "");
  return new Function(`${mutated}\nreturn ${symbol};`)() as T;
}
