// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import AccountChannelsConnectionRoute, {
  action as detailAction,
  loader as detailLoader,
} from "../../../routes/marketplace/account-channels-connection";
import { createFakeConnectionServices, foreignAccountId, mountConnectionRouteHarness } from "./route-harness";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const foreignFixture = {
  connectionId: "connection-foreign",
  accountId: foreignAccountId,
  providerKey: "fixture-provider",
  environment: "sandbox" as const,
  status: "active" as const,
  createdAt: "2026-09-01T00:00:00.000Z",
};

async function renderConnection(connectionId: string) {
  const harness = createFakeConnectionServices([foreignFixture]);
  const routeHarness = mountConnectionRouteHarness(harness.services);
  const router = createMemoryRouter(
    [
      {
        path: "/account/channels/:connectionId",
        loader: detailLoader,
        action: detailAction,
        Component: AccountChannelsConnectionRoute,
      },
    ],
    { initialEntries: [`/account/channels/${connectionId}`] },
  );
  render(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
  const title = await screen.findByText("Channel connection not found");
  const description = await screen.findByText("This connection is not available for the current account.");
  return { title: title.textContent, description: description.textContent, routeHarness };
}

describe("channel-connection-page-isolation", () => {
  it("renders the identical not-found contract for a truly missing connection and a foreign-account connection", async () => {
    const missing = await renderConnection("connection-does-not-exist");
    cleanup();
    const foreign = await renderConnection(foreignFixture.connectionId);

    expect(missing.title).toBe(foreign.title);
    expect(missing.description).toBe(foreign.description);
  });

  it("never issues an action request for a missing or foreign connection", async () => {
    const { routeHarness } = await renderConnection(foreignFixture.connectionId);

    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(routeHarness.apiRequests.every((request) => request.method === "GET")).toBe(true);
    expect(routeHarness.apiRequests.length).toBeGreaterThan(0);
  });
});
