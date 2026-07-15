// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { FacilityIntakePage, type FacilityIntakePageProps } from "./facility-intake-page";

afterEach(cleanup);

function props(overrides: Partial<FacilityIntakePageProps> = {}): FacilityIntakePageProps {
  return {
    facilityId: "fac_east",
    queue: [],
    unidentified: [],
    metrics: {
      delivered_not_intaken_count: 1,
      oldest_delivered_not_intaken_age_seconds: 3600,
      completed_intake_count: 2,
      discrepancy_count: 1,
      discrepancy_rate: 0.5,
      unidentified_package_count: 0,
      duplicate_scan_count: 0,
      average_intake_latency_seconds: 600,
    },
    resolved: {
      return_shipment_id: "rsh_1",
      remedy_id: "rmd_1",
      support_request_id: "sup_1",
      order_id: "ord_1",
      outbound_shipment_id: "shp_1",
      return_directive: "return-to-platform",
      status: "delivered",
      ship_from_snapshot: {},
      destination_snapshot: { displayInstructions: "Keep sealed until photographed." },
      facility_id: "fac_east",
      facility_config_version: "v1",
      selection_policy_version: "v1",
      package_requirements: { weightOunces: 8, lengthInches: 6, widthInches: 4, heightInches: 2 },
      label_status: "ready",
      label_provider_reference: "lbl_1",
      label_document_url: "https://labels.test/rsh_1.pdf",
      carrier_name: "USPS",
      tracking_identifier: "track-1",
      postage_provider_name: "sandbox-usps",
      postage_provider_mode: "test",
      postage_provider_shipment_id: "ps_1",
      postage_provider_label_id: "pl_1",
      postage_amount_cents: 499,
      estimated_postage_amount_cents: 450,
      postage_currency: "USD",
      label_failure_reason: null,
      label_failure_detail: null,
      label_refund_status: null,
      label_refund_reference: null,
      cost_payer: "platform",
      cost_allocation_reference: null,
      ship_by_deadline_at: "2026-07-10T00:00:00.000Z",
      return_by_deadline_at: "2026-07-20T00:00:00.000Z",
      policy_version: "v1",
      idempotency_key: "request-1",
      current_exception_type: null,
      current_exception_notes: null,
      milestones: [],
      exceptions: [],
      facility_intake: null,
      intake_corrections: [],
      duplicate_intake_scan_count: 0,
      requested_at: "2026-07-01T00:00:00.000Z",
      label_ready_at: "2026-07-02T00:00:00.000Z",
      label_failed_at: null,
      label_voided_at: null,
      carrier_accepted_at: "2026-07-03T00:00:00.000Z",
      delivered_at: "2026-07-14T10:00:00.000Z",
      received_at: null,
      cancelled_at: null,
      return_expired_at: null,
      updated_at: "2026-07-14T10:00:00.000Z",
      expected_items: [
        {
          line_id: "spl_1",
          order_line_id: "orl_1",
          item_title: "1999 Charizard",
          item_subtitle: null,
          product_summary: "Graded card",
          quantity: 1,
        },
      ],
    },
    expectedVersion: 5,
    formToken: "rii_1",
    actionError: null,
    actionResult: null,
    submitting: false,
    ...overrides,
  };
}

describe("FacilityIntakePage", () => {
  it("renders scanner-first evidence, discrepancy, disposition, and accessibility controls", () => {
    const { container } = render(
      <MemoryRouter>
        <FacilityIntakePage {...props()} />
      </MemoryRouter>,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("searchbox", { name: /tracking or return shipment identifier/i }),
    );
    expect(screen.getAllByText("Keep sealed until photographed.")).toHaveLength(2);
    expect(screen.getAllByText("1999 Charizard × 1")).toHaveLength(2);
    expect(screen.getByRole("option", { name: "Missing item" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Empty package" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Manual review" })).toBeTruthy();
    expect(container.querySelector('input[type="file"][accept="image/jpeg,image/png,image/webp"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Complete facility intake" })).toBeTruthy();
  });

  it("prevents a second completion and exposes append-only correction", () => {
    render(
      <MemoryRouter>
        <FacilityIntakePage
          {...props({
            resolved: {
              ...props().resolved!,
              facility_intake: { custodyIdentifier: "CUST-1" },
              received_at: "2026-07-14T12:00:00.000Z",
            },
            actionResult: "duplicate",
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/already received/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Complete facility intake" })).toBeNull();
    expect(screen.getByRole("button", { name: "Record correction" })).toBeTruthy();
  });

  it("keeps quarantine and manual-review dispositions visible after custody is recorded", () => {
    render(
      <MemoryRouter>
        <FacilityIntakePage
          {...props({
            resolved: {
              ...props().resolved!,
              facility_intake: { custodyIdentifier: "CUST-REVIEW-1", disposition: "quarantine" },
              received_at: "2026-07-14T12:00:00.000Z",
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Intake routed to quarantine")).toBeTruthy();
    expect(screen.getAllByText("CUST-REVIEW-1")).toHaveLength(2);
  });
});
