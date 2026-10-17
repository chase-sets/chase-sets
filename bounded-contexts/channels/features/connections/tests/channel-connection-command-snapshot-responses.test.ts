import { describe, expect, it } from "vitest";
import { activateFixture, connectFixture, createConnectionHarness, fixedCreatedAt, testContext } from "./test-support";

describe("channel-connection-command-snapshot-responses", () => {
  it("returns committed pause, resume, disconnect, and repeat no-op state without querying the projection", async () => {
    const { services } = createConnectionHarness();
    await connectFixture(services);
    await activateFixture(services);
    const pause = await services.pauseChannelConnection(
      { accountId: "acc_owner", connectionId: "connection_1" },
      testContext,
    );
    const repeatPause = await services.pauseChannelConnection(
      { accountId: "acc_owner", connectionId: "connection_1" },
      testContext,
    );
    const resume = await services.resumeChannelConnection(
      { accountId: "acc_owner", connectionId: "connection_1" },
      testContext,
    );
    const disconnect = await services.disconnectChannelConnection(
      { accountId: "acc_owner", connectionId: "connection_1" },
      testContext,
    );
    const repeatDisconnect = await services.disconnectChannelConnection(
      { accountId: "acc_owner", connectionId: "connection_1" },
      testContext,
    );
    expect([pause.state.status, repeatPause.state.status, resume.state.status, disconnect.state.status]).toEqual([
      "paused",
      "paused",
      "active",
      "disconnected",
    ]);
    expect(repeatPause.newEvents).toEqual([]);
    expect(repeatDisconnect).toMatchObject({
      state: { status: "disconnected", credentialReference: null, bindings: [], createdAt: fixedCreatedAt },
      newEvents: [],
      storedEvents: [],
    });
  });
});
