import { describe, expect, it } from "vitest";
import tailwindConfig from "../../../../tailwind.config";
import { chaseTheme, minWidthQuery } from "../theme/tokens";

// The root Tailwind config intentionally does not override screens, so compiled
// responsive classes use Tailwind's default min-width breakpoints.
const tailwindDefaultScreens = {
  sm: "640px",
  md: "768px",
  lg: "1024px",
  xl: "1280px",
  "2xl": "1536px",
} as const;

describe("breakpoint tokens", () => {
  it("matches Tailwind's compiled screen contract", () => {
    const theme = tailwindConfig.theme as { screens?: unknown; extend?: { screens?: unknown } } | undefined;

    expect(theme?.screens).toBeUndefined();
    expect(theme?.extend?.screens).toBeUndefined();
    expect(chaseTheme.breakpoints).toEqual({
      base: "0px",
      ...tailwindDefaultScreens,
    });
  });

  it("formats min-width media queries from breakpoint tokens", () => {
    expect(minWidthQuery("md")).toBe("(min-width: 768px)");
    expect(minWidthQuery("lg")).toBe("(min-width: 1024px)");
  });
});
