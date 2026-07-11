import {
  isSetLikeReferenceType,
  referenceIdFromValue,
  setCodeFromReferenceAttributes,
  type ReferenceRecordRef,
} from "../../../support/item-support/reference-records";
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
    if (!reference || !isSetLikeReferenceType(reference.typeKey)) {
      continue;
    }

    const code = setCodeFromReferenceAttributes(reference.attributes);
    if (code) {
      return normalizeStructuredSetCode(code);
    }
  }

  return null;
}
