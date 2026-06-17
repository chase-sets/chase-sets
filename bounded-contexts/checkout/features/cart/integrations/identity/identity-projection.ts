import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

const ACCOUNT_STREAM_PREFIX = "identity.account-";
const ID_SUFFIX_LABEL_LENGTH = 24;

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
  };
}
