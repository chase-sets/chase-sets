import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPlatformApiMarketplaceChannelInboundClampBinding } from "../src/app";

describe("marketplace-channel-inbound-clamp-production-binding", () => {
  it("mounts the Marketplace service behind the Channels host port without a second clamp implementation", () => {
    const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    expect(source).toContain("createMarketplaceChannelInboundClampCapability(");
    expect(source).toContain("Boolean(marketplacePool)");
    expect(source).toContain("runtime?.services.marketplace as MarketplaceServices | undefined");
    expect(source).toContain("marketplaceChannelInboundClamp,");
    expect(source).not.toContain("services.channelInboundClamp.engage(input, context)");
    expect(source).not.toContain("services.channelInboundClamp.recover(input, context)");
    expect(source).not.toMatch(/listingIds\.(?:slice|filter)\(/);
  });

  it("executes engage and recover through the actual API-host Channels-facing binding", async () => {
    const engage = vi.fn(async () => ({
      kind: "engaged" as const,
      requestedListingCount: 1,
      affectedListingCount: 1,
      clampedListingCount: 1,
      recoveryListingCount: 0,
    }));
    const recover = vi.fn(async () => ({
      kind: "released" as const,
      examinedListingCount: 1,
      releasedListingCount: 1,
      retainedListingCount: 0,
      recoveryListingCount: 0,
    }));
    const capability = createPlatformApiMarketplaceChannelInboundClampBinding(true, () => ({
      channelInboundClamp: { engage, recover },
    }));
    if (capability.kind !== "available") throw new Error("Expected API-host Marketplace clamp binding.");
    const input = {
      accountId: "account-synthetic-api-host",
      connectionId: "connection-synthetic-api-host",
      runId: "run-synthetic-api-host",
      listingIds: ["listing-synthetic-api-host"],
    };
    const context = {
      tenantId: "tenant-synthetic-api-host",
      audit: { performedByUserId: "user-synthetic-api-host", forAccountId: input.accountId },
    } as never;

    await expect(capability.port.engage(input, context)).resolves.toMatchObject({ kind: "engaged" });
    await expect(capability.port.recover(input, context)).resolves.toMatchObject({ kind: "released" });
    expect(engage).toHaveBeenCalledWith(input, context);
    expect(recover).toHaveBeenCalledWith(input, context);
  });
});
