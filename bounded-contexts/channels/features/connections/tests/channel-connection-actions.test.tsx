// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import AccountChannelsConnectionRoute, {
  action as detailAction,
  loader as detailLoader,
} from "../../../routes/marketplace/account-channels-connection";
import { ChannelConnectionError } from "../domain/contracts";
import { createFakeConnectionServices, mountConnectionRouteHarness, routeAccountId } from "./route-harness";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const path = "/account/channels/connection-1";
const connection = {
  connectionId: "connection-1",
  providerKey: "fixture-provider",
  environment: "sandbox" as const,
  status: "active" as const,
  createdAt: "2026-09-01T00:00:00.000Z",
};
const fixture = { ...connection, accountId: routeAccountId };

function renderDetail() {
  const router = createMemoryRouter(
    [
      {
        path: "/account/channels/:connectionId",
        loader: detailLoader,
        action: detailAction,
        Component: AccountChannelsConnectionRoute,
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
  return router;
}

describe("channel-connection-actions", () => {
  it("submits pause exactly once from a real click, disables every control while pending, and reconciles from the committed response", async () => {
    const harness = createFakeConnectionServices([fixture]);
    const originalPause = harness.services.pauseChannelConnection;
    let releasePause: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    harness.services.pauseChannelConnection = vi.fn(async (input) => {
      await gate;
      return originalPause(input);
    });
    const { apiRequests } = mountConnectionRouteHarness(harness.services);
    const router = renderDetail();
    await screen.findByText("fixture-provider");

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(router.state.navigation.state).toBe("submitting"));
    expect(screen.getByRole("button", { name: "Pause" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Disconnect" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Working…")).toBeTruthy();
    expect(apiRequests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect((harness.services.pauseChannelConnection as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    // A repeat click while the control is disabled must not submit a second time.
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(apiRequests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect((harness.services.pauseChannelConnection as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    await act(async () => {
      releasePause();
    });

    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(harness.calls.pause).toBe(1);
    expect(apiRequests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(harness.connections.get(fixture.connectionId)?.status).toBe("paused");
  });

  it("renders a stable domain error without inventing optimistic state on a failed response", async () => {
    const harness = createFakeConnectionServices([fixture]);
    harness.services.pauseChannelConnection = vi.fn(async () => {
      throw new ChannelConnectionError("connection-disconnected");
    });
    mountConnectionRouteHarness(harness.services);
    renderDetail();
    await screen.findByText("fixture-provider");

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByText("connection-disconnected")).toBeTruthy();
    // The connection remains in its last-known committed status: still active,
    // still offering Pause rather than a locally invented Paused/Resume state.
    expect(await screen.findByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(harness.connections.get(fixture.connectionId)?.status).toBe("active");
  });

  it("clicks a resolved command as a single, idempotent action rather than compounding state", async () => {
    const harness = createFakeConnectionServices([fixture]);
    mountConnectionRouteHarness(harness.services);
    renderDetail();
    await screen.findByText("fixture-provider");

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    expect(harness.calls.pause).toBe(1);
    expect(harness.connections.get(fixture.connectionId)?.status).toBe("paused");

    // A second, distinct disconnect click is still honored once and reflects
    // the newly committed terminal status, never an invented intermediate one.
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("No actions are available for this connection.")).toBeTruthy();
    expect(harness.calls.disconnect).toBe(1);
    expect(harness.connections.get(fixture.connectionId)?.status).toBe("disconnected");
  });
});
