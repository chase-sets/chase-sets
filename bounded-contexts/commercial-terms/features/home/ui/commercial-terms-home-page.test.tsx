// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ComponentProps } from "react";
import { CommercialTermsHomePage } from "./commercial-terms-home-page";

const publishedSchedule = {
  value: {
    label: "Standard seller terms",
    marketplaceSalesFeePercentageBps: 500,
    marketplaceSalesFeeFixedAmount: "0.00",
    marketplaceSalesFeeCapAmount: "25.00",
    shippingAllowancePercentageBps: 500,
  },
  source: "policy",
  documentId: "pol_standard",
  effectiveFrom: "2026-07-03T00:00:00.000Z",
  resolvedAt: "2026-07-15T12:00:00.000Z",
} as const;

const revisedSchedule = {
  ...publishedSchedule,
  value: {
    label: "Synthetic revised seller terms",
    marketplaceSalesFeePercentageBps: 625,
    marketplaceSalesFeeFixedAmount: "0.42",
    marketplaceSalesFeeCapAmount: "19.75",
    shippingAllowancePercentageBps: 725,
  },
  effectiveFrom: "2026-07-12T00:00:00.000Z",
};

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
  account_name: "Demo Account",
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
            publishedSchedule={publishedSchedule}
            schedules={[activeSchedule, upcomingSchedule]}
            agreements={[expiringAgreement]}
            accounts={[
              {
                accountId: "acc_seller",
                name: "Demo Account",
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

  it.each([
    [publishedSchedule, "5%", "$0.00", "$25.00", "5%", "2026-07-03"],
    [revisedSchedule, "6.25%", "$0.42", "$19.75", "7.25%", "2026-07-12"],
  ] as const)(
    "renders every resolved published field for $0.value.label",
    (schedule, percentage, fixed, cap, allowance, date) => {
      const { container } = renderHome({ publishedSchedule: schedule, schedules: [], agreements: [] });
      const card = within(container.querySelector<HTMLElement>("[data-published-schedule]")!);
      expect(card.getByText(schedule.value.label)).toBeTruthy();
      expect(card.getByText(`${percentage} + ${fixed}`)).toBeTruthy();
      expect(card.getByText("Marketplace sales fee cap per item")).toBeTruthy();
      expect(card.getByText(cap)).toBeTruthy();
      expect(card.getByText("Shipping allowance")).toBeTruthy();
      expect(card.getByText(allowance)).toBeTruthy();
      expect(card.getByText(date)).toBeTruthy();
      expect(card.getByText("Published policy")).toBeTruthy();
    },
  );

  it("labels fallback without inventing an effective date", () => {
    const { container } = renderHome({
      publishedSchedule: { ...publishedSchedule, source: "fallback", documentId: null, effectiveFrom: null },
    });
    const card = within(container.querySelector<HTMLElement>("[data-published-schedule]")!);
    expect(card.getByText("Fallback policy")).toBeTruthy();
    expect(card.getByText("None")).toBeTruthy();
    expect(card.queryByText("2026-07-03")).toBeNull();
    expect(card.queryByText("2026-07-15")).toBeNull();
  });

  it.each(["policy", "fallback"] as const)(
    "uses the %s resolver baseline in the opened override sheet despite typed rows",
    (source) => {
      const baseline =
        source === "policy"
          ? revisedSchedule
          : {
              ...revisedSchedule,
              source,
              documentId: null,
              effectiveFrom: null,
            };
      for (const schedules of [
        [],
        [activeSchedule],
        [{ ...activeSchedule, status: "draft" }],
        [upcomingSchedule],
        [{ ...activeSchedule, status: "inactive" }],
      ]) {
        renderHome({ publishedSchedule: baseline, schedules, selectedAgreement: expiringAgreement });
        const sheet = within(screen.getByRole("dialog", { name: expiringAgreement.label }));
        expect(sheet.getByText(baseline.value.label)).toBeTruthy();
        expect(sheet.getByText("6.25% + $0.42")).toBeTruthy();
        expect(sheet.getByText("7.25%")).toBeTruthy();
        expect(sheet.getByText("$19.75")).toBeTruthy();
        expect(sheet.getByText(source === "policy" ? "Published policy" : "Fallback policy")).toBeTruthy();
        expect(sheet.queryByText(activeSchedule.label)).toBeNull();
        expect(sheet.queryByText(upcomingSchedule.label)).toBeNull();
        if (source === "policy") expect(sheet.getByText("2026-07-12")).toBeTruthy();
        else expect(sheet.queryByText("2026-07-12")).toBeNull();
        cleanup();
      }
    },
  );

  it.each([
    ["Demo Account", "Seller Studio", "Demo Account (Seller Studio)"],
    ["", "Seller Studio", "Seller Studio"],
    [null, null, "acc_seller"],
  ])("shows account identity on the card and opened sheet for name %s", (name, displayName, label) => {
    const agreement = { ...expiringAgreement, account_name: name, account_display_name: displayName };
    const { container } = renderHome({ agreements: [agreement], selectedAgreement: agreement });
    const surfaces = [
      container.querySelector<HTMLElement>(`[data-commercial-term-id="${agreement.agreement_id}"]`)!,
      screen.getByRole("dialog", { name: agreement.label }),
    ];
    for (const surface of surfaces) {
      expect(within(surface).getAllByText(label!).length).toBeGreaterThan(0);
      expect(within(surface).getAllByText(agreement.account_id).length).toBeGreaterThan(0);
    }
  });

  it("keeps failed policy loading unavailable without an invented baseline", () => {
    const { container } = renderHome({ publishedSchedule: null, loadErrorMessage: "Policy unavailable" });
    expect(screen.getByText("Commercial Terms unavailable")).toBeTruthy();
    expect(container.querySelector("[data-published-schedule]")).toBeNull();
  });

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
