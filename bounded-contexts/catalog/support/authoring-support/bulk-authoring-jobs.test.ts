import { describe, expect, it } from "vitest";
import { parseEditOperation } from "./bulk-authoring-jobs";

describe("catalog authoring bulk job operation parser", () => {
  it("accepts valid Catalog Item bulk edit operations", () => {
    expect(parseEditOperation({ action: "mergeTags", tags: ["featured", "foil"] })).toEqual({
      action: "mergeTags",
      tags: ["featured", "foil"],
    });
    expect(parseEditOperation({ action: "clearTags" })).toEqual({ action: "clearTags" });
  });

  it("rejects malformed Catalog Item bulk edit operations", () => {
    expect(() => parseEditOperation({ action: "mergeTags", tags: ["featured", 10] })).toThrow(
      "Catalog Item bulk edit operation is invalid.",
    );
    expect(() => parseEditOperation({ action: "assignCategory" })).toThrow(
      "Catalog Item bulk edit operation is invalid.",
    );
  });
});
