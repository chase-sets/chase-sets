import { describe, expect, it } from "vitest";
import { createCurveBuilderRegistry } from "../domain/demand-curve/curve-builder-registry";

describe("CurveBuilder registry", () => {
  it("loads a second registered builder without changing the merge or reader contract", async () => {
    const registry = createCurveBuilderRegistry([
      { id: "platform", version: "1", weightSource: "platform-trade", load: async () => [] },
    ]);
    registry.registerCurveBuilder({
      id: "synthetic-second",
      version: "2",
      weightSource: "external-comp",
      load: async () => [
        {
          price: 10,
          soldAt: "2026-09-01T00:00:00Z",
          condition: "Near Mint",
          variant: "Normal",
          language: "English",
          source: "external-comp",
          coverage: "complete",
        },
      ],
    });
    const inputs = await registry.load(
      {
        catalogItemId: "cat_test",
        productId: "product_test",
        condition: "Near Mint",
        variant: "Normal",
        language: "English",
      },
      { since: "2026-08-01", asOf: "2026-09-02", freeShippingThreshold: 5, salesLimit: 100 },
    );
    expect(inputs).toHaveLength(1);
    expect(registry.definitions().map((definition) => definition.id)).toEqual(["platform", "synthetic-second"]);
    expect(() => registry.registerCurveBuilder(registry.definitions()[0]!)).toThrow(/unique/);
  });
});
