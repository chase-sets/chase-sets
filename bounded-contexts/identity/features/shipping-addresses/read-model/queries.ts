import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type ShippingAddressRow = Readonly<{
  shipping_address_id: string;
  account_id: string;
  label: string;
  recipient_name: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  phone: string | null;
  email: string | null;
  is_default: boolean;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}>;

export async function listShippingAddresses(
  db: PgQueryable,
  accountId: string,
  options: Readonly<{ includeArchived?: boolean }> = {},
) {
  const result = await db.query<ShippingAddressRow>(
    `SELECT *
     FROM identity_shipping_addresses
     WHERE account_id = $1
       AND ($2::boolean = true OR is_archived = false)
     ORDER BY is_default DESC, updated_at DESC, label ASC`,
    [accountId, options.includeArchived === true],
  );
  return result.rows;
}

export async function getShippingAddress(db: PgQueryable, accountId: string, shippingAddressId: string) {
  const result = await db.query<ShippingAddressRow>(
    `SELECT *
     FROM identity_shipping_addresses
     WHERE account_id = $1
       AND shipping_address_id = $2`,
    [accountId, shippingAddressId],
  );
  return result.rows[0] ?? null;
}
