import { readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import type { ChannelConnectionServices } from "../../connections/domain/contracts";
import { OutboundSyncError, type OutboundSyncServices } from "../domain/contracts";
import { createUnavailableOutboundSyncServices } from "./test-support";

const marketplaceOpenApiPath = path.resolve(import.meta.dirname, "../../../../../docs/api/marketplace.openapi.json");

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
    expect(readLog).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc-owner", connectionId: "connection-a" }),
    );
    expect(readSummary).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc-owner", connectionId: "connection-a" }),
    );
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

  it.each([
    ["malformed", "not-a-date"],
    ["empty", ""],
  ])("rejects a %s `to` with the stable invalid_request 400 before any operation read", async (_case, to) => {
    const readLog = vi.fn();
    const readSummary = vi.fn();
    const app = createApp(connections(), {
      ...createUnavailableOutboundSyncServices(),
      readOutboundOperationLog: readLog,
      readOutboundOperationSummary: readSummary,
    });
    const response = await app.request(
      `http://local/api/channels/connections/connection-a/outbound-operations?to=${encodeURIComponent(to)}`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "invalid_request" } });
    expect(readLog).not.toHaveBeenCalled();
    expect(readSummary).not.toHaveBeenCalled();
  });

  it("derives the default window from a valid `to` and leaves the remaining query validation to the service", async () => {
    const readLog = vi.fn(async () => ({ items: [], completeness: { kind: "complete" as const, total: 0 } }));
    const readSummary = vi.fn(async () => {
      throw new OutboundSyncError("invalid-input");
    });
    const app = createApp(connections(), {
      ...createUnavailableOutboundSyncServices(),
      readOutboundOperationLog: readLog,
      readOutboundOperationSummary: readSummary,
    });
    const response = await app.request(
      "http://local/api/channels/connections/connection-a/outbound-operations?to=2026-09-07T19:00:00.000Z&limit=7",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "invalid_request" } });
    expect(readLog).toHaveBeenCalledWith({ accountId: "acc-owner", connectionId: "connection-a", limit: 7 });
    expect(readSummary).toHaveBeenCalledWith({
      accountId: "acc-owner",
      connectionId: "connection-a",
      window: { from: "2026-08-08T19:00:00.000Z", to: "2026-09-07T19:00:00.000Z" },
    });
  });

  it("emits a connection whose 200 body conforms exactly to the documented OutboundConnection schema", async () => {
    const app = createApp(connections(), {
      ...createUnavailableOutboundSyncServices(),
      readOutboundOperationLog: async () => ({ items: [], completeness: { kind: "complete" as const, total: 0 } }),
      readOutboundOperationSummary: async () => ({
        completeness: { kind: "complete" as const, total: 0 },
        succeeded: 0,
        failed: 0,
        pending: 0,
        inFlight: 0,
        blocked: 0,
        inlineEventToProviderAckMs: { p50: null, p95: null, p99: null },
        claimedEventToProviderAckMs: { p50: null, p95: null, p99: null },
      }),
    });
    const response = await app.request("http://local/api/channels/connections/connection-a/outbound-operations");
    expect(response.status).toBe(200);
    const { connection } = (await response.json()) as { connection: Record<string, unknown> };
    const schema = readOutboundConnectionSchema();

    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(connection).sort()).toEqual([...schema.required].sort());
    expect(Object.keys(connection).sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.properties.createdAt).toEqual({ type: "string", format: "date-time" });
    for (const [key, property] of Object.entries(schema.properties)) {
      expect({ key, type: typeof connection[key] }).toEqual({ key, type: property.type });
      if (property.enum) expect(property.enum).toContain(connection[key]);
      if (property.format === "date-time")
        expect(new Date(String(connection[key])).toISOString()).toBe(connection[key]);
    }
  });
});

function readOutboundConnectionSchema() {
  const document = JSON.parse(readFileSync(marketplaceOpenApiPath, "utf8")) as {
    components: {
      schemas: Record<
        string,
        {
          additionalProperties?: boolean;
          required: readonly string[];
          properties: Record<string, { type: string; enum?: readonly string[]; format?: string }>;
        }
      >;
    };
  };
  return document.components.schemas.OutboundConnection;
}

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
