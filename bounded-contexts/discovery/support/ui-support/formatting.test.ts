import { describe, expect, it } from "vitest";
import { formatMoney } from "./formatting";

describe("discovery money formatting", () => {
  it("formats canonical decimal amounts for discovery surfaces", () => {
    expect(formatMoney("10")).toBe("$10.00");
    expect(formatMoney("1234.5")).toBe("$1,234.50");
    expect(formatMoney("10", "EUR")).toBe("€10.00");
  });

  it("keeps an explicitly undenominated amount unavailable", () => {
    expect(formatMoney("10", null)).toBe("Unavailable");
  });
});
