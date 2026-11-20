import { describe, expect, it } from "vitest";
import { parseGradedCardSnapshot } from "./graded-card-snapshot";

const snapshot = { gradingCompany: "PSA", grade: "10", conditionDescriptors: [] };

describe("parseGradedCardSnapshot conditionDescriptors", () => {
  it.each(
    [[], ["Centered"], Array.from({ length: 101 }, (_, index) => `Descriptor ${index}`)].map(
      (conditionDescriptors) => ({ conditionDescriptors }),
    ),
  )(
    "preserves valid descriptor strings without introducing a collection limit (case %#)",
    ({ conditionDescriptors }) => {
      expect(parseGradedCardSnapshot({ ...snapshot, conditionDescriptors })).toEqual({
        ...snapshot,
        certificationNumber: null,
        population: null,
        conditionDescriptors,
      });
    },
  );

  it.each(
    [undefined, null, "Centered", ["Centered", 1], Array.from({ length: 101 }, () => ({}))].map(
      (conditionDescriptors) => ({ conditionDescriptors }),
    ),
  )("rejects malformed descriptor collections (case %#)", ({ conditionDescriptors }) => {
    expect(() => parseGradedCardSnapshot({ ...snapshot, conditionDescriptors })).toThrow(
      "Graded card snapshot is invalid.",
    );
  });
});
