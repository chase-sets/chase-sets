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
      "--dark-background": "#020617",
      "--dark-foreground": "#f8fafc",
      "--dark-card": "#0f172a",
      "--dark-primary": "#5b8ef4",
      "--dark-primary-foreground": "#061329",
      "--dark-ring": "#93c5fd",
      "--dark-surface-2": "#0b1220",
      "--dark-text-secondary": "#cbd5e1",
      "--dark-text-muted": "#94a3b8",
      "--dark-border": "#334155",
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
    expect(appearance.variables.colorPrimary).toBe("#1d5fd6");
    expect(appearance.variables.colorText).toBe("#0f172a");
    expect(appearance.variables.colorBackground).toBe("#ffffff");
    expect(appearance.variables.borderRadius).toBe("0.5rem");
    expect(appearance.rules?.[".Input"]?.backgroundColor).toBe("#f8fafc");
    expect(appearance.rules?.[".Tab--selected"]?.border).toBe("1px solid #1d5fd6");

    root.remove();
  });

  it("renders placeholder text in the secondary ink role, which clears 4.5:1 where the muted role does not", () => {
    const root = themedScope("light");
    const appearance = createStripeElementsAppearance({ scope: root });

    // --text-muted is a 3:1-class anchor. Placeholder text is normal-size text,
    // so it reads from the secondary role instead; token-contrast.test.ts
    // computes the ratios that make this binding mandatory.
    expect(appearance.variables.colorTextPlaceholder).toBe(appearance.variables.colorTextSecondary);
    expect(appearance.variables.colorTextPlaceholder).toBe("#334155");
    expect(appearance.variables.colorTextPlaceholder).not.toBe("#64748b");

    root.remove();
  });

  it("can omit rules for Stripe surfaces that only accept variables", () => {
    const appearance = createStripeElementsAppearance({ includeRules: false });

    expect(appearance.variables.colorPrimary).toBe("#1d5fd6");
    expect(appearance.rules).toBeUndefined();
  });

  it("resolves dark-mode scoped variables for embedded provider components", () => {
    const root = themedScope("dark");
    const child = document.createElement("div");
    root.appendChild(child);

    const appearance = createStripeConnectAppearance({ scope: child });

    expect(appearance.overlays).toBe("dialog");
    expect(appearance.variables.colorPrimary).toBe("#5b8ef4");
    expect(appearance.variables.colorText).toBe("#f8fafc");
    expect(appearance.variables.colorBackground).toBe("#0f172a");
    expect(appearance.variables.formBackgroundColor).toBe("#0b1220");
    expect(appearance.variables.buttonLabelTextTransform).toBe("none");

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
