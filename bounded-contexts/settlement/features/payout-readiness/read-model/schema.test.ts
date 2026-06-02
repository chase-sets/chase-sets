import { describe, expect, it } from "vitest";
import { settlementPayoutReadinessSchemaSql } from "./schema";

describe("settlement payout readiness schema", () => {
  it("adds provider posture columns before creating the provider posture index", () => {
    const addDashboardColumnIndex = settlementPayoutReadinessSchemaSql.indexOf(
      "ADD COLUMN IF NOT EXISTS payout_account_dashboard",
    );
    const addRequirementsCollectorColumnIndex = settlementPayoutReadinessSchemaSql.indexOf(
      "ADD COLUMN IF NOT EXISTS requirements_collector",
    );
    const providerPostureIndexIndex = settlementPayoutReadinessSchemaSql.indexOf(
      "settlement_payout_readiness_pages_provider_posture_idx",
    );

    expect(addDashboardColumnIndex).toBeGreaterThanOrEqual(0);
    expect(addRequirementsCollectorColumnIndex).toBeGreaterThanOrEqual(0);
    expect(providerPostureIndexIndex).toBeGreaterThan(addDashboardColumnIndex);
    expect(providerPostureIndexIndex).toBeGreaterThan(addRequirementsCollectorColumnIndex);
  });
});
