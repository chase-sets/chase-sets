import { resolveThemeTokenValue } from "./internal-token-values";

export type StripeElementsAppearance = Readonly<{
  theme: "flat";
  variables: Readonly<Record<string, string>>;
  rules?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}>;

export type StripeConnectAppearance = Readonly<{
  overlays: "dialog" | "drawer";
  variables: Readonly<Record<string, string | number>>;
}>;

export type StripeAppearanceOptions = Readonly<{
  scope?: Element | null;
}>;

export type StripeElementsAppearanceOptions = StripeAppearanceOptions &
  Readonly<{
    includeRules?: boolean;
  }>;

function token(name: string, fallback: string, scope?: Element | null) {
  return resolveThemeTokenValue(`var(${name}, ${fallback})`, scope) ?? fallback;
}

function themeScope(scope?: Element | null) {
  if (typeof document === "undefined") {
    return null;
  }

  return scope?.closest?.("[data-chase-theme], [data-chase-theme-scope]") ?? scope ?? document.documentElement;
}

function pxToken(name: string, fallbackRem: string, scope?: Element | null) {
  const value = token(name, fallbackRem, scope);
  const remMatch = value.match(/^([0-9.]+)rem$/);

  if (!remMatch) {
    return value;
  }

  return `${Number.parseFloat(remMatch[1] ?? "0") * 16}px`;
}

const appearanceSnapshotTokens = [
  "--background",
  "--card",
  "--surface-2",
  "--foreground",
  "--text-secondary",
  "--text-muted",
  "--border",
  "--primary",
  "--primary-foreground",
  "--ring",
  "--destructive",
  "--success",
  "--warning",
  "--radius",
  "--body-font",
] as const;

export function stripeAppearanceSnapshot({ scope = null }: StripeAppearanceOptions = {}) {
  const root = themeScope(scope);
  const colorMode = root?.getAttribute("data-color-mode") ?? "";

  return [colorMode, ...appearanceSnapshotTokens.map((name) => token(name, "", root))].join("|");
}

export function observeStripeAppearance({ scope = null }: StripeAppearanceOptions, onChange: () => void) {
  const root = themeScope(scope);
  if (!root || typeof MutationObserver === "undefined") {
    return () => {};
  }

  const observer = new MutationObserver(onChange);
  observer.observe(root, {
    attributeFilter: ["class", "data-color-mode", "data-theme", "style"],
    attributes: true,
  });

  return () => observer.disconnect();
}

export function createStripeElementsAppearance({
  includeRules = true,
  scope = null,
}: StripeElementsAppearanceOptions = {}): StripeElementsAppearance {
  const primary = token("--primary", "#1d5fd6", scope);
  const background = token("--card", "#ffffff", scope);
  const surface = token("--surface-2", "#f8fafc", scope);
  const text = token("--foreground", "#0f172a", scope);
  const secondaryText = token("--text-secondary", "#334155", scope);
  const mutedText = token("--text-muted", "#64748b", scope);
  const border = token("--border", "#e2e8f0", scope);
  const focus = token("--ring", "#2563eb", scope);
  const danger = token("--destructive", "#b91c1c", scope);
  const success = token("--success", "#15803d", scope);
  const warning = token("--warning", "#b45309", scope);
  const radius = token("--radius", "0.5rem", scope);

  return {
    theme: "flat",
    variables: {
      borderRadius: radius,
      colorBackground: background,
      colorDanger: danger,
      colorIcon: secondaryText,
      colorPrimary: primary,
      colorSuccess: success,
      colorText: text,
      colorTextPlaceholder: secondaryText,
      colorTextSecondary: secondaryText,
      colorWarning: warning,
      fontFamily: token("--body-font", '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif', scope),
      fontLineHeight: token("--line-height-base", "1.5rem", scope),
      fontSizeBase: token("--font-size-base", "1rem", scope),
      fontSizeSm: token("--font-size-sm", "0.875rem", scope),
      fontWeightMedium: "600",
      fontWeightNormal: "400",
      spacingGridColumn: token("--space-3", "0.75rem", scope),
      spacingGridRow: token("--space-3", "0.75rem", scope),
      spacingUnit: token("--space-unit", "0.25rem", scope),
    },
    ...(includeRules
      ? {
          rules: {
            ".Block": {
              backgroundColor: surface,
              border: `1px solid ${border}`,
              boxShadow: token("--shadow-sm", "0 1px 2px rgba(15, 23, 42, 0.06)", scope),
            },
            ".Input": {
              backgroundColor: surface,
              border: `1px solid ${border}`,
              boxShadow: "none",
              color: text,
              padding: `${token("--control-md-py", "0.625rem", scope)} ${token("--control-md-px", "1rem", scope)}`,
            },
            ".Input:focus": {
              border: `1px solid ${focus}`,
              boxShadow: `0 0 0 2px ${focus}`,
            },
            ".Input--invalid": {
              border: `1px solid ${danger}`,
              color: text,
            },
            ".Label": {
              color: secondaryText,
              fontWeight: "600",
            },
            ".Tab": {
              backgroundColor: background,
              border: `1px solid ${border}`,
              boxShadow: "none",
              color: secondaryText,
            },
            ".Tab:hover": {
              backgroundColor: surface,
              color: text,
            },
            ".Tab--selected": {
              backgroundColor: surface,
              border: `1px solid ${primary}`,
              boxShadow: "none",
              color: primary,
            },
          },
        }
      : {}),
  };
}

export function createStripeConnectAppearance({ scope = null }: StripeAppearanceOptions = {}): StripeConnectAppearance {
  const background = token("--card", "#ffffff", scope);
  const surface = token("--surface-2", "#f8fafc", scope);
  const text = token("--foreground", "#0f172a", scope);
  const secondaryText = token("--text-secondary", "#334155", scope);
  const border = token("--border", "#e2e8f0", scope);
  const primary = token("--primary", "#1d5fd6", scope);
  const danger = token("--destructive", "#b91c1c", scope);

  return {
    overlays: "dialog",
    variables: {
      actionPrimaryColorText: primary,
      actionPrimaryTextDecorationColor: primary,
      actionPrimaryTextDecorationLine: "none",
      actionSecondaryColorText: secondaryText,
      actionSecondaryTextDecorationColor: secondaryText,
      badgeBorderRadius: pxToken("--radius-sm", "0.375rem", scope),
      badgeDangerColorBackground: token("--danger-soft", "#fee2e2", scope),
      badgeDangerColorBorder: token("--danger-soft", "#fee2e2", scope),
      badgeDangerColorText: danger,
      badgeLabelFontSize: pxToken("--font-size-xs", "0.75rem", scope),
      badgeNeutralColorBackground: surface,
      badgeNeutralColorBorder: border,
      badgeNeutralColorText: secondaryText,
      badgeSuccessColorBackground: token("--success-soft", "#dcfce7", scope),
      badgeSuccessColorBorder: token("--success-soft", "#dcfce7", scope),
      badgeSuccessColorText: token("--success", "#15803d", scope),
      badgeWarningColorBackground: token("--warning-soft", "#fef3c7", scope),
      badgeWarningColorBorder: token("--warning-soft", "#fef3c7", scope),
      badgeWarningColorText: token("--warning", "#b45309", scope),
      bodyMdFontSize: pxToken("--font-size-base", "1rem", scope),
      bodySmFontSize: pxToken("--font-size-sm", "0.875rem", scope),
      borderRadius: pxToken("--radius", "0.5rem", scope),
      buttonBorderRadius: pxToken("--radius", "0.5rem", scope),
      buttonLabelFontSize: pxToken("--font-size-sm", "0.875rem", scope),
      buttonLabelFontWeight: "600",
      buttonLabelTextTransform: "none",
      buttonPaddingX: pxToken("--control-md-px", "1rem", scope),
      buttonPaddingY: pxToken("--control-md-py", "0.625rem", scope),
      buttonPrimaryColorBackground: primary,
      buttonPrimaryColorBorder: primary,
      buttonPrimaryColorText: token("--primary-foreground", "#ffffff", scope),
      buttonSecondaryColorBackground: surface,
      buttonSecondaryColorBorder: border,
      buttonSecondaryColorText: text,
      colorBackground: background,
      colorBorder: border,
      colorDanger: danger,
      colorPrimary: primary,
      colorSecondaryText: secondaryText,
      colorText: text,
      fontFamily: token("--body-font", '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif', scope),
      fontSizeBase: pxToken("--font-size-base", "1rem", scope),
      formAccentColor: primary,
      formBackgroundColor: surface,
      formBorderRadius: pxToken("--radius", "0.5rem", scope),
      formHighlightColorBorder: token("--ring", "#2563eb", scope),
      formPlaceholderTextColor: token("--text-muted", "#64748b", scope),
      headingLgFontSize: pxToken("--font-size-xl", "1.25rem", scope),
      headingLgFontWeight: "700",
      headingLgTextTransform: "none",
      headingMdFontSize: pxToken("--font-size-lg", "1.125rem", scope),
      headingMdFontWeight: "700",
      headingMdTextTransform: "none",
      headingSmFontSize: pxToken("--font-size-base", "1rem", scope),
      headingSmFontWeight: "600",
      headingSmTextTransform: "none",
      inputFieldPaddingX: pxToken("--control-md-px", "1rem", scope),
      inputFieldPaddingY: pxToken("--control-md-py", "0.625rem", scope),
      labelMdFontSize: pxToken("--font-size-sm", "0.875rem", scope),
      labelMdFontWeight: "600",
      labelMdTextTransform: "none",
      offsetBackgroundColor: surface,
      overlayBackdropColor: token("--overlay", "rgba(29, 27, 24, 0.35)", scope),
      overlayBorderRadius: pxToken("--radius-lg", "0.75rem", scope),
      overlayZIndex: Number.parseInt(token("--z-modal", "60", scope), 10),
      spacingUnit: pxToken("--space-2", "0.5rem", scope),
      tableRowPaddingY: pxToken("--space-3", "0.75rem", scope),
    },
  };
}
