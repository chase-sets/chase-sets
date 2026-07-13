import type { TypedUlid } from "./typed-ids";

export const DISPLAY_REFERENCE_DEFAULT_SUFFIX_LENGTH = 8;
export const DISPLAY_REFERENCE_SUFFIX_LENGTHS = [8, 10, 12] as const;

export type DisplayReferenceSuffixLength = (typeof DISPLAY_REFERENCE_SUFFIX_LENGTHS)[number];

export const DISPLAY_REFERENCE_PREFIX_BY_TYPED_ID_PREFIX = {
  ord: "ORD",
  shp: "SHP",
  pyo: "PYO",
  sup: "SUP",
  wad: "WAD",
} as const;

export type DisplayReferenceTypedIdPrefix = keyof typeof DISPLAY_REFERENCE_PREFIX_BY_TYPED_ID_PREFIX;

export type DisplayReferencePrefix =
  (typeof DISPLAY_REFERENCE_PREFIX_BY_TYPED_ID_PREFIX)[DisplayReferenceTypedIdPrefix];

export type DisplayReferenceFor<Prefix extends DisplayReferenceTypedIdPrefix> =
  `${(typeof DISPLAY_REFERENCE_PREFIX_BY_TYPED_ID_PREFIX)[Prefix]}-${string}`;

export interface DeriveDisplayReferenceOptions {
  suffixLength?: DisplayReferenceSuffixLength;
}

const CROCKFORD_ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * Derives a support-safe display reference from a canonical typed ULID.
 *
 * Collision policy: consumers persist the derived reference with a UNIQUE index
 * and retry projection upserts with suffix length 10, then 12, on conflict. Do
 * not add hashes or global sequences. Typed ULIDs remain canonical for URLs,
 * events, foreign keys, and cross-context identity.
 */
export function deriveDisplayReference<Prefix extends DisplayReferenceTypedIdPrefix>(
  id: TypedUlid<Prefix>,
  options?: DeriveDisplayReferenceOptions,
): DisplayReferenceFor<Prefix>;
export function deriveDisplayReference(
  id: TypedUlid<string>,
  options?: DeriveDisplayReferenceOptions,
): `${DisplayReferencePrefix}-${string}`;
export function deriveDisplayReference(
  id: TypedUlid<string>,
  options: DeriveDisplayReferenceOptions = {},
): `${DisplayReferencePrefix}-${string}` {
  const suffixLength = options.suffixLength ?? DISPLAY_REFERENCE_DEFAULT_SUFFIX_LENGTH;
  if (!isDisplayReferenceSuffixLength(suffixLength)) {
    throw new Error(`Display reference suffix length must be one of ${DISPLAY_REFERENCE_SUFFIX_LENGTHS.join(", ")}.`);
  }

  const [typedIdPrefix, ulid, ...rest] = id.split("_");
  if (rest.length > 0 || !typedIdPrefix || !ulid) {
    throw new Error("Display reference source must be a typed ULID.");
  }

  const displayPrefix = displayReferencePrefixForTypedIdPrefix(typedIdPrefix);
  const normalizedUlid = ulid.toUpperCase();
  if (!CROCKFORD_ULID_PATTERN.test(normalizedUlid)) {
    throw new Error("Display reference source must contain a 26-character Crockford-base32 ULID.");
  }

  return `${displayPrefix}-${normalizedUlid.slice(-suffixLength)}`;
}

/**
 * Best-effort variant of {@link deriveDisplayReference}: falls back to the raw
 * id verbatim when it is not a well-formed typed ULID, instead of throwing.
 * Fixed, human-readable seed/demo identifiers (e.g. `ord_seed_checkout_pending`)
 * predate real ULID generation and cannot derive a reference; every order,
 * shipment, or payout created through a live domain command always carries a
 * real ULID, so the fallback only matters for that legitimate non-ULID data —
 * it is never a silent failure mode for a real buyer or seller.
 */
export function deriveDisplayReferenceOrRaw(id: TypedUlid<string>, options?: DeriveDisplayReferenceOptions): string {
  try {
    return deriveDisplayReference(id, options);
  } catch {
    return id;
  }
}

export function displayReferencePrefixForTypedIdPrefix(prefix: string): DisplayReferencePrefix {
  if (!isDisplayReferenceTypedIdPrefix(prefix)) {
    throw new Error(`Unsupported display reference typed-id prefix '${prefix}'.`);
  }

  return DISPLAY_REFERENCE_PREFIX_BY_TYPED_ID_PREFIX[prefix];
}

function isDisplayReferenceTypedIdPrefix(prefix: string): prefix is DisplayReferenceTypedIdPrefix {
  return Object.prototype.hasOwnProperty.call(DISPLAY_REFERENCE_PREFIX_BY_TYPED_ID_PREFIX, prefix);
}

function isDisplayReferenceSuffixLength(length: number): length is DisplayReferenceSuffixLength {
  return DISPLAY_REFERENCE_SUFFIX_LENGTHS.includes(length as DisplayReferenceSuffixLength);
}
