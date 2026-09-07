import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import type { ChannelConnectionServices } from "../../connections/domain/contracts";
import type { OutboundSyncServices } from "../domain/contracts";
import { createUnavailableOutboundSyncServices } from "./test-support";

describe("channels-connection-detail-operation-log", () => {
  it("authenticates through the Channels API and returns a complete account-scoped result", async () => {
    const readLog = vi.fn(async () => ({ items: [], completeness: { kind: "complete" as const, total: 0 } }));
    const readSummary = vi.fn(async () => ({
      completeness: { kind: "complete" as const, total: 0 },
      succeeded: 0,
      failed: 0,
      pending: 0,
      inFlight: 0,
      blocked: 0,
      inlineEventToProviderAckMs: { p50: null, p95: null, p99: null },
      claimedEventToProviderAckMs: { p50: null, p95: null, p99: null },
    }));
    const app = createApp(connections(), {
      ...createUnavailableOutboundSyncServices(),
      readOutboundOperationLog: readLog,
      readOutboundOperationSummary: readSummary,
    });
    const response = await app.request("http://local/api/channels/connections/connection-a/outbound-operations");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connection: { connectionId: "connection-a" },
      log: { items: [], completeness: { kind: "complete", total: 0 } },
      summary: { completeness: { kind: "complete", total: 0 } },
    });
    expect(readLog).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc-owner", connectionId: "connection-a" }));
    expect(readSummary).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc-owner", connectionId: "connection-a" }));
  });

  it("makes a foreign connection byte-identical to missing and performs no operation read", async () => {
    const readLog = vi.fn();
    const readSummary = vi.fn();
    const app = createApp(connections(), {
      ...createUnavailableOutboundSyncServices(),
      readOutboundOperationLog: readLog,
      readOutboundOperationSummary: readSummary,
    });
    const missing = await app.request("http://local/api/channels/connections/missing/outbound-operations");
    const foreign = await app.request("http://local/api/channels/connections/foreign/outbound-operations");
    expect({ status: missing.status, body: await missing.text() }).toEqual({
      status: foreign.status,
      body: await foreign.text(),
    });
    expect(readLog).not.toHaveBeenCalled();
    expect(readSummary).not.toHaveBeenCalled();
  });
});

function createApp(connectionsService: ChannelConnectionServices, outboundSync: OutboundSyncServices) {
  const app = new Hono<ChannelsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", { accountId: "acc-owner", permissions: ["channels.view"] });
    await next();
  });
  app.route("/api/channels", buildChannelsApi({ connections: connectionsService, outboundSync, projectors: [] }));
  return app;
}

function connections(): ChannelConnectionServices {
  const unavailable = async (): Promise<never> => Promise.reject(new Error("not reached"));
  return {
    connectChannel: unavailable,
    activateChannelConnection: unavailable,
    pauseChannelConnection: unavailable,
    resumeChannelConnection: unavailable,
    disconnectChannelConnection: unavailable,
    getConnection: async ({ accountId, connectionId }) =>
      accountId === "acc-owner" && connectionId === "connection-a"
        ? {
            connectionId,
            providerKey: "synthetic-provider",
            environment: "sandbox",
            status: "active",
            createdAt: "2026-09-07T18:00:00.000Z",
          }
        : null,
    listConnections: unavailable,
    projectors: [],
  };
}
