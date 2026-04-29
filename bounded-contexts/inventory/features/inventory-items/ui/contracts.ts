export type InventoryHold = Readonly<{
  hold_id: string;
  account_id: string;
  item_id: string;
  quantity: number;
  reason: string;
  notes: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  released_at: string | null;
}>;

export type InventoryItemListItem = Readonly<{
  item_id: string;
  account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  storage_location_id: string;
  storage_location_name: string;
  ship_from_code: string;
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
  }>;
