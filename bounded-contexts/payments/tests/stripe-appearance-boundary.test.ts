import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./stripe-appearance-support";

const root = repositoryRoot();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const callers = [
  "bounded-contexts/payments/features/payments/ui/account-payment/stripe-confirmation-card.tsx",
  "bounded-contexts/payments/features/payments/ui/account-payment/stripe-setup-card.tsx",
  "bounded-contexts/settlement/features/payout-readiness/ui/payout-setup-page.tsx",
  "bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-notification-banner.tsx",
];
const specs = [
  "deployables/marketplace/e2e/account-payment-stripe-embed.uat.spec.ts",
  "deployables/marketplace/e2e/payout-connect-appearance.uat.spec.ts",
];
const adapter = "infrastructure/stripe-appearance/stripe-appearance.ts";
const resolver = "packages/design-system/src/theme/embedded-surface-theme.ts";
const contract = "contracts/embedded-surface-theme/index.ts";

function forbiddenImports(path: string, source: string): string[] {
  const imports = [...source.matchAll(/\b(?:from\s*|import\s*)["']([^"']+)["']/g)].map((match) => match[1]!);
  const designSystem = (value: string) =>
    value.startsWith("@chase-sets/design-system") || /(?:^|\/)packages\/design-system(?:\/|$)/.test(value);
  const appearance = (value: string) =>
    value.startsWith("@chase-sets/stripe-appearance") ||
    /(?:^|\/)infrastructure\/stripe-appearance(?:\/|$)/.test(value);
  if (path.startsWith("infrastructure/stripe-appearance/"))
    return imports.filter((value) => designSystem(value) || /(?:^|\/)packages\//.test(value));
  if (path.startsWith("packages/design-system/")) return imports.filter(appearance);
  if (path.startsWith("contracts/embedded-surface-theme/")) return imports;
  return [];
}

describe("browser-only embedded theme import boundary", () => {
  it("composes both layers in four callers, with a pure shared contract", () => {
    for (const path of callers) {
      const source = read(path);
      expect(source).toContain('from "@chase-sets/stripe-appearance"');
      expect(source).toContain('from "@chase-sets/design-system"');
      expect(source).toContain("resolveEmbeddedSurfaceTheme({ scope:");
      expect(source).toContain("observeEmbeddedSurfaceTheme(");
      expect(source).toContain("embeddedSurfaceThemeSnapshot(");
      expect(source).not.toContain("observeStripeAppearance(");
    }
    for (const path of specs) expect(read(path)).toContain('from "./support/stripe-appearance-evidence-source"');
    expect(read(adapter)).toContain('from "@chase-sets/embedded-surface-theme"');
    expect(read(resolver)).toContain('from "@chase-sets/embedded-surface-theme"');
    expect(forbiddenImports(adapter, read(adapter))).toEqual([]);
    expect(forbiddenImports(resolver, read(resolver))).toEqual([]);
    expect(forbiddenImports(contract, read(contract))).toEqual([]);
    expect(read(contract)).not.toMatch(/\b(?:document|Element|CSS|Stripe|Record<string|function)\b/);
    expect(JSON.parse(read("packages/design-system/package.json")).exports).not.toHaveProperty(
      "./theme/stripe-appearance",
    );
    expect(JSON.parse(read("infrastructure/stripe-appearance/package.json")).exports).toEqual({
      ".": "./stripe-appearance.ts",
    });
    expect(read("packages/design-system/src/index.ts")).not.toContain("theme/stripe-appearance");
    expect(read(adapter)).not.toMatch(/from "node:|@stripe\/stripe-node/);
  });

  it("rejects bare, subpath, type-only and relative package imports in adapter and tests", () => {
    for (const path of [adapter, "infrastructure/stripe-appearance/stripe-appearance.test.ts"]) {
      for (const specifier of [
        "@chase-sets/design-system",
        "@chase-sets/design-system/theme/provider",
        "../../packages/design-system/src/theme/embedded-surface-theme",
      ]) {
        expect(forbiddenImports(path, `import type { X } from "${specifier}";`)).toEqual([specifier]);
        expect(forbiddenImports(path, `import { X } from "${specifier}";`)).toEqual([specifier]);
      }
      expect(
        forbiddenImports(path, 'import type { EmbeddedSurfaceTheme } from "@chase-sets/embedded-surface-theme";'),
      ).toEqual([]);
    }
    expect(
      forbiddenImports(
        resolver,
        'import type { X } from "../../../infrastructure/stripe-appearance/stripe-appearance";',
      ),
    ).toHaveLength(1);
    expect(forbiddenImports(contract, 'import { X } from "@chase-sets/design-system";')).toHaveLength(1);
  });
});
