import { t } from "@chase-sets/localization";
import type { ReferenceRelationship } from "./contracts";

export function parseKeyList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function formatKeyList(values: readonly string[] | unknown): string {
  return Array.isArray(values) ? values.join("\n") : "";
}

export function parseAttributesInput(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to line-based parsing.
  }

  return Object.fromEntries(
    trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [key = "", ...rest] = line.split(":");
        return [key.trim(), parseScalar(rest.join(":").trim())] as const;
      })
      .filter(([key]) => key.length > 0),
  );
}

export function formatAttributesInput(attributes: unknown): string {
  if (!isRecord(attributes) || Object.keys(attributes).length === 0) {
    return "";
  }

  return JSON.stringify(attributes, null, 2);
}

export function parseRelationshipsInput(value: string): ReferenceRelationship[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [relationshipType = "", referenceId = ""] = line.split(":");
      return {
        relationshipType: relationshipType.trim(),
        referenceId: referenceId.trim(),
      };
    })
    .filter((relationship) =>
      relationship.relationshipType.length > 0 && relationship.referenceId.length > 0,
    );
}

export function formatRelationshipsInput(relationships: readonly ReferenceRelationship[] | unknown): string {
  if (!Array.isArray(relationships)) {
    return "";
  }

  return relationships
    .map((relationship) =>
      t("catalog.features.referenceData.ui.referenceDataForm.relationship.input.entry", {
        relationshipType: relationship.relationshipType,
        referenceId: relationship.referenceId,
      }),
    )
    .join("\n");
}

export function formatAttributesSummary(attributes: unknown): string {
  if (!isRecord(attributes) || Object.keys(attributes).length === 0) {
    return "—";
  }

  return Object.entries(attributes)
    .map(([key, value]) =>
      t("catalog.features.referenceData.ui.referenceDataForm.attribute.summary.entry", {
        key,
        value: formatValue(value),
      }),
    )
    .join(", ");
}

export function formatRelationshipsSummary(relationships: readonly ReferenceRelationship[] | unknown): string {
  if (!Array.isArray(relationships) || relationships.length === 0) {
    return "—";
  }

  return relationships
    .map((relationship) =>
      t("catalog.features.referenceData.ui.referenceDataForm.relationship.summary.entry", {
        relationshipType: relationship.relationshipType,
        referenceId: relationship.referenceId,
      }),
    )
    .join(", ");
}

function parseScalar(value: string): unknown {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null") {
    return null;
  }
  if (value !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return value;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
