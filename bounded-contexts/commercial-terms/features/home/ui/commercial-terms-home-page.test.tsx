// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ComponentProps } from "react";
import type { CommercialAgreementRow } from "../../agreements/read-model/queries";
import type { CommercialTermsScheduleRow } from "../../schedules/read-model/queries";
import { resolveCommercialTermsHome, type CommercialTermsHome } from "../api/home-read";
import { CommercialTermsHomePage } from "./commercial-terms-home-page";

const resolvedAt = "2026-07-15T12:00:00.000Z";

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
      schedule_id: "cts_upcoming",
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

function homeOf(
  schedules: readonly CommercialTermsScheduleRow[] = [activeSchedule, upcomingSchedule],
  agreements: readonly CommercialAgreementRow[] = [expiringAgreement],
  scheduleId: string | null = null,
): CommercialTermsHome {
  return resolveCommercialTermsHome({ schedules, agreements, resolvedAt, scheduleId });
}

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
            home={homeOf()}
            accounts={[
              {
                accountId: "acc_seller",
                name: "Demo Account",
                displayName: "Seller Studio",
                accountType: "business",
              },
            ]}
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
      const { container } = renderHome({ publishedSchedule: schedule, home: homeOf([], []) });
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
        renderHome({ publishedSchedule: baseline, home: homeOf(schedules), selectedAgreement: expiringAgreement });
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
    const { container } = renderHome({ home: homeOf(undefined, [agreement]), selectedAgreement: agreement });
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
    const { container } = renderHome({ publishedSchedule: null, home: null, loadErrorMessage: "Policy unavailable" });
    expect(screen.getByText("Commercial Terms unavailable")).toBeTruthy();
    expect(container.querySelector("[data-published-schedule]")).toBeNull();
    expect(container.querySelector("[data-commercial-term-id]")).toBeNull();
  });

  it.each(["schedule", "agreement"] as const)(
    "opens no %s create form without the API starting terms",
    (createKind) => {
      renderHome({ home: null, loadErrorMessage: "Commercial Terms unavailable", createKind });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("spinbutton", { name: "Marketplace sales fee (bps)" })).toBeNull();
    },
  );

  it("orders schedule and agreement cards by effective date and surfaces pending windows", () => {
    const { container } = renderHome({
      home: homeOf(undefined, [
        expiringAgreement,
        {
          ...expiringAgreement,
          agreement_id: "cag_inactive",
          label: "Inactive override",
          status: "inactive",
        },
      ]),
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
    renderHome(
      { home: homeOf(undefined, undefined, "cts_upcoming"), selectedSchedule: upcomingSchedule },
      "/commerce/terms?schedule=cts_upcoming",
    );

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

  it("renders the API phase and date for every card instead of reading the browser clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-03-01T00:00:00.000Z"));
    try {
      const { container } = renderHome();
      expect(screen.getByText("Effective 2026-08-01")).toBeTruthy();
      expect(screen.getByText("Override expires 2026-08-15")).toBeTruthy();
      expect(screen.getByText("Effective since 2026-07-01")).toBeTruthy();
      expect(container.querySelectorAll("[data-commercial-term-id]")).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps each API phase to its badge tone and copy without recomputing it from the dates", () => {
    const home = homeOf();
    const [upcoming, expiring, active] = home.activeTerms;
    const { container } = renderHome({
      home: {
        ...home,
        activeTerms: [
          { ...upcoming!, phase: "scheduled", phaseAt: "2026-09-09T00:00:00.000Z" },
          { ...expiring!, phase: "expiring", phaseAt: "2026-10-10T00:00:00.000Z" },
          { ...active!, phase: "in_effect", phaseAt: "2026-06-06T00:00:00.000Z" },
        ],
      },
    });
    const badge = (id: string) =>
      within(container.querySelector<HTMLElement>(`[data-commercial-term-id="${id}"]`)!).getByText("active").className;

    expect(screen.getByText("Effective 2026-09-09")).toBeTruthy();
    expect(screen.getByText("Override expires 2026-10-10")).toBeTruthy();
    expect(screen.getByText("Effective since 2026-06-06")).toBeTruthy();
    expect(badge("cts_upcoming")).not.toBe(badge("cts_active"));
    expect(badge("cag_expiring")).toBe(badge("cts_active"));
  });

  it("prefills a new schedule from the API starting terms and keeps the localized new-schedule label", () => {
    renderHome({ home: homeOf([{ ...activeSchedule, account_type: "personal" }], []), createKind: "schedule" });

    const sheet = within(screen.getByRole("dialog", { name: "Create schedule" }));
    expect(sheet.getByRole<HTMLInputElement>("textbox", { name: "Label" }).value).toBe("New schedule");
    expect(sheet.getByRole<HTMLInputElement>("spinbutton", { name: "Marketplace sales fee (bps)" }).value).toBe("850");
    expect(sheet.getByRole<HTMLInputElement>("textbox", { name: "Marketplace fixed amount" }).value).toBe("0.10");
    expect(sheet.getByRole<HTMLInputElement>("spinbutton", { name: "Shipping allowance (bps)" }).value).toBe("500");
    expect(sheet.getByRole<HTMLInputElement>("textbox", { name: "Effective from" }).value).toBe(resolvedAt);
  });

  it.each([
    ["personal", "Account override", "850"],
    ["business", "Current business terms", "850"],
    ["unknown", "Account override", "850"],
  ])("prefills an override for a %s account from its API starting terms", (accountType, label, bps) => {
    const home = homeOf();
    renderHome({
      home: {
        ...home,
        startingTerms: {
          ...home.startingTerms,
          override: {
            ...home.startingTerms.override,
            business: { ...home.startingTerms.override.business, effective_until: "2027-01-01T00:00:00.000Z" },
          },
        },
      },
      accounts: [{ accountId: "acc_typed", name: "Typed", displayName: "Typed", accountType }],
      createKind: "agreement",
    });

    const sheet = within(screen.getByRole("dialog", { name: "Create account override" }));
    expect(sheet.getByRole<HTMLInputElement>("textbox", { name: "Label" }).value).toBe(label);
    expect(sheet.getByRole<HTMLInputElement>("spinbutton", { name: "Marketplace sales fee (bps)" }).value).toBe(bps);
    expect(sheet.getByRole<HTMLInputElement>("textbox", { name: "Effective until" }).value).toBe(
      accountType === "business" ? "2027-01-01T00:00:00.000Z" : "",
    );
  });
});
