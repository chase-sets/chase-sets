import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ShippingAddressId } from "@chase-sets/primitives/typed-ids";

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

/** A saved address as checkout's shipping address: the address book id and its content, without a verification. */
export function checkoutShippingAddressFromSavedAddress(address: CheckoutShipFromAddressRow) {
  return {
    shippingAddressId: address.shipping_address_id as ShippingAddressId,
    name: address.recipient_name,
    company: address.company,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postalCode: address.postal_code,
    country: address.country,
    phone: address.phone,
    email: address.email,
  };
}

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
