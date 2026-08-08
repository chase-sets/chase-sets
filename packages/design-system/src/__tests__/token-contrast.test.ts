import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Ink & Foil AA guard (#6015 AC-10).
//
// Every ratio below is computed from the values the stylesheet actually ships, never
// transcribed by hand: a hand-copied ratio table proves only that someone did the
// arithmetic on a value that may no longer be in the file.
//
// Thresholds:
//   4.5:1  foreground and secondary text on background, card and elevated, in both
//          modes; every status-on-soft pair; every on-primary contrast pair.
//   3.0:1  the muted text role. --text-muted / --dark-text-muted is a ratified anchor
//          carrying supporting metadata at large-text and non-body sizes, which is the
//          large-text threshold the acceptance contract names for this role.
//
// Disabled pairs are deliberately absent: disabled controls are the one surface WCAG
// 1.4.3 exempts, and asserting them would force the disabled state to stop reading as
// disabled.
const stylesPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles/styles.css");
const styles = readFileSync(stylesPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const BLOCK_MARKERS = {
  light: '[data-chase-theme-scope][data-color-mode="light"] {',
  darkLiteral: "\n  :root {",
} as const;

type BlockName = keyof typeof BLOCK_MARKERS;

function blockBody(name: BlockName): string {
  const marker = BLOCK_MARKERS[name];
  const markerIndex = styles.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`styles.css no longer contains the '${name}' block marker ${JSON.stringify(marker)}.`);
  }

  const open = markerIndex + marker.length - 1;
  let depth = 0;
  for (let index = open; index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    else if (styles[index] === "}") {
      depth -= 1;
      if (depth === 0) return styles.slice(open + 1, index);
    }
  }
  throw new Error(`styles.css '${name}' block is unbalanced.`);
}

function declarationMap(name: BlockName): Record<string, string> {
  return Object.fromEntries(
    [...blockBody(name).matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);\s*$/gm)].map((match) => [
      match[1]!,
      match[2]!.trim(),
    ]),
  );
}

const light = declarationMap("light");
const darkLiteral = declarationMap("darkLiteral");

function resolveHex(mode: "light" | "dark", role: string): string {
  const property = mode === "light" ? `--${role}` : `--dark-${role}`;
  const value = (mode === "light" ? light : darkLiteral)[property];
  if (value === undefined) {
    throw new Error(`styles.css does not declare ${property}.`);
  }
  // Fail closed rather than coerce. An alpha or non-hex token cannot be scored against
  // an opaque surface without knowing what it composites over, so a pair list that
  // drifts onto one must be rewritten, not silently approximated.
  if (!/^#[0-9a-f]{6}$/.test(value)) {
    throw new Error(`${property} is ${JSON.stringify(value)}, which is not an opaque hex this guard can score.`);
  }
  return value;
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const SURFACE_ROLES = ["background", "card", "elevated"] as const;
const MODES = ["light", "dark"] as const;

type Pair = readonly [mode: (typeof MODES)[number], foregroundRole: string, backgroundRole: string, minimum: number];

const TEXT_ON_SURFACE_PAIRS: readonly Pair[] = MODES.flatMap((mode) =>
  SURFACE_ROLES.flatMap((surface) => [
    [mode, "foreground", surface, 4.5] as Pair,
    [mode, "text-secondary", surface, 4.5] as Pair,
    [mode, "text-muted", surface, 3] as Pair,
  ]),
);

const STATUS_ON_SOFT_PAIRS: readonly Pair[] = MODES.flatMap((mode) =>
  (["success", "warning", "danger", "info", "trust", "deal", "rating"] as const).map(
    (status) => [mode, status, `${status}-soft`, 4.5] as Pair,
  ),
);

const ON_PRIMARY_PAIRS: readonly Pair[] = MODES.map((mode) => [mode, "primary-foreground", "primary", 4.5] as Pair);

function label([mode, foregroundRole, backgroundRole]: Pair): string {
  return `${mode}: --${foregroundRole} on --${backgroundRole}`;
}

describe("token contrast", () => {
  const observed: string[] = [];

  it.each([...TEXT_ON_SURFACE_PAIRS, ...STATUS_ON_SOFT_PAIRS, ...ON_PRIMARY_PAIRS].map((pair) => [label(pair), pair]))(
    "%s",
    (_name, pair) => {
      const [mode, foregroundRole, backgroundRole, minimum] = pair as Pair;
      const foreground = resolveHex(mode, foregroundRole);
      const background = resolveHex(mode, backgroundRole);
      const ratio = contrastRatio(foreground, background);

      observed.push(
        `${label(pair as Pair).padEnd(44)} ${foreground} on ${background}  ${ratio.toFixed(2)}:1 (>= ${minimum})`,
      );
      expect(
        Number(ratio.toFixed(2)),
        `${label(pair as Pair)}: ${ratio.toFixed(2)} < ${minimum}`,
      ).toBeGreaterThanOrEqual(minimum);
    },
  );

  it("reports the computed ratio table", () => {
    // Printed so the PR body's ratio table is a transcript of this run rather than a
    // parallel hand-maintained artifact.
    console.log(`\ncomputed contrast ratios (${observed.length} pairs)\n${observed.join("\n")}`);
    expect(observed.length).toBe(TEXT_ON_SURFACE_PAIRS.length + STATUS_ON_SOFT_PAIRS.length + ON_PRIMARY_PAIRS.length);
  });
});
