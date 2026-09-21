// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChannelPublicationDetailPage,
  ChannelPublicationListPage,
  type ChannelPublicationDetailPageState,
  type ChannelPublicationListPageState,
} from "../ui/publication-pages";
import type { ChannelPublicationConnectionDetail } from "../domain/contracts";
import AccountChannelsPublicationConnectionRoute, {
  action,
  loader,
} from "../../../routes/marketplace/account-channels-publication-connection";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("channel-publication-settings-route", () => {
  it("settings-write-visible", async () => {
    let projected = detail();
    stubPublicationRouteFetch({
      readDetail: () => projected,
      replaceSettings: (settings) => {
        projected = detail({
          connection: { ...projected.connection, settingsState: "configured" },
          settings,
          configurationStreamVersion: 1,
        });
      },
    });
    const router = renderPublicationRoute();
    expect(await screen.findByText("Settings are required")).toBeTruthy();

    await act(async () => {
      await router.navigate(PUBLICATION_PATH, { formMethod: "post", formData: settingsForm() });
    });

    expect(screen.getByDisplayValue("[fresh]")).toBeTruthy();
    expect(Object.values(router.state.actionData ?? {})[0]).toMatchObject({ kind: "applied", streamVersion: 1 });
  });

  it("settings-write-freshness-lag", async () => {
    let projectionVisible = false;
    let savedSettings = detail().settings;
    stubPublicationRouteFetch({
      readDetail: () =>
        projectionVisible
          ? detail({
              connection: { ...detail().connection, settingsState: "configured" },
              settings: savedSettings,
              configurationStreamVersion: 1,
            })
          : detail(),
      replaceSettings: (settings) => {
        savedSettings = settings;
      },
    });
    const router = renderPublicationRoute();
    expect(await screen.findByText("Settings are required")).toBeTruthy();

    await act(async () => {
      await router.navigate(PUBLICATION_PATH, { formMethod: "post", formData: settingsForm() });
    });
    expect(screen.getByText(/Loading channel publication settings/u)).toBeTruthy();
    expect(screen.queryByText("Settings are required")).toBeNull();

    projectionVisible = true;
    await act(async () => {
      await router.revalidate();
    });
    expect(screen.getByDisplayValue("[fresh]")).toBeTruthy();
    expect(screen.queryByText(/Loading channel publication settings/u)).toBeNull();
  });

  it("renders every list loading, empty, error, forbidden and success state through design-system components", () => {
    const states: readonly ChannelPublicationListPageState[] = [
      { kind: "loading" },
      { kind: "authorization-forbidden" },
      { kind: "command-error", message: "synthetic-error" },
      { kind: "ready", connections: [] },
      {
        kind: "ready",
        connections: [
          {
            connectionId: "connection-1",
            providerKey: "synthetic-provider",
            environment: "sandbox",
            connectionStatus: "active",
            settingsState: "configured",
            reviewCount: 2,
          },
        ],
      },
    ];
    const output = states.map((state) => renderToStaticMarkup(<ChannelPublicationListPage state={state} />));
    expect(output[0]).toContain("Loading channel publication settings");
    expect(output[1]).toContain("Publication access required");
    expect(output[2]).toContain("synthetic-error");
    expect(output[3]).toContain("No channel connections");
    expect(output[4]).toContain("synthetic-provider");
  });

  it("renders settings missing/present, queue empty/paged/incomplete, conflict, foreign-account and command error", () => {
    const ready = detail();
    const incomplete = detail({
      mappingReview: {
        items: [
          {
            connectionId: "connection-1",
            dimension: "category",
            sourceKey: "catalog-category:cards",
            targetKey: null,
            confidenceTier: "high",
            reviewStatus: "proposed",
            provenance: "compose-discovered",
            evidence: { listingId: "listing-1", derivedFrom: "assigned category cards" },
            lastStreamVersion: 2,
          },
        ],
        nextCursor: "next",
        completeness: { kind: "incomplete", reason: "synthetic-incomplete" },
      },
    });
    const states: readonly ChannelPublicationDetailPageState[] = [
      { kind: "loading" },
      { kind: "authorization-forbidden" },
      { kind: "foreign-account" },
      { kind: "command-error", message: "synthetic-command-error", detail: ready },
      { kind: "stale-version-conflict", detail: ready },
      { kind: "ready", detail: ready },
      { kind: "ready", detail: incomplete },
    ];
    const output = states.map((state) => renderToStaticMarkup(<ChannelPublicationDetailPage state={state} />));
    expect(output[2]).toContain("Channel connection not found");
    expect(output[3]).toContain("synthetic-command-error");
    expect(output[4]).toContain("Settings changed");
    expect(output[5]).toContain("Settings are required");
    expect(output[5]).toContain("No mappings to review");
    expect(output[6]).toContain("synthetic-incomplete");
    expect(output[6]).toContain("Next mappings");
  });
});

function detail(overrides: Partial<ChannelPublicationConnectionDetail> = {}): ChannelPublicationConnectionDetail {
  return {
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
    ...overrides,
  };
}

const PUBLICATION_PATH = "/account/channels/publication/connection-1";

function renderPublicationRoute() {
  const router = createMemoryRouter(
    [
      {
        path: "/account/channels/publication/:connectionId",
        loader,
        action,
        Component: AccountChannelsPublicationConnectionRoute,
      },
    ],
    { initialEntries: [PUBLICATION_PATH] },
  );
  render(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
  return router;
}

function settingsForm() {
  const form = new FormData();
  form.set("intent", "replace-settings");
  form.set("expectedStreamVersion", "0");
  form.set("titlePrefix", "[fresh]");
  form.set("titleSuffix", "");
  form.set("descriptionFooter", "saved footer");
  form.set("categoryAllowlist", "cards");
  form.set("excludedListingIds", "");
  return form;
}

function stubPublicationRouteFetch(options: {
  readDetail: () => ChannelPublicationConnectionDetail;
  replaceSettings: (settings: NonNullable<ChannelPublicationConnectionDetail["settings"]>) => void;
}) {
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
            permissions: ["channels.view", "channels.manage"],
          },
        });
      }
      if (url.pathname.endsWith("/publication/connection-1/settings") && request.method === "PUT") {
        const body = (await request.json()) as {
          settings: NonNullable<ChannelPublicationConnectionDetail["settings"]>;
        };
        options.replaceSettings(body.settings);
        return jsonResponse({ kind: "applied", streamVersion: 1 });
      }
      if (url.pathname.endsWith("/publication/connection-1") && request.method === "GET") {
        return jsonResponse(options.readDetail());
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    }),
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
