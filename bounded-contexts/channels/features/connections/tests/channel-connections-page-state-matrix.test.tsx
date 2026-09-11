// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import AccountChannelsRoute, { loader as listLoader } from "../../../routes/marketplace/account-channels";
import AccountChannelsConnectionRoute, {
  action as detailAction,
  loader as detailLoader,
} from "../../../routes/marketplace/account-channels-connection";
import { allowedChannelConnectionActions } from "../ui/connection-pages";
import { channelConnectionStatuses, type ChannelConnectionStatus } from "../domain/contracts";
import { createFakeConnectionServices, mountConnectionRouteHarness, routeAccountId } from "./route-harness";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fixedCreatedAt = "2026-09-01T00:00:00.000Z";

function fixtureFor(status: ChannelConnectionStatus) {
  return {
    connectionId: `connection-${status}`,
    accountId: routeAccountId,
    providerKey: "fixture-provider",
    environment: "sandbox" as const,
    status,
    createdAt: fixedCreatedAt,
  };
}

describe("channel-connections-page-state-matrix", () => {
  it("shows the canonical empty state when the account has no connections", async () => {
    mountConnectionRouteHarness(createFakeConnectionServices([]).services);
    const router = createMemoryRouter(
      [{ path: "/account/channels", loader: listLoader, Component: AccountChannelsRoute }],
      { initialEntries: ["/account/channels"] },
    );
    render(
      <ChaseRoot linkComponent={RouterLinkAdapter}>
        <RouterProvider router={router} />
      </ChaseRoot>,
    );
    expect(await screen.findByText("No channel connections")).toBeTruthy();
  });

  it("shows the canonical error state when the connections API fails to load", async () => {
    const { services } = createFakeConnectionServices([]);
    services.listConnections = vi.fn(async () => {
      throw new Error("boom");
    });
    mountConnectionRouteHarness(services);
    const router = createMemoryRouter(
      [{ path: "/account/channels", loader: listLoader, Component: AccountChannelsRoute }],
      { initialEntries: ["/account/channels"] },
    );
    render(
      <ChaseRoot linkComponent={RouterLinkAdapter}>
        <RouterProvider router={router} />
      </ChaseRoot>,
    );
    expect(await screen.findByText("Connections could not be loaded")).toBeTruthy();
    expect(await screen.findByText("Channels API error 500")).toBeTruthy();
  });

  it("shows the loading state during a filter navigation instead of stale results", async () => {
    const fixtures = channelConnectionStatuses.map(fixtureFor);
    const harness = createFakeConnectionServices(fixtures);
    const originalList = harness.services.listConnections;
    let releaseSecondLoad: () => void = () => {};
    let loadCount = 0;
    harness.services.listConnections = vi.fn(async (input) => {
      loadCount += 1;
      if (loadCount === 2) {
        await new Promise<void>((resolve) => {
          releaseSecondLoad = resolve;
        });
      }
      return originalList(input);
    });
    mountConnectionRouteHarness(harness.services);
    const router = createMemoryRouter(
      [{ path: "/account/channels", loader: listLoader, Component: AccountChannelsRoute }],
      { initialEntries: ["/account/channels"] },
    );
    render(
      <ChaseRoot linkComponent={RouterLinkAdapter}>
        <RouterProvider router={router} />
      </ChaseRoot>,
    );
    expect(await screen.findAllByRole("link", { name: "View connection" })).toHaveLength(3);

    void router.navigate("/account/channels?status=paused");
    await waitFor(() => expect(router.state.navigation.state).toBe("loading"));
    expect(await screen.findByText("Loading channel connections…")).toBeTruthy();

    await act(async () => {
      releaseSecondLoad();
    });
    expect(await screen.findAllByRole("link", { name: "View connection" })).toHaveLength(1);
    expect(screen.queryByText("Loading channel connections…")).toBeNull();
  });

  it("excludes disconnected from the default list and includes it only under the explicit filter", async () => {
    const fixtures = channelConnectionStatuses.map(fixtureFor);
    mountConnectionRouteHarness(createFakeConnectionServices(fixtures).services);
    const router = createMemoryRouter(
      [{ path: "/account/channels", loader: listLoader, Component: AccountChannelsRoute }],
      { initialEntries: ["/account/channels"] },
    );
    render(
      <ChaseRoot linkComponent={RouterLinkAdapter}>
        <RouterProvider router={router} />
      </ChaseRoot>,
    );
    expect(await screen.findAllByRole("link", { name: "View connection" })).toHaveLength(3);
    expect(screen.getAllByRole("link", { name: "Active" })).toHaveLength(1);

    await act(async () => {
      await router.navigate("/account/channels?status=disconnected");
    });
    expect(await screen.findAllByRole("link", { name: "View connection" })).toHaveLength(1);
  });

  it.each(channelConnectionStatuses)("renders the exact allowed action set for status %s", async (status) => {
    const fixture = fixtureFor(status);
    mountConnectionRouteHarness(createFakeConnectionServices([fixture]).services);
    const router = createMemoryRouter(
      [
        {
          path: "/account/channels/:connectionId",
          loader: detailLoader,
          action: detailAction,
          Component: AccountChannelsConnectionRoute,
        },
      ],
      { initialEntries: [`/account/channels/${fixture.connectionId}`] },
    );
    render(
      <ChaseRoot linkComponent={RouterLinkAdapter}>
        <RouterProvider router={router} />
      </ChaseRoot>,
    );
    await screen.findByText("fixture-provider");
    const expectedActions = allowedChannelConnectionActions(status);
    const actionLabels: Record<string, string> = { pause: "Pause", resume: "Resume", disconnect: "Disconnect" };
    for (const action of ["pause", "resume", "disconnect"] as const) {
      const button = screen.queryByRole("button", { name: actionLabels[action] });
      if (expectedActions.includes(action)) {
        expect(button, `expected a ${action} button for status ${status}`).toBeTruthy();
      } else {
        expect(button, `did not expect a ${action} button for status ${status}`).toBeNull();
      }
    }
    if (expectedActions.length === 0) {
      expect(await screen.findByText("No actions are available for this connection.")).toBeTruthy();
    }
  });
});
