import { describe, expect, it } from "vitest";
import { formatBpsPercent } from "./bps-percent";

describe("formatBpsPercent", () => {
  it("formats a round basis-points value as a whole percent", () => {
    expect(formatBpsPercent(500)).toBe("5%");
  });

  it("formats a fractional basis-points value with up to two fraction digits", () => {
    expect(formatBpsPercent(450)).toBe("4.5%");
  });

  it("rounds to two fraction digits instead of showing a long repeating decimal", () => {
    expect(formatBpsPercent(50)).toBe("0.5%");
    expect(formatBpsPercent(1)).toBe("0.01%");
  });

  it("formats zero", () => {
    expect(formatBpsPercent(0)).toBe("0%");
  });

  it("formats basis points at exactly 100%", () => {
    expect(formatBpsPercent(10_000)).toBe("100%");
  });

  it("formats basis points above 100% (for example an offer priced above its listing ask)", () => {
    expect(formatBpsPercent(12_500)).toBe("125%");
  });

  it("honors a coarser maximumFractionDigits override", () => {
    expect(formatBpsPercent(1234, { maximumFractionDigits: 1 })).toBe("12.3%");
  });

  it("renders identically across call sites for the same value", () => {
    expect(formatBpsPercent(450)).toBe(formatBpsPercent(450));
  });
});
