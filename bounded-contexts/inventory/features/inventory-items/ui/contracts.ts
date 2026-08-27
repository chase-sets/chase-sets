import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type {
  InventoryAdjustmentReason,
  InventoryHoldPurpose,
  InventoryHoldReleaseReason,
  InventoryHoldSourceRef,
  InventoryOfflineSaleChannel,
} from "@chase-sets/event-core/public-event-payloads";

export type InventoryHold = Readonly<{
  hold_id: string;
  account_id: string;
  item_id: string;
  quantity: number;
  reason: string;
  notes: string | null;
  purpose: InventoryHoldPurpose;
  source_ref: InventoryHoldSourceRef;
  expires_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  released_at: string | null;
  release_reason: InventoryHoldReleaseReason | null;
}>;

export type InventoryItemLedgerEntry = Readonly<{
  ledger_entry_id: string;
  item_id: string;
  account_id: string;
  occurred_at: string;
  kind:
    | "created"
    | "adjusted"
    | "offline-sale"
    | "hold-placed"
    | "hold-converted"
    | "hold-consumed"
    | "hold-released"
    | "hold-expired"
    | "restock-decision";
  quantity_delta: number | null;
  hold_quantity: number | null;
  purpose: InventoryHoldPurpose | null;
  reason: string;
  reason_code: InventoryAdjustmentReason | null;
  note: string | null;
  sale_price_amount: string | null;
  channel: InventoryOfflineSaleChannel | null;
  source_ref: InventoryHoldSourceRef;
  actor: "seller" | "system";
  event_type: string;
  stream_id: string;
  stream_version: number;
  recorded_at: string;
}>;

export type InventoryGradedCardDetails = Readonly<{
  gradingCompany: string;
  grade: string;
  certificationNumber: string | null;
  population: Readonly<{
    populationAtGrade: number | null;
    populationHigher: number | null;
    source: string | null;
    asOf: string | null;
  }> | null;
  conditionDescriptors: string[];
}>;

export type InventoryItemListItem = Readonly<{
  item_id: string;
  account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  language_code: string | null;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  graded_card: InventoryGradedCardDetails | null;
  storage_location_id: string;
  storage_location_name: string;
  ship_from_code: string;
  ship_from_address: AddressSnapshot;
  total_quantity: number;
  held_quantity: number;
  available_quantity: number;
  acquisition_cost_amount: string | null;
  created_at: string;
  updated_at: string;
}>;

export type InventoryItemDetail = InventoryItemListItem &
  Readonly<{
    holds: readonly InventoryHold[];
    ledger: readonly InventoryItemLedgerEntry[];
  }>;
