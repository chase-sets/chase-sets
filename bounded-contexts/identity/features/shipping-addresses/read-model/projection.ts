import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type ShippingAddressPayload = {
  accountId: string;
  shippingAddressId: string;
  label: string;
  address: {
    name: string;
    company: string | null;
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone: string | null;
    email: string | null;
  };
  isDefault: boolean;
};

async function clearDefault(db: PgQueryable, accountId: string, exceptShippingAddressId: string) {
  await db.query(
    `UPDATE identity_shipping_addresses
     SET is_default = false
     WHERE account_id = $1
       AND shipping_address_id <> $2`,
    [accountId, exceptShippingAddressId],
  );
}

export function buildShippingAddressProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.shipping-address.added": async (event) => {
      const data = event.data as ShippingAddressPayload & { addedAt: string };
      if (data.isDefault) {
        await clearDefault(db, data.accountId, data.shippingAddressId);
      }
      await db.query(
        `INSERT INTO identity_shipping_addresses (
           shipping_address_id,
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
           is_archived,
           created_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, false, $15, $16)
         ON CONFLICT (shipping_address_id) DO UPDATE
         SET account_id = $2,
             label = $3,
             recipient_name = $4,
             company = $5,
             line1 = $6,
             line2 = $7,
             city = $8,
             state = $9,
             postal_code = $10,
             country = $11,
             phone = $12,
             email = $13,
             is_default = $14,
             is_archived = false,
             created_at = $15,
             updated_at = $16`,
        [
          data.shippingAddressId,
          data.accountId,
          data.label,
          data.address.name,
          data.address.company,
          data.address.line1,
          data.address.line2,
          data.address.city,
          data.address.state,
          data.address.postalCode,
          data.address.country,
          data.address.phone,
          data.address.email,
          data.isDefault,
          data.addedAt,
          data.addedAt,
        ],
      );
    },
    "identity.shipping-address.updated": async (event) => {
      const data = event.data as ShippingAddressPayload & { updatedAt: string };
      if (data.isDefault) {
        await clearDefault(db, data.accountId, data.shippingAddressId);
      }
      await db.query(
        `UPDATE identity_shipping_addresses
         SET label = $2,
             recipient_name = $3,
             company = $4,
             line1 = $5,
             line2 = $6,
             city = $7,
             state = $8,
             postal_code = $9,
             country = $10,
             phone = $11,
             email = $12,
             is_default = $13,
             updated_at = $14
         WHERE shipping_address_id = $1
           AND account_id = $15`,
        [
          data.shippingAddressId,
          data.label,
          data.address.name,
          data.address.company,
          data.address.line1,
          data.address.line2,
          data.address.city,
          data.address.state,
          data.address.postalCode,
          data.address.country,
          data.address.phone,
          data.address.email,
          data.isDefault,
          data.updatedAt,
          data.accountId,
        ],
      );
    },
    "identity.shipping-address.default-set": async (event) => {
      const data = event.data as {
        accountId: string;
        shippingAddressId: string;
        setAt: string;
      };
      await clearDefault(db, data.accountId, data.shippingAddressId);
      await db.query(
        `UPDATE identity_shipping_addresses
         SET is_default = true,
             updated_at = $3
         WHERE account_id = $1
           AND shipping_address_id = $2
           AND is_archived = false`,
        [data.accountId, data.shippingAddressId, data.setAt],
      );
    },
    "identity.shipping-address.archived": async (event) => {
      const data = event.data as {
        accountId: string;
        shippingAddressId: string;
        promotedDefaultShippingAddressId: string | null;
        archivedAt: string;
      };
      await db.query(
        `UPDATE identity_shipping_addresses
         SET is_archived = true,
             is_default = false,
             updated_at = $2
         WHERE shipping_address_id = $1
           AND account_id = $3`,
        [data.shippingAddressId, data.archivedAt, data.accountId],
      );
      if (data.promotedDefaultShippingAddressId) {
        await clearDefault(db, data.accountId, data.promotedDefaultShippingAddressId);
        await db.query(
          `UPDATE identity_shipping_addresses
           SET is_default = true,
               updated_at = $3
           WHERE account_id = $1
             AND shipping_address_id = $2
             AND is_archived = false`,
          [data.accountId, data.promotedDefaultShippingAddressId, data.archivedAt],
        );
      }
    },
  };
}
