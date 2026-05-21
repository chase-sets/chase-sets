import { describe, expect, it } from "vitest";
import { normalizeSimpleSearchText } from "./normalization";

describe("discovery search normalization", () => {
  it("keeps letters and numbers while collapsing punctuation and whitespace", () => {
    expect(normalizeSimpleSearchText("  Charizard--ex  199/165!!! ")).toBe("Charizard ex 199 165");
  });
});
