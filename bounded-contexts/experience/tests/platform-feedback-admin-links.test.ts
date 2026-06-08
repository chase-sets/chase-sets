import { afterEach, describe, expect, it } from "vitest";
import { resolvePlatformFeedbackMarketplaceOrigin } from "../routes/admin/platform-feedback-detail";

const originalMarketplaceOrigin = process.env.CHASE_SETS_MARKETPLACE_ORIGIN;

afterEach(() => {
  if (originalMarketplaceOrigin === undefined) {
    delete process.env.CHASE_SETS_MARKETPLACE_ORIGIN;
  } else {
    process.env.CHASE_SETS_MARKETPLACE_ORIGIN = originalMarketplaceOrigin;
  }
});

describe("platform feedback admin links", () => {
  it("uses the configured marketplace origin for admin-rendered account links", () => {
    process.env.CHASE_SETS_MARKETPLACE_ORIGIN = "https://marketplace.chasesets.com";

    expect(
      resolvePlatformFeedbackMarketplaceOrigin(),
    ).toBe("https://marketplace.chasesets.com");
  });

  it("does not fall back to the admin request origin when no marketplace origin is configured", () => {
    delete process.env.CHASE_SETS_MARKETPLACE_ORIGIN;

    expect(
      resolvePlatformFeedbackMarketplaceOrigin(),
    ).toBeNull();
  });
});
