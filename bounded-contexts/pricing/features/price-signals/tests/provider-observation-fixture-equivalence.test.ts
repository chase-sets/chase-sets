import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSyntheticProviderObservationFixture } from "./fixtures/provider-observations/generate-fixture";

const fixtureUrl = new URL("./fixtures/provider-observations/synthetic-single-product-90-days.json", import.meta.url);

describe("mapper-generated provider-observation fixture", () => {
  it("is exactly equivalent to executable mapper output", () => {
    const committed = JSON.parse(readFileSync(fixtureUrl, "utf8"));
    expect(committed).toEqual(generateSyntheticProviderObservationFixture());
    expect(committed.observedDayCount).toBe(90);
    expect(committed.capture.sales).toHaveLength(90);
  });

  it("rejects a hand edit and contains no privacy marker", () => {
    const generated = generateSyntheticProviderObservationFixture();
    const edited = {
      ...generated,
      capture: {
        ...generated.capture,
        sales: generated.capture.sales.map((row, index) =>
          index === 0 ? { ...row, quantity: row.quantity + 1 } : row,
        ),
      },
    };
    expect(edited).not.toEqual(generated);
    const json = JSON.stringify(generated);
    expect(json).not.toMatch(
      /sellerKey|sellerId|sellerName|listingId|customListingId|cookie|authorization|responseBody|exceptionMessage|synthetic-transient/i,
    );
  });
});
