import type { JsonValue } from "@chase-sets/primitives/json";

export type CatalogLifecycleStatus =
  | "draft"
  | "active"
  | "deprecated"
  | "archived";

export type CatalogItemStatus = "draft" | "active" | "retired" | "archived";

export type OptionStatus = "active" | "deprecated";

export type FieldValueType = "string" | "number" | "boolean" | "date" | "json";

export type LocalizedText = Readonly<{
  locale: string;
  value: string;
}>;

export type FieldBehavior = Readonly<{
  filterable: boolean;
  searchable: boolean;
  sortable: boolean;
}>;

export type CatalogValue = JsonValue;

export type EmptyEventData = Readonly<Record<string, never>>;

export const EMPTY_EVENT_DATA: EmptyEventData = {};

export class CatalogDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CatalogDomainError";
  }
}

export function assert(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) {
    throw new CatalogDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new CatalogDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function normalizeLocalizedText(
  labels: readonly LocalizedText[],
): LocalizedText[] {
  const normalized = labels.map((label) => ({
    locale: label.locale.trim(),
    value: label.value.trim(),
  }));

  ensureUniqueBy(
    normalized,
    (label) => label.locale,
    "Localized labels must have unique locales.",
  );

  return normalized.sort((left, right) =>
    left.locale.localeCompare(right.locale),
  );
}

export function ensureUniqueBy<T>(
  values: readonly T[],
  selectKey: (value: T) => string,
  message: string,
): void {
  const keys = new Set<string>();

  for (const value of values) {
    const key = selectKey(value);

    if (keys.has(key)) {
      throw new CatalogDomainError(message);
    }

    keys.add(key);
  }
}

export function hasSameMembers<T extends string>(
  left: readonly T[],
  right: readonly T[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const remaining = new Set<string>(left);

  for (const value of right) {
    if (!remaining.has(value)) {
      return false;
    }

    remaining.delete(value);
  }

  return remaining.size === 0;
}

export function toSortedUniqueList<T extends string>(
  values: readonly T[],
): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

