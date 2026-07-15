import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InventoryRecoveredItemRow } from "../read-model/queries";
import { RecoveredItemsPage } from "./recovered-items-page";

const item: InventoryRecoveredItemRow = {
  recovered_item_id: "rcv_1",
  return_shipment_id: "rsh_1",
  remedy_id: "rmd_1",
  custody_location_id: "facility-1:station-2",
  custody_identifier: "CUST-1",
  evidence_references: ["att_1", "att_2"],
  status: "awaiting-identification",
  catalog_item_id: null,
  product_id: null,
  selected_options: [],
  condition_grade: null,
  authenticity_review_required: false,
  authenticity_outcome: null,
  disposition_authority: null,
  disposition: null,
  target_account_id: null,
  storage_location_id: null,
  sellable_at: null,
  merged_into_recovered_item_id: null,
  received_at: "2026-07-15T00:00:00.000Z",
  updated_at: "2026-07-15T00:00:00.000Z",
};

describe("RecoveredItemsPage", () => {
  it("renders custody metrics, evidence, and the complete disposition workflow", () => {
    const html = renderToString(
      <RecoveredItemsPage
        items={[item]}
        metrics={{
          total_count: 1,
          unidentified_count: 1,
          quarantined_count: 1,
          sellable_count: 0,
          terminal_count: 0,
          recovered_count: 0,
          recovery_rate: 0,
          average_age_hours: 4,
          gross_value: "0.00",
          disposition_cost: "0.00",
          net_recovered_value: "0.00",
        }}
      />,
    );

    expect(html).toContain("Recovered returns");
    expect(html).toContain("CUST-1");
    expect(html).toContain("2 references");
    expect(html).toContain("Require authenticity review");
    expect(html).toContain("Record ownership authority");
    expect(html).toContain("Decide disposition");
    expect(html).toContain("Record recovered value");
    expect(html).toContain('name="evidenceReferences"');
  });
});
