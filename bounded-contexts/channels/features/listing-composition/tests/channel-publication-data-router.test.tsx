// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Hono } from "hono";
import { createMemoryRouter, RouterProvider, type ActionFunctionArgs } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelConnectionServices } from "../../connections/domain/contracts";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import AccountChannelsPublicationConnectionRoute, {
  action,
  loader,
} from "../../../routes/marketplace/account-channels-publication-connection";
import type { ChannelListingCompositionServices } from "../api/runtime";
import type { ChannelPublicationConnectionDetail, ChannelPublicationSettings } from "../domain/contracts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("channel-publication-settings-route", () => {
  it("drives the real authorized data-router load/action/revalidation transition beyond the first cursor", async () => {
    const harness = routeHarness(["channels.view", "channels.manage"]);
    let detail = detailAt(null);
    let secondCandidateAccepted = false;
    let recompositions = 0;
    const listingComposition = services({
      readDetail: async (cursor) => {
        const page = detailAt(cursor, secondCandidateAccepted);
        return {
          ...page,
          settings: detail.settings,
          connection: detail.connection,
          configurationStreamVersion: detail.configurationStreamVersion,
        };
      },
      replaceSettings: async (settings) => {
        detail = {
          ...detail,
          connection: { ...detail.connection, settingsState: "configured" },
          settings,
          configurationStreamVersion: detail.configurationStreamVersion + 1,
        };
        recompositions += 1;
      },
      acceptSecond: async () => {
        secondCandidateAccepted = true;
        detail = { ...detail, configurationStreamVersion: detail.configurationStreamVersion + 1 };
        recompositions += 1;
      },
    });
    harness.mountApi(listingComposition);

    const path = "/account/channels/publication/connection-1";
    const router = createMemoryRouter(
      [
        {
          path: "/account/channels/publication/:connectionId",
          loader,
          action,
          Component: AccountChannelsPublicationConnectionRoute,
        },
      ],
      { initialEntries: [path] },
    );
    render(
      <ChaseRoot linkComponent={RouterLinkAdapter}>
        <RouterProvider router={router} />
      </ChaseRoot>,
    );
    expect(await screen.findByText("Settings are required")).toBeTruthy();
    expect(await screen.findByText("catalog-category:first-page")).toBeTruthy();

    const settingsForm = new FormData();
    settingsForm.set("intent", "replace-settings");
    settingsForm.set("expectedStreamVersion", "0");
    settingsForm.set("titlePrefix", "[");
    settingsForm.set("titleSuffix", "]");
    settingsForm.set("descriptionFooter", "footer");
    settingsForm.set("categoryAllowlist", "cards\nsealed");
    settingsForm.set("excludedListingIds", "listing-excluded");
    await act(async () => {
      await router.navigate(path, { formMethod: "post", formData: settingsForm });
    });
    expect(screen.queryByText("Settings are required")).toBeNull();
    expect(harness.apiRequests.some((request) => request.method === "PUT")).toBe(true);

    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Next mappings" }));
    expect(await screen.findByText("catalog-category:second-page")).toBeTruthy();
    expect(router.state.location.search).toBe("?cursor=page-2");

    const decisionForm = new FormData();
    decisionForm.set("intent", "decide-mapping");
    decisionForm.set("dimension", "category");
    decisionForm.set("sourceKey", "catalog-category:second-page");
    decisionForm.set("decision", "accept");
    decisionForm.set("targetKey", "provider-second-page");
    decisionForm.set("expectedStreamVersion", "1");
    await act(async () => {
      await router.navigate(`${path}?cursor=page-2`, { formMethod: "post", formData: decisionForm });
    });
    expect(await screen.findByText("No mappings to review")).toBeTruthy();
    expect(harness.apiRequests.some((request) => request.method === "POST")).toBe(true);
    expect(recompositions).toBe(2);
    expect(harness.detailReads).toBeGreaterThanOrEqual(4);
  });

  it("returns a real 403 from loader and action before any Channels API call", async () => {
    const harness = routeHarness([]);
    harness.mountApi(services({}));
    await expect(loader(loaderArgs("/account/channels/publication/connection-1"))).rejects.toMatchObject({
      status: 403,
    });
    expect(harness.apiRequests).toEqual([]);

    harness.permissions.splice(0, harness.permissions.length, "channels.view");
    const formData = new FormData();
    formData.set("intent", "replace-settings");
    formData.set("expectedStreamVersion", "0");
    const request = new Request("http://localhost/account/channels/publication/connection-1", {
      method: "POST",
      body: formData,
    });
    await expect(
      action({ request, params: { connectionId: "connection-1" }, context: {} } as unknown as ActionFunctionArgs),
    ).rejects.toMatchObject({ status: 403 });
    expect(harness.apiRequests).toEqual([]);
  });
});

function routeHarness(initialPermissions: string[]) {
  const permissions = [...initialPermissions];
  const apiRequests: Array<{ url: string; method: string }> = [];
  let api: Hono<ChannelsApiEnv> | null = null;
  let detailReads = 0;
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
            accountId: "account-1",
            membershipId: "membership-1",
            roleKey: "owner",
            permissions,
          },
        });
      }
      if (url.pathname.startsWith("/api/channels/publication")) {
        if (!api) throw new Error("Channels API was not mounted.");
        apiRequests.push({ url: `${url.pathname}${url.search}`, method: request.method });
        return api.request(request);
      }
      throw new Error(`Unexpected route request: ${url.pathname}`);
    }),
  );
  return {
    permissions,
    apiRequests,
    get detailReads() {
      return detailReads;
    },
    mountApi(listingComposition: ChannelListingCompositionServices) {
      const root = new Hono<ChannelsApiEnv>();
      root.use("*", async (c, next) => {
        c.set("actor", { accountId: "account-1", permissions });
        c.set("context", testContext);
        await next();
      });
      const counted: ChannelListingCompositionServices = {
        ...listingComposition,
        readChannelPublicationConnection: async (input) => {
          detailReads += 1;
          return listingComposition.readChannelPublicationConnection(input);
        },
      };
      root.route(
        "/api/channels",
        buildChannelsApi({ connections: connectionServices(), listingComposition: counted, projectors: [] }),
      );
      api = root;
    },
  };
}

function services(
  options: Readonly<{
    readDetail?: (cursor: string | null) => Promise<ChannelPublicationConnectionDetail>;
    replaceSettings?: (settings: ChannelPublicationSettings) => Promise<void>;
    acceptSecond?: () => Promise<void>;
  }>,
): ChannelListingCompositionServices {
  return {
    replaceChannelConnectionPublicationSettings: async (input) => {
      await options.replaceSettings?.(input.settings);
      return { kind: "applied" as const, value: undefined, streamVersion: input.expectedStreamVersion + 1 };
    },
    recordChannelMappingCandidates: vi.fn(),
    decideChannelMappingReview: async (input) => {
      if (input.sourceKey === "catalog-category:second-page" && input.decision === "accept") {
        await options.acceptSecond?.();
      }
      return { kind: "applied" as const, value: undefined, streamVersion: input.expectedStreamVersion + 1 };
    },
    recordChannelListingDesiredState: vi.fn(),
    recordChannelListingPublicationOutcome: vi.fn(),
    enqueueChannelListingDesiredStateBackfill: vi.fn(),
    enqueueChannelListingDesiredStateReconciliation: vi.fn(),
    drainChannelListingDesiredStateReconciliation: vi.fn(),
    resolveChannelPublishableQuantity: vi.fn(),
    readChannelListingProviderProductReferences: vi.fn(),
    readChannelMappingReviewQueue: vi.fn(),
    listChannelPublicationConnections: vi.fn(async () => [detailAt(null).connection]),
    readChannelPublicationConnection: vi.fn(
      async ({ cursor }) => options.readDetail?.(cursor ?? null) ?? detailAt(cursor ?? null),
    ),
    projectors: [],
  };
}

function detailAt(cursor: string | null, secondAccepted = false): ChannelPublicationConnectionDetail {
  const first = mappingItem("first-page");
  const second = mappingItem("second-page");
  return {
    connection: {
      connectionId: "connection-1",
      providerKey: "synthetic-provider",
      environment: "sandbox",
      connectionStatus: "active",
      settingsState: "missing",
      reviewCount: secondAccepted ? 1 : 2,
    },
    settings: null,
    mappingReview:
      cursor === "page-2"
        ? {
            items: secondAccepted ? [] : [second],
            nextCursor: null,
            completeness: { kind: "complete", total: secondAccepted ? 1 : 2 },
          }
        : { items: [first], nextCursor: "page-2", completeness: { kind: "complete", total: secondAccepted ? 1 : 2 } },
    configurationStreamVersion: 0,
  };
}

function mappingItem(suffix: string) {
  return {
    connectionId: "connection-1",
    dimension: "category" as const,
    sourceKey: `catalog-category:${suffix}`,
    targetKey: null,
    confidenceTier: "high" as const,
    reviewStatus: "proposed" as const,
    provenance: "compose-discovered" as const,
    evidence: { listingId: "listing-1", derivedFrom: `route-${suffix}` },
    lastStreamVersion: 1,
  };
}

function loaderArgs(path: string) {
  return {
    request: new Request(`http://localhost${path}`),
    params: { connectionId: "connection-1" },
    context: {},
  } as unknown as Parameters<typeof loader>[0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const testContext: EventStoreContext = {
  tenantId: "tenant-1" as EventStoreContext["tenantId"],
  audit: {
    performedByUserId: "user-1" as EventStoreContext["audit"]["performedByUserId"],
    forAccountId: "account-1" as EventStoreContext["audit"]["forAccountId"],
  },
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
