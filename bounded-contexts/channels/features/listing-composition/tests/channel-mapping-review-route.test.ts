import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelConnectionServices } from "../../connections/domain/contracts";
import { buildChannelsApi, type ChannelsActor, type ChannelsApiEnv } from "../../../api";
import type { ChannelListingCompositionServices } from "../api/runtime";

describe("channel-mapping-review-route", () => {
  it("aligns channels.view and channels.manage while preserving account isolation and API 403", async () => {
    const observedAccounts: string[] = [];
    const listingComposition = services(observedAccounts);
    const api = buildChannelsApi({ connections: connectionServices(), listingComposition, projectors: [] });
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
  });
});

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
      return connectionId === "foreign" ? null : null;
    }),
    projectors: [],
  };
}

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
