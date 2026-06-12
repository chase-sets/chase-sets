import type { JsonObject } from "@chase-sets/primitives/json";

export function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function jsonRecord(value: unknown): JsonObject {
  return (recordValue(value) ?? {}) as JsonObject;
}

export function listValue(value: FormDataEntryValue | unknown, fallback: readonly string[]): readonly string[] {
  const parsed =
    typeof value === "string"
      ? value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
  return parsed.length > 0 ? parsed : fallback;
}

export function stringArrayValue(value: unknown): readonly string[] {
  return arrayValue(value).filter((entry): entry is string => typeof entry === "string");
}

export function nullableStringValue(value: FormDataEntryValue | unknown, fallback: string | null): string | null {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function numberValue(value: FormDataEntryValue | unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function mutableLifecycleValue(value: FormDataEntryValue | unknown): "draft" | "test" | undefined {
  return value === "draft" || value === "test" ? value : undefined;
}

export function profileStatusValue(value: FormDataEntryValue | unknown): "active" | "planned" | undefined {
  return value === "active" || value === "planned" ? value : undefined;
}

export function stringValue(value: FormDataEntryValue | unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
