// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import AccountChannelsRoute, { loader as listLoader } from "../../../routes/marketplace/account-channels";
import AccountChannelsConnectionRoute, {
  loader as detailLoader,
} from "../../../routes/marketplace/account-channels-connection";
import { createFakeConnectionServices, mountConnectionRouteHarness } from "./route-harness";
import {
  channelConnectionBrowserState,
  channelConnectionStateFixture,
  mountChannelConnectionBrowserState,
} from "./browser-state-fixture.test-data";

type FixtureHost = {
  __reactRouterDataRouter: ReturnType<typeof createMemoryRouter>;
  channelConnectionEvidence?: { dispose: () => void };
};
const host = window as unknown as FixtureHost;

afterEach(() => {
  host.__reactRouterDataRouter?.dispose();
  host.channelConnectionEvidence?.dispose();
  cleanup();
  vi.unstubAllGlobals();
});

describe("channels-connect-design-system browser fixture uses the production routes", () => {
  for (const surface of ["list", "connect", "setup", "activate"] as const) {
    it.each(["loading", "empty", "error", "success"] as const)(`${surface} renders %s`, async (state) => {
      const connection = channelConnectionStateFixture("active");
      mountConnectionRouteHarness(createFakeConnectionServices([connection]).services);
      const router = createMemoryRouter(
        [
          {
            id: "channels/account-channels",
            path: "/account/channels",
            loader: listLoader,
            Component: AccountChannelsRoute,
          },
          {
            id: "channels/account-channels-connection",
            path: "/account/channels/:connectionId",
            loader: detailLoader,
            Component: AccountChannelsConnectionRoute,
          },
        ],
        { initialEntries: ["/account/channels/connection-active"] },
      );
      host.__reactRouterDataRouter = router;
      render(
        <ChaseRoot linkComponent={RouterLinkAdapter}>
          <RouterProvider router={router} />
        </ChaseRoot>,
      );
      await screen.findByText("fixture-provider");
      const originals = router.routes.map((route) => ({ loader: route.loader, action: route.action }));
      await act(async () => {
        await mountChannelConnectionBrowserState(channelConnectionBrowserState(surface, state));
      });
      if (surface === "list") {
        expect(
          await screen.findByText(
            state === "loading"
              ? "Loading channel connections…"
              : state === "empty"
                ? "No channel connections"
                : state === "error"
                  ? "Channels API error 503"
                  : "fixture-provider",
          ),
        ).toBeTruthy();
      } else if (state === "empty") {
        expect(
          screen.queryByRole("button", { name: surface === "connect" ? "Connect a channel" : "Activate" }),
        ).toBeNull();
        expect(
          surface === "connect"
            ? screen.getByText("No channel connections")
            : screen.getByRole("link", { name: "Storage locations" }),
        ).toBeTruthy();
      } else {
        const label = surface === "connect" ? "Connect a channel" : "Activate";
        if (surface !== "connect") fireEvent.click(screen.getByRole("checkbox", { name: "Shelf one" }));
        fireEvent.click(screen.getByRole("button", { name: label }));
        if (state === "loading") {
          await waitFor(() =>
            expect(screen.getByRole("button", { name: label }).getAttribute("aria-busy")).toBe("true"),
          );
          expect(router.state.navigation.state).toBe("submitting");
        } else {
          expect(
            await screen.findByText(
              state === "error"
                ? surface === "connect"
                  ? "provider-setup-not-registered"
                  : "binding-not-current"
                : surface === "connect"
                  ? "Pending setup"
                  : "Active",
            ),
          ).toBeTruthy();
        }
      }
      router.dispose();
      host.channelConnectionEvidence?.dispose();
      expect(router.routes.map((route) => ({ loader: route.loader, action: route.action }))).toEqual(originals);
    });
  }
});
