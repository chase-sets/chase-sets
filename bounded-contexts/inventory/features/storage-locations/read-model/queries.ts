import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";

export type InventoryStorageLocationRow = Readonly<{
  storage_location_id: string;
  account_id: string;
  name: string;
  description: string | null;
  ship_from_code: string;
  ship_from_address: AddressSnapshot;
  is_archived: boolean;
  updated_at: string;
}>;

export async function listStorageLocations(
  db: PgQueryable,
  params: Readonly<{
    accountId: string;
    includeArchived?: boolean;
  }>,
) {
  const values: unknown[] = [params.accountId];
  const filters = ["account_id = $1"];

  if (!params.includeArchived) {
    filters.push("is_archived = false");
  }

  const result = await db.query<InventoryStorageLocationRow>(
    `SELECT *
     FROM inventory_storage_locations
     WHERE ${filters.join(" AND ")}
     ORDER BY is_archived ASC, name ASC`,
    values,
  );

  return result.rows;
}

export async function getStorageLocation(
  db: PgQueryable,
  storageLocationId: string,
  accountId?: string,
) {
  const values: unknown[] = [storageLocationId];
  const filters = ["storage_location_id = $1"];

  if (accountId) {
    values.push(accountId);
    filters.push(`account_id = $${values.length}`);
  }

  const result = await db.query<InventoryStorageLocationRow>(
    `SELECT *
     FROM inventory_storage_locations
     WHERE ${filters.join(" AND ")}`,
    values,
  );

  return result.rows[0] ?? null;
}
