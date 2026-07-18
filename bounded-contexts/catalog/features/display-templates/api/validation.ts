import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { CatalogDomainError } from "../../../support/runtime-support/common";
import { displayTemplateTokens, titleHasNonOptionalContent, type DisplayTemplateState } from "../domain/domain";

type ActiveReferenceTypeRow = Readonly<{ key: string; attribute_keys: unknown }>;

export async function validatePublishedDisplayTemplate(db: PgQueryable, template: DisplayTemplateState): Promise<void> {
  if (!titleHasNonOptionalContent(template.titleTemplate)) {
    throw new CatalogDomainError("Display Template title renders empty when optional segments are dropped.");
  }

  const tokens = [
    ...displayTemplateTokens(template.titleTemplate),
    ...displayTemplateTokens(template.subtitleTemplate ?? ""),
  ];
  const fieldKeys = new Set<string>();
  const referenceTypeKeys = new Set<string>();
  const relationshipTypes = new Set<string>();

  for (const token of tokens) {
    const parts = token.split(".");
    if (parts[0] === "field" && parts.length === 2 && parts[1]) {
      fieldKeys.add(parts[1]);
    } else if (parts[0] === "item" && parts.length === 2 && (parts[1] === "title" || parts[1] === "subtitle")) {
      continue;
    } else if (parts[0] === "reference" && parts[1]) {
      referenceTypeKeys.add(parts[1]);
      if (parts[2] === "relationship" && parts[3]) relationshipTypes.add(parts[3]);
    } else {
      throw invalidToken(token);
    }
  }

  const [fields, referenceTypes, relationships] = await Promise.all([
    db.query<{ key: string }>(`SELECT key FROM catalog_fields WHERE status = 'active' AND key = ANY($1::text[])`, [
      [...fieldKeys],
    ]),
    db.query<ActiveReferenceTypeRow>(
      `SELECT key, attribute_keys FROM catalog_reference_types WHERE status = 'active' AND key = ANY($1::text[])`,
      [[...referenceTypeKeys]],
    ),
    relationshipTypes.size === 0
      ? Promise.resolve({ rows: [] as Array<{ relationship_type: string }> })
      : db.query<{ relationship_type: string }>(
          `SELECT DISTINCT relationship->>'relationshipType' AS relationship_type
           FROM catalog_reference_records
           CROSS JOIN LATERAL jsonb_array_elements(relationships) AS relationship
           WHERE status = 'active' AND relationship->>'relationshipType' = ANY($1::text[])`,
          [[...relationshipTypes]],
        ),
  ]);

  const activeFieldKeys = new Set(fields.rows.map((row) => row.key));
  for (const fieldKey of fieldKeys) {
    if (!activeFieldKeys.has(fieldKey)) {
      throw new CatalogDomainError(
        `Display Template token {field.${fieldKey}} references an unknown or inactive field.`,
      );
    }
  }

  const activeReferenceTypes = new Map(referenceTypes.rows.map((row) => [row.key, row]));
  for (const token of tokens) {
    const parts = token.split(".");
    if (parts[0] !== "reference") continue;
    const referenceType = activeReferenceTypes.get(parts[1]);
    if (!referenceType)
      throw new CatalogDomainError(
        `Display Template token {${token}} references an unknown or inactive reference type.`,
      );
    if (parts.length === 2 || (parts.length === 3 && (parts[2] === "name" || parts[2] === "key"))) continue;
    if (parts[2] === "attributes" && parts.length >= 4) {
      const attributeKey = parts.slice(3).join(".");
      if (asStrings(referenceType.attribute_keys).includes(attributeKey)) continue;
      throw new CatalogDomainError(
        `Display Template token {${token}} references undeclared attribute '${attributeKey}'.`,
      );
    }
    if (parts[2] === "relationship" && parts.length >= 4) continue;
    throw invalidToken(token);
  }

  const knownRelationshipTypes = new Set(relationships.rows.map((row) => row.relationship_type));
  for (const relationshipType of relationshipTypes) {
    if (!knownRelationshipTypes.has(relationshipType)) {
      throw new CatalogDomainError(`Display Template token relationship '${relationshipType}' is unknown or inactive.`);
    }
  }
}

function invalidToken(token: string): CatalogDomainError {
  return new CatalogDomainError(`Display Template token {${token}} is invalid.`);
}

function asStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
