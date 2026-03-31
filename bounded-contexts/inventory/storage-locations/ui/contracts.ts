export type InventoryStorageLocation = Readonly<{
  storage_location_id: string;
  account_id: string;
  name: string;
  description: string | null;
  ship_from_code: string;
  is_archived: boolean;
  updated_at: string;
}>;
