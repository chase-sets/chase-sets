import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WaitlistAdminPage } from "./admin-pages";

describe("waitlist admin page", () => {
  it("renders filters, export, and signup rows", () => {
    render(
      <WaitlistAdminPage
        exportHref="/api/public-presence/admin/waitlist/export"
        filters={{ role: "all", interest: "all", search: "" }}
        metrics={{
          total_count: 1,
          buy_count: 0,
          sell_count: 0,
          both_count: 1,
        }}
        signups={{
          count: 1,
          total: 1,
          items: [
            {
              signup_id: "wls_test",
              email: "todd@example.com",
              role: "both",
              interests: ["low-sales-fees"],
              email_consent_accepted_at: "2026-05-07T12:00:00.000Z",
              marketing_consent_accepted_at: null,
              page_path: "/",
              referrer: null,
              utm_source: "discord",
              utm_medium: null,
              utm_campaign: null,
              utm_content: null,
              utm_term: null,
              submitted_at: "2026-05-07T12:00:00.000Z",
              updated_at: "2026-05-07T12:00:00.000Z",
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
  });
});
