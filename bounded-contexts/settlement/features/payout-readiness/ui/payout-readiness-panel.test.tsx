// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettlementPayoutReadinessRow } from "../read-model/queries";
import { PayoutReadinessPanel } from "./payout-readiness-panel";

function readiness(overrides: Partial<SettlementPayoutReadinessRow> = {}): SettlementPayoutReadinessRow {
  return {
    account_id: "acc_test" as never,
    status: "pending",
    missing_requirements: [],
    provider_reference: "acct_test",
    onboarding_status: "pending",
    transfer_capability_status: "pending",
    payout_capability_status: "pending",
    payout_destination_status: "pending",
    payout_account_dashboard: "none",
    losses_collector: "application",
    fees_collector: "application",
    requirements_collector: "application",
    updated_at: "2026-06-01T15:00:00.000Z",
    ...overrides,
  };
}

describe("payout readiness panel recovery paths", () => {
  it("renders support-safe requirement groups without raw provider requirement identifiers", () => {
    const html = renderToStaticMarkup(
      <PayoutReadinessPanel
        payoutReadiness={readiness({
          missing_requirements: ["external_account", "individual.verification.document"],
        })}
        showSupportEscalation
      />,
    );

    expect(html).toContain("Payout setup details need attention");
    expect(html).toContain("Payout account");
    expect(html).toContain("Identity and business details");
    expect(html).toContain("Contact support");
    expect(html).not.toContain("external_account");
    expect(html).not.toContain("individual.verification.document");
    expect(html).not.toContain("Express Dashboard");
  });

  it("links restricted setup states to support escalation", () => {
    const html = renderToStaticMarkup(
      <PayoutReadinessPanel
        payoutReadiness={readiness({
          status: "restricted",
          missing_requirements: [],
          transfer_capability_status: "inactive",
          payout_capability_status: "inactive",
        })}
      />,
    );

    expect(html).toContain("Payout setup is restricted");
    expect(html).toContain("Contact support");
    expect(html).toContain('href="/account/support"');
  });

  it("explains provider review and missing payout destinations as recoverable states", () => {
    const reviewHtml = renderToStaticMarkup(<PayoutReadinessPanel payoutReadiness={readiness()} />);
    const destinationHtml = renderToStaticMarkup(
      <PayoutReadinessPanel
        payoutReadiness={readiness({
          status: "pending",
          onboarding_status: "complete",
          transfer_capability_status: "active",
          payout_capability_status: "active",
          payout_destination_status: "missing",
        })}
      />,
    );

    expect(reviewHtml).toContain("Provider review is in progress");
    expect(destinationHtml).toContain("Add a payout destination");
  });
});
