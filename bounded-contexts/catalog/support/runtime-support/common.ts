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

export type LocalizedTextMap = Readonly<{
  defaultLocale: "en";
  values: Readonly<Record<string, string>>;
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

export function normalizeLocaleCode(locale: string): string {
  const trimmed = locale.trim();

  assert(trimmed.length > 0, "Locale codes are required.");
  assert(trimmed.toLowerCase() !== "jp", "Use the BCP 47 language code \"ja\" for Japanese.");

  const parts = trimmed.split("-");
  const [language = "", ...rest] = parts;
  const normalized = [
    language.toLowerCase(),
    ...rest.map((part, index) =>
      index === 0 && part.length === 4
        ? part[0].toUpperCase() + part.slice(1).toLowerCase()
        : part.length === 2
          ? part.toUpperCase()
          : part.toLowerCase(),
    ),
  ].join("-");

  assert(
    /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(normalized),
    "Locale codes must be valid BCP 47 language tags.",
  );

  return normalized;
}

export function normalizeLocalizedTextMap(
  input: LocalizedTextMap,
  options: Readonly<{ requiredEnglish?: boolean }> = {},
): LocalizedTextMap {
  const entries = Object.entries(input.values)
    .map(([locale, value]) => [normalizeLocaleCode(locale), value.trim()] as const)
    .filter(([, value]) => value.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const values = Object.fromEntries(entries);

  assert(
    input.defaultLocale === "en",
    "Localized text maps currently require English as the default locale.",
  );

  if (options.requiredEnglish) {
    assert(
      typeof values.en === "string" && values.en.length > 0,
      "Localized text maps require an English value.",
    );
  }

  return {
    defaultLocale: "en",
    values,
  };
}

export function localizedTextMapFromEnglish(value: string): LocalizedTextMap {
  return normalizeLocalizedTextMap(
    {
      defaultLocale: "en",
      values: { en: value },
    },
    { requiredEnglish: value.trim().length > 0 },
  );
}

export function resolveLocalizedTextMap(
  input: LocalizedTextMap | null | undefined,
  locale = "en",
): string {
  if (!input) {
    return "";
  }

  const requestedLocale = normalizeLocaleCode(locale);
  const defaultLocale = input.defaultLocale;

  return (
    input.values[requestedLocale] ??
    input.values[defaultLocale] ??
    input.values.en ??
    Object.values(input.values)[0] ??
    ""
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
