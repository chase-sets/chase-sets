// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ComponentProps } from "react";
import { CommercialTermsHomePage } from "./commercial-terms-home-page";

const activeSchedule = {
  schedule_id: "cts_active",
  label: "Current business terms",
  account_type: "business",
  marketplace_sales_fee_percentage_bps: 850,
  marketplace_sales_fee_fixed_amount: "0.10",
  shipping_allowance_percentage_bps: 500,
  status: "active",
  effective_from: "2026-07-01T00:00:00.000Z",
  effective_until: null,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
} as const;

const upcomingSchedule = {
  ...activeSchedule,
  schedule_id: "cts_upcoming",
  label: "August business terms",
  marketplace_sales_fee_percentage_bps: 700,
  effective_from: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-07-15T00:00:00.000Z",
  history: [
    {
      history_id: "1",
      event_id: "evt_terms_created",
      event_type: "created",
      actor_user_id: "usr_admin",
      status: "active",
      payload: {},
      effective_from: "2026-08-01T00:00:00.000Z",
      effective_until: null,
      recorded_at: "2026-07-15T00:00:00.000Z",
    },
  ],
} as const;

const expiringAgreement = {
  agreement_id: "cag_expiring",
  account_id: "acc_seller",
  account_display_name: "Seller Studio",
  account_type: "business",
  label: "Launch override",
  marketplace_sales_fee_percentage_bps: 0,
  marketplace_sales_fee_fixed_amount: "0.00",
  shipping_allowance_percentage_bps: 500,
  status: "active",
  effective_from: "2026-07-10T00:00:00.000Z",
  effective_until: "2026-08-15T00:00:00.000Z",
  created_at: "2026-07-10T00:00:00.000Z",
  updated_at: "2026-07-10T00:00:00.000Z",
} as const;

function renderHome(
  props: Partial<ComponentProps<typeof CommercialTermsHomePage>> = {},
  initialEntry = "/commerce/terms",
) {
  const router = createMemoryRouter(
    [
      {
        path: "/commerce/terms",
        element: (
          <CommercialTermsHomePage
            schedules={[activeSchedule, upcomingSchedule]}
            agreements={[expiringAgreement]}
            accounts={[
              {
                accountId: "acc_seller",
                displayName: "Seller Studio",
                accountType: "business",
              },
            ]}
            now="2026-07-15T12:00:00.000Z"
            {...props}
          />
        ),
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return render(<RouterProvider router={router} />);
}

describe("commercial terms home", () => {
  afterEach(cleanup);

  it("orders schedule and agreement cards by effective date and surfaces pending windows", () => {
    const { container } = renderHome({
      agreements: [
        expiringAgreement,
        {
          ...expiringAgreement,
          agreement_id: "cag_inactive",
          label: "Inactive override",
          status: "inactive",
        },
      ],
    });
    const cards = [...container.querySelectorAll<HTMLElement>("[data-commercial-term-id]")];

    expect(cards.map((card) => card.getAttribute("data-commercial-term-id"))).toEqual([
      "cts_upcoming",
      "cag_expiring",
      "cts_active",
    ]);
    expect(screen.getByText("Effective 2026-08-01")).toBeTruthy();
    expect(screen.getByText("Override expires 2026-08-15")).toBeTruthy();
    expect(screen.queryByText("Inactive override")).toBeNull();
    for (const card of cards) {
      expect(card.classList.contains("ds-glass")).toBe(true);
      expect(card.classList.contains("shadow-tokenSm")).toBe(true);
    }
  });

  it("shows schedule state, active comparison, history, and revision form in one responsive sheet", () => {
    renderHome({ selectedSchedule: upcomingSchedule }, "/commerce/terms?schedule=cts_upcoming");

    expect(screen.getByRole("dialog", { name: "August business terms" })).toBeTruthy();
    expect(screen.getByText("Compare with active schedule")).toBeTruthy();
    expect(screen.getAllByText("Current business terms")).toHaveLength(2);
    expect(screen.getByText("Revision history")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save schedule revision" })).toBeTruthy();
  });

  it("creates an account override inline with an account picker and schedule-prefilled terms", () => {
    renderHome({ createKind: "agreement" }, "/commerce/terms?create=agreement");

    expect(screen.getByRole("dialog", { name: "Create account override" })).toBeTruthy();
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Account" }).value).toBe("acc_seller");
    expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Marketplace sales fee (bps)" }).value).toBe("850");
    expect(screen.getByRole("button", { name: "Save account override" })).toBeTruthy();
  });
});
