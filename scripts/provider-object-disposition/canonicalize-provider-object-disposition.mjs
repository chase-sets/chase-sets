import { createHash } from "node:crypto";

// Domain-separated digest prefix for the provider-object-disposition/v1
// schema. Never change the literal bytes below without minting a new
// schema version.
export const RESULT_DIGEST_DOMAIN_PREFIX = "provider-object-disposition/v1\n";

function compareCodeUnits(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Sorts object keys by raw UTF-16 code unit (JS string `<`/`>`), not locale
// collation, at every depth. Arrays keep their schema-declared order.
//
// Builds into a null-prototype target with Object.defineProperty per key
// (mirroring parseObject in validate-provider-object-disposition.mjs): an
// own `__proto__` key must become an ordinary own key, not invoke the
// inherited Object.prototype setter via `result[key] = value`, which would
// silently vanish the key and its value from the canonical bytes and digest
// (defence in depth — publication already refuses an own `__proto__` key
// via TOP_LEVEL_KEY_UNKNOWN/CLASS_ENTRY_KEY_UNKNOWN before this ever runs).
export function sortKeysByCodeUnit(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysByCodeUnit);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value).sort(compareCodeUnits);
    const result = Object.create(null);
    for (const key of sortedKeys) {
      Object.defineProperty(result, key, {
        value: sortKeysByCodeUnit(value[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
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
