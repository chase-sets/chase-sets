import { describe, expect, it } from "vitest";
import { cssValues } from "./token-contract";
const modes = ["light", "dark"] as const;
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

function composite(foreground: Rgba, surface: Rgba): Rgba {
  if (foreground.a >= 1) return foreground;
  return {
    r: foreground.r * foreground.a + surface.r * (1 - foreground.a),
    g: foreground.g * foreground.a + surface.g * (1 - foreground.a),
    b: foreground.b * foreground.a + surface.b * (1 - foreground.a),
    a: 1,
  };
}

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

describe("actual stylesheet text and status contrast", () => {
it.each(modes)("measures complete text/status pairs in %s", (mode) => {
    const values = cssValues(mode);
    const pairs: [string, string, number][] = [
      ["--foreground", "--background", 4.5],
      ["--card-foreground", "--card", 4.5],
      ["--popover-foreground", "--popover", 4.5],
      ["--primary-foreground", "--primary", 4.5],
      ["--accent-foreground", "--accent", 4.5],
      ["--secondary-foreground", "--secondary", 4.5],
      ["--trust", "--trust-soft", 4.5],
      ["--deal", "--deal-soft", 4.5],
      ["--rating", "--rating-soft", 4.5],
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
});
