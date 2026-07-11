import {
  DISPLAY_REFERENCE_SUFFIX_LENGTHS,
  deriveDisplayReferenceOrRaw,
} from "@chase-sets/primitives/display-reference";
import type { OrderId } from "@chase-sets/primitives/typed-ids";

/**
 * Unique index name backing `ordering_order_pages.display_reference` (see schema.ts).
 * Kept in sync with the `CREATE UNIQUE INDEX CONCURRENTLY` migration.
 */
export const ORDERING_ORDER_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT = "ordering_order_pages_display_reference_key";

/**
 * Resolves the order display reference for an insert/upsert and retries with a
 * longer suffix on a unique-index collision, per the shared display-reference
 * primitive's collision policy (try 8, then 10, then 12 Crockford chars before
 * giving up). `insert` performs the write for the given reference and must throw
 * the raw Postgres error on failure so collisions can be detected.
 *
 * Fixed, human-readable seed/demo order ids (e.g. `ord_seed_checkout_pending`)
 * predate real ULID generation and cannot derive a reference; the projection
 * falls back to the raw order id verbatim rather than failing the write, since
 * every order created through the live domain always carries a real ULID.
 */
export async function withOrderDisplayReference<T>(
  orderId: OrderId,
  insert: (displayReference: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (const suffixLength of DISPLAY_REFERENCE_SUFFIX_LENGTHS) {
    const displayReference = deriveDisplayReferenceOrRaw(orderId, { suffixLength });
    try {
      return await insert(displayReference);
    } catch (error) {
      if (!isOrderDisplayReferenceUniqueViolation(error)) {
        throw error;
      }
      lastError = error;
      if (displayReference === orderId) {
        // The fallback already used the raw id verbatim; a longer suffix
        // would not change the outcome, so stop retrying.
        break;
      }
    }
  }

  throw lastError;
}

function isOrderDisplayReferenceUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as Readonly<{ code?: unknown; constraint?: unknown }>;
  return candidate.code === "23505" && candidate.constraint === ORDERING_ORDER_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT;
}
