import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
});
