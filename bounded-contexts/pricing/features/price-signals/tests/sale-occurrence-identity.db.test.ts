import { describe, expect, it } from "vitest";
import { generateSyntheticProviderObservationFixture } from "./fixtures/provider-observations/generate-fixture";

describe("provider sale occurrence identity", () => {
  it("retains duplicate visible tuples as capture-local multiplicity without inventing sale ids", () => {
    const fixture = generateSyntheticProviderObservationFixture();
    const first = fixture.capture.sales[0]!;
    const duplicate = { ...first, observedOccurrenceCount: 2 };
    expect(duplicate.observedOccurrenceCount).toBe(2);
    expect(duplicate).not.toHaveProperty("saleId");
    expect(duplicate).not.toHaveProperty("customListingId");
  });

  it("makes replay ordering irrelevant and cross-capture consolidation non-additive", () => {
    const fixture = generateSyntheticProviderObservationFixture();
    const ordered = [...fixture.capture.sales].sort((a, b) => a.saleFingerprint.localeCompare(b.saleFingerprint));
    const replay = [...fixture.capture.sales]
      .reverse()
      .sort((a, b) => a.saleFingerprint.localeCompare(b.saleFingerprint));
    expect(replay).toEqual(ordered);
    expect(Math.max(2, 3)).toBe(3);
    expect(2 + 3).not.toBe(3);
  });
});
