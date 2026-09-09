import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelConnectionServices } from "../../connections/domain/contracts";
import { createUnavailableOutboundSyncServices } from "../../outbound-sync/tests/test-support";
import { buildChannelsApi, type ChannelsActor, type ChannelsApiEnv } from "../../../api";
import { createUnavailableOutboundSyncServices } from "../../outbound-sync/tests/test-support";
import type { ChannelListingCompositionServices } from "../api/runtime";
import type { ChannelPublicationConnectionDetail } from "../domain/contracts";

describe("channel-mapping-review-route", () => {
  it("R2 rejects the unscoped foreign-mutation lookup mutant while preserving API permissions", async () => {
    const observedAccounts: string[] = [];
    const { listingComposition, root } = routeHarness(observedAccounts);

    expect((await root.request("/api/channels/publication")).status).toBe(403);
    expect(
      (await root.request("/api/channels/publication", { headers: { "x-permissions": "channels.view" } })).status,
    ).toBe(200);
    expect(observedAccounts).toEqual(["account-owner"]);
    expect(
      (
        await root.request("/api/channels/publication/foreign", {
          headers: { "x-permissions": "channels.view", "x-account": "account-foreign" },
        })
      ).status,
    ).toBe(404);
    expect(observedAccounts).toContain("account-foreign");
    const viewOnlyAction = await root.request("/api/channels/publication/connection-1/settings", {
      method: "PUT",
      headers: { "x-permissions": "channels.view", "content-type": "application/json" },
      body: "{}",
    });
    expect(viewOnlyAction.status).toBe(403);
    const managed = await root.request("/api/channels/publication/connection-1/settings", {
      method: "PUT",
      headers: { "x-permissions": "channels.manage", "content-type": "application/json" },
      body: JSON.stringify({
        expectedStreamVersion: 0,
        settings: {
          titlePrefix: "",
          titleSuffix: "",
          descriptionFooter: "",
          categoryAllowlist: [],
          excludedListingIds: [],
        },
      }),
    });
    expect(managed.status).toBe(200);
    expect(listingComposition.replaceChannelConnectionPublicationSettings).toHaveBeenCalledOnce();
    expect(listingComposition.replaceChannelConnectionPublicationSettings).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-owner", connectionId: "connection-1" }),
      testContext,
    );

    const foreignMutation = await root.request("/api/channels/publication/connection-1/settings", {
      method: "PUT",
      headers: {
        "x-account": "account-foreign",
        "x-permissions": "channels.manage",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expectedStreamVersion: 0,
        settings: {
          titlePrefix: "",
          titleSuffix: "",
          descriptionFooter: "",
          categoryAllowlist: [],
          excludedListingIds: [],
        },
      }),
    });
    expect(foreignMutation.status).toBe(404);
    expect(listingComposition.replaceChannelConnectionPublicationSettings).toHaveBeenCalledOnce();
  });

  it("R3 rejects top-level and nested reconstruction mutants before either command", async () => {
    const { listingComposition, root } = routeHarness([]);
    for (const body of [
      {
        expectedStreamVersion: 0,
        intruder: true,
        settings: {
          titlePrefix: "",
          titleSuffix: "",
          descriptionFooter: "",
          categoryAllowlist: [],
          excludedListingIds: [],
        },
      },
      {
        expectedStreamVersion: 0,
        settings: {
          titlePrefix: "",
          titleSuffix: "",
          descriptionFooter: "",
          categoryAllowlist: [],
          excludedListingIds: [],
          intruder: true,
        },
      },
    ]) {
      const malformed = await root.request("/api/channels/publication/connection-1/settings", {
        method: "PUT",
        headers: { "x-permissions": "channels.manage", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(await malformed.json()).toEqual({ error: { code: "invalid_input", message: "invalid_input" } });
      expect(malformed.status).toBe(400);
    }
    const malformedDecision = await root.request(
      "/api/channels/publication/connection-1/mappings/category/catalog-category%3Acards/decision",
      {
        method: "POST",
        headers: { "x-permissions": "channels.manage", "content-type": "application/json" },
        body: JSON.stringify({ decision: "accept", targetKey: "cards", expectedStreamVersion: 0, intruder: true }),
      },
    );
    expect(malformedDecision.status).toBe(400);
    expect(listingComposition.replaceChannelConnectionPublicationSettings).not.toHaveBeenCalled();
    expect(listingComposition.decideChannelMappingReview).not.toHaveBeenCalled();
  });
});

function routeHarness(observedAccounts: string[]) {
  const listingComposition = services(observedAccounts);
  const api = buildChannelsApi({
    connections: connectionServices(),
    listingComposition,
    outboundSync: createUnavailableOutboundSyncServices(),
    projectors: [],
  });
  const root = new Hono<ChannelsApiEnv>();
  root.use("*", async (c, next) => {
    c.set("actor", {
      accountId: c.req.header("x-account") ?? "account-owner",
      permissions: (c.req.header("x-permissions") ?? "").split(",").filter(Boolean),
    });
    c.set("context", testContext);
    await next();
  });
  root.route("/api/channels", api);
  return { listingComposition, root };
}

const testContext: EventStoreContext = {
  tenantId: "tenant-synthetic" as EventStoreContext["tenantId"],
  audit: {
    performedByUserId: "user-synthetic" as EventStoreContext["audit"]["performedByUserId"],
    forAccountId: "account-owner" as EventStoreContext["audit"]["forAccountId"],
  },
};

function services(observedAccounts: string[]): ChannelListingCompositionServices {
  return {
    replaceChannelConnectionPublicationSettings: vi.fn(async () => ({
      kind: "applied" as const,
      value: undefined,
      streamVersion: 1,
    })),
    recordChannelMappingCandidates: vi.fn(),
    decideChannelMappingReview: vi.fn(),
    recordChannelListingDesiredState: vi.fn(),
    recordChannelListingPublicationOutcome: vi.fn(),
    recordChannelListingPublicationOutcomeInTransaction: vi.fn(),
    enqueueChannelListingDesiredStateBackfill: vi.fn(),
    enqueueChannelListingDesiredStateReconciliation: vi.fn(),
    drainChannelListingDesiredStateReconciliation: vi.fn(),
    resolveChannelPublishableQuantity: vi.fn(),
    readChannelListingProviderProductReferences: vi.fn(),
    readChannelMappingReviewQueue: vi.fn(),
    listChannelPublicationConnections: vi.fn(async ({ accountId }) => {
      observedAccounts.push(accountId);
      return [];
    }),
    readChannelPublicationConnection: vi.fn(async ({ accountId, connectionId }) => {
      observedAccounts.push(accountId);
      return accountId === "account-owner" && connectionId === "connection-1" ? connectionDetail : null;
    }),
    projectors: [],
  };
}

const connectionDetail: ChannelPublicationConnectionDetail = {
  connection: {
    connectionId: "connection-1",
    providerKey: "synthetic-provider",
    environment: "sandbox",
    connectionStatus: "active",
    settingsState: "missing",
    reviewCount: 0,
  },
  settings: null,
  mappingReview: { items: [], nextCursor: null, completeness: { kind: "complete", total: 0 } },
  configurationStreamVersion: 0,
};

function connectionServices(): ChannelConnectionServices {
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
