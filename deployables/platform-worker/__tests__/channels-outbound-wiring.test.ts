import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Channels outbound worker wiring", () => {
  it("uses the canonical expanded Channels service and injected provider registry", () => {
    const source = readFileSync(new URL("../src/channels-outbound-runners.ts", import.meta.url), "utf8");
    expect(source).toContain('type { ChannelsServices } from "@chase-sets/channels/server"');
    expect(source).toContain("registry: channelProviderRegistry");
    expect(source).toContain('workflowName: "channels.outbound-operations"');
    expect(source).toContain("channelsOutboundOperationLaneCount");
    expect(source).not.toMatch(/services\.channels\s+as\s+\{/);
    expect(source).not.toMatch(/services\.channels\s+as\s+ChannelsServices/);
  });
});
