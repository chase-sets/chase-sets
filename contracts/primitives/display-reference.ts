import type { TypedUlid } from "./typed-ids";

export const DISPLAY_REFERENCE_DEFAULT_SUFFIX_LENGTH = 8;
export const DISPLAY_REFERENCE_SUFFIX_LENGTHS = [8, 10, 12] as const;

export type DisplayReferenceSuffixLength = (typeof DISPLAY_REFERENCE_SUFFIX_LENGTHS)[number];

export const DISPLAY_REFERENCE_PREFIX_BY_TYPED_ID_PREFIX = {
  ord: "ORD",
  shp: "SHP",
  pyo: "PYO",
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
