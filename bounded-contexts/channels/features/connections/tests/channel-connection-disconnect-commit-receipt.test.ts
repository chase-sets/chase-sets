import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { attachWriteConsistencyMiddleware } from "@chase-sets/bounded-context-runtime";
import { CHASE_SETS_COMMIT_RECEIPT_HEADER, decodeCommitReceipt } from "@chase-sets/http/responses";
import type { ChannelsApiEnv } from "../../../api";
import { channelConnectionEventCodec } from "../domain/codec";
import type { ChannelConnectionServices } from "../domain/contracts";
import { decideChannelConnection, evolveChannelConnection } from "../domain/domain";
import { channelConnectionRoutes } from "../api/route";
import { createChannelConnectionRuntime, loadOwned } from "../api/runtime";
import { activateFixture, connectFixture, createConnectionHarness, testContext } from "./test-support";

const target = { accountId: "acc_owner", connectionId: "connection_1" };

/**
 * The production disconnect is Connector Feed's: it appends the event itself, in the transaction
 * that also closes the pairing, rather than through the command handler that records Pause's and
 * Resume's events. This one appends the same way, outside the command handler.
 */
function installedDisconnect(
  eventStore: ReturnType<typeof createConnectionHarness>["memory"]["eventStore"],
): ChannelConnectionServices["disconnectChannelConnection"] {
  return async (input, context) => {
    const loaded = await loadOwned(eventStore, input.accountId, input.connectionId);
    const newEvents = decideChannelConnection(loaded.state, { type: "DisconnectChannelConnection" });
    const storedEvents = newEvents.length
      ? await eventStore.appendToStream({
          streamId: `channels.connection-${input.connectionId}`,
          expectedVersion: loaded.version,
          events: newEvents.map(channelConnectionEventCodec.encode),
          context,
        })
      : [];
    return {
      state: newEvents.reduce(evolveChannelConnection, loaded.state),
      version: loaded.version + newEvents.length,
      newEvents,
      storedEvents,
    };
  };
}

async function harness() {
  const { services: setup, memory, ports } = createConnectionHarness();
  await connectFixture(setup);
  await activateFixture(setup);
  const services = createChannelConnectionRuntime(
    {
      eventStore: memory.eventStore,
      db: { query: async () => ({ rows: [] }) },
      disconnectChannelConnection: installedDisconnect(memory.eventStore),
    },
    ports,
  );
  const app = new Hono<ChannelsApiEnv>();
  attachWriteConsistencyMiddleware(app, [{ mountPath: "/api/channels" }]);
  app.use("*", async (c, next) => {
    c.set("actor", { accountId: target.accountId } as ChannelsApiEnv["Variables"]["actor"]);
    c.set("context", testContext);
    await next();
  });
  app.route("/api/channels/connections", channelConnectionRoutes(services, { deploymentEnvironment: "local" }));
  const streamEvents = async () =>
    memory.eventStore.readStream({ streamId: `channels.connection-${target.connectionId}` });
  return { app, streamEvents };
}

function post(app: Hono<ChannelsApiEnv>, action: string) {
  return app.request(`/api/channels/connections/${target.connectionId}/${action}`, { method: "POST" });
}

describe("channel-connection-disconnect-commit-receipt", () => {
  it("answers Disconnect with the commit receipt of the event it appended, as Pause does", async () => {
    const { app, streamEvents } = await harness();

    const pause = await post(app, "pause");
    const disconnect = await post(app, "disconnect");

    expect([pause.status, disconnect.status]).toEqual([200, 200]);
    await expect(disconnect.json()).resolves.toMatchObject({ status: "disconnected" });
    const [paused, disconnected] = (await streamEvents()).slice(-2);
    for (const [response, event] of [
      [pause, paused!],
      [disconnect, disconnected!],
    ] as const) {
      expect(response.headers.get("Chase-Sets-Consistency")).toBe("eventual");
      expect(response.headers.get("Chase-Sets-Commit-Event-Ids")).toBe(String(event.eventId));
      expect(response.headers.get("Chase-Sets-Commit-Position")).toBe(String(event.globalPosition));
      expect(decodeCommitReceipt(response.headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER))).toEqual([
        {
          sourceContextName: "channels",
          maxGlobalPosition: String(event.globalPosition),
          eventIds: [String(event.eventId)],
        },
      ]);
    }
    expect(disconnected!.eventType).toBe("channels.connection.disconnected");
  });

  it("answers a repeat Disconnect, which appends nothing, with no commit receipt", async () => {
    const { app } = await harness();
    await post(app, "disconnect");

    const repeat = await post(app, "disconnect");

    expect(repeat.status).toBe(200);
    expect(repeat.headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER)).toBeNull();
    expect(repeat.headers.get("Chase-Sets-Commit-Event-Ids")).toBeNull();
  });
});
