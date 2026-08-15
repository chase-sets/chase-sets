// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateSellerAttentionQueue,
  buildSellerAttentionItem,
  type SellerAttentionContext,
  type SellerAttentionItem,
  type SellerAttentionQueue,
  type SellerAttentionSource,
  type SellerAttentionSourceId,
} from "@chase-sets/seller-attention-queue";
import type { SellerDeskKpis } from "./contracts";
import { SellerDeskHomePage } from "./seller-desk-home-page";

const CONTEXT: SellerAttentionContext = { accountId: "acct-1", now: "2026-07-14T12:00:00.000Z" };

const KPIS: SellerDeskKpis = {
  activeListings: 5,
  openOrdersToShip: 2,
  nextPayoutAmount: null,
  walletBalanceAmount: "$40.00",
};

function staticSource(id: SellerAttentionSourceId, items: readonly SellerAttentionItem[]): SellerAttentionSource {
  return { id, load: async () => items };
}

function throwingSource(id: SellerAttentionSourceId, reason: string): SellerAttentionSource {
  return {
    id,
    load: async () => {
      throw new Error(reason);
    },
  };
}

function expectOutlinedCard(root: Element | null) {
  expect(root).toBeTruthy();
  const className = (root as HTMLElement).className;
  const tokens = className.split(/\s+/);
  expect(tokens).toContain("border");
  expect(tokens).toContain("border-muted");
  expect(tokens).toContain("bg-surface");
  expect(className).not.toMatch(
    /\b(?:ds-glass|shadow-tokenSm|shadow-tokenLg|ds-glow|hover:border-accent|hover:shadow-tokenMd)\b/,
  );
}

async function fullQueue(): Promise<SellerAttentionQueue> {
  return aggregateSellerAttentionQueue(
    [
      staticSource("fulfillment-ship-by", [
        buildSellerAttentionItem({
          source: "fulfillment-ship-by",
          entityId: "ship-1",
          severity: "critical",
          summary: { code: "ship-by-overdue", params: { reference: "SHP-1", dueAt: "2026-07-14T00:00:00.000Z" } },
          observedAt: "2026-07-13T00:00:00.000Z",
          dueAt: "2026-07-14T00:00:00.000Z",
        }),
      ]),
      staticSource("settlement-blocked-payout", [
        buildSellerAttentionItem({
          source: "settlement-blocked-payout",
          entityId: "pay-1",
          severity: "critical",
          summary: { code: "payout-blocked", params: { reference: "PO-1", reason: "verify your bank account" } },
          observedAt: "2026-07-12T00:00:00.000Z",
        }),
      ]),
      staticSource("inventory-resolution", [
        buildSellerAttentionItem({
          source: "inventory-resolution",
          entityId: "imp-1",
          severity: "warning",
          summary: { code: "import-rows-unresolved", params: { reference: "IMP-1", count: 3 } },
          observedAt: "2026-07-11T00:00:00.000Z",
        }),
      ]),
      staticSource("offer-response", [
        buildSellerAttentionItem({
          source: "offer-response",
          entityId: "off-1",
          severity: "warning",
          summary: { code: "offer-awaiting-response", params: { reference: "Charizard" } },
          observedAt: "2026-07-11T00:00:00.000Z",
        }),
      ]),
      staticSource("listing-action", [
        buildSellerAttentionItem({
          source: "listing-action",
          entityId: "lst-1",
          severity: "info",
          summary: { code: "listing-needs-action", params: { reference: "Blastoise", action: "draft" } },
          observedAt: "2026-07-10T00:00:00.000Z",
        }),
      ]),
    ],
    CONTEXT,
  );
}

afterEach(cleanup);

describe("SellerDeskHomePage", () => {
  it("renders the three needs-you items a seller expects, critical first, each one click away", async () => {
    const queue = await fullQueue();
    render(<SellerDeskHomePage queue={queue} kpis={KPIS} />);

    // All three headline signals are present.
    expect(screen.getByText("Import IMP-1 has 3 rows to resolve")).toBeTruthy();
    expect(screen.getByText("Shipment SHP-1 is past its ship-by deadline")).toBeTruthy();
    expect(screen.getByText("Payout PO-1 is blocked: verify your bank account")).toBeTruthy();

    // Ordered by the blueprint policy: ship-by, blocked payout, import, offer, listing.
    const rows = document.querySelectorAll("[data-seller-desk-item]");
    expect([...rows].map((row) => row.getAttribute("data-seller-desk-item"))).toEqual([
      "fulfillment-ship-by:ship-1",
      "settlement-blocked-payout:pay-1",
      "inventory-resolution:imp-1",
      "offer-response:off-1",
      "listing-action:lst-1",
    ]);
    for (const row of rows) {
      expectOutlinedCard(row);
    }

    // Each row deep-links straight into the owning surface.
    const shipRow = document.querySelector('[data-seller-desk-item="fulfillment-ship-by:ship-1"]');
    expect(
      within(shipRow as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toBe("/account/desk/shipments/ship-1");
    const importRow = document.querySelector('[data-seller-desk-item="inventory-resolution:imp-1"]');
    expect(
      within(importRow as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toContain("drawer=resolution-drawer");
  });

  it("renders the KPI band, degrading a metric that could not be computed", async () => {
    const queue = await fullQueue();
    render(<SellerDeskHomePage queue={queue} kpis={KPIS} />);

    expect(screen.getByText("Active listings")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("$40.00")).toBeTruthy();
    // The next-payout tile has no value wired yet and degrades to "Unavailable".
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });

  it("shows a calm empty state with pointers when nothing needs the seller", async () => {
    const queue = await aggregateSellerAttentionQueue([], CONTEXT);
    render(<SellerDeskHomePage queue={queue} kpis={KPIS} />);

    expect(screen.getByText("Nothing needs you")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create a listing" }).getAttribute("href")).toBe("/account/listings/new");
    expect(document.querySelector("[data-seller-desk-queue]")).toBeNull();
  });

  it("marks a source unavailable without blanking the queue", async () => {
    const queue = await aggregateSellerAttentionQueue(
      [
        throwingSource("settlement-blocked-payout", "settlement unavailable"),
        staticSource("listing-action", [
          buildSellerAttentionItem({
            source: "listing-action",
            entityId: "lst-1",
            severity: "info",
            summary: { code: "listing-needs-action", params: { reference: "Blastoise", action: "draft" } },
            observedAt: "2026-07-10T00:00:00.000Z",
          }),
        ]),
      ],
      CONTEXT,
    );

    render(<SellerDeskHomePage queue={queue} kpis={KPIS} />);

    const banner = document.querySelector("[data-seller-desk-degraded]");
    expect(banner).not.toBeNull();
    expect(within(banner as HTMLElement).getByText(/Blocked payouts/)).toBeTruthy();
    // The healthy listing signal still renders.
    expect(screen.getByText("Listing Blastoise needs attention (draft)")).toBeTruthy();
  });
});
