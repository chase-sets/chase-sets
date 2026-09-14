// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ChannelConnectionHealthPanel, type ChannelHealthPanelState } from "../ui/health-panel";

afterEach(cleanup);
function panel(state: ChannelHealthPanelState) {
  const router = createMemoryRouter([{ path: "/", element: <ChannelConnectionHealthPanel state={state} /> }]);
  render(
    <ChaseRoot>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
}
describe("channel-connection-health-panel-states", () => {
  it("renders loading", () => {
    panel({ kind: "loading" });
    expect(screen.getByText("Loading channel health and attention.")).toBeTruthy();
  });
  it("renders unavailable without implying healthy", () => {
    panel({ kind: "read-error" });
    expect(screen.getByText("Channel health and attention is unavailable")).toBeTruthy();
    expect(screen.queryByText("Healthy")).toBeNull();
  });
  it("renders healthy with no resolution control", () => {
    panel({ kind: "loaded", data: { connectionId: "synthetic", healthState: "healthy", health: [], manual: null } });
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("renders exact generation and only seller resolution choices", () => {
    panel({
      kind: "loaded",
      data: {
        connectionId: "synthetic",
        healthState: "failing",
        manual: null,
        health: [
          {
            reasonCode: "polling",
            generation: 7,
            fingerprint: "a".repeat(64),
            state: "failing",
            consecutiveFailures: 3,
            trailingFailures: 3,
            opening: { sourceWorkId: "b".repeat(64), sourceAttempt: 1, occurredAt: "2026-09-13T00:00:00Z" },
            lastOccurredAt: "2026-09-13T00:00:00Z",
          },
        ],
      },
    });
    expect(screen.getByText("Channel polling")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resolve attention" })).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.queryByRole("option", { name: "Recovered automatically" })).toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[name="generation"]')?.value).toBe("7");
  });
});
