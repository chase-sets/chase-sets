import { describe, expect, it } from "vitest";
import type { EmbeddedSurfaceTheme } from "@chase-sets/embedded-surface-theme";
import { createStripeConnectAppearance, createStripeElementsAppearance } from "./stripe-appearance";

const theme: EmbeddedSurfaceTheme = {
  mode: "light",
  pageBackground: "#f7f5f1",
  surface: "#ffffff",
  subtleSurface: "#f7f5f1",
  text: "#211d33",
  secondaryText: "#4d4763",
  mutedText: "#7d7791",
  border: "#e6e2d9",
  accent: "#4845c6",
  onAccent: "#ffffff",
  focusRing: "#5b58d6",
  danger: "#b91c1c",
  dangerSoft: "#fee2e2",
  success: "#15803d",
  successSoft: "#dcfce7",
  warning: "#b45309",
  warningSoft: "#fef3c7",
  overlayBackdrop: "rgba(0, 0, 0, 0.5)",
  bodyFontFamily: "sans-serif",
  baseLineHeight: "1.5rem",
  baseFontSize: "1rem",
  smallFontSize: "0.875rem",
  extraSmallFontSize: "0.75rem",
  largeFontSize: "1.125rem",
  extraLargeFontSize: "1.25rem",
  unit: "0.25rem",
  small: "0.5rem",
  medium: "0.75rem",
  controlPaddingInline: "1rem",
  controlPaddingBlock: "0.625rem",
  smallRadius: "0.25rem",
  mediumRadius: "0.5rem",
  largeRadius: "0.75rem",
  smallShadow: "0 1px 2px rgba(33, 29, 51, 0.07)",
  modalLayer: "50",
};

describe("pure browser adapter", () => {
  it("translates a closed theme without a DOM or design-system dependency", () => {
    expect(createStripeElementsAppearance({ theme }).variables.colorPrimary).toBe(theme.accent);
    expect(createStripeConnectAppearance({ theme }).variables.colorPrimary).toBe(theme.accent);
    expect(createStripeElementsAppearance({ theme, includeRules: false }).rules).toBeUndefined();
  });

  it("substitutes invalid input without throwing or leaking the value", () => {
    const malformed = { ...theme, accent: "url(https://example.invalid/a)" };
    expect(createStripeElementsAppearance({ theme: malformed }).variables.colorPrimary).toBe("#4845c6");
    expect(createStripeConnectAppearance({ theme: malformed }).variables.colorPrimary).toBe("#4845c6");
  });
});
