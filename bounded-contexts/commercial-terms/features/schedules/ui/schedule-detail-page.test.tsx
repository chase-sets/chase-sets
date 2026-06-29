import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ScheduleDetailPage } from "./schedule-detail-page";

describe("schedule detail page", () => {
  it("shows projected schedule history with actor, event, and effective window", () => {
    const markup = renderToString(
      <ScheduleDetailPage
        schedule={{
          schedule_id: "cts_business",
          label: "Business",
          account_type: "business",
          marketplace_sales_fee_percentage_bps: 850,
          marketplace_sales_fee_fixed_amount: "0.10",
          shipping_allowance_percentage_bps: 500,
          status: "active",
          effective_from: "2026-01-01T00:00:00.000Z",
          effective_until: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:00:01.000Z",
          history: [
            {
              history_id: "1",
              event_id: "evt_schedule_revised",
              event_type: "revised",
              actor_user_id: "usr_admin",
              status: "active",
              payload: {},
              effective_from: "2026-05-01T00:00:00.000Z",
              effective_until: null,
              recorded_at: "2026-05-01T00:00:01.000Z",
            },
          ],
        }}
      />,
    );

    expect(markup).toContain("History");
    expect(markup).toContain("revised");
    expect(markup).toContain("usr_admin");
    expect(markup).toContain("2026-05-01T00:00:00.000Z - Open-ended");
    expect(markup).toContain("2026-05-01T00:00:01.000Z");
  });
});
