import { describe, expect, it, vi } from "vitest";
import {
  createStripeConnectAppearance,
  createStripeElementsAppearance,
  observeStripeAppearance,
  stripeAppearanceSnapshot,
} from "../theme/stripe-appearance";

function themedScope(colorMode: "light" | "dark" = "light") {
  const root = document.createElement("div");
  root.dataset.chaseTheme = "";
  root.dataset.colorMode = colorMode;

  if (colorMode === "dark") {
    const variables = {
      "--dark-background": "#0e0c15",
      "--dark-foreground": "#f2effa",
      "--dark-card": "#1a1626",
      "--dark-primary": "#8a97ff",
      "--dark-primary-foreground": "#14102a",
      "--dark-ring": "#b8c1ff",
      "--dark-surface-2": "#14111c",
      "--dark-text-secondary": "#b6b0c9",
      "--dark-text-muted": "#857e9c",
      // The ratified dark border is an alpha ink hairline, so the value this repository
      // hands to Stripe is an rgba() string rather than a hex. Its acceptance by the
      // provider is settled by the AC-08 test-mode probe, not by this fixture.
      "--dark-border": "rgba(242, 239, 250, 0.08)",
      "--dark-danger": "#f87171",
      "--dark-danger-soft": "#450a0a",
      "--dark-success": "#4ade80",
      "--dark-success-soft": "#052e16",
      "--dark-warning": "#facc15",
      "--dark-warning-soft": "#422006",
      "--foreground": "var(--dark-foreground)",
      "--card": "var(--dark-card)",
      "--primary": "var(--dark-primary)",
      "--primary-foreground": "var(--dark-primary-foreground)",
      "--ring": "var(--dark-ring)",
      "--surface-2": "var(--dark-surface-2)",
      "--text-secondary": "var(--dark-text-secondary)",
      "--text-muted": "var(--dark-text-muted)",
      "--border": "var(--dark-border)",
      "--destructive": "var(--dark-danger)",
      "--danger-soft": "var(--dark-danger-soft)",
      "--success": "var(--dark-success)",
      "--success-soft": "var(--dark-success-soft)",
      "--warning": "var(--dark-warning)",
      "--warning-soft": "var(--dark-warning-soft)",
    };

    for (const [name, value] of Object.entries(variables)) {
      root.style.setProperty(name, value);
    }
  }

  document.body.appendChild(root);
  return root;
}

describe("Stripe appearance helpers", () => {
  it("maps Chase Sets design tokens into Stripe Elements appearance variables and rules", () => {
    const root = themedScope("light");
    const appearance = createStripeElementsAppearance({ scope: root });

    expect(appearance.theme).toBe("flat");
    expect(appearance.variables.colorPrimary).toBe("#4845c6");
    expect(appearance.variables.colorText).toBe("#211d33");
    expect(appearance.variables.colorBackground).toBe("#ffffff");
    expect(appearance.variables.borderRadius).toBe("0.5rem");
    expect(appearance.rules?.[".Input"]?.backgroundColor).toBe("#f7f5f1");
    expect(appearance.rules?.[".Tab--selected"]?.border).toBe("1px solid #4845c6");

    root.remove();
  });

  it("can omit rules for Stripe surfaces that only accept variables", () => {
    const appearance = createStripeElementsAppearance({ includeRules: false });

    expect(appearance.variables.colorPrimary).toBe("#4845c6");
    expect(appearance.rules).toBeUndefined();
  });

  // The fallback path is the one taken when no token resolves. It shipped the
  // superseded palette before Ink & Foil, which is invisible in any run where the
  // tokens do resolve.
  it("carries the Ink & Foil palette on the unresolved-token fallback path", () => {
    const appearance = createStripeElementsAppearance();

    expect(appearance.variables.colorPrimary).toBe("#4845c6");
    expect(appearance.variables.colorText).toBe("#211d33");
    expect(appearance.variables.colorTextSecondary).toBe("#4d4763");
    expect(appearance.variables.colorTextPlaceholder).toBe("#7d7791");
    expect(appearance.rules?.[".Block"]?.backgroundColor).toBe("#f7f5f1");
    expect(appearance.rules?.[".Block"]?.border).toBe("1px solid #e6e2d9");
    expect(appearance.rules?.[".Input:focus"]?.border).toBe("1px solid #5b58d6");

    const connect = createStripeConnectAppearance();
    expect(connect.variables.colorPrimary).toBe("#4845c6");
    expect(connect.variables.colorBorder).toBe("#e6e2d9");
    expect(connect.variables.formHighlightColorBorder).toBe("#5b58d6");
    expect(connect.variables.overlayBackdropColor).toBe("rgba(33, 29, 51, 0.35)");
  });

  it("resolves dark-mode scoped variables for embedded provider components", () => {
    const root = themedScope("dark");
    const child = document.createElement("div");
    root.appendChild(child);

    const appearance = createStripeConnectAppearance({ scope: child });

    expect(appearance.overlays).toBe("dialog");
    expect(appearance.variables.colorPrimary).toBe("#8a97ff");
    expect(appearance.variables.colorText).toBe("#f2effa");
    expect(appearance.variables.colorBackground).toBe("#1a1626");
    expect(appearance.variables.formBackgroundColor).toBe("#14111c");
    expect(appearance.variables.buttonLabelTextTransform).toBe("none");
    // The exact string handed to the provider for the alpha ink hairline.
    expect(appearance.variables.colorBorder).toBe("rgba(242, 239, 250, 0.08)");
    expect(appearance.variables.badgeNeutralColorBorder).toBe("rgba(242, 239, 250, 0.08)");

    root.remove();
  });

  it("creates scoped snapshots and observes theme changes", () => {
    const root = themedScope("light");
    const child = document.createElement("div");
    root.appendChild(child);
    const onChange = vi.fn();
    const disconnect = observeStripeAppearance({ scope: child }, onChange);
    const lightSnapshot = stripeAppearanceSnapshot({ scope: child });

    root.dataset.colorMode = "dark";
    const darkSnapshot = stripeAppearanceSnapshot({ scope: child });

    expect(lightSnapshot).not.toBe(darkSnapshot);
    expect(onChange).not.toHaveBeenCalled();

    disconnect();
    root.remove();
  });
});
