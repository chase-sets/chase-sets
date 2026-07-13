import {
  DISPLAY_REFERENCE_SUFFIX_LENGTHS,
  deriveDisplayReferenceOrRaw,
} from "@chase-sets/primitives/display-reference";
import type { WalletAdjustmentId } from "@chase-sets/primitives/typed-ids";

/**
 * Unique index name backing `settlement_wallet_adjustment_pages.display_reference`
 * (see `wallet-adjustment-schema.ts`). Kept in sync with the `CREATE UNIQUE INDEX
 * CONCURRENTLY` migration.
 */
export const SETTLEMENT_WALLET_ADJUSTMENT_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT =
  "settlement_wallet_adjustment_pages_display_reference_key";

/**
 * Resolves the Wallet Adjustment display reference (`WAD-...`) for the
 * `requested` projection insert and retries with a longer suffix on a unique-
 * index collision, mirroring the payout display-reference primitive's
 * collision policy (try 8, then 10, then 12 Crockford chars before giving
 * up). `insert` performs the write for the given reference and must throw the
 * raw Postgres error on failure so collisions can be detected.
 *
 * Every live Wallet Adjustment id is a real ULID minted by
 * `deriveWalletAdjustmentId`, so the raw-id fallback in
 * `deriveDisplayReferenceOrRaw` only matters in the same defensive sense it
 * does for payouts -- it is never a silent failure mode for a real request.
 */
export async function withWalletAdjustmentDisplayReference<T>(
  adjustmentId: WalletAdjustmentId,
  insert: (displayReference: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (const suffixLength of DISPLAY_REFERENCE_SUFFIX_LENGTHS) {
    const displayReference = deriveDisplayReferenceOrRaw(adjustmentId, { suffixLength });
    try {
      return await insert(displayReference);
    } catch (error) {
      if (!isWalletAdjustmentDisplayReferenceUniqueViolation(error)) {
        throw error;
      }
      lastError = error;
      if (displayReference === adjustmentId) {
        // The fallback already used the raw id verbatim; a longer suffix
        // would not change the outcome, so stop retrying.
        break;
      }
    }
  }

  throw lastError;
}

function isWalletAdjustmentDisplayReferenceUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as Readonly<{ code?: unknown; constraint?: unknown }>;
  return (
    candidate.code === "23505" &&
    candidate.constraint === SETTLEMENT_WALLET_ADJUSTMENT_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT
  );
}
