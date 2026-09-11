import { Hono } from "hono";
import { vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import type { ChannelListingCompositionServices } from "../../listing-composition/api/runtime";
import { createUnavailableOutboundSyncServices } from "../../outbound-sync/tests/test-support";
import {
  ChannelConnectionError,
  channelConnectionStatuses,
  type ChannelConnectionCommandResult,
  type ChannelConnectionServices,
  type ChannelConnectionStatus,
  type PublicChannelConnection,
} from "../domain/contracts";

export const routeAccountId = "account-1";
export const foreignAccountId = "account-2";

export type FakeConnectionRecord = PublicChannelConnection & { accountId: string };

function commandResult(state: PublicChannelConnection | null): ChannelConnectionCommandResult {
  return {
    state: state
      ? {
          connectionId: state.connectionId,
          accountId: routeAccountId,
          providerKey: state.providerKey,
          environment: state.environment,
          status: state.status,
          createdAt: state.createdAt,
          credentialReference: null,
          bindings: [],
        }
      : {
          connectionId: null,
          accountId: null,
          providerKey: null,
          environment: null,
          status: null,
          createdAt: null,
          credentialReference: null,
          bindings: [],
        },
    version: 1,
    newEvents: [],
    storedEvents: [],
  };
}

export function createFakeConnectionServices(seed: readonly FakeConnectionRecord[]) {
  const connections = new Map(seed.map((connection) => [connection.connectionId, { ...connection }]));
  const calls: { pause: number; resume: number; disconnect: number } = { pause: 0, resume: 0, disconnect: 0 };

  function require_(accountId: string, connectionId: string): FakeConnectionRecord {
    const record = connections.get(connectionId);
    if (!record || record.accountId !== accountId) throw new ChannelConnectionError("connection-not-found");
    return record;
  }

  function transition(
    accountId: string,
    connectionId: string,
    from: readonly ChannelConnectionStatus[],
    to: ChannelConnectionStatus,
  ): PublicChannelConnection {
    const record = require_(accountId, connectionId);
    if (!from.includes(record.status)) throw new ChannelConnectionError("invalid-transition");
    const updated: FakeConnectionRecord = { ...record, status: to };
    connections.set(connectionId, updated);
    return { ...updated };
  }

  const services: ChannelConnectionServices = {
    connectChannel: vi.fn(),
    activateChannelConnection: vi.fn(),
    pauseChannelConnection: async ({ accountId, connectionId }) => {
      calls.pause += 1;
      return commandResult(transition(accountId, connectionId, ["active"], "paused"));
    },
    resumeChannelConnection: async ({ accountId, connectionId }) => {
      calls.resume += 1;
      return commandResult(transition(accountId, connectionId, ["paused"], "active"));
    },
    disconnectChannelConnection: async ({ accountId, connectionId }) => {
      calls.disconnect += 1;
      return commandResult(transition(accountId, connectionId, [...channelConnectionStatuses], "disconnected"));
    },
    getConnection: async ({ accountId, connectionId }) => {
      const record = connections.get(connectionId);
      if (!record || record.accountId !== accountId) return null;
      const { accountId: _accountId, ...publicConnection } = record;
      return publicConnection;
    },
    listConnections: async ({ accountId, status }) => {
      const defaultStatuses: readonly ChannelConnectionStatus[] = ["pending-setup", "active", "paused"];
      const statuses = status ? [status] : defaultStatuses;
      const items = [...connections.values()]
        .filter((record) => record.accountId === accountId && statuses.includes(record.status))
        .map(({ accountId: _accountId, ...publicConnection }) => publicConnection);
      return { items };
    },
    projectors: [],
  };

  return { services, connections, calls };
}

function connectionServicesStub(): ChannelConnectionServices {
  return {
    connectChannel: vi.fn(),
    activateChannelConnection: vi.fn(),
    pauseChannelConnection: vi.fn(),
    resumeChannelConnection: vi.fn(),
    disconnectChannelConnection: vi.fn(),
    getConnection: vi.fn(),
    listConnections: vi.fn(),
    projectors: [],
  };
}

function listingCompositionStub(): ChannelListingCompositionServices {
  return {
    replaceChannelConnectionPublicationSettings: vi.fn(),
    recordChannelMappingCandidates: vi.fn(),
    decideChannelMappingReview: vi.fn(),
    recordChannelListingDesiredState: vi.fn(),
    recordChannelListingPublicationOutcome: vi.fn(),
    enqueueChannelListingDesiredStateBackfill: vi.fn(),
    enqueueChannelListingDesiredStateReconciliation: vi.fn(),
    drainChannelListingDesiredStateReconciliation: vi.fn(),
    resolveChannelPublishableQuantity: vi.fn(),
    readChannelListingProviderProductReferences: vi.fn(),
    readChannelMappingReviewQueue: vi.fn(),
    listChannelPublicationConnections: vi.fn(),
    readChannelPublicationConnection: vi.fn(),
    projectors: [],
  };
}

export function mountConnectionRouteHarness(
  connectionServices: ChannelConnectionServices,
  initialPermissions: readonly string[] = ["channels.view", "channels.manage"],
) {
  const permissions = [...initialPermissions];
  const apiRequests: Array<{ url: string; method: string }> = [];
  const root = new Hono<ChannelsApiEnv>();
  root.use("*", async (c, next) => {
    c.set("actor", { accountId: routeAccountId, permissions });
    c.set("context", testContext);
    await next();
  });
  root.route(
    "/api/channels",
    buildChannelsApi({
      connections: connectionServices,
      listingComposition: listingCompositionStub(),
      outboundSync: createUnavailableOutboundSyncServices(),
      projectors: [],
    }),
  );

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.pathname === "/api/auth/session") {
        return jsonResponse({
          actor: {
            sessionId: "session-1",
            tenantId: "tenant-1",
            userId: "user-1",
            accountId: routeAccountId,
            membershipId: "membership-1",
            roleKey: "owner",
            permissions,
          },
        });
      }
      if (url.pathname.startsWith("/api/channels/connections")) {
        apiRequests.push({ url: `${url.pathname}${url.search}`, method: request.method });
        return root.request(request);
      }
      throw new Error(`Unexpected route request: ${url.pathname}`);
    }),
  );

  return { permissions, apiRequests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const testContext: EventStoreContext = {
  tenantId: "tenant-1" as EventStoreContext["tenantId"],
  audit: {
    performedByUserId: "user-1" as EventStoreContext["audit"]["performedByUserId"],
    forAccountId: routeAccountId as EventStoreContext["audit"]["forAccountId"],
  },
};

export { connectionServicesStub };
