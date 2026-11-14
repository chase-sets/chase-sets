import { describe, expect, it, vi } from "vitest";
import { createPlatformApiHost } from "../src/app";

describe("Checkout Commercial Terms host dependency", () => {
  it("refuses to construct Checkout without the Commercial Terms pool", () => {
    const query = vi.fn(async () => ({ rows: [] }));

    expect(() =>
      createPlatformApiHost({
        runtimeProfile: "public",
        pools: { checkout: { query } as never },
      }),
    ).toThrow("Checkout requires a Commercial Terms resolver backed by the Commercial Terms database.");
    expect(query).not.toHaveBeenCalled();
  });
});
