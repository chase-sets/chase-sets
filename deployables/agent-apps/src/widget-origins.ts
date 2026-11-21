export function readWidgetOrigins(content: string | undefined): string[] {
  if (!content) return [];
  try {
    const value: unknown = JSON.parse(decodeURIComponent(content));
    return Array.isArray(value) &&
      value.every(
        (origin): origin is string =>
          typeof origin === "string" && origin.startsWith("https://") && new URL(origin).origin === origin,
      )
      ? value
      : [];
  } catch {
    return [];
  }
}
