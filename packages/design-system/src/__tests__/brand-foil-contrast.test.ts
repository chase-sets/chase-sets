import { describe, expect, it } from "vitest";
import { cssValues, fixture, stylesheet, type Mode } from "./token-contract";

type Rgb = readonly [number, number, number];
const minimumRatio = 3;
const recipe = stylesheet.match(/\.ds-brand-foil-text\s*\{([^}]+)\}/)![1]!;
const stops = [...recipe.matchAll(/var\(([^)]+)\)\s+(\d+)%/g)].map((match) => ({
  name: match[1]!,
  offset: Number(match[2]),
}));

function rgb(hex: string): Rgb {
  expect(hex).toMatch(/^#[\da-f]{6}$/i);
  const channel = (index: number) => Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return [channel(0), channel(1), channel(2)];
}

function luminance(color: Rgb) {
  const linear = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

function contrast(foreground: Rgb, background: Rgb) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function sample(colors: readonly Rgb[], position: number): Rgb {
  const segment = position <= stops[1]!.offset ? 0 : 1;
  const fraction = (position - stops[segment]!.offset) / (stops[segment + 1]!.offset - stops[segment]!.offset);
  const start = colors[segment]!;
  const end = colors[segment + 1]!;
  const channel = (index: number) => start[index]! + (end[index]! - start[index]!) * fraction;
  return [channel(0), channel(1), channel(2)];
}

describe("brand foil large-text contrast", () => {
  it("samples the shipped three-stop recipe, including its middle stop", () => {
    expect(stops.map(({ offset }) => offset)).toEqual([0, 52, 100]);
    expect(stops.map(({ name }) => name.split("-").at(-1))).toEqual(["start", "mid", "end"]);
  });

  for (const mode of ["light", "dark"] as const satisfies readonly Mode[]) {
    const sources = {
      stylesheet: cssValues(mode),
      fixture: Object.fromEntries(Object.entries(fixture[mode]).map(([name, entry]) => [name, entry.candidate])),
    };
    for (const [source, values] of Object.entries(sources)) {
      const colors = stops.map(({ name }) => rgb(values[name]!));
      for (const surface of ["--background", "--card"]) {
        it(`${mode}/${source} clears 3:1 at every 1% sample on ${surface}`, () => {
          const background = rgb(values[surface]!);
          for (let position = 0; position <= 100; position += 1) {
            expect(
              contrast(sample(colors, position), background),
              `${mode}/${source}/${surface} at ${position}%`,
            ).toBeGreaterThanOrEqual(minimumRatio);
          }
        });
      }
    }
  }

  it("rejects the previous light mid stop on both light surfaces", () => {
    // RGB form keeps the historical negative control out of the shipped hex palette inventory.
    const previousMid: Rgb = [201, 164, 78];
    const values = cssValues("light");
    const colors = stops.map(({ name }, index) => (index === 1 ? previousMid : rgb(values[name]!)));
    for (const surface of ["--background", "--card"]) {
      const background = rgb(values[surface]!);
      expect(contrast(sample(colors, stops[1]!.offset), background)).toBeLessThan(minimumRatio);
    }
  });
});
