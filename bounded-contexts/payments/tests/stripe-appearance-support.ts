import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Mode = "light" | "dark";
export function repositoryRoot() {
  let candidate = process.cwd();
  while (!existsSync(join(candidate, "pnpm-workspace.yaml"))) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error(`Could not locate the repository root from ${process.cwd()}`);
    candidate = parent;
  }
  return candidate;
}

export const stylesheet = readFileSync(join(repositoryRoot(), "packages/design-system/src/styles/styles.css"), "utf8");
export function declarations(css: string) {
  const blocks: { selector: string; context: string[]; entries: (readonly [string, string])[] }[] = [];
  const stack: { selector: string; start: number; nested: boolean }[] = [];
  let boundary = 0;
  let quote = "";
  let comment = false;
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]!;
    if (comment) {
      if (char === "*" && css[index + 1] === "/") {
        comment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && css[index + 1] === "*") {
      comment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") {
      if (stack.length) stack[stack.length - 1]!.nested = true;
      stack.push({
        selector: css
          .slice(boundary, index)
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .trim(),
        start: index + 1,
        nested: false,
      });
      boundary = index + 1;
    } else if (char === "}") {
      const block = stack.pop();
      if (!block) throw new Error("Unbalanced stylesheet block");
      if (!block.nested)
        blocks.push({
          selector: block.selector,
          context: stack.map((parent) => parent.selector),
          entries: [
            ...css
              .slice(block.start, index)
              .replace(/\/\*[\s\S]*?\*\//g, "")
              .matchAll(/(--[\w-]+):\s*([^;]+);/g),
          ].map((entry) => [entry[1]!, entry[2]!.trim()] as const),
        });
      boundary = index + 1;
    } else if (char === ";") boundary = index + 1;
  }
  if (stack.length || quote || comment) throw new Error("Unterminated stylesheet block, string or comment");
  return blocks;
}

export function cssValues(mode: Mode, css = stylesheet): Record<string, string> {
  const blocks = declarations(css);
  const values: Record<string, string> = {};
  // Follow the shipped base cascade, including shared aliases and the selected
  // explicit theme. Responsive geometry and forced colors are not palette modes.
  for (const block of blocks) {
    if (block.context.length !== 1 || block.context[0] !== "@layer base") continue;
    if (
      block.selector === ":root" ||
      block.selector.includes('[data-theme="light"]') ||
      block.selector.includes("[data-theme],") ||
      (mode === "dark" && block.selector.startsWith('[data-theme="dark"]'))
    ) {
      Object.assign(values, Object.fromEntries(block.entries));
    }
  }
  const resolve = (name: string, seen = new Set<string>()): string => {
    if (seen.has(name) || !(name in values)) throw new Error(`${mode}/${name}: missing or cyclic declaration`);
    seen.add(name);
    const value = values[name]!;
    const alias = value.match(/^var\((--[\w-]+)\)$/);
    return alias ? resolve(alias[1]!, seen) : value;
  };
  return Object.fromEntries(Object.keys(values).map((name) => [name, resolve(name)]));
}
