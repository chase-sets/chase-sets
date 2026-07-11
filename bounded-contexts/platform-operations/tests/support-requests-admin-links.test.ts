import { afterEach, describe, expect, it } from "vitest";
import { resolveSupportRequestsMarketplaceOrigin } from "../routes/admin/requests";

const originalMarketplaceOrigin = process.env.CHASE_SETS_MARKETPLACE_ORIGIN;

afterEach(() => {
  if (originalMarketplaceOrigin === undefined) {
    delete process.env.CHASE_SETS_MARKETPLACE_ORIGIN;
  } else {
    process.env.CHASE_SETS_MARKETPLACE_ORIGIN = originalMarketplaceOrigin;
  }
});

describe("support requests admin links", () => {
  it("uses the configured marketplace origin for admin-rendered order links", () => {
    process.env.CHASE_SETS_MARKETPLACE_ORIGIN = "https://marketplace.chasesets.com";

    expect(resolveSupportRequestsMarketplaceOrigin()).toBe("https://marketplace.chasesets.com");
  });

  it("does not fall back to the admin request origin when no marketplace origin is configured", () => {
    delete process.env.CHASE_SETS_MARKETPLACE_ORIGIN;

    expect(resolveSupportRequestsMarketplaceOrigin()).toBeNull();
  });
});
