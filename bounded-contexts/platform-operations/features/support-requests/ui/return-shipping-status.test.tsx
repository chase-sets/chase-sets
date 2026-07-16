// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SupportRequestListItem } from "./contracts";
import { ReturnShippingStatus } from "./return-shipping-status";

afterEach(cleanup);

function request(labelStatus: "ready" | "failed", costPayer: "buyer" | "seller"): SupportRequestListItem {
  return {
    return_shipping: {
      return_shipment_id: "rsh_1",
      status: "ready-to-ship",
      label_status: labelStatus,
      cost_payer: costPayer,
      tracking_identifier: labelStatus === "ready" ? "940011" : null,
      label_document_url: labelStatus === "ready" ? "https://labels.test/1" : null,
      postage_amount_cents: labelStatus === "ready" ? 275 : null,
      postage_currency: "USD",
      failure_reason: labelStatus === "failed" ? "provider-unavailable" : null,
      ship_by_deadline_at: "2026-07-29T00:00:00.000Z",
      return_by_deadline_at: "2026-08-14T00:00:00.000Z",
    },
  } as SupportRequestListItem;
}

describe("ReturnShippingStatus", () => {
  it("gives the buyer the label, tracking, and refund deduction", () => {
    render(<ReturnShippingStatus request={request("ready", "buyer")} role="buyer" />);
    expect(screen.getByRole("link", { name: "Open return label" }).getAttribute("href")).toBe("https://labels.test/1");
    expect(screen.getByText("Tracking: 940011")).not.toBeNull();
    expect(screen.getByText("$2.75 will be deducted from the buyer refund.")).not.toBeNull();
  });

  it("shows the seller the automatic fallback without exposing the buyer label", () => {
    render(<ReturnShippingStatus request={request("failed", "seller")} role="seller" />);
    expect(screen.queryByRole("link", { name: "Open return label" })).toBeNull();
    expect(screen.getByText(/couldn't create the label automatically/i)).not.toBeNull();
    expect(screen.getByText("Return postage will be deducted from the seller balance.")).not.toBeNull();
  });
});
