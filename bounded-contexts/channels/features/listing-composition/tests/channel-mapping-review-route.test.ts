// @vitest-environment jsdom
import { createChannelsServicesForTest } from "../../../tests/channels-services-test-support";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { Hono } from "hono";
import { createElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelConnectionServices } from "../../connections/domain/contracts";
import { createUnavailableOutboundSyncServices } from "../../outbound-sync/tests/test-support";
import { buildChannelsApi, type ChannelsActor, type ChannelsApiEnv } from "../../../api";
import type { ChannelListingCompositionServices } from "../api/runtime";
import type { ChannelPublicationConnectionDetail } from "../domain/contracts";
import AccountChannelsPublicationConnectionRoute, {
  action as publicationAction,
  loader as publicationLoader,
} from "../../../routes/marketplace/account-channels-publication-connection";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("channel-mapping-review-route", () => {
  it("mapping-decision-freshness-lag", async () => {
    let projectedVersion = 0;
    let appliedVersion = 0;
    let reads = 0;
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
              accountId: "account-owner",
              membershipId: "membership-1",
              roleKey: "owner",
              permissions: ["channels.view", "channels.manage"],
            },
          });
        }
        if (url.pathname.includes("/mappings/") && request.method === "POST") {
          appliedVersion += 1;
          return jsonResponse({ kind: "applied", streamVersion: appliedVersion });
        }
        if (url.pathname.endsWith("/publication/connection-1") && request.method === "GET") {
          reads += 1;
          return jsonResponse(mappingReviewDetail(projectedVersion));
        }
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    );
    const router = renderPublicationRoute();
    expect(await screen.findByText("catalog-category:cards")).toBeTruthy();
    vi.useFakeTimers();
    expect(screen.getByText(/category · proposed · high/u)).toBeTruthy();

    await act(async () => {
      await router.navigate(PUBLICATION_PATH, { formMethod: "post", formData: decideMappingForm("0") });
    });
    expect(screen.getByText(/Loading channel publication settings/u)).toBeTruthy();
    expect(screen.queryByText("catalog-category:cards")).toBeNull();

    const readsAfterDecision = reads;
    await settle(1_999);
    expect(reads).toBe(readsAfterDecision);
    await settle(1);
    expect(reads).toBe(readsAfterDecision + 1);
    expect(screen.getByText(/Loading channel publication settings/u)).toBeTruthy();

    projectedVersion = 1;
    await settle(2_000);
    expect(screen.getByText(/category · rejected · high/u)).toBeTruthy();
    expect(screen.getByDisplayValue("cards")).toBeTruthy();
    expect(screen.queryByText(/Loading channel publication settings/u)).toBeNull();

    await act(async () => {
      await router.navigate(PUBLICATION_PATH, { formMethod: "post", formData: decideMappingForm("1") });
    });
    expect(screen.getByText(/Loading channel publication settings/u)).toBeTruthy();
    const readsAfterStuckDecision = reads;
    for (let tick = 0; tick < 40; tick += 1) await settle(2_000);
    expect(reads - readsAfterStuckDecision).toBe(15);
    expect(screen.getByText(/Loading channel publication settings/u)).toBeTruthy();
  });

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
    ...createChannelsServicesForTest(),
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
  blockedListings: { items: [], total: 0 },
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

const PUBLICATION_PATH = "/account/channels/publication/connection-1";

function renderPublicationRoute() {
  const router = createMemoryRouter(
    [
      {
        path: "/account/channels/publication/:connectionId",
        loader: publicationLoader,
        action: publicationAction,
        Component: AccountChannelsPublicationConnectionRoute,
      },
    ],
    { initialEntries: [PUBLICATION_PATH] },
  );
  render(createElement(ChaseRoot, { linkComponent: RouterLinkAdapter }, createElement(RouterProvider, { router })));
  return router;
}

function decideMappingForm(expectedStreamVersion: string) {
  const form = new FormData();
  form.set("intent", "decide-mapping");
  form.set("dimension", "category");
  form.set("sourceKey", "catalog-category:cards");
  form.set("decision", "reject");
  form.set("targetKey", "cards");
  form.set("expectedStreamVersion", expectedStreamVersion);
  return form;
}

function mappingReviewDetail(streamVersion: number): ChannelPublicationConnectionDetail {
  const decided = streamVersion > 0;
  return {
    connection: { ...connectionDetail.connection, reviewCount: 1 },
    settings: null,
    mappingReview: {
      items: [
        {
          connectionId: "connection-1",
          dimension: "category",
          sourceKey: "catalog-category:cards",
          targetKey: decided ? "cards" : null,
          confidenceTier: "high",
          reviewStatus: decided ? "rejected" : "proposed",
          provenance: "compose-discovered",
          evidence: { listingId: "listing-1", derivedFrom: "assigned category cards" },
          lastStreamVersion: streamVersion,
        },
      ],
      nextCursor: null,
      completeness: { kind: "complete", total: 1 },
    },
    blockedListings: { items: [], total: 0 },
    configurationStreamVersion: streamVersion,
  };
}

async function settle(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
