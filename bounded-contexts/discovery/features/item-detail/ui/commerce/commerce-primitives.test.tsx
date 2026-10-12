import { describe, expect, it } from "vitest";
import { t } from "@chase-sets/localization";
import { formatMoneyAmount, multiplyMoneyAmount, parseMoneyAmount } from "./commerce-primitives";

describe("commerce money display", () => {
  it.each([null, undefined, "12abc", "1e3", "10000000000.00"])("parses display money amounts strictly: %s", (value) => {
    expect.soft(parseMoneyAmount(value)).toBeNull();
    expect.soft(formatMoneyAmount(value)).toBe(t("discovery.routes.itemDetail.unavailable"));
    if (typeof value === "string") expect.soft(multiplyMoneyAmount(value, 3)).toBeNull();
  });

  it("parses display money amounts strictly: canonical parity", () => {
    expect(parseMoneyAmount("12.34")).toBe(12.34);
    expect(parseMoneyAmount(" 12.34 ")).toBe(12.34);
    expect(multiplyMoneyAmount("0.10", 3)).toBe(0.1 * 3);
  });
});
