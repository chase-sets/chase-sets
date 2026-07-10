import { referenceIdFromValue, type ReferenceRecordRef } from "../../../support/item-support/reference-records";
import { normalizeStructuredCardNumber, normalizeStructuredSetCode } from "../domain/structured-natural-key-query";

/**
 * Derives the denormalized `card_number` / `set_code` columns on
 * `discovery_search_items` from data the search projection already loads per
 * catalog item: the item's field values, the filterable field definitions
 * (now including Catalog's authored `key`), and the resolved reference records
 * those field values point at. No new catalog data or cross-context dependency
 * is required — see the read-model schema comment for the natural-key columns.
 */
export type NaturalKeyFieldValue = Readonly<{ fieldId: string; value: unknown }>;
export type NaturalKeyFieldDefinition = Readonly<{ key: string }>;

// Reference types that carry a set-level natural key across today's provider
// integrations: Magic, Lorcana, and One Piece promote through the "set"
// reference type; Pokemon has no top-level "set" concept and promotes through
// "expansion" instead (see provider-integration-profiles.ts reference hierarchy
// mappings). Extend this set if a future game introduces another top-level
// set-like reference type key.
const SET_LIKE_REFERENCE_TYPE_KEYS: ReadonlySet<string> = new Set(["set", "expansion"]);

export function extractStructuredCardNumber(
  fieldValues: readonly NaturalKeyFieldValue[],
  fieldDefinitionsById: ReadonlyMap<string, NaturalKeyFieldDefinition>,
): string | null {
  for (const fieldValue of fieldValues) {
    if (fieldDefinitionsById.get(fieldValue.fieldId)?.key !== "card-number") {
      continue;
    }

    const raw = typeof fieldValue.value === "string" ? fieldValue.value : String(fieldValue.value ?? "");
    const normalized = normalizeStructuredCardNumber(raw);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

export function extractStructuredSetCode(
  fieldValues: readonly NaturalKeyFieldValue[],
  referencesByReferenceId: ReadonlyMap<string, ReferenceRecordRef>,
): string | null {
  for (const fieldValue of fieldValues) {
    const referenceId = referenceIdFromValue(fieldValue.value);
    const reference = referenceId ? referencesByReferenceId.get(referenceId) : undefined;
    if (!reference || !SET_LIKE_REFERENCE_TYPE_KEYS.has(reference.typeKey)) {
      continue;
    }

    const code = setCodeFromReferenceAttributes(reference.attributes);
    if (code) {
      return normalizeStructuredSetCode(code);
    }
  }

  return null;
}

// Provider reference-hierarchy attributes carry the printed set code under a
// provider-prefixed key (mtgjson-set-code, scryfall-set-code, lorcast-set-code,
// lorcanajson-set-code, scrydex-<game>-set-code) or, for TCGdex/Pokemon
// expansions, the plain "abbreviation" key (provider-integration-profiles.ts).
// Matching on this naming convention lets Discovery read the code without
// importing Catalog's provider-integration internals at runtime.
function setCodeFromReferenceAttributes(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    return null;
  }

  for (const [attributeKey, value] of Object.entries(attributes as Record<string, unknown>)) {
    if (isSetCodeAttributeKey(attributeKey) && typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function isSetCodeAttributeKey(attributeKey: string): boolean {
  return attributeKey === "abbreviation" || attributeKey === "code" || attributeKey.endsWith("-set-code");
}
