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
  vi.useRealTimers();
});

describe("channel-publication-settings-route", () => {
  it("settings-write-visible", async () => {
    let projected = detail();
    stubPublicationRouteFetch({
      readDetail: () => projected,
      replaceSettings: (_connectionId, settings) => {
        projected = detail({
          connection: { ...projected.connection, settingsState: "configured" },
          settings,
          configurationStreamVersion: 1,
        });
        return 1;
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
    let projectedVersion = 0;
    let appliedVersion = 0;
    let savedSettings = detail().settings;
    const stub = stubPublicationRouteFetch({
      readDetail: () =>
        projectedVersion === 0
          ? detail()
          : detail({
              connection: { ...detail().connection, settingsState: "configured" },
              settings: savedSettings,
              configurationStreamVersion: projectedVersion,
            }),
      replaceSettings: (_connectionId, settings) => {
        savedSettings = settings;
        appliedVersion += 1;
        return appliedVersion;
      },
    });
    const router = renderPublicationRoute();
    expect(await screen.findByText("Settings are required")).toBeTruthy();
    vi.useFakeTimers();

    await act(async () => {
      await router.navigate(PUBLICATION_PATH, { formMethod: "post", formData: settingsForm("0") });
    });
    expect(screen.getByText(/Loading channel publication settings/u)).toBeTruthy();
    expect(screen.queryByText("Settings are required")).toBeNull();

    const readsAfterWrite = stub.reads();
    await settle(1_999);
    expect(stub.reads()).toBe(readsAfterWrite);
    await settle(1);
    expect(stub.reads()).toBe(readsAfterWrite + 1);
    expect(screen.getByText(/Loading channel publication settings/u)).toBeTruthy();

    projectedVersion = 1;
    await settle(2_000);
    expect(screen.getByDisplayValue("[fresh]")).toBeTruthy();
    expect(screen.queryByText(/Loading channel publication settings/u)).toBeNull();

    await act(async () => {
      await router.navigate(PUBLICATION_PATH, { formMethod: "post", formData: settingsForm("1") });
    });
    expect(screen.getByText(/Loading channel publication settings/u)).toBeTruthy();
    const readsAfterStuckWrite = stub.reads();
    for (let tick = 0; tick < 40; tick += 1) await settle(2_000);
    expect(stub.reads() - readsAfterStuckWrite).toBe(15);
    expect(screen.getByText("Still catching up")).toBeTruthy();
    expect(screen.queryByText(/Loading channel publication settings/u)).toBeNull();
    expect(screen.getByDisplayValue("[fresh]")).toBeTruthy();
  });

  it("settings-freshness-exhausted-offers-refresh", async () => {
    let projectedVersion = 0;
    let appliedVersion = 0;
    let savedSettings = detail().settings;
    const stub = stubPublicationRouteFetch({
      readDetail: () =>
        projectedVersion === 0
          ? detail()
          : detail({
              connection: { ...detail().connection, settingsState: "configured" },
              settings: savedSettings,
              configurationStreamVersion: projectedVersion,
            }),
      replaceSettings: (_connectionId, settings) => {
        savedSettings = settings;
        appliedVersion += 1;
        return appliedVersion;
      },
    });
    const router = renderPublicationRoute();
    expect(await screen.findByText("Settings are required")).toBeTruthy();
    vi.useFakeTimers();

    await act(async () => {
      await router.navigate(PUBLICATION_PATH, { formMethod: "post", formData: settingsForm("0") });
    });
    expect(screen.getByText(/Loading channel publication settings/u)).toBeTruthy();

    for (let tick = 0; tick < 15; tick += 1) await settle(2_000);

    expect(screen.getByText("Still catching up")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.getByDisplayValue("[fresh]")).toBeTruthy();
    expect(screen.getByDisplayValue("saved footer")).toBeTruthy();
    expect(screen.queryByText("Settings are required")).toBeNull();
    expect(screen.queryByText(/Loading channel publication settings/u)).toBeNull();

    projectedVersion = appliedVersion;
    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    await act(async () => {
      refreshButton.click();
    });
    await settle(0);

    expect(screen.queryByText("Still catching up")).toBeNull();
    expect(screen.getByDisplayValue("[fresh]")).toBeTruthy();
  });

  it("latch-keyed-by-connection", async () => {
    const connection1 = detail({ configurationStreamVersion: 0 });
    const connection2 = detail({
      connection: {
        connectionId: "connection-2",
        providerKey: "second-provider",
        environment: "sandbox",
        connectionStatus: "active",
        settingsState: "missing",
        reviewCount: 0,
      },
      configurationStreamVersion: 0,
    });
    stubPublicationRouteFetch({
      readDetail: (connectionId) => (connectionId === "connection-2" ? connection2 : connection1),
      replaceSettings: (_connectionId, _settings) => 1,
    });
    const router = renderPublicationRoute();
    expect(await screen.findByText("Settings are required")).toBeTruthy();
    vi.useFakeTimers();

    await act(async () => {
      await router.navigate(PUBLICATION_PATH, { formMethod: "post", formData: settingsForm("0") });
    });
    expect(screen.getByText(/Loading channel publication settings/u)).toBeTruthy();

    await act(async () => {
      await router.navigate("/account/channels/publication/connection-2");
    });

    expect(screen.getByText("second-provider")).toBeTruthy();
    expect(screen.queryByText(/Loading channel publication settings/u)).toBeNull();
    expect(screen.queryByText("Still catching up")).toBeNull();

    await settle(2_000);
    expect(screen.queryByText(/Loading channel publication settings/u)).toBeNull();
    expect(screen.queryByText("Still catching up")).toBeNull();
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
    blockedListings: { items: [], total: 0 },
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

function settingsForm(expectedStreamVersion = "0") {
  const form = new FormData();
  form.set("intent", "replace-settings");
  form.set("expectedStreamVersion", expectedStreamVersion);
  form.set("titlePrefix", "[fresh]");
  form.set("titleSuffix", "");
  form.set("descriptionFooter", "saved footer");
  form.set("categoryAllowlist", "cards");
  form.set("excludedListingIds", "");
  return form;
}

function stubPublicationRouteFetch(options: {
  readDetail: (connectionId: string) => ChannelPublicationConnectionDetail;
  replaceSettings: (
    connectionId: string,
    settings: NonNullable<ChannelPublicationConnectionDetail["settings"]>,
  ) => number;
}) {
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
            accountId: "account-1",
            membershipId: "membership-1",
            roleKey: "owner",
            permissions: ["channels.view", "channels.manage"],
          },
        });
      }
      const settingsMatch = /\/publication\/([^/]+)\/settings$/u.exec(url.pathname);
      if (settingsMatch && request.method === "PUT") {
        const body = (await request.json()) as {
          settings: NonNullable<ChannelPublicationConnectionDetail["settings"]>;
        };
        return jsonResponse({
          kind: "applied",
          streamVersion: options.replaceSettings(settingsMatch[1], body.settings),
        });
      }
      const detailMatch = /\/publication\/([^/]+)$/u.exec(url.pathname);
      if (detailMatch && request.method === "GET") {
        reads += 1;
        return jsonResponse(options.readDetail(detailMatch[1]));
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    }),
  );
  return { reads: () => reads };
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
