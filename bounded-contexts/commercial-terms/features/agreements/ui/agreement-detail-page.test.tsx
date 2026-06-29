import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { AgreementDetailPage } from "./agreement-detail-page";

describe("agreement detail page", () => {
  it("shows projected agreement history with actor, event, and effective window", () => {
    const markup = renderToString(
      <AgreementDetailPage
        agreement={{
          agreement_id: "cag_preferred",
          account_id: "acc_seller",
          account_display_name: "Seller",
          account_type: "business",
          label: "Preferred",
          marketplace_sales_fee_percentage_bps: 700,
          marketplace_sales_fee_fixed_amount: "0.05",
          shipping_allowance_percentage_bps: 500,
          status: "active",
          effective_from: "2026-01-01T00:00:00.000Z",
          effective_until: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:00:01.000Z",
          history: [
            {
              history_id: "1",
              event_id: "evt_agreement_revised",
              event_type: "revised",
              actor_user_id: "usr_admin",
              status: "active",
              payload: {},
              effective_from: "2026-05-01T00:00:00.000Z",
              effective_until: "2027-05-01T00:00:00.000Z",
              recorded_at: "2026-05-01T00:00:01.000Z",
            },
          ],
        }}
      />,
    );

    expect(markup).toContain("History");
    expect(markup).toContain("revised");
    expect(markup).toContain("usr_admin");
    expect(markup).toContain("2026-05-01T00:00:00.000Z - 2027-05-01T00:00:00.000Z");
    expect(markup).toContain("2026-05-01T00:00:01.000Z");
  });
});
