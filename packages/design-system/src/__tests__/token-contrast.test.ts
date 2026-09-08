import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cssValues } from "./token-contract";
import { afterEach, describe, expect, it } from "vitest";
import { createStripeConnectAppearance, createStripeElementsAppearance } from "../theme/stripe-appearance";

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
const sources = ["candidate", "shipped", "css"] as const;

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

function themedRoot(mode: Mode, source: Source) {
  const root = document.createElement("div");
  root.dataset.chaseTheme = "";
  root.dataset.colorMode = mode;
  const values =
    source === "css"
      ? cssValues(mode)
      : Object.fromEntries(
          Object.entries(fixture[mode] as Record<string, Record<"candidate" | "shipped", string>>).map(
            ([name, entry]) => [name, entry[source]],
          ),
        );
  for (const [name, value] of Object.entries(values)) root.style.setProperty(name, value);
  document.body.appendChild(root);
  roots.push(root);

  return root;
}

function elementsAppearanceFor(mode: Mode, source: Source) {
  return createStripeElementsAppearance({ scope: themedRoot(mode, source) });
}

function connectAppearanceFor(mode: Mode, source: Source) {
  return createStripeConnectAppearance({ scope: themedRoot(mode, source) });
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

function elementsRowsFor(mode: Mode, source: Source): Row[] {
  const appearance = elementsAppearanceFor(mode, source);
  const cardSurface = appearance.variables.colorBackground!;
  const inputSurface = appearance.rules![".Input"]!.backgroundColor!;

  // Every Elements role that renders normal-size text, against each surface it
  // can render on. The input surface is derived, not anchored, so its ratios
  // resolve from the fixture at run time.
  const roles: ReadonlyArray<readonly [string, string]> = [
    ["colorText", appearance.variables.colorText!],
    ["colorPrimary", appearance.variables.colorPrimary!],
    ["colorDanger", appearance.variables.colorDanger!],
    ["colorSuccess", appearance.variables.colorSuccess!],
    ["colorWarning", appearance.variables.colorWarning!],
    ["colorTextSecondary", appearance.variables.colorTextSecondary!],
    ["colorTextPlaceholder", appearance.variables.colorTextPlaceholder!],
    [".Label color", appearance.rules![".Label"]!.color!],
    [".Input color", appearance.rules![".Input"]!.color!],
    [".Input--invalid color", appearance.rules![".Input--invalid"]!.color!],
    [".Tab color", appearance.rules![".Tab"]!.color!],
    [".Tab:hover color", appearance.rules![".Tab:hover"]!.color!],
    [".Tab--selected color", appearance.rules![".Tab--selected"]!.color!],
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
  it("covers every Elements normal-text variable and every rule color", () => {
    const appearance = elementsAppearanceFor("light", "css");
    const rows = elementsRowsFor("light", "css");
    const actualRoles = [
      ...Object.keys(appearance.variables).filter((name) => /^color(Text|Primary|Danger|Success|Warning)/.test(name)),
      ...Object.entries(appearance.rules!).flatMap(([selector, rules]) =>
        "color" in rules ? [`${selector} color`] : [],
      ),
    ];
    expect([...new Set(rows.map((row) => row.role))].sort()).toEqual(actualRoles.sort());
  });
  it("binds colorTextPlaceholder to the secondary text role, not the muted role", () => {
    for (const mode of modes) {
      for (const source of sources) {
        const appearance = elementsAppearanceFor(mode, source);
        expect(
          appearance.variables.colorTextPlaceholder,
          `${mode}/${source}: colorTextPlaceholder must resolve from --text-secondary`,
        ).toBe(appearance.variables.colorTextSecondary);
        expect(appearance.variables.colorTextPlaceholder).toBe(
          fixture[mode]["--text-secondary"][source === "css" ? "candidate" : source],
        );
        expect(appearance.variables.colorTextPlaceholder).not.toBe(
          fixture[mode]["--text-muted"][source === "css" ? "candidate" : source],
        );
      }
    }
  });

  it("clears 4.5:1 for every normal-size text role, in both modes, from fixture and actual CSS sources", () => {
    const rows = modes.flatMap((mode) => sources.flatMap((source) => elementsRowsFor(mode, source)));

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

describe("actual stylesheet text and status contrast", () => {
  it.each(modes)("measures complete text/status pairs in %s", (mode) => {
    const values = cssValues(mode);
    const pairs: [string, string, number][] = [
      ["--foreground", "--background", 4.5],
      ["--card-foreground", "--card", 4.5],
      ["--popover-foreground", "--popover", 4.5],
      ["--primary-foreground", "--primary", 4.5],
      ["--secondary-foreground", "--secondary", 4.5],
      ...["--card", "--background", "--surface-2", "--surface-3", "--elevated"].flatMap(
        (surface): [string, string, number][] => [
          ["--text-primary", surface, 4.5],
          ["--text-secondary", surface, 4.5],
          ["--text-muted", surface, 3],
        ],
      ),
      ...["success", "warning", "danger", "info"].flatMap((status): [string, string, number][] => [
        [`--${status}`, `--${status}-soft`, 4.5],
        [`--${status}-contrast`, `--${status}`, 4.5],
      ]),
    ];
    const rows = pairs.map(([role, surface, minimum]) => ({
      mode,
      role,
      surface,
      minimum,
      foreground: values[role]!,
      background: values[surface]!,
      ratio: contrastRatio(values[role]!, values[surface]!),
    }));
    console.log(`actual CSS text/status table: ${JSON.stringify(rows)}`);
    expect(rows.filter((row) => row.ratio < row.minimum)).toEqual([]);
  });

  it("rejects one below-threshold normal-text role on its actual surface and mode", () => {
    const appearance = elementsAppearanceFor("light", "css");
    const surface = appearance.rules![".Input"]!.backgroundColor!;
    const failures = (foreground: string) =>
      contrastRatio(foreground, surface) < NORMAL_TEXT_MINIMUM_RATIO
        ? ["Elements/light/colorTextPlaceholder on .Input"]
        : [];
    expect(failures(appearance.variables.colorTextPlaceholder!)).toEqual([]);
    expect(failures(cssValues("light")["--text-muted"]!)).toEqual(["Elements/light/colorTextPlaceholder on .Input"]);
  });
});

const connectTextVariables = [
  "actionPrimaryColorText",
  "actionSecondaryColorText",
  "badgeDangerColorText",
  "badgeNeutralColorText",
  "badgeSuccessColorText",
  "badgeWarningColorText",
  "buttonPrimaryColorText",
  "buttonSecondaryColorText",
  "colorSecondaryText",
  "colorText",
  "formPlaceholderTextColor",
] as const;

function connectRowsFor(mode: Mode, source: Source): Row[] {
  const appearance = connectAppearanceFor(mode, source);
  const value = (name: string) => String(appearance.variables[name]);
  const rows: ReadonlyArray<readonly [string, string, ReadonlyArray<readonly [string, string]>]> = [
    [
      "colorText",
      value("colorText"),
      [
        ["colorBackground", value("colorBackground")],
        ["formBackgroundColor", value("formBackgroundColor")],
      ],
    ],
    [
      "colorSecondaryText",
      value("colorSecondaryText"),
      [
        ["colorBackground", value("colorBackground")],
        ["formBackgroundColor", value("formBackgroundColor")],
      ],
    ],
    [
      "formPlaceholderTextColor",
      value("formPlaceholderTextColor"),
      [["formBackgroundColor", value("formBackgroundColor")]],
    ],
    [
      "buttonPrimaryColorText",
      value("buttonPrimaryColorText"),
      [["buttonPrimaryColorBackground", value("buttonPrimaryColorBackground")]],
    ],
    [
      "buttonSecondaryColorText",
      value("buttonSecondaryColorText"),
      [["buttonSecondaryColorBackground", value("buttonSecondaryColorBackground")]],
    ],
    [
      "badgeNeutralColorText",
      value("badgeNeutralColorText"),
      [["badgeNeutralColorBackground", value("badgeNeutralColorBackground")]],
    ],
    [
      "badgeDangerColorText",
      value("badgeDangerColorText"),
      [["badgeDangerColorBackground", value("badgeDangerColorBackground")]],
    ],
    [
      "badgeSuccessColorText",
      value("badgeSuccessColorText"),
      [["badgeSuccessColorBackground", value("badgeSuccessColorBackground")]],
    ],
    [
      "badgeWarningColorText",
      value("badgeWarningColorText"),
      [["badgeWarningColorBackground", value("badgeWarningColorBackground")]],
    ],
    [
      "actionPrimaryColorText",
      value("actionPrimaryColorText"),
      [
        ["colorBackground", value("colorBackground")],
        ["offsetBackgroundColor", value("offsetBackgroundColor")],
      ],
    ],
    [
      "actionSecondaryColorText",
      value("actionSecondaryColorText"),
      [
        ["colorBackground", value("colorBackground")],
        ["offsetBackgroundColor", value("offsetBackgroundColor")],
      ],
    ],
  ];

  return rows.flatMap(([role, foreground, surfaces]) =>
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

describe("Stripe Connect text contrast", () => {
  it("derives the complete normal-text variable inventory from the factory", () => {
    const appearance = connectAppearanceFor("light", "candidate");
    const derived = Object.keys(appearance.variables)
      .filter((name) => /(colortext|textcolor|secondarytext)$/i.test(name))
      .sort();

    expect(derived).toEqual([...connectTextVariables].sort());
  });

  it("binds formPlaceholderTextColor to secondary text on both palettes and from fixture and actual CSS sources", () => {
    for (const mode of modes) {
      for (const source of sources) {
        const appearance = connectAppearanceFor(mode, source);
        expect(
          appearance.variables.formPlaceholderTextColor,
          `${mode}/${source}: formPlaceholderTextColor must resolve from --text-secondary`,
        ).toBe(appearance.variables.colorSecondaryText);
        expect(appearance.variables.formPlaceholderTextColor).toBe(
          fixture[mode]["--text-secondary"][source === "css" ? "candidate" : source],
        );
        expect(appearance.variables.formPlaceholderTextColor).not.toBe(
          fixture[mode]["--text-muted"][source === "css" ? "candidate" : source],
        );
      }
    }
  });

  it("clears 4.5:1 for every normal-text variable on every rendered surface", () => {
    const rows = modes.flatMap((mode) => sources.flatMap((source) => connectRowsFor(mode, source)));

    console.log(
      [
        "variable                       surface                         mode   source     foreground                background                 ratio",
        ...rows.map((row) =>
          [
            row.role.padEnd(30),
            row.surface.padEnd(31),
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
          `${row.role} on ${row.surface}: ${row.ratio.toFixed(3)} < ${NORMAL_TEXT_MINIMUM_RATIO} ` +
          `(${row.mode} mode, ${row.source} values, ${row.foreground} on ${row.background})`,
      );

    expect(failures).toEqual([]);
  });

  it("keeps the predecessor muted placeholder binding red on the actual form surface", () => {
    const muted = fixture.light["--text-muted"].candidate;
    const formSurface = fixture.light["--surface-2"].candidate;
    const ratio = contrastRatio(muted, formSurface);

    expect(ratio).toBeCloseTo(3.92, 2);
    expect(
      ratio,
      `formPlaceholderTextColor on formBackgroundColor: ${ratio.toFixed(3)} must reproduce the predecessor failure`,
    ).toBeLessThan(NORMAL_TEXT_MINIMUM_RATIO);
  });
});
