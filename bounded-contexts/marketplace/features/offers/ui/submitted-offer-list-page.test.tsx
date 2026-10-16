// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketplaceSubmittedOfferListPage } from "./submitted-offer-list-page";
import type { SubmittedOfferListItem } from "./contracts";

afterEach(cleanup);

function offer(offerId: string, status: string, itemTitle: string): SubmittedOfferListItem {
  return {
    offer_id: offerId,
    buyer_account_id: "acc_buyer",
    catalog_catalog_item_id: "cat_one",
    product_id: "cat_one::",
    item_title: itemTitle,
    item_subtitle: null,
    selected_options: [],
    product_summary: null,
    price_amount: "20.00",
    price_currency_code: "USD",
    last_stream_version: 2,
    quantity_requested: 1,
    status,
    accepted_seller_account_id: null,
    accepted_at: null,
    created_at: "2026-10-14T00:00:00.000Z",
    updated_at: "2026-10-14T00:00:00.000Z",
  };
}

const statusCounts = { submitted: 3, paused: 2, withdrawn: 1, accepted: 0 };

function renderPage(overrides: Partial<Parameters<typeof MarketplaceSubmittedOfferListPage>[0]> = {}) {
  const onLifecycleAction = vi.fn();
  const onStatusFilterChange = vi.fn();
  render(
    <MarketplaceSubmittedOfferListPage
      data={{
        items: [offer("off_open", "submitted", "Charizard"), offer("off_paused", "paused", "Blastoise")],
        statusCounts,
      }}
      statusFilter="all"
      onStatusFilterChange={onStatusFilterChange}
      lifecycle={{ pending: false, outcomes: null, onAction: onLifecycleAction }}
      {...overrides}
    />,
  );
  return { onLifecycleAction, onStatusFilterChange };
}

describe("Submitted Offers list lifecycle controls", () => {
  it("filters by Open, Paused, Withdrawn and Accepted with per-status counts", () => {
    const { onStatusFilterChange } = renderPage();
    expect(screen.getByRole("radio", { name: "All (6)" }).getAttribute("aria-checked")).toBe("true");
    for (const name of ["Open (3)", "Paused (2)", "Withdrawn (1)", "Accepted (0)"])
      expect(screen.getByRole("radio", { name })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Paused (2)" }));
    expect(onStatusFilterChange).toHaveBeenCalledWith("paused");
  });

  it("shows a per-filter empty state", () => {
    renderPage({ data: { items: [], statusCounts }, statusFilter: "withdrawn" });
    expect(screen.getAllByText("No withdrawn Offers").length).toBeGreaterThan(0);
  });

  it("offers Pause on open rows and Resume on paused rows", () => {
    const { onLifecycleAction } = renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: "Pause Charizard" })[0]!);
    expect(onLifecycleAction).toHaveBeenLastCalledWith("pause", ["off_open"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Resume Blastoise" })[0]!);
    expect(onLifecycleAction).toHaveBeenLastCalledWith("resume", ["off_paused"]);
    expect(screen.queryAllByRole("button", { name: "Resume Charizard" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "Pause Blastoise" })).toHaveLength(0);
  });

  it("asks for confirmation before withdrawing a row and does nothing on cancel", async () => {
    const { onLifecycleAction } = renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: "Withdraw Charizard" })[0]!);
    expect(onLifecycleAction).not.toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep Offer" }));
    expect(onLifecycleAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Withdraw Charizard" })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    expect(onLifecycleAction).toHaveBeenCalledWith("withdraw", ["off_open"]);
  });

  it("runs bulk Pause and Resume on the selection and confirms bulk Withdraw", async () => {
    const { onLifecycleAction } = renderPage();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Charizard" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Blastoise" }));
    expect(screen.getByText("2 Offers selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause selected" }));
    expect(onLifecycleAction).toHaveBeenLastCalledWith("pause", ["off_open", "off_paused"]);
    fireEvent.click(screen.getByRole("button", { name: "Resume selected" }));
    expect(onLifecycleAction).toHaveBeenLastCalledWith("resume", ["off_open", "off_paused"]);
    onLifecycleAction.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw selected" }));
    expect(onLifecycleAction).not.toHaveBeenCalled();
    expect(await screen.findByText("Withdraw 2 Offers?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(onLifecycleAction).toHaveBeenCalledWith("withdraw", ["off_open", "off_paused"]);
  });

  it("reports one outcome per row, including rejected rows", () => {
    renderPage({
      lifecycle: {
        pending: false,
        onAction: vi.fn(),
        outcomes: [
          { offerId: "off_open", outcome: "changed", status: "paused", version: 3 },
          { offerId: "off_paused", outcome: "unchanged", status: "paused", version: 2 },
          { offerId: "off_gone", outcome: "rejected", code: "offer_transition_rejected" },
        ],
      },
    });
    expect(screen.getByText("1 changed, 1 already in that state, 1 could not change")).toBeTruthy();
    expect(screen.getByText("Charizard: now Paused")).toBeTruthy();
    expect(screen.getByText("Blastoise: already Paused")).toBeTruthy();
    expect(screen.getByText("off_gone: withdrawn and accepted Offers are final")).toBeTruthy();
  });

  it("tells the buyer when lifecycle changes are not open yet", () => {
    renderPage({
      lifecycle: {
        pending: false,
        onAction: vi.fn(),
        outcomes: [{ offerId: "off_open", outcome: "rejected", code: "offer_lifecycle_closed" }],
      },
    });
    expect(screen.getByText("Charizard: Pause, Resume and Withdraw are not open yet. Try again later.")).toBeTruthy();
  });
});
