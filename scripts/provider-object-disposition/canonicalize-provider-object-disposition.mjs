import { createHash } from "node:crypto";

// Domain-separated digest prefix fixed by issue #6733. Never change the
// literal bytes below without minting a new schema version.
export const RESULT_DIGEST_DOMAIN_PREFIX = "provider-object-disposition/v1\n";

function compareCodeUnits(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Sorts object keys by raw UTF-16 code unit (JS string `<`/`>`), not locale
// collation, at every depth. Arrays keep their schema-declared order.
export function sortKeysByCodeUnit(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysByCodeUnit);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value).sort(compareCodeUnits);
    const result = {};
    for (const key of sortedKeys) {
      result[key] = sortKeysByCodeUnit(value[key]);
    }
    return result;
  }
  return value;
}

/**
 * Produces the canonical UTF-8 byte form of a provider-object-disposition/v1
 * document: keys sorted by code unit at every depth, arrays left in their
 * declared order, no insignificant whitespace, no trailing newline, and
 * `resultDigest` forced to the empty string regardless of its input value.
 */
export function canonicalizeProviderObjectDisposition(document) {
  const blanked = { ...document, resultDigest: "" };
  const canonicalJson = JSON.stringify(sortKeysByCodeUnit(blanked));
  return Buffer.from(canonicalJson, "utf8");
}

/** SHA-256 of the domain prefix followed by the canonical bytes (resultDigest blanked). */
export function computeResultDigest(document) {
  const canonicalBytes = canonicalizeProviderObjectDisposition(document);
  return createHash("sha256")
    .update(Buffer.from(RESULT_DIGEST_DOMAIN_PREFIX, "utf8"))
    .update(canonicalBytes)
    .digest("hex");
}
