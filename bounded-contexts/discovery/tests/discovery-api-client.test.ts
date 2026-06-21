import { describe, expect, it } from "vitest";

import { DiscoveryApiError } from "../client";

describe("DiscoveryApiError", () => {
  it("uses structured API error messages", () => {
    const error = new DiscoveryApiError(503, {
      error: {
        code: "projection_freshness_timeout",
        message: "Projection read model did not catch up before the freshness timeout.",
      },
    });

    expect(error.message).toBe("Projection read model did not catch up before the freshness timeout.");
  });
});
