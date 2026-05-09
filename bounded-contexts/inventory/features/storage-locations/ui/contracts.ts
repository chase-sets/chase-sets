import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";

export type InventoryStorageLocation = Readonly<{
  storage_location_id: string;
  account_id: string;
  name: string;
  description: string | null;
  ship_from_code: string;
  ship_from_address: AddressSnapshot;
  is_archived: boolean;
  updated_at: string;
}>;
