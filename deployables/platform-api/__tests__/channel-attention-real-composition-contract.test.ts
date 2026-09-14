import { describe, expect, expectTypeOf, it } from "vitest";
import { readFileSync } from "node:fs";
import { module as channelsModule } from "@chase-sets/channels";
import {
  isChannelsServices,
  type ChannelsServices,
  type ConnectionAttentionServices,
} from "@chase-sets/channels/server";

describe("channel-attention-real-composition-contract", () => {
  it("imports the real aggregate and requires attention in the API input", () => {
    const unavailable = async (): Promise<never> => {
      throw new Error("unexpected-db-call");
    };
    const services = channelsModule.createServices(
      { query: unavailable, connect: unavailable },
      { channelSaleRecorder: unavailable },
    );
    expectTypeOf(services).toEqualTypeOf<ChannelsServices>();
    expectTypeOf(services.connectionAttention).toEqualTypeOf<ConnectionAttentionServices>();
    expectTypeOf<
      Parameters<typeof channelsModule.buildApis>[0]["connectionAttention"]
    >().toEqualTypeOf<ConnectionAttentionServices>();
    expect(isChannelsServices(services)).toBe(true);
    const { connectionAttention, ...missing } = services;
    expect(connectionAttention).toBeDefined();
    expect(isChannelsServices(missing)).toBe(false);
    // @ts-expect-error The actual API input cannot omit the attention service.
    const invalidApiInput: Parameters<typeof channelsModule.buildApis>[0] = missing;
    expect(invalidApiInput).not.toHaveProperty("connectionAttention");
    for (const member of ["listOpenAttention", "resolveAttention"])
      expect(
        isChannelsServices({
          ...services,
          connectionAttention: Object.fromEntries(
            Object.entries(connectionAttention).filter(([key]) => key !== member),
          ),
        }),
      ).toBe(false);
  });
  it("pins the API factory import and single production composition", () => {
    const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    expect(source.match(/createChannelActionAttentionSourceFromReadModel\(channelsPool\)/g)).toHaveLength(1);
    expect(source).toContain('from "@chase-sets/channels/server"');
  });
});
