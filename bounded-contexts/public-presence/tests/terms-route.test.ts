import { describe, expect, it } from "vitest";
import { meta } from "../routes/marketplace/terms";

describe("Terms of Service route metadata", () => {
  it("publishes consent and effective-version metadata for machine consumers", () => {
    const descriptors = meta({} as never);

    expect(descriptors).toEqual(
      expect.arrayContaining([
        { name: "chase-sets:policy-key", content: "terms-of-service" },
        { name: "chase-sets:policy-version", content: "v1" },
        { name: "chase-sets:policy-publication-status", content: "counsel-review-required" },
      ]),
    );
  });
});
