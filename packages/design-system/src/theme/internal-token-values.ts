export function readThemeCssVariable(cssVariable: string): string | undefined {
  if (
    typeof document === "undefined" ||
    typeof window === "undefined" ||
    typeof window.getComputedStyle !== "function"
  ) {
    return undefined;
  }

  const value = window.getComputedStyle(document.documentElement).getPropertyValue(cssVariable).trim();

  return value || undefined;
}

export function resolveThemeTokenValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/);

  if (!match) {
    return trimmed;
  }

  return readThemeCssVariable(match[1] ?? "") ?? match[2]?.trim();
}
