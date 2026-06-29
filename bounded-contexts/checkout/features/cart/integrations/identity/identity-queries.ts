import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type CheckoutShipFromAddressRow = Readonly<{
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
  updated_at: string;
}>;

export async function listCheckoutShipFromAddresses(
  db: PgQueryable,
  accountId: string,
): Promise<readonly CheckoutShipFromAddressRow[]> {
  const result = await db.query<CheckoutShipFromAddressRow>(
    `SELECT shipping_address_id,
            account_id,
            label,
            recipient_name,
            company,
            line1,
            line2,
            city,
            state,
            postal_code,
            country,
            phone,
            email,
            is_default,
            updated_at::text AS updated_at
       FROM checkout_ship_from_addresses
      WHERE account_id = $1
        AND is_archived = false
      ORDER BY is_default DESC, updated_at DESC, shipping_address_id ASC`,
    [accountId],
  );

  return result.rows;
}
