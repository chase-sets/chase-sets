import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WaitlistAdminPage } from "./admin-pages";

describe("waitlist admin page", () => {
  it("renders filters, export, and signup rows", () => {
    render(
      <WaitlistAdminPage
        exportHref="/api/public-presence/admin/waitlist/export"
        filters={{ role: "all", interest: "all", search: "", sort: "updated" }}
        metrics={{
          total_count: 2,
          buy_count: 0,
          sell_count: 1,
          both_count: 1,
        }}
        signups={{
          count: 2,
          total: 2,
          items: [
            {
              signup_id: "wls_test",
              email: "todd@example.com",
              role: "both",
              interests: ["low-sales-fees"],
              email_consent_accepted_at: "2026-05-07T12:00:00.000Z",
              marketing_consent_accepted_at: null,
              referred_by_signup_id: null,
              page_path: "/",
              referrer: null,
              utm_source: "discord",
              utm_medium: null,
              utm_campaign: null,
              utm_content: null,
              utm_term: null,
              games: [],
              has_store_link: false,
              store_url: null,
              inventory_size: null,
              submitted_at: "2026-05-07T12:00:00.000Z",
              updated_at: "2026-05-07T12:00:00.000Z",
              referral_count: 2,
            },
            {
              signup_id: "wls_referred",
              email: "referred@example.com",
              role: "sell",
              interests: ["low-sales-fees"],
              email_consent_accepted_at: "2026-05-07T12:05:00.000Z",
              marketing_consent_accepted_at: null,
              referred_by_signup_id: "wls_test",
              page_path: "/",
              referrer: null,
              utm_source: null,
              utm_medium: null,
              utm_campaign: null,
              utm_content: null,
              utm_term: null,
              games: ["pokemon"],
              has_store_link: true,
              store_url: "https://example-store.com",
              inventory_size: "under_100",
              submitted_at: "2026-05-07T12:05:00.000Z",
              updated_at: "2026-05-07T12:05:00.000Z",
              referral_count: 0,
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Waitlist" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Export CSV" }).getAttribute("href")).toBe(
      "/api/public-presence/admin/waitlist/export",
    );
    expect(screen.getAllByText("todd@example.com")).toHaveLength(2);
    expect(screen.getByRole("columnheader", { name: "Referrals" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Referred" })).toBeTruthy();
    expect(screen.getAllByText("Yes")).toHaveLength(2);
  });
});
