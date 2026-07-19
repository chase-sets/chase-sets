import { describe, expect, it, vi } from "vitest";
import { createCheckoutServices } from "./services";

describe("checkout projection eligibility", () => {
  it("keeps Inline Apply adoption Cart-only", () => {
    const services = createCheckoutServices({
      query: vi.fn(async () => ({ rows: [] })),
    } as never);

    expect(
      services.projectors.filter((projector) => projector.inlineApply).map((projector) => projector.projectionName),
    ).toEqual(["checkout.cart-projection"]);
    expect(
      services.projectors.find((projector) => projector.projectionName === "checkout.session-projection"),
    ).toMatchObject({ inlineApply: false });
    expect(
      services.projectors.find((projector) => projector.projectionName === "checkout.sell-list-projection"),
    ).toMatchObject({ inlineApply: false });
  });
});
