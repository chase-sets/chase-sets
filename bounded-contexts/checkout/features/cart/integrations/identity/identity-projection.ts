import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

const ACCOUNT_STREAM_PREFIX = "identity.account-";
const ID_SUFFIX_LABEL_LENGTH = 24;

type ShippingAddressPayload = Readonly<{
  accountId: string;
  shippingAddressId: string;
  label: string;
  address: Readonly<{
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
  }>;
  isDefault: boolean;
}>;

/**
 * Slugifies a display name into a marketplace-safe, ASCII, kebab-case label.
 * Kept local to the checkout identity integration (single-slice usage): the
 * algorithm mirrors discovery's `createMarketplaceSlug` so a seller resolves to
 * the same slug across read models, but the helper is intentionally not shared
 * across contexts.
 */
function createSlugBase(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function hashId(id: string): string {
  let hash = 0x811c9dc5;

  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36);
}

function compactIdSuffix(id: string): string {
  const suffix = createSlugBase(id).slice(-ID_SUFFIX_LABEL_LENGTH).replace(/^-+/, "");

  return `${suffix || "item"}-${hashId(id)}`;
}

export function createSellerSlug(displayName: string, accountId: string): string {
  const base = createSlugBase(displayName) || "marketplace";

  return `${base}-${compactIdSuffix(accountId)}`;
}

/**
 * Checkout-local identity handler set feeding the SAME
 * `checkout-marketplace-seller-options-projection` as the marketplace listing
 * and inventory supply handlers. It maintains a small auxiliary
 * `checkout_seller_accounts` table keyed by `account_id` so the seller-options
 * read model can LEFT JOIN seller display name / slug onto each option by
 * `seller_account_id`.
 *
 * The join table (rather than denormalizing the name onto every seller-options
 * row) keeps profile-name changes a single-row update and stays correct when an
 * account is created or renamed after — or before — its listings are projected,
 * since the JOIN always resolves the current seller identity at read time.
 *
 * Both handlers upsert idempotently behind a `last_stream_version` guard,
 * mirroring the inventory auxiliary tables, so replaying account events
 * converges to the same row without regressing a newer profile name.
 */
export function buildCheckoutIdentitySellerAccountsProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const { accountId, displayName } = event.data as {
        accountId: string;
        displayName: string;
      };
      const slug = createSellerSlug(displayName, accountId);

      await db.query(
        `INSERT INTO checkout_seller_accounts (
           account_id,
           display_name,
           slug,
           last_stream_version,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           slug = EXCLUDED.slug,
           last_stream_version = EXCLUDED.last_stream_version,
           updated_at = EXCLUDED.updated_at
         WHERE checkout_seller_accounts.last_stream_version < EXCLUDED.last_stream_version`,
        [accountId, displayName, slug, event.streamVersion, event.timing.recordedAt],
      );
    },
    "identity.account.profile-updated": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX);
      const { displayName } = event.data as { displayName: string };
      const slug = createSellerSlug(displayName, accountId);

      await db.query(
        `INSERT INTO checkout_seller_accounts (
           account_id,
           display_name,
           slug,
           last_stream_version,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           slug = EXCLUDED.slug,
           last_stream_version = EXCLUDED.last_stream_version,
           updated_at = EXCLUDED.updated_at
         WHERE checkout_seller_accounts.last_stream_version < EXCLUDED.last_stream_version`,
        [accountId, displayName, slug, event.streamVersion, event.timing.recordedAt],
      );
    },
    "identity.shipping-address.added": async (event) => {
      const data = event.data as ShippingAddressPayload & { addedAt: string };
      if (data.isDefault) {
        await clearDefaultShipFromAddresses(db, data.accountId, data.shippingAddressId, event.streamVersion);
      }

      await upsertShipFromAddress(db, data, event.streamVersion, data.addedAt, false);
    },
    "identity.shipping-address.updated": async (event) => {
      const data = event.data as ShippingAddressPayload & { updatedAt: string };
      if (data.isDefault) {
        await clearDefaultShipFromAddresses(db, data.accountId, data.shippingAddressId, event.streamVersion);
      }

      await upsertShipFromAddress(db, data, event.streamVersion, data.updatedAt, false);
    },
    "identity.shipping-address.default-set": async (event) => {
      const data = event.data as {
        accountId: string;
        shippingAddressId: string;
        setAt: string;
      };
      await clearDefaultShipFromAddresses(db, data.accountId, data.shippingAddressId, event.streamVersion);
      await db.query(
        `UPDATE checkout_ship_from_addresses
         SET is_default = true,
             last_stream_version = $3,
             updated_at = $4
         WHERE account_id = $1
           AND shipping_address_id = $2
           AND is_archived = false
           AND last_stream_version < $3`,
        [data.accountId, data.shippingAddressId, event.streamVersion, data.setAt],
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
        `UPDATE checkout_ship_from_addresses
         SET is_archived = true,
             is_default = false,
             last_stream_version = $2,
             updated_at = $3
         WHERE shipping_address_id = $1
           AND last_stream_version < $2`,
        [data.shippingAddressId, event.streamVersion, data.archivedAt],
      );

      if (data.promotedDefaultShippingAddressId) {
        await clearDefaultShipFromAddresses(
          db,
          data.accountId,
          data.promotedDefaultShippingAddressId,
          event.streamVersion,
        );
        await db.query(
          `UPDATE checkout_ship_from_addresses
           SET is_default = true,
               last_stream_version = $3,
               updated_at = $4
           WHERE account_id = $1
             AND shipping_address_id = $2
             AND is_archived = false
             AND last_stream_version < $3`,
          [data.accountId, data.promotedDefaultShippingAddressId, event.streamVersion, data.archivedAt],
        );
      }
    },
  };
}

async function clearDefaultShipFromAddresses(
  db: PgQueryable,
  accountId: string,
  exceptShippingAddressId: string,
  streamVersion: number,
) {
  await db.query(
    `UPDATE checkout_ship_from_addresses
     SET is_default = false,
         last_stream_version = $3,
         updated_at = now()
     WHERE account_id = $1
       AND shipping_address_id <> $2
       AND last_stream_version < $3`,
    [accountId, exceptShippingAddressId, streamVersion],
  );
}

async function upsertShipFromAddress(
  db: PgQueryable,
  data: ShippingAddressPayload,
  streamVersion: number,
  updatedAt: string,
  isArchived: boolean,
) {
  await db.query(
    `INSERT INTO checkout_ship_from_addresses (
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
       last_stream_version,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (shipping_address_id) DO UPDATE SET
       account_id = EXCLUDED.account_id,
       label = EXCLUDED.label,
       recipient_name = EXCLUDED.recipient_name,
       company = EXCLUDED.company,
       line1 = EXCLUDED.line1,
       line2 = EXCLUDED.line2,
       city = EXCLUDED.city,
       state = EXCLUDED.state,
       postal_code = EXCLUDED.postal_code,
       country = EXCLUDED.country,
       phone = EXCLUDED.phone,
       email = EXCLUDED.email,
       is_default = EXCLUDED.is_default,
       is_archived = EXCLUDED.is_archived,
       last_stream_version = EXCLUDED.last_stream_version,
       updated_at = EXCLUDED.updated_at
     WHERE checkout_ship_from_addresses.last_stream_version < EXCLUDED.last_stream_version`,
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
      isArchived,
      streamVersion,
      updatedAt,
    ],
  );
}
