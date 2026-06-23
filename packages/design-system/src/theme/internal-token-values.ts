function themeReadTarget(scope?: Element | null): Element | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }

  return scope?.closest?.("[data-chase-theme], [data-chase-theme-scope]") ?? scope ?? document.documentElement;
}

export function readThemeCssVariable(cssVariable: string, scope?: Element | null): string | undefined {
  if (
    typeof document === "undefined" ||
    typeof window === "undefined" ||
    typeof window.getComputedStyle !== "function" ||
    !themeReadTarget(scope)
  ) {
    return undefined;
  }

  const value = window.getComputedStyle(themeReadTarget(scope)!).getPropertyValue(cssVariable).trim();

  return value || undefined;
}

export function resolveThemeTokenValue(
  value: string | undefined,
  scope?: Element | null,
  seenVariables = new Set<string>(),
): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/);

  if (!match) {
    return trimmed;
  }

  const cssVariable = match[1] ?? "";
  if (seenVariables.has(cssVariable)) {
    return match[2]?.trim();
  }

  seenVariables.add(cssVariable);
  const resolved = readThemeCssVariable(cssVariable, scope);

  return resolveThemeTokenValue(resolved, scope, seenVariables) ?? match[2]?.trim();
}
