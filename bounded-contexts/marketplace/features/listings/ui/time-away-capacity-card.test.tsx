// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TimeAwayCapacityCard, type TimeAwayCapacitySnapshot } from "./time-away-capacity-card";
import type { MarketplaceSellerListingAvailability, MarketplaceSellerOrderCapacity } from "./contracts";

function availability(
  overrides: Partial<MarketplaceSellerListingAvailability> = {},
): MarketplaceSellerListingAvailability {
  return {
    account_id: "acc_seller",
    status: "available",
    disabled_reason_category: null,
    available_again_on: null,
    available_again_at: null,
    disabled_at: null,
    enabled_at: "2026-06-01T00:00:00.000Z",
    away_window_starts_at: null,
    away_window_ends_at: null,
    away_window_reason_category: null,
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function capacity(overrides: Partial<MarketplaceSellerOrderCapacity> = {}): MarketplaceSellerOrderCapacity {
  return {
    account_id: "acc_seller",
    max_open_orders: null,
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<TimeAwayCapacitySnapshot> = {}): TimeAwayCapacitySnapshot {
  return {
    availability: availability(),
    orderCapacity: capacity(),
    openOrderCount: 0,
    activeListingCount: 4,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("TimeAwayCapacityCard states", () => {
  // State 1: available (and capacity unset) -- status badge, impact preview,
  // schedule-away-window affordance, and "no cap set" capacity copy.
  it("renders the available state with the impact preview and a schedulable away window", () => {
    render(<TimeAwayCapacityCard {...snapshot()} />);

    // Available state: the disable ("turn off") control is offered, not the
    // enable ("turn on") control; the impact preview and schedulable window show.
    expect(screen.getByRole("button", { name: "Turn off listings" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on listings" })).toBeNull();
    expect(
      screen.getByText(
        "4 active listings will be hidden from buyers; offer acceptance pauses; orders already in flight are unaffected.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Schedule away window" })).toBeTruthy();
    expect(screen.getByText("No cap set — you'll accept unlimited open orders.")).toBeTruthy();
    const root = screen.getByRole("button", { name: "Turn off listings" }).closest(".rounded-tokenLg");
    expect(root).not.toBeNull();
    const tokens = new Set((root as HTMLElement).className.split(/\s+/));
    expect(tokens.has("bg-surface-2"), "time-away capacity includes bg-surface-2").toBe(true);
    for (const excluded of [
      "ds-glass",
      "border",
      "border-muted",
      "shadow-tokenSm",
      "shadow-tokenLg",
      "ds-glow",
      "hover:border-accent",
      "hover:shadow-tokenMd",
    ])
      expect(tokens.has(excluded), `time-away capacity excludes ${excluded}`).toBe(false);
  });

  it("populates seller-local away-window instants from the submitted date fields", () => {
    render(<TimeAwayCapacityCard {...snapshot()} />);

    const submit = screen.getByRole("button", { name: "Schedule away window" });
    const form = submit.closest("form");
    expect(form).not.toBeNull();

    const startsOn = form?.elements.namedItem("awayWindowStartsOn") as HTMLInputElement;
    const endsOn = form?.elements.namedItem("awayWindowEndsOn") as HTMLInputElement;
    const startsAt = form?.elements.namedItem("awayWindowStartsAt") as HTMLInputElement;
    const endsAt = form?.elements.namedItem("awayWindowEndsAt") as HTMLInputElement;

    // Assign the DOM values directly to cover a user filling the SSR form
    // before React has attached change handlers.
    startsOn.value = "2026-08-01";
    endsOn.value = "2026-08-10";
    fireEvent.submit(form as HTMLFormElement);

    expect(startsAt.value).toBe(new Date("2026-08-01T00:00:00").toISOString());
    expect(endsAt.value).toBe(new Date("2026-08-10T00:00:00").toISOString());
  });

  // State 2: away-with-date -- the scheduled-restore notice makes the
  // automation legible with the concrete return date.
  it("renders the away-with-date state with the automatic-return notice", () => {
    render(
      <TimeAwayCapacityCard
        {...snapshot({
          availability: availability({
            status: "unavailable",
            disabled_reason_category: "travel",
            available_again_on: "2026-07-20",
            available_again_at: "2026-07-20T05:00:00.000Z",
            disabled_at: "2026-07-13T12:00:00.000Z",
            enabled_at: null,
          }),
        })}
      />,
    );

    // Away state: the enable ("turn on") control is offered, and the
    // automatic-return notice makes the resume date legible.
    expect(screen.getByRole("button", { name: "Turn on listings" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn off listings" })).toBeNull();
    expect(screen.getByText(/Your listings will automatically return on/)).toBeTruthy();
    expect(screen.getByText(/we'll notify you\./)).toBeTruthy();
  });

  // State 3: away-indefinite -- unavailable with no resume instant, so no
  // automatic-return notice is shown (nothing to promise a date for).
  it("renders the away-indefinite state without an automatic-return date notice", () => {
    render(
      <TimeAwayCapacityCard
        {...snapshot({
          availability: availability({
            status: "unavailable",
            disabled_reason_category: "operations",
            available_again_on: null,
            available_again_at: null,
            disabled_at: "2026-07-13T12:00:00.000Z",
            enabled_at: null,
          }),
        })}
      />,
    );

    // Away-indefinite: enable control is offered, but with no resume instant
    // there is no automatic-return date to promise.
    expect(screen.getByRole("button", { name: "Turn on listings" })).toBeTruthy();
    expect(screen.queryByText(/will automatically return on/)).toBeNull();
  });

  // State 4: window-scheduled -- upcoming window display + a cancel control +
  // the scheduled-restore notice describing the turn-off/return automation.
  it("renders the window-scheduled state with a cancel control and restore notice", () => {
    render(
      <TimeAwayCapacityCard
        {...snapshot({
          availability: availability({
            away_window_starts_at: "2026-08-01T07:00:00.000Z",
            away_window_ends_at: "2026-08-10T07:00:00.000Z",
            away_window_reason_category: "travel",
          }),
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel scheduled away window" })).toBeTruthy();
    expect(screen.getByText(/Your listings will turn off on/)).toBeTruthy();
    // The schedule form is not offered while a window is already pending.
    expect(screen.queryByRole("button", { name: "Schedule away window" })).toBeNull();
  });

  // State 5: at-capacity -- read-only "N of M" showing the count has reached
  // the cap. The count is supplied (Ordering-sourced); the card never counts.
  it("renders the at-capacity state with the read-only N of M open-order count", () => {
    render(
      <TimeAwayCapacityCard
        {...snapshot({
          orderCapacity: capacity({ max_open_orders: 5 }),
          openOrderCount: 5,
        })}
      />,
    );

    expect(screen.getByText("Current cap: 5 open orders")).toBeTruthy();
    expect(screen.getByText("Open orders right now: 5 of 5")).toBeTruthy();
    expect(screen.getByText("Counted live from your orders.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove cap" })).toBeTruthy();
  });

  // State 6: capacity-unset -- unlimited, no cap; the "N of M" collapses to a
  // bare count and no remove-cap control is offered.
  it("renders the capacity-unset state as unlimited with no remove-cap control", () => {
    render(<TimeAwayCapacityCard {...snapshot({ orderCapacity: capacity(), openOrderCount: 2 })} />);

    expect(screen.getByText("No cap set — you'll accept unlimited open orders.")).toBeTruthy();
    expect(screen.getByText("Open orders right now: 2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove cap" })).toBeNull();
    expect(screen.getByRole("button", { name: "Set capacity" })).toBeTruthy();
  });

  // The open-order count is strictly display: when the Ordering read is
  // unavailable the card shows a fallback rather than inventing a number.
  it("shows a fallback when the Ordering-sourced open-order count is unavailable", () => {
    render(
      <TimeAwayCapacityCard {...snapshot({ orderCapacity: capacity({ max_open_orders: 3 }), openOrderCount: null })} />,
    );

    expect(screen.getByText("Open order count is temporarily unavailable.")).toBeTruthy();
    expect(screen.queryByText(/Open orders right now:/)).toBeNull();
  });
});
