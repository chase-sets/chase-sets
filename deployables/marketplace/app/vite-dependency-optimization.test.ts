import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@react-router/dev/vite", () => ({ reactRouter: () => [] }));
vi.mock("@tailwindcss/vite", () => ({ default: () => [] }));

const capturedOptimizerDependencyIds = [
  "ulid",
  "pg",
  "hono/client",
  "lucide-react",
  "motion/react",
  "@base-ui/react/accordion",
  "@base-ui/react/alert-dialog",
  "@base-ui/react/autocomplete",
  "@base-ui/react/combobox",
  "@base-ui/react/dialog",
  "@base-ui/react/field",
  "@base-ui/react/fieldset",
  "@base-ui/react/menu",
  "@base-ui/react/navigation-menu",
  "@base-ui/react/number-field",
  "@base-ui/react/popover",
  "@base-ui/react/radio-group",
  "@base-ui/react/radio",
  "@base-ui/react/scroll-area",
  "@base-ui/react/select",
  "@base-ui/react/separator",
  "@base-ui/react/slider",
  "@base-ui/react/switch",
  "@base-ui/react/tabs",
  "@base-ui/react/toast",
  "@base-ui/react/toggle-group",
  "@base-ui/react/toggle",
  "@base-ui/react/toolbar",
  "@base-ui/react/tooltip",
] as const;

function linkedOptimizerIdentity(dependencyId: string, ownerPackage: string) {
  return `${ownerPackage} > ${dependencyId}`;
}

const settledOptimizerIncludes = [
  "ulid",
  "pg",
  linkedOptimizerIdentity("hono/client", "@chase-sets/marketplace"),
  linkedOptimizerIdentity("lucide-react", "@chase-sets/design-system"),
  linkedOptimizerIdentity("motion/react", "@chase-sets/design-system"),
  ...capturedOptimizerDependencyIds
    .filter((dependencyId) => dependencyId.startsWith("@base-ui/react/"))
    .map((dependencyId) => linkedOptimizerIdentity(dependencyId, "@chase-sets/design-system")),
];

describe("Marketplace Vite dependency optimization", () => {
  it("covers every dependency from the retained post-readiness optimizer sequence", async () => {
    const { default: viteConfig } = await import("../vite.config");
    const configuredIncludes = viteConfig.optimizeDeps?.include ?? [];

    expect(viteConfig.optimizeDeps?.noDiscovery).not.toBe(true);
    expect(configuredIncludes).toEqual(settledOptimizerIncludes);
    expect(configuredIncludes.map((identity) => identity.split(" > ").at(-1))).toEqual(capturedOptimizerDependencyIds);
  });

  it("resolves every optimizer include from its declared owner basedir", async () => {
    const { default: viteConfig } = await import("../vite.config");
    const marketplaceRequire = createRequire(resolve(__dirname, "../package.json"));

    for (const identity of viteConfig.optimizeDeps?.include ?? []) {
      let requireFromOwner = marketplaceRequire;
      let resolvedDependency = "";
      for (const dependencyId of identity.split(" > ")) {
        resolvedDependency = requireFromOwner.resolve(dependencyId);
        requireFromOwner = createRequire(resolvedDependency);
      }
      expect(existsSync(resolvedDependency), `${identity} -> ${resolvedDependency}`).toBe(true);
    }
  });
});
