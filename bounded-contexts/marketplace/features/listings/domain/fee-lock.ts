import { centsToMoneyAmount, moneyToCents, tryMoneyToCents } from "@chase-sets/primitives/money";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeMoneyAmount(value: string, fieldName: string): string {
  const normalized = value.trim();
  const cents = tryMoneyToCents(normalized);
  assert(cents !== null, `${fieldName} must be a valid non-negative decimal within the supported money range.`);
  return centsToMoneyAmount(cents);
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function normalizePercentageBps(value: number, fieldName: string): number {
  assert(
    Number.isInteger(value) && value >= 0 && value <= 10_000,
    `${fieldName} must be a whole number from 0 through 10000 basis points.`,
  );
  return value;
}

function normalizeRequiredText(value: string, fieldName: string): string {
  const normalized = value.trim();
  assert(normalized.length > 0, `${fieldName} is required.`);
  return normalized;
}

export type MarketplaceListingFeeTermsSnapshot = Readonly<{
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  marketplaceSalesFeeCapAmount: string | null;
  shippingAllowancePercentageBps: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
}>;

export type MarketplaceListingFeeLock = Readonly<{
  unitCount: number;
  terms: MarketplaceListingFeeTermsSnapshot;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  feeQuoteFingerprint: string;
}>;

export function normalizeMarketplaceListingFeeLock(lock: MarketplaceListingFeeLock): MarketplaceListingFeeLock {
  assert(
    Number.isInteger(lock.unitCount) && lock.unitCount > 0,
    "Fee-lock unit count must be a positive whole number.",
  );
  const marketplaceSalesFeeFixedAmount = normalizeMoneyAmount(
    lock.terms.marketplaceSalesFeeFixedAmount,
    "Locked marketplace sales fee fixed amount",
  );
  const marketplaceSalesFeeCapAmount =
    lock.terms.marketplaceSalesFeeCapAmount !== null
      ? normalizeMoneyAmount(lock.terms.marketplaceSalesFeeCapAmount, "Locked marketplace sales fee cap amount")
      : null;
  if (marketplaceSalesFeeCapAmount !== null) {
    assert(
      moneyToCents(marketplaceSalesFeeCapAmount) > 0n,
      "Locked marketplace sales fee cap must be greater than zero.",
    );
  }

  return {
    unitCount: lock.unitCount,
    terms: {
      marketplaceSalesFeePercentageBps: normalizePercentageBps(
        lock.terms.marketplaceSalesFeePercentageBps,
        "Locked marketplace sales fee percentage",
      ),
      marketplaceSalesFeeFixedAmount,
      marketplaceSalesFeeCapAmount,
      shippingAllowancePercentageBps: normalizePercentageBps(
        lock.terms.shippingAllowancePercentageBps,
        "Locked shipping allowance percentage",
      ),
      termsScheduleId: normalizeOptionalText(lock.terms.termsScheduleId),
      termsAgreementId: normalizeOptionalText(lock.terms.termsAgreementId),
      termsResolvedAt: normalizeRequiredText(lock.terms.termsResolvedAt, "Locked terms resolution timestamp"),
    },
    marketplaceSalesFeeUnitAmount: normalizeMoneyAmount(
      lock.marketplaceSalesFeeUnitAmount,
      "Locked marketplace sales fee unit amount",
    ),
    sellerNetUnitAmount: normalizeMoneyAmount(lock.sellerNetUnitAmount, "Locked seller net unit amount"),
    feeQuoteFingerprint: normalizeRequiredText(lock.feeQuoteFingerprint, "Locked fee quote fingerprint"),
  };
}

function sameMoneyAmount(left: string | null, right: string | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return moneyToCents(left) === moneyToCents(right);
}

export function sameMarketplaceListingFeeTerms(
  left: MarketplaceListingFeeTermsSnapshot,
  right: MarketplaceListingFeeTermsSnapshot,
): boolean {
  return (
    left.marketplaceSalesFeePercentageBps === right.marketplaceSalesFeePercentageBps &&
    sameMoneyAmount(left.marketplaceSalesFeeFixedAmount, right.marketplaceSalesFeeFixedAmount) &&
    sameMoneyAmount(left.marketplaceSalesFeeCapAmount, right.marketplaceSalesFeeCapAmount) &&
    left.shippingAllowancePercentageBps === right.shippingAllowancePercentageBps &&
    left.termsScheduleId === right.termsScheduleId &&
    left.termsAgreementId === right.termsAgreementId &&
    left.termsResolvedAt === right.termsResolvedAt
  );
}

export function assertFeeLockTermsPreserved(
  current: readonly MarketplaceListingFeeLock[],
  requoted: readonly MarketplaceListingFeeLock[],
): void {
  assert(current.length === requoted.length, "Price edits must preserve every listing fee-lock tranche.");
  for (let index = 0; index < current.length; index += 1) {
    const currentLock = current[index]!;
    const nextLock = requoted[index]!;
    assert(currentLock.unitCount === nextLock.unitCount, "Price edits cannot move units between fee-lock tranches.");
    assert(
      sameMarketplaceListingFeeTerms(currentLock.terms, nextLock.terms),
      "Price edits must use the listing's locked fee terms.",
    );
  }
}

/**
 * Reductions retire the most recently added units first. Retired capacity is
 * not remembered: a later increase is a new restock and therefore needs a
 * fresh fee lock. This prevents quantity-down/quantity-up rate farming while
 * leaving the original listing identity and its remaining units intact.
 */
export function resizeMarketplaceListingFeeLocks(
  current: readonly MarketplaceListingFeeLock[],
  quantityCap: number,
  addedUnitsFeeLock: MarketplaceListingFeeLock | null,
): MarketplaceListingFeeLock[] {
  assert(Number.isInteger(quantityCap) && quantityCap > 0, "Listing quantity cap must be a positive whole number.");
  const currentUnitCount = current.reduce((sum, lock) => sum + lock.unitCount, 0);

  if (quantityCap === currentUnitCount) {
    assert(addedUnitsFeeLock === null, "Unchanged quantity cannot add a fee-lock tranche.");
    return [...current];
  }

  if (quantityCap > currentUnitCount) {
    assert(addedUnitsFeeLock !== null, "Quantity increases require current fee terms for the added units.");
    const normalized = normalizeMarketplaceListingFeeLock(addedUnitsFeeLock);
    assert(
      normalized.unitCount === quantityCap - currentUnitCount,
      "Added fee-lock units must equal the quantity increase.",
    );
    return [...current, normalized];
  }

  assert(addedUnitsFeeLock === null, "Quantity reductions cannot replace locked fee terms.");
  let unitsToRetire = currentUnitCount - quantityCap;
  const resized = [...current];
  while (unitsToRetire > 0) {
    const latest = resized.pop();
    assert(latest, "Listing fee locks cannot be empty.");
    if (latest.unitCount > unitsToRetire) {
      resized.push({ ...latest, unitCount: latest.unitCount - unitsToRetire });
      unitsToRetire = 0;
    } else {
      unitsToRetire -= latest.unitCount;
    }
  }
  return resized;
}

export function totalFeeLockedUnits(feeLocks: readonly MarketplaceListingFeeLock[]): number {
  return feeLocks.reduce((sum, lock) => sum + lock.unitCount, 0);
}

export function currentMarketplaceListingFeeLock(
  feeLocks: readonly MarketplaceListingFeeLock[],
): MarketplaceListingFeeLock {
  const lock = feeLocks.at(-1);
  assert(lock, "Listing fee lock is missing.");
  return lock;
}
