/**
 * Type checks for the stored JSON values a public Listing read copies. A value of the wrong type is
 * never passed on: a nullable field becomes null, and the copy drops an entry whose required value fails.
 */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function publicText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function publicNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function publicTextList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Each entry of a stored list, copied by `copy`; an entry that is not an object, or that `copy` rejects, is dropped. */
export function publicEntries<T>(value: unknown, copy: (entry: Readonly<Record<string, unknown>>) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const copied = isRecord(entry) ? copy(entry) : null;
    return copied === null ? [] : [copied];
  });
}
