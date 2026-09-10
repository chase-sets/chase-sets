import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createMarketplaceChannelInboundClampCapability } from "./capability";

const context: EventStoreContext = {
  tenantId: "tenant-synthetic" as never,
  audit: { performedByUserId: "user-synthetic" as never, forAccountId: "account-synthetic" as never },
};
const input = {
  accountId: "account-synthetic",
  connectionId: "connection-synthetic",
  runId: "run-synthetic",
  listingIds: ["listing-synthetic"],
} as const;

describe("marketplace-channel-inbound-clamp imported-port execution", () => {
  it("executes engage and recover through the same late-bound Marketplace service used by each host", async () => {
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
    let services: { channelInboundClamp: { engage: typeof engage; recover: typeof recover } } | undefined;
    const capability = createMarketplaceChannelInboundClampCapability(true, () => services);
    expect(capability.kind).toBe("available");
    if (capability.kind !== "available") throw new Error("Expected the mounted capability.");
    await expect(capability.port.engage(input, context)).rejects.toThrow("service is unavailable");

    services = { channelInboundClamp: { engage, recover } };
    await expect(capability.port.engage(input, context)).resolves.toMatchObject({ kind: "engaged" });
    await expect(capability.port.recover(input, context)).resolves.toMatchObject({ kind: "released" });
    expect(engage).toHaveBeenCalledWith(input, context);
    expect(recover).toHaveBeenCalledWith(input, context);
  });

  it("exposes no port when the Marketplace database is not mounted", () => {
    expect(createMarketplaceChannelInboundClampCapability(false, () => undefined)).toEqual({ kind: "not-mounted" });
  });
});
