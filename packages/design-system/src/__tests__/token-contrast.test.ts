import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStripeElementsAppearance } from "../theme/stripe-appearance";

// Every ratio here is computed inside the test from the values the appearance
// factory actually resolves. Nothing is transcribed: a role rebound to a
// lighter or darker token moves these numbers, and the 4.5:1 threshold never
// relaxes.

function repositoryRoot() {
  let candidate = process.cwd();
  while (!existsSync(join(candidate, "pnpm-workspace.yaml"))) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Could not locate the repository root from ${process.cwd()}`);
    }
    candidate = parent;
  }
  return candidate;
}

const fixture = JSON.parse(
  readFileSync(
    join(
      repositoryRoot(),
      "packages",
      "design-system",
      "src",
      "theme",
      "__fixtures__",
      "ink-foil-candidate-tokens.json",
    ),
    "utf8",
  ),
);

const NORMAL_TEXT_MINIMUM_RATIO = 4.5;
const modes = ["light", "dark"] as const;
const sources = ["candidate", "shipped"] as const;

type Mode = (typeof modes)[number];
type Source = (typeof sources)[number];
type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgba {
  const input = value.trim();

  const hex = input.match(/^#([0-9a-f]{3,8})$/i)?.[1];
  if (hex) {
    const expand = hex.length <= 4 ? [...hex].map((char) => char + char).join("") : hex;
    const channel = (index: number) => Number.parseInt(expand.slice(index * 2, index * 2 + 2), 16);
    return { r: channel(0), g: channel(1), b: channel(2), a: expand.length === 8 ? channel(3) / 255 : 1 };
  }

  const rgb = input.match(/^rgba?\(([^)]+)\)$/i)?.[1];
  if (rgb) {
    const parts = rgb
      .split(/[,/\s]+/)
      .filter(Boolean)
      .map(Number);
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
  }

  throw new Error(`token-contrast cannot parse the colour ${JSON.stringify(value)}`);
}

// A translucent foreground is what the eye sees composited over its surface, so
// composite before measuring rather than measuring the declared value.
function composite(foreground: Rgba, surface: Rgba): Rgba {
  if (foreground.a >= 1) return foreground;
  return {
    r: foreground.r * foreground.a + surface.r * (1 - foreground.a),
    g: foreground.g * foreground.a + surface.g * (1 - foreground.a),
    b: foreground.b * foreground.a + surface.b * (1 - foreground.a),
    a: 1,
  };
}

// WCAG 2.1 relative luminance.
function relativeLuminance({ r, g, b }: Rgba) {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(foreground: string, surface: string) {
  const surfaceColor = parseColor(surface);
  const foregroundColor = composite(parseColor(foreground), surfaceColor);
  const [lighter, darker] = [relativeLuminance(foregroundColor), relativeLuminance(surfaceColor)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

const roots: HTMLElement[] = [];

function appearanceFor(mode: Mode, source: Source) {
  const root = document.createElement("div");
  root.dataset.chaseTheme = "";
  root.dataset.colorMode = mode;
  for (const [name, entry] of Object.entries(fixture[mode] as Record<string, Record<Source, string>>)) {
    root.style.setProperty(name, entry[source]);
  }
  document.body.appendChild(root);
  roots.push(root);

  return createStripeElementsAppearance({ scope: root });
}

type Row = {
  role: string;
  surface: string;
  mode: Mode;
  source: Source;
  foreground: string;
  background: string;
  ratio: number;
};

function rowsFor(mode: Mode, source: Source): Row[] {
  const appearance = appearanceFor(mode, source);
  const cardSurface = appearance.variables.colorBackground!;
  const inputSurface = appearance.rules![".Input"]!.backgroundColor!;

  // Every Elements role that renders normal-size text, against each surface it
  // can render on. The input surface is derived, not anchored, so its ratios
  // resolve from the fixture at run time.
  const roles: ReadonlyArray<readonly [string, string]> = [
    ["colorText", appearance.variables.colorText!],
    ["colorTextSecondary", appearance.variables.colorTextSecondary!],
    ["colorTextPlaceholder", appearance.variables.colorTextPlaceholder!],
    [".Label color", appearance.rules![".Label"]!.color!],
    [".Input color", appearance.rules![".Input"]!.color!],
  ];
  const surfaces: ReadonlyArray<readonly [string, string]> = [
    ["card surface", cardSurface],
    ["input surface", inputSurface],
  ];

  return roles.flatMap(([role, foreground]) =>
    surfaces.map(([surface, background]) => ({
      role,
      surface,
      mode,
      source,
      foreground,
      background,
      ratio: contrastRatio(foreground, background),
    })),
  );
}

afterEach(() => {
  while (roots.length > 0) roots.pop()!.remove();
});

describe("Stripe Elements text contrast", () => {
  it("binds colorTextPlaceholder to the secondary text role, not the muted role", () => {
    for (const mode of modes) {
      for (const source of sources) {
        const appearance = appearanceFor(mode, source);
        expect(
          appearance.variables.colorTextPlaceholder,
          `${mode}/${source}: colorTextPlaceholder must resolve from --text-secondary`,
        ).toBe(appearance.variables.colorTextSecondary);
        expect(appearance.variables.colorTextPlaceholder).toBe(fixture[mode]["--text-secondary"][source]);
        expect(appearance.variables.colorTextPlaceholder).not.toBe(fixture[mode]["--text-muted"][source]);
      }
    }
  });

  it("clears 4.5:1 for every normal-size text role, in both modes, from both value sources", () => {
    const rows = modes.flatMap((mode) => sources.flatMap((source) => rowsFor(mode, source)));

    console.log(
      [
        "role                  surface        mode   source     foreground                candidate/shipped surface  ratio",
        ...rows.map((row) =>
          [
            row.role.padEnd(21),
            row.surface.padEnd(14),
            row.mode.padEnd(6),
            row.source.padEnd(10),
            row.foreground.padEnd(25),
            row.background.padEnd(26),
            row.ratio.toFixed(3),
          ].join(" "),
        ),
      ].join("\n"),
    );

    const failures = rows
      .filter((row) => row.ratio < NORMAL_TEXT_MINIMUM_RATIO)
      .map(
        (row) =>
          `${row.role} on ${row.surface}: ${row.ratio.toFixed(2)} < ${NORMAL_TEXT_MINIMUM_RATIO} ` +
          `(${row.mode} mode, ${row.source} values, ${row.foreground} on ${row.background})`,
      );

    expect(failures).toEqual([]);
  });

  it("computes ratios rather than trusting them: known WCAG pairs land on their published values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // The anchored candidate muted ink on the anchored candidate card is the
    // ratio that made the old placeholder binding a defect.
    expect(contrastRatio("#7d7791", "#ffffff")).toBeCloseTo(4.269, 2);
    // A translucent foreground is measured composited over its surface.
    expect(contrastRatio("rgba(0, 0, 0, 0)", "#ffffff")).toBeCloseTo(1, 5);
  });
});
