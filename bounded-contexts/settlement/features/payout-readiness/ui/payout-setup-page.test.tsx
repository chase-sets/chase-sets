import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettlementPayoutReadinessRow } from "../read-model/queries";
import { PayoutSetupPage } from "./payout-setup-page";

function readiness(overrides: Partial<SettlementPayoutReadinessRow> = {}): SettlementPayoutReadinessRow {
  return {
    account_id: "acc_test" as never,
    status: "not-started",
    missing_requirements: [],
    provider_reference: null,
    onboarding_status: "not-started",
    transfer_capability_status: "inactive",
    payout_capability_status: "inactive",
    payout_destination_status: "missing",
    updated_at: null,
    ...overrides,
  };
}

function renderPage(row: SettlementPayoutReadinessRow, options: { providerErrorMessage?: string | null } = {}) {
  return renderToStaticMarkup(
    <PayoutSetupPage
      payoutReadiness={row}
      mode="setup"
      stripePublishableKey="pk_test_123"
      providerErrorMessage={options.providerErrorMessage ?? null}
    />,
  );
}

describe("payout setup page", () => {
  it("renders a Chase Sets setup page for accounts that have not started", () => {
    const html = renderPage(readiness());

    expect(html).toContain("Payout setup");
    expect(html).toContain("Add the required account and payout destination details without leaving Chase Sets.");
    expect(html).toContain("Loading secure payout setup");
    expect(html).not.toContain("Express");
    expect(html).not.toContain("hosted setup");
  });

  it("renders pending setup without sending users to a provider dashboard", () => {
    const html = renderPage(
      readiness({
        status: "pending",
        provider_reference: "acct_test",
        onboarding_status: "pending",
        transfer_capability_status: "pending",
        payout_capability_status: "pending",
        payout_destination_status: "pending",
        updated_at: "2026-06-01T15:00:00.000Z",
      }),
    );

    expect(html).toContain("Continue the Chase Sets setup page before requesting payouts.");
    expect(html).toContain("Payout setup");
    expect(html).not.toContain("Stripe Express");
  });

  it("groups restricted provider requirements before exposing raw support details", () => {
    const html = renderPage(
      readiness({
        status: "restricted",
        provider_reference: "acct_test",
        onboarding_status: "pending",
        missing_requirements: ["individual.verification.document", "external_account"],
        updated_at: "2026-06-01T15:00:00.000Z",
      }),
    );

    expect(html).toContain("Identity details");
    expect(html).toContain("Payout account");
    expect(html).toContain("Support details");
    expect(html).toContain("individual.verification.document");
  });

  it("renders the ready state without mounting setup by default", () => {
    const html = renderPage(
      readiness({
        status: "ready",
        provider_reference: "acct_test",
        onboarding_status: "complete",
        transfer_capability_status: "active",
        payout_capability_status: "active",
        payout_destination_status: "ready",
        updated_at: "2026-06-01T15:00:00.000Z",
      }),
    );

    expect(html).toContain("Payouts are ready");
    expect(html).toContain("Request payout");
    expect(html).not.toContain("Loading secure payout setup");
  });

  it("renders provider errors with a retry path", () => {
    const html = renderPage(readiness({ status: "pending", provider_reference: "acct_test" }), {
      providerErrorMessage: "Provider session expired.",
    });

    expect(html).toContain("Setup could not load");
    expect(html).toContain("Provider session expired.");
    expect(html).toContain("Retry");
  });
});
