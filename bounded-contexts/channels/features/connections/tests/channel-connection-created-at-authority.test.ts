import { describe, expect, it } from "vitest";
import { activateFixture, connectFixture, createConnectionHarness, fixedCreatedAt, testContext } from "./test-support";

describe("channel-connection-created-at-authority", () => {
  it("captures one clock value in the event and preserves it through reload, transitions, and no-ops", async () => {
    const { services, memory, authorityCalls } = createConnectionHarness();
    const connected = await connectFixture(services);
    expect(authorityCalls.clock).toBe(1);
    expect(connected.state.createdAt).toBe(fixedCreatedAt);
    expect(connected.newEvents[0]).toMatchObject({
      type: "channels.connection.connected",
      data: { createdAt: fixedCreatedAt },
    });
    expect(memory.streams.get("channels.connection-connection_1")?.[0]?.payload).toMatchObject({
      createdAt: fixedCreatedAt,
    });
    await activateFixture(services);
    const paused = await services.pauseChannelConnection(
      { accountId: "acc_owner", connectionId: "connection_1" },
      testContext,
    );
    const repeatedPause = await services.pauseChannelConnection(
      { accountId: "acc_owner", connectionId: "connection_1" },
      testContext,
    );
    expect(paused.state.createdAt).toBe(fixedCreatedAt);
    expect(repeatedPause).toMatchObject({ state: { createdAt: fixedCreatedAt }, newEvents: [], storedEvents: [] });
    expect(authorityCalls.clock).toBe(1);
  });

  it("rejects a timezone-less clock value", async () => {
    const { services } = createConnectionHarness({ clock: { now: () => "2026-09-05T12:00:00" } });
    await expect(connectFixture(services)).rejects.toMatchObject({ code: "invalid-input" });
  });
});
