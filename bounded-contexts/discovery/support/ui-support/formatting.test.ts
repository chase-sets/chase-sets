import { describe, expect, it } from "vitest";
import { formatMoney } from "./formatting";

describe("discovery money formatting", () => {
  it("formats canonical decimal amounts for discovery surfaces", () => {
    expect(formatMoney("10")).toBe("$10.00");
    expect(formatMoney("1234.5")).toBe("$1,234.50");
  });
});
