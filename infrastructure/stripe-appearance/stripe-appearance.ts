import type { EmbeddedSurfaceTheme } from "@chase-sets/embedded-surface-theme";

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
  theme?: EmbeddedSurfaceTheme;
}>;

export type StripeElementsAppearanceOptions = StripeAppearanceOptions &
  Readonly<{
    includeRules?: boolean;
  }>;

type Slot = Exclude<keyof EmbeddedSurfaceTheme, "mode">;

const colorSlots = new Set<Slot>([
  "pageBackground",
  "surface",
  "subtleSurface",
  "text",
  "secondaryText",
  "mutedText",
  "border",
  "accent",
  "onAccent",
  "focusRing",
  "danger",
  "dangerSoft",
  "success",
  "successSoft",
  "warning",
  "warningSoft",
  "overlayBackdrop",
]);
const sizeSlots = new Set<Slot>([
  "baseFontSize",
  "smallFontSize",
  "extraSmallFontSize",
  "largeFontSize",
  "extraLargeFontSize",
  "unit",
  "small",
  "medium",
  "controlPaddingInline",
  "controlPaddingBlock",
  "smallRadius",
  "mediumRadius",
  "largeRadius",
]);
const themeKeys = new Set<string>([
  "mode",
  ...colorSlots,
  ...sizeSlots,
  "bodyFontFamily",
  "baseLineHeight",
  "smallShadow",
  "modalLayer",
]);
const rgbColor =
  /^rgba?\(\s*(?:\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0(?:\.\d+)?|1(?:\.0+)?))?|\d{1,3}\s+\d{1,3}\s+\d{1,3}(?:\s*\/\s*(?:0(?:\.\d+)?|1(?:\.0+)?))?)\s*\)$/i;

function acceptedTheme(input: unknown): EmbeddedSurfaceTheme | undefined {
  try {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype ||
      Reflect.ownKeys(input).some((key) => typeof key !== "string" || !themeKeys.has(key))
    )
      return undefined;
    const values = Object.fromEntries(
      [...themeKeys].filter((key) => key !== "mode").map((key) => [key, (input as Record<string, unknown>)[key]]),
    );
    values.pageBackground = valid("pageBackground", values.pageBackground) ? values.pageBackground : "#f7f5f1";
    return {
      mode: (input as { mode?: unknown }).mode === "dark" ? "dark" : "light",
      ...values,
    } as EmbeddedSurfaceTheme;
  } catch {
    return undefined;
  }
}

function valid(slot: Slot, value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /var\s*\(|url\s*\(/i.test(value) ||
    /^(?:nan|[+-]?infinity)$/i.test(value.trim())
  )
    return false;
  const input = value.trim();
  if (colorSlots.has(slot)) {
    return (
      /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(input) ||
      rgbColor.test(input) ||
      /^(?:transparent|currentColor)$/i.test(input)
    );
  }
  if (sizeSlots.has(slot) || slot === "baseLineHeight") {
    const match = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(input);
    return (
      !!match &&
      Number.isFinite(Number(match[1])) &&
      (slot === "baseLineHeight" || slot.endsWith("FontSize") ? Number(match[1]) > 0 : true)
    );
  }
  if (slot === "modalLayer") return /^(?:0|[1-9]\d*)$/.test(input) && Number.isSafeInteger(Number(input));
  if (slot === "bodyFontFamily")
    return (
      /^[\w\s,'"-]+$/.test(input) &&
      !/[;{}]/.test(input) &&
      /^(?:"[^"]*"|'[^']*'|[\w-]+(?:\s+[\w-]+)*)(?:\s*,\s*(?:"[^"]*"|'[^']*'|[\w-]+(?:\s+[\w-]+)*))*$/.test(input)
    );
  if (slot === "smallShadow") {
    const shadow = /^(?:0|\d+(?:\.\d+)?(?:px|rem))(?:\s+(?:0|\d+(?:\.\d+)?(?:px|rem))){1,3}\s+(rgba?\([^)]*\))$/i.exec(
      input,
    );
    return /^none$/i.test(input) || (!!shadow && rgbColor.test(shadow[1]!));
  }
  return false;
}

function token(name: Slot, fallback: string, theme?: EmbeddedSurfaceTheme) {
  const value = theme?.[name];
  return valid(name, value) ? value : fallback;
}

function pxToken(name: Slot, fallbackRem: string, theme?: EmbeddedSurfaceTheme) {
  const value = token(name, fallbackRem, theme);
  const remMatch = value.match(/^(\d+(?:\.\d+)?)rem$/);

  if (!remMatch) {
    return value;
  }

  return `${Number.parseFloat(remMatch[1] ?? "0") * 16}px`;
}

export function createStripeElementsAppearance({
  includeRules = true,
  theme,
}: StripeElementsAppearanceOptions = {}): StripeElementsAppearance {
  theme = acceptedTheme(theme);
  const primary = token("accent", "#4845c6", theme);
  const background = token("surface", "#ffffff", theme);
  const surface = token("subtleSurface", "#f7f5f1", theme);
  const text = token("text", "#211d33", theme);
  const secondaryText = token("secondaryText", "#4d4763", theme);

  const border = token("border", "#e6e2d9", theme);
  const focus = token("focusRing", "#5b58d6", theme);
  const danger = token("danger", "#b91c1c", theme);
  const success = token("success", "#15803d", theme);
  const warning = token("warning", "#b45309", theme);
  const radius = token("mediumRadius", "0.5rem", theme);

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
      fontFamily: token("bodyFontFamily", '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif', theme),
      fontLineHeight: token("baseLineHeight", "1.5rem", theme),
      fontSizeBase: token("baseFontSize", "1rem", theme),
      fontSizeSm: token("smallFontSize", "0.875rem", theme),
      fontWeightMedium: "600",
      fontWeightNormal: "400",
      spacingGridColumn: token("medium", "0.75rem", theme),
      spacingGridRow: token("medium", "0.75rem", theme),
      spacingUnit: token("unit", "0.25rem", theme),
    },
    ...(includeRules
      ? {
          rules: {
            ".Block": {
              backgroundColor: surface,
              border: `1px solid ${border}`,
              boxShadow: token("smallShadow", "0 1px 2px rgba(33, 29, 51, 0.07)", theme),
            },
            ".Input": {
              backgroundColor: surface,
              border: `1px solid ${border}`,
              boxShadow: "none",
              color: text,
              padding: `${token("controlPaddingBlock", "0.625rem", theme)} ${token("controlPaddingInline", "1rem", theme)}`,
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

export function createStripeConnectAppearance({ theme }: StripeAppearanceOptions = {}): StripeConnectAppearance {
  theme = acceptedTheme(theme);
  const background = token("surface", "#ffffff", theme);
  const surface = token("subtleSurface", "#f7f5f1", theme);
  const text = token("text", "#211d33", theme);
  const secondaryText = token("secondaryText", "#4d4763", theme);
  const border = token("border", "#e6e2d9", theme);
  const primary = token("accent", "#4845c6", theme);
  const danger = token("danger", "#b91c1c", theme);

  return {
    overlays: "dialog",
    variables: {
      actionPrimaryColorText: primary,
      actionPrimaryTextDecorationColor: primary,
      actionPrimaryTextDecorationLine: "none",
      actionSecondaryColorText: secondaryText,
      actionSecondaryTextDecorationColor: secondaryText,
      badgeBorderRadius: pxToken("smallRadius", "0.375rem", theme),
      badgeDangerColorBackground: token("dangerSoft", "#fee2e2", theme),
      badgeDangerColorBorder: token("dangerSoft", "#fee2e2", theme),
      badgeDangerColorText: danger,
      badgeLabelFontSize: pxToken("extraSmallFontSize", "0.75rem", theme),
      badgeNeutralColorBackground: surface,
      badgeNeutralColorBorder: border,
      badgeNeutralColorText: secondaryText,
      badgeSuccessColorBackground: token("successSoft", "#dcfce7", theme),
      badgeSuccessColorBorder: token("successSoft", "#dcfce7", theme),
      badgeSuccessColorText: token("success", "#15803d", theme),
      badgeWarningColorBackground: token("warningSoft", "#fef3c7", theme),
      badgeWarningColorBorder: token("warningSoft", "#fef3c7", theme),
      badgeWarningColorText: token("warning", "#b45309", theme),
      bodyMdFontSize: pxToken("baseFontSize", "1rem", theme),
      bodySmFontSize: pxToken("smallFontSize", "0.875rem", theme),
      borderRadius: pxToken("mediumRadius", "0.5rem", theme),
      buttonBorderRadius: pxToken("mediumRadius", "0.5rem", theme),
      buttonLabelFontSize: pxToken("smallFontSize", "0.875rem", theme),
      buttonLabelFontWeight: "600",
      buttonLabelTextTransform: "none",
      buttonPaddingX: pxToken("controlPaddingInline", "1rem", theme),
      buttonPaddingY: pxToken("controlPaddingBlock", "0.625rem", theme),
      buttonPrimaryColorBackground: primary,
      buttonPrimaryColorBorder: primary,
      buttonPrimaryColorText: token("onAccent", "#ffffff", theme),
      buttonSecondaryColorBackground: surface,
      buttonSecondaryColorBorder: border,
      buttonSecondaryColorText: text,
      colorBackground: background,
      colorBorder: border,
      colorDanger: danger,
      colorPrimary: primary,
      colorSecondaryText: secondaryText,
      colorText: text,
      fontFamily: token("bodyFontFamily", '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif', theme),
      fontSizeBase: pxToken("baseFontSize", "1rem", theme),
      formAccentColor: primary,
      formBackgroundColor: surface,
      formBorderRadius: pxToken("mediumRadius", "0.5rem", theme),
      formHighlightColorBorder: token("focusRing", "#5b58d6", theme),
      formPlaceholderTextColor: secondaryText,
      headingLgFontSize: pxToken("extraLargeFontSize", "1.25rem", theme),
      headingLgFontWeight: "700",
      headingLgTextTransform: "none",
      headingMdFontSize: pxToken("largeFontSize", "1.125rem", theme),
      headingMdFontWeight: "700",
      headingMdTextTransform: "none",
      headingSmFontSize: pxToken("baseFontSize", "1rem", theme),
      headingSmFontWeight: "600",
      headingSmTextTransform: "none",
      inputFieldPaddingX: pxToken("controlPaddingInline", "1rem", theme),
      inputFieldPaddingY: pxToken("controlPaddingBlock", "0.625rem", theme),
      labelMdFontSize: pxToken("smallFontSize", "0.875rem", theme),
      labelMdFontWeight: "600",
      labelMdTextTransform: "none",
      offsetBackgroundColor: surface,
      overlayBackdropColor: token("overlayBackdrop", "rgba(33, 29, 51, 0.35)", theme),
      overlayBorderRadius: pxToken("largeRadius", "0.75rem", theme),
      overlayZIndex: Number.parseInt(token("modalLayer", "60", theme), 10),
      spacingUnit: pxToken("small", "0.5rem", theme),
      tableRowPaddingY: pxToken("medium", "0.75rem", theme),
    },
  };
}
