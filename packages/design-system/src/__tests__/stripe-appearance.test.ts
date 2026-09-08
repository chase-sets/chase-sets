import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cssValues, fixture, repositoryRoot, sha256 } from "./token-contract";
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
    expect(appearance.variables.colorPrimary).toBe("#4845c6");
    expect(appearance.variables.colorText).toBe("#211d33");
    expect(appearance.variables.colorBackground).toBe("#ffffff");
    expect(appearance.variables.borderRadius).toBe("0.5rem");
    expect(appearance.rules?.[".Input"]?.backgroundColor).toBe("#f7f5f1");
    expect(appearance.rules?.[".Tab--selected"]?.border).toBe("1px solid #4845c6");

    root.remove();
  });

  it("renders placeholder text in the secondary ink role, which clears 4.5:1 where the muted role does not", () => {
    const root = themedScope("light");
    const appearance = createStripeElementsAppearance({ scope: root });

    // --text-muted is a 3:1-class anchor. Placeholder text is normal-size text,
    // so it reads from the secondary role instead; token-contrast.test.ts
    // computes the ratios that make this binding mandatory.
    expect(appearance.variables.colorTextPlaceholder).toBe(appearance.variables.colorTextSecondary);
    expect(appearance.variables.colorTextPlaceholder).toBe("#4d4763");
    expect(appearance.variables.colorTextPlaceholder).not.toBe("#7d7791");

    root.remove();
  });

  it("can omit rules for Stripe surfaces that only accept variables", () => {
    const appearance = createStripeElementsAppearance({ includeRules: false });

    expect(appearance.variables.colorPrimary).toBe("#4845c6");
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
    expect(appearance.variables.formPlaceholderTextColor).toBe(appearance.variables.colorSecondaryText);
    expect(appearance.variables.formPlaceholderTextColor).toBe("#cbd5e1");
    expect(appearance.variables.formPlaceholderTextColor).not.toBe("#94a3b8");
    expect(appearance.variables.buttonLabelTextTransform).toBe("none");

    root.remove();
  });

  it("binds the light Connect placeholder to secondary ink rather than the muted role", () => {
    const root = themedScope("light");
    const child = document.createElement("div");
    root.appendChild(child);

    const appearance = createStripeConnectAppearance({ scope: child });

    expect(appearance.variables.formPlaceholderTextColor).toBe(appearance.variables.colorSecondaryText);
    expect(appearance.variables.formPlaceholderTextColor).toBe("#4d4763");
    expect(appearance.variables.formPlaceholderTextColor).not.toBe("#7d7791");

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

const factorySource = readFileSync(
  join(repositoryRoot(), "packages/design-system/src/theme/stripe-appearance.ts"),
  "utf8",
);
const fallbackPattern = /((?:token|pxToken)\("(--[\w-]+)", )("[^"\n]*"|'[^'\n]*')(, scope\))/g;

function fallbackInventory(source: string) {
  return source
    .split(/export function createStripe/)
    .slice(1)
    .flatMap((factory) =>
      [...factory.matchAll(fallbackPattern)].map((match) => ({
        factory: factory.startsWith("Elements") ? "Elements" : "Connect",
        binding: match[1]!.startsWith("pxToken") ? "pxToken" : "token",
        property: match[2]!,
        fallback: match[3]!.slice(1, -1),
      })),
    );
}

function fallbackFailures(source: string) {
  return fallbackInventory(source).flatMap((entry) => {
    const candidate = (fixture.light as Record<string, { candidate: string }>)[entry.property]!.candidate;
    return entry.fallback === candidate
      ? []
      : [`${entry.factory}/${entry.property}: ${entry.fallback} != ${candidate}`];
  });
}

function bindingStructure(source: string) {
  return source.replace(fallbackPattern, '$1"<fallback>"$4');
}

describe("complete Stripe factory cutover contract", () => {
  it("preserves all factory output fields, token/pxToken bindings and non-fallback source", () => {
    expect(sha256(bindingStructure(factorySource))).toBe(
      "d197d17d5f8c258ea8aa7a4390b5b0e1ebf44b6b9660c223f7f87a7abd44aeb6",
    );
    expect(fallbackInventory(factorySource)).toHaveLength(62);
    console.log(`factory binding/fallback inventory: ${JSON.stringify(fallbackInventory(factorySource))}`);
  });

  it("transcribes every fallback in both factories from the independent light candidate", () => {
    expect(fallbackFailures(factorySource)).toEqual([]);
  });

  it.each(["Elements", "Connect"])("rejects a stale %s fallback", (factory) => {
    const split = factorySource.indexOf(`export function createStripe${factory}`);
    const mutant = factorySource.slice(0, split) + factorySource.slice(split).replace('"#4845c6"', '"#1d5fd6"');
    expect(mutant).not.toBe(factorySource);
    expect(fallbackFailures(mutant)).toEqual([`${factory}/--primary: #1d5fd6 != #4845c6`]);
    expect(sha256(bindingStructure(mutant))).toBe(sha256(bindingStructure(factorySource)));
  });

  it.each(["Elements", "Connect"])("rejects leaving the entire %s factory on shipped values", (factory) => {
    const start = factorySource.indexOf(`export function createStripe${factory}`);
    const next = factorySource.indexOf("export function createStripe", start + 1);
    const end = next < 0 ? factorySource.length : next;
    const unchangedFactory = factorySource
      .slice(start, end)
      .replace(fallbackPattern, (_match, prefix: string, property: string, quoted: string, suffix: string) => {
        const shipped = (fixture.light as Record<string, { shipped: string }>)[property]!.shipped;
        return `${prefix}${quoted[0]}${shipped}${quoted[0]}${suffix}`;
      });
    const mutant = factorySource.slice(0, start) + unchangedFactory + factorySource.slice(end);
    const failures = fallbackFailures(mutant);
    expect(failures.length).toBeGreaterThan(1);
    expect(failures.every((failure) => failure.startsWith(`${factory}/`))).toBe(true);
    expect(sha256(bindingStructure(mutant))).toBe(sha256(bindingStructure(factorySource)));
  });

  it("rejects an equal-valued token rebound while fallback equality stays green", () => {
    const mutant = factorySource.replace('token("--primary",', 'token("--accent",');
    expect(mutant).not.toBe(factorySource);
    expect(fallbackFailures(mutant)).toEqual([]);
    expect(sha256(bindingStructure(mutant))).not.toBe(sha256(bindingStructure(factorySource)));
  });

  it.each(["light", "dark"] as const)("resolves every factory field from actual %s stylesheet values", (mode) => {
    const root = document.createElement("div");
    root.dataset.chaseTheme = "";
    root.dataset.colorMode = mode;
    const actual = cssValues(mode);
    document.body.append(root);
    try {
      for (const [name, value] of Object.entries(actual)) root.style.setProperty(name, value);
      const observed = [
        createStripeElementsAppearance({ scope: root }),
        createStripeConnectAppearance({ scope: root }),
      ];
      for (const [name, entry] of Object.entries(fixture[mode])) root.style.setProperty(name, entry.candidate);
      const expected = [
        createStripeElementsAppearance({ scope: root }),
        createStripeConnectAppearance({ scope: root }),
      ];
      expect(observed).toEqual(expected);
      console.log(`actual CSS factory outputs (${mode}): ${JSON.stringify(observed)}`);
    } finally {
      root.remove();
    }
  });
});
