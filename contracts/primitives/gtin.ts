import type { Branded } from "./brand";

/**
 * A GTIN normalized to its canonical GTIN-14 form: digits only, left-padded
 * with zeros, and check-digit validated. GTIN-8, GTIN-12 (UPC-A), and
 * GTIN-13 (EAN-13) inputs all normalize into this same 14-digit shape so a
 * single barcode scan resolves regardless of which format a provider or
 * scanner emitted.
 */
export type NormalizedGtin = Branded<string, "NormalizedGtin">;

const GTIN_INPUT_LENGTHS = new Set([8, 12, 13, 14]);
const GTIN_CANONICAL_LENGTH = 14;

/**
 * Normalizes a raw barcode string into a canonical GTIN-14 form.
 *
 * Strips non-digit characters (spaces, hyphens), requires the remaining
 * digit count to be a valid GTIN length (8, 12, 13, or 14), validates the
 * GS1 mod-10 check digit, and left-pads to 14 digits. Returns `null` when
 * the input is not digit-length-valid or fails the check digit -- callers
 * should treat that as "not a GTIN candidate", not throw.
 */
export function normalizeGtin(raw: string | null | undefined): NormalizedGtin | null {
  const digitsOnly = (raw ?? "").replace(/[^0-9]/g, "");

  if (!GTIN_INPUT_LENGTHS.has(digitsOnly.length)) {
    return null;
  }

  if (!hasValidGtinCheckDigit(digitsOnly)) {
    return null;
  }

  return digitsOnly.padStart(GTIN_CANONICAL_LENGTH, "0") as NormalizedGtin;
}

/** True when `raw` normalizes to a valid GTIN. Convenience wrapper for input detection. */
export function isGtinCandidate(raw: string | null | undefined): boolean {
  return normalizeGtin(raw) !== null;
}

function hasValidGtinCheckDigit(digits: string): boolean {
  const checkDigit = Number(digits[digits.length - 1]);
  const body = digits.slice(0, -1);
  let sum = 0;

  for (let index = 0; index < body.length; index += 1) {
    const digit = Number(body[body.length - 1 - index]);
    const weight = index % 2 === 0 ? 3 : 1;
    sum += digit * weight;
  }

  const expectedCheckDigit = (10 - (sum % 10)) % 10;
  return expectedCheckDigit === checkDigit;
}
