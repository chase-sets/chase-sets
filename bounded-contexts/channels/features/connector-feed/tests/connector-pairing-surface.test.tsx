// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { ConnectorPairingPanel, type GeneratedPairingCode, type PairingPanelState } from "../ui/pairing-panel";

afterEach(cleanup);
function renderPanel(state: PairingPanelState, pending = false, generated?: GeneratedPairingCode) {
  const router = createMemoryRouter([
    { path: "/", element: <ConnectorPairingPanel state={state} pending={pending} generated={generated} /> },
  ]);
  render(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
}
describe("connector-pairing-surface", () => {
  it.each(["unpaired", "code", "expired", "paired"] as const)(
    "renders %s using the existing seller-detail panel",
    (state) => {
      renderPanel({
        kind: "loaded",
        data: {
          state,
          pairingId: "pair_test",
          revision: 2,
          codeExpiresAt: "2026-09-14T12:10:00.000Z",
          lastSeenAt: null,
        },
      });
      expect(screen.getByText("Connector pairing")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Generate pairing code" })).toBeTruthy();
      if (state === "paired") expect(screen.getByText("Not seen yet")).toBeTruthy();
      if (state === "code" || state === "paired")
        expect(screen.getByRole("button", { name: "Unpair connector" })).toBeTruthy();
      else expect(screen.queryByRole("button", { name: "Unpair connector" })).toBeNull();
    },
  );
  it("renders recoverable errors without fabricating paired state", () => {
    renderPanel({ kind: "read-error" });
    expect(screen.getByText("Connector pairing unavailable")).toBeTruthy();
    expect(screen.queryByText("Connector paired")).toBeNull();
  });
  it("disables the action and shows progress during submission", () => {
    renderPanel(
      {
        kind: "loaded",
        data: { state: "unpaired", pairingId: null, revision: null, codeExpiresAt: null, lastSeenAt: null },
      },
      true,
    );
    expect(screen.getByRole("button", { name: "Generate pairing code" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Updating connector pairing...")).toBeTruthy();
  });
  it("shows the newly generated code and expiry only for its current pairing", () => {
    const generated = {
      pairingId: "pair_test",
      revision: 1,
      code: "x".repeat(43),
      expiresAt: "2026-09-14T12:10:00.000Z",
    };
    renderPanel(
      {
        kind: "loaded",
        data: {
          state: "code",
          pairingId: generated.pairingId,
          revision: 1,
          codeExpiresAt: generated.expiresAt,
          lastSeenAt: null,
        },
      },
      false,
      generated,
    );
    expect(screen.getByText(generated.code)).toBeTruthy();
    expect(screen.getByText(`Expires ${generated.expiresAt}`)).toBeTruthy();
  });
  it("does not redisplay an old code after expiry or supersession", () => {
    const generated = {
      pairingId: "pair_old",
      revision: 1,
      code: "x".repeat(43),
      expiresAt: "2026-09-14T12:10:00.000Z",
    };
    renderPanel(
      {
        kind: "loaded",
        data: {
          state: "expired",
          pairingId: generated.pairingId,
          revision: 2,
          codeExpiresAt: generated.expiresAt,
          lastSeenAt: null,
        },
      },
      false,
      generated,
    );
    expect(screen.queryByText(generated.code)).toBeNull();
    expect(screen.getByRole("button", { name: "Generate pairing code" })).toBeTruthy();
  });
});
