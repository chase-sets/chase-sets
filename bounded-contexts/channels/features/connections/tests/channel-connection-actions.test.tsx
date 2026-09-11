// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import AccountChannelsConnectionRoute, {
  action as detailAction,
  loader as detailLoader,
} from "../../../routes/marketplace/account-channels-connection";
import { ChannelConnectionDetailPage } from "../ui/connection-pages";
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

function intentFormData(intent: string) {
  const formData = new FormData();
  formData.set("intent", intent);
  return formData;
}

describe("channel-connection-actions", () => {
  it("disables every action control while a command is pending for the connection", () => {
    render(
      <ChaseRoot linkComponent={RouterLinkAdapter}>
        <MemoryRouter>
          <ChannelConnectionDetailPage state={{ kind: "ready", connection }} pendingIntent="pause" />
        </MemoryRouter>
      </ChaseRoot>,
    );
    expect(screen.getByRole("button", { name: "Pause" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Disconnect" }).hasAttribute("disabled")).toBe(true);
  });

  it("submits pause once and reconciles from the committed API response", async () => {
    const harness = createFakeConnectionServices([fixture]);
    mountConnectionRouteHarness(harness.services);
    const router = renderDetail();
    await screen.findByText("fixture-provider");

    await act(async () => {
      await router.navigate(path, { formMethod: "post", formData: intentFormData("pause") });
    });

    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(harness.calls.pause).toBe(1);
    expect(harness.connections.get(fixture.connectionId)?.status).toBe("paused");
  });

  it("renders a stable domain error without inventing optimistic state on a failed response", async () => {
    const harness = createFakeConnectionServices([fixture]);
    harness.services.pauseChannelConnection = vi.fn(async () => {
      throw new ChannelConnectionError("connection-disconnected");
    });
    mountConnectionRouteHarness(harness.services);
    const router = renderDetail();
    await screen.findByText("fixture-provider");

    await act(async () => {
      await router.navigate(path, { formMethod: "post", formData: intentFormData("pause") });
    });

    expect(await screen.findByText("connection-disconnected")).toBeTruthy();
    // The connection remains in its last-known committed status: still active,
    // still offering Pause rather than a locally invented Paused/Resume state.
    expect(await screen.findByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(harness.connections.get(fixture.connectionId)?.status).toBe("active");
  });

  it("repeats a resolved command as a single, idempotent call rather than compounding state", async () => {
    const harness = createFakeConnectionServices([fixture]);
    mountConnectionRouteHarness(harness.services);
    const router = renderDetail();
    await screen.findByText("fixture-provider");

    await act(async () => {
      await router.navigate(path, { formMethod: "post", formData: intentFormData("pause") });
    });
    expect(harness.calls.pause).toBe(1);
    expect(harness.connections.get(fixture.connectionId)?.status).toBe("paused");

    // A second, distinct disconnect command is still honored once and reflects
    // the newly committed terminal status, never an invented intermediate one.
    await act(async () => {
      await router.navigate(path, { formMethod: "post", formData: intentFormData("disconnect") });
    });
    expect(harness.calls.disconnect).toBe(1);
    expect(await screen.findByText("No actions are available for this connection.")).toBeTruthy();
    expect(harness.connections.get(fixture.connectionId)?.status).toBe("disconnected");
  });
});
