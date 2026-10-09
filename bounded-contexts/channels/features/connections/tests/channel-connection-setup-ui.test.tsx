// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { ChannelConnectionListPage, ChannelConnectionSetupSection } from "../ui/connection-pages";
import type { ReactNode } from "react";

afterEach(cleanup);
function show(children: ReactNode) {
  const router = createMemoryRouter([{ path: "/", element: children }]);
  render(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
}

describe("channels-connect-design-system states", () => {
  it("hides connect when no deployment provider resolves", () => {
    show(
      <ChannelConnectionListPage state={{ kind: "ready", connections: [], statusFilter: "default" }} providers={[]} />,
    );
    expect(screen.queryByRole("button", { name: "Connect a channel" })).toBeNull();
  });
  it("renders connect pending and inline refusal", () => {
    show(
      <ChannelConnectionListPage
        state={{ kind: "ready", connections: [], statusFilter: "default" }}
        providers={["tcgplayer"]}
        connecting
        connectError="provider-setup-not-registered"
      />,
    );
    expect(screen.getByRole("button", { name: "Connect a channel" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("provider-setup-not-registered")).toBeTruthy();
  });
  it("requires a selection, retains multiple ids, and enables activation", () => {
    show(
      <ChannelConnectionSetupSection
        locations={{
          kind: "loaded",
          items: [
            { storageLocationId: "one", name: "Shelf one" },
            { storageLocationId: "two", name: "Shelf two" },
          ],
        }}
      />,
    );
    const button = screen.getByRole("button", { name: "Activate" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Shelf one" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Shelf two" }));
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(new FormData(button.closest("form")!).getAll("storageLocationIds")).toEqual(["one", "two"]);
  });
  it("links empty Inventory without offering activation", () => {
    show(<ChannelConnectionSetupSection locations={{ kind: "loaded", items: [] }} />);
    expect(screen.getByRole("link", { name: "Storage locations" }).getAttribute("href")).toBe(
      "/account/inventory/locations",
    );
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
  });
  it("disables the selection and activation during submission", () => {
    show(
      <ChannelConnectionSetupSection
        locations={{ kind: "loaded", items: [{ storageLocationId: "one", name: "Shelf one" }] }}
        pending
      />,
    );
    expect(screen.getByRole("button", { name: "Activate" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("checkbox", { name: "Shelf one" }).hasAttribute("disabled")).toBe(true);
  });
  it("renders unavailable Inventory without pretending the account has no locations", () => {
    show(<ChannelConnectionSetupSection locations={{ kind: "read-error" }} />);
    expect(screen.queryByRole("link", { name: "Storage locations" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
  });
});
