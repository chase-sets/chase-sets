import { resolveThemeTokenValue } from "./internal-token-values";
import type { EmbeddedSurfaceTheme } from "@chase-sets/embedded-surface-theme";

// The closed CSS input map for embedded surfaces. Provider translation belongs to an adapter.
const embeddedSurfaceThemeCssInputs = {
  pageBackground: "--background",
  surface: "--card",
  subtleSurface: "--surface-2",
  text: "--foreground",
  secondaryText: "--text-secondary",
  mutedText: "--text-muted",
  border: "--border",
  accent: "--primary",
  onAccent: "--primary-foreground",
  focusRing: "--ring",
  danger: "--destructive",
  dangerSoft: "--danger-soft",
  success: "--success",
  successSoft: "--success-soft",
  warning: "--warning",
  warningSoft: "--warning-soft",
  overlayBackdrop: "--overlay",
  bodyFontFamily: "--body-font",
  baseLineHeight: "--line-height-base",
  baseFontSize: "--font-size-base",
  smallFontSize: "--font-size-sm",
  extraSmallFontSize: "--font-size-xs",
  largeFontSize: "--font-size-lg",
  extraLargeFontSize: "--font-size-xl",
  unit: "--space-unit",
  small: "--space-2",
  medium: "--space-3",
  controlPaddingInline: "--control-md-px",
  controlPaddingBlock: "--control-md-py",
  smallRadius: "--radius-sm",
  mediumRadius: "--radius",
  largeRadius: "--radius-lg",
  smallShadow: "--shadow-sm",
  modalLayer: "--z-modal",
} as const;

type ExactSlots = Exclude<keyof EmbeddedSurfaceTheme, "mode">;
const _allSlots: Record<ExactSlots, string> = embeddedSurfaceThemeCssInputs;
const _noExtra: Exclude<keyof typeof embeddedSurfaceThemeCssInputs, ExactSlots> extends never ? true : never = true;
void _allSlots;
void _noExtra;

export type EmbeddedSurfaceThemeOptions = Readonly<{ scope?: Element | null }>;

function themeScope(scope?: Element | null) {
  if (typeof document === "undefined") return null;
  return scope?.closest?.("[data-chase-theme], [data-chase-theme-scope]") ?? scope ?? document.documentElement;
}

export function resolveEmbeddedSurfaceTheme({ scope = null }: EmbeddedSurfaceThemeOptions = {}): EmbeddedSurfaceTheme {
  const root = themeScope(scope);
  const mode = root?.getAttribute("data-color-mode");
  const values = Object.fromEntries(
    Object.entries(embeddedSurfaceThemeCssInputs).map(([slot, name]) => [
      slot,
      resolveThemeTokenValue(`var(${name})`, root) ?? "",
    ]),
  ) as { [Slot in keyof typeof embeddedSurfaceThemeCssInputs]: string };
  return { mode: mode === "dark" ? "dark" : "light", ...values };
}

export function embeddedSurfaceThemeSnapshot(options: EmbeddedSurfaceThemeOptions = {}): string {
  const theme = resolveEmbeddedSurfaceTheme(options);
  return [
    theme.mode,
    ...Object.keys(embeddedSurfaceThemeCssInputs).map(
      (slot) => theme[slot as keyof typeof embeddedSurfaceThemeCssInputs],
    ),
  ].join("|");
}

export function observeEmbeddedSurfaceTheme({ scope = null }: EmbeddedSurfaceThemeOptions, onChange: () => void) {
  const root = themeScope(scope);
  if (!root || typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(root, {
    attributeFilter: ["class", "data-color-mode", "data-theme", "style"],
    attributes: true,
  });
  return () => observer.disconnect();
}
