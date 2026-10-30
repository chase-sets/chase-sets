// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { createMemoryRouter, RouterProvider } from "react-router";
import { channelsEnglishTranslations } from "@chase-sets/localization/locales/en/channels";
import type { ConnectorAttentionContribution } from "../domain/contracts";
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
  it("does not imply resolution on an empty later order page", () => {
    panel({
      kind: "loaded",
      data: {
        connectionId: "synthetic",
        healthState: "unknown",
        health: [],
        manual: null,
        orders: { count: 100, hasMore: true, nextCursor: null, items: [] },
      },
    });
    expect(screen.getByRole("link", { name: "No order issues on this page. Return to the first page." })).toBeTruthy();
    expect(screen.queryByText("No open health attention")).toBeNull();
  });
  it("renders an order reference and reason without inventing an acknowledgement, with bounded paging", () => {
    panel({
      kind: "loaded",
      data: {
        connectionId: "synthetic",
        healthState: "unknown",
        health: [],
        manual: null,
        orders: {
          count: 100,
          hasMore: true,
          nextCursor: "next",
          items: [
            {
              externalOrderReference: "synthetic-order",
              reason: "tcgplayer-order-unmapped",
              generation: 1,
              openedAt: "2026-09-12T00:00:00Z",
              affectedLineCount: 0,
            },
          ],
        },
      },
    });
    expect(screen.getByText("Order synthetic-order")).toBeTruthy();
    expect(screen.getByText("An order item could not be matched to inventory.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "More order issues" }).getAttribute("href")).toContain("orderCursor=next");
    expect(screen.queryByRole("button", { name: "Resolve attention" })).toBeNull();
  });
  it("renders the health section as flush furniture", () => {
    panel({ kind: "loaded", data: { connectionId: "synthetic", healthState: "healthy", health: [], manual: null } });
    expect(screen.getByTestId("channel-health-panel").className).toBe("rounded-tokenLg overflow-hidden p-4");
  });

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
  it.each([
    { reasonCode: "polling", label: "Channel polling" },
    { reasonCode: "connector-liveness", label: "Connector not responding" },
  ] as const)("renders $reasonCode generation and only seller resolution choices", ({ reasonCode, label }) => {
    panel({
      kind: "loaded",
      data: {
        connectionId: "synthetic",
        healthState: "failing",
        manual: null,
        health: [
          {
            reasonCode,
            generation: 7,
            fingerprint: reasonCode === "connector-liveness" ? "pair_synthetic" : "a".repeat(64),
            state: "failing",
            consecutiveFailures: 3,
            trailingFailures: 3,
            opening: {
              sourceWorkId:
                reasonCode === "connector-liveness"
                  ? JSON.stringify([reasonCode, "synthetic", "pair_synthetic", 1, "b".repeat(64)])
                  : "b".repeat(64),
              sourceAttempt: 1,
              occurredAt: "2026-09-13T00:00:00Z",
            },
            lastOccurredAt: "2026-09-13T00:00:00Z",
          },
        ],
      },
    });
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resolve attention" })).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.queryByRole("option", { name: "Recovered automatically" })).toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[name="generation"]')?.value).toBe("7");
  });
});

const idle = { lastSucceededAt: null, queued: 0, inFlightSince: null } as const;
const connector = (overrides: Partial<ConnectorAttentionContribution> = {}): ConnectorAttentionContribution => ({
  signInNeeded: false,
  unknownOutcomes: [],
  activity: { "live-export": idle, "order-pull": idle, "staged-import-batch": idle },
  ...overrides,
});
function connectorPanel(value: ConnectorAttentionContribution | null) {
  panel({
    kind: "loaded",
    data: { connectionId: "synthetic", healthState: "healthy", health: [], manual: null, connector: value },
  });
  return screen.queryByTestId("channel-connector-attention");
}
// Every rendered string must be a catalog template; a hard-coded literal matches none of them.
const catalogTemplates = Object.values(channelsEnglishTranslations).map(
  (value) => new RegExp(`^${value.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[A-Za-z]+\}/g, ".+")}$`),
);
function expectOnlyCatalogText(section: HTMLElement) {
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
  const texts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node.textContent?.trim()) texts.push(node.textContent.trim());
  expect(texts.length).toBeGreaterThan(0);
  expect(texts.filter((text) => !catalogTemplates.some((template) => template.test(text)))).toEqual([]);
}

describe("channel-connection-health-panel-states connector section", () => {
  it("is absent when the connection has no connector work", () => {
    expect(connectorPanel(null)).toBeNull();
  });
  it("says no connector activity yet when every kind is idle", () => {
    const section = connectorPanel(connector())!;
    expect(screen.getByText("No connector activity yet")).toBeTruthy();
    expect(screen.queryByText("Sign in to TCGplayer")).toBeNull();
    expectOnlyCatalogText(section);
  });
  it("instructs a sign-in in the connector's Chrome profile without implying Chase Sets signs in", () => {
    const section = connectorPanel(connector({ signInNeeded: true }))!;
    expect(screen.getByText("Sign in to TCGplayer")).toBeTruthy();
    expect(
      screen.getByText(
        "Sign in to TCGplayer in the Chrome profile where the connector runs. Chase Sets never asks for or stores that sign-in.",
      ),
    ).toBeTruthy();
    expect(section.querySelectorAll("button, a, input, form")).toHaveLength(0);
    expectOnlyCatalogText(section);
  });
  it("renders each unknown outcome with suffix and reason, says it will not be retried, and offers no control", () => {
    const section = connectorPanel(
      connector({
        unknownOutcomes: [
          { kind: "live-export", idSuffix: "a1b2", reason: "session-lost", at: "2026-10-18T10:00:00.000Z" },
          { kind: "order-pull", idSuffix: "c3d4", reason: "completeness-unproven", at: "2026-10-18T10:01:00.000Z" },
          {
            kind: "staged-import-batch",
            idSuffix: "e5f6",
            reason: "application-unknown",
            at: "2026-10-18T10:02:00.000Z",
          },
        ],
      }),
    )!;
    expect(
      screen.getByText("Chase Sets will not retry these. Check TCGplayer before changing those listings."),
    ).toBeTruthy();
    for (const [label, reference, reason] of [
      [
        "Live export",
        "Ending a1b2, reported 2026-10-18T10:00:00.000Z",
        "The TCGplayer sign-in in the connector's browser profile ended.",
      ],
      [
        "Order pull",
        "Ending c3d4, reported 2026-10-18T10:01:00.000Z",
        "The order list could not be confirmed as complete.",
      ],
      [
        "Staged import batch",
        "Ending e5f6, reported 2026-10-18T10:02:00.000Z",
        "TCGplayer did not confirm whether the staged import was applied.",
      ],
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getByText(reference)).toBeTruthy();
      expect(screen.getByText(reason)).toBeTruthy();
    }
    expect(section.querySelectorAll("button, a, input, form")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /retry|resolve/i })).toBeNull();
    expectOnlyCatalogText(section);
  });
  it("renders per-kind activity with last success, complete queued count and in-flight start", () => {
    const section = connectorPanel(
      connector({
        activity: {
          "live-export": { lastSucceededAt: "2026-10-18T09:00:00.000Z", queued: 1, inFlightSince: null },
          "order-pull": { lastSucceededAt: null, queued: 0, inFlightSince: "2026-10-18T09:30:00.000Z" },
          "staged-import-batch": idle,
        },
      }),
    )!;
    expect(screen.getByText("Live export")).toBeTruthy();
    expect(screen.getByText("Last succeeded 2026-10-18T09:00:00.000Z")).toBeTruthy();
    expect(screen.getByText("Queued: 1")).toBeTruthy();
    expect(screen.getByText("Order pull")).toBeTruthy();
    expect(screen.getByText("No success yet")).toBeTruthy();
    expect(screen.getByText("In progress since 2026-10-18T09:30:00.000Z")).toBeTruthy();
    expect(screen.queryByText("Staged import batch")).toBeNull();
    expect(screen.queryByText("No connector activity yet")).toBeNull();
    expectOnlyCatalogText(section);
  });
  it("keeps the panel's read-error notice instead of a connector section", () => {
    panel({ kind: "read-error" });
    expect(screen.queryByTestId("channel-connector-attention")).toBeNull();
    expect(screen.getByText("Channel health and attention is unavailable")).toBeTruthy();
  });
});
