import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findServerBarrelReactFreeViolations,
  resolveExportsSubpath,
  validateServerBarrelReactFree,
} from "./server-barrel-react-free.mjs";

const tempRoots = [];

function createRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "cs-server-barrel-react-free-"));
  tempRoots.push(root);
  return root;
}

function writeSource(root, relativeFile, content) {
  const absolute = path.join(root, relativeFile);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${content.trim()}\n`, "utf8");
}

function writePackageJson(root, relativeDir, packageJson) {
  writeSource(root, `${relativeDir}/package.json`, JSON.stringify(packageJson, null, 2));
}

function writeDesignSystemPackage(root) {
  writePackageJson(root, "packages/design-system", {
    name: "@chase-sets/design-system",
    exports: { ".": "./src/index.ts" },
  });
  writeSource(root, "packages/design-system/src/index.ts", `export { Button } from "./button";`);
  writeSource(root, "packages/design-system/src/button.tsx", `export function Button() { return null; }`);
}

function contextManifestsFor(entries) {
  return new Map(entries.map((entry) => [entry.root, entry]));
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("findServerBarrelReactFreeViolations", () => {
  it("passes a clean context whose server.ts only re-exports plain values and types", async () => {
    const root = createRepo();
    writePackageJson(root, "bounded-contexts/widgets", {
      name: "@chase-sets/widgets",
      exports: { ".": "./index.ts", "./server": "./server.ts" },
    });
    writeSource(root, "bounded-contexts/widgets/context.json", `{}`);
    writeSource(
      root,
      "bounded-contexts/widgets/server.ts",
      `
        export type { WidgetSummary } from "./features/widgets/api/contracts";
        export { createWidgetRequestApiClient } from "./support/request-support/api-client";
      `,
    );
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/api/contracts.ts",
      `export type WidgetSummary = { id: string };`,
    );
    writeSource(
      root,
      "bounded-contexts/widgets/support/request-support/api-client.ts",
      `export function createWidgetRequestApiClient() { return { list: async () => [] }; }`,
    );
    writeSource(root, "bounded-contexts/widgets/index.ts", `export const module = {};`);

    const violations = await findServerBarrelReactFreeViolations({
      repoRoot: root,
      contextManifests: contextManifestsFor([{ root: "bounded-contexts/widgets", packageName: "@chase-sets/widgets" }]),
    });

    expect(violations).toEqual([]);
  });

  it("flags server.ts when it transitively re-exports a .tsx module (the #4835 regression shape)", async () => {
    const root = createRepo();
    writePackageJson(root, "bounded-contexts/widgets", {
      name: "@chase-sets/widgets",
      exports: { ".": "./index.ts", "./server": "./server.ts", "./web": "./web.ts" },
    });
    writeSource(root, "bounded-contexts/widgets/index.ts", `export const module = {};`);
    // Mirrors the real bug: server.ts re-exports API clients alongside a
    // React prompt component that only became reachable once something in
    // the deployable actually imported the barrel.
    writeSource(
      root,
      "bounded-contexts/widgets/server.ts",
      `
        export { createWidgetRequestApiClient } from "./support/request-support/api-client";
        export { WidgetFeedbackPrompt } from "./features/widgets/ui/widget-feedback-prompt";
      `,
    );
    writeSource(
      root,
      "bounded-contexts/widgets/support/request-support/api-client.ts",
      `export function createWidgetRequestApiClient() { return {}; }`,
    );
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/ui/widget-feedback-prompt.tsx",
      `export function WidgetFeedbackPrompt() { return null; }`,
    );

    const violations = await findServerBarrelReactFreeViolations({
      repoRoot: root,
      contextManifests: contextManifestsFor([{ root: "bounded-contexts/widgets", packageName: "@chase-sets/widgets" }]),
    });

    expect(violations).toEqual([
      expect.objectContaining({
        entryFile: "bounded-contexts/widgets/server.ts",
        type: "tsx-module",
        file: "bounded-contexts/widgets/features/widgets/ui/widget-feedback-prompt.tsx",
        chain: [
          "bounded-contexts/widgets/server.ts",
          "bounded-contexts/widgets/features/widgets/ui/widget-feedback-prompt.tsx",
        ],
      }),
    ]);

    const result = await validateServerBarrelReactFree({
      repoRoot: root,
      contextManifests: contextManifestsFor([{ root: "bounded-contexts/widgets", packageName: "@chase-sets/widgets" }]),
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("reaches React/JSX module");
    expect(result.violations[0]).toContain("widget-feedback-prompt.tsx");
  });

  it("flags server.ts when it transitively imports the design-system package", async () => {
    const root = createRepo();
    writeDesignSystemPackage(root);
    writePackageJson(root, "bounded-contexts/widgets", {
      name: "@chase-sets/widgets",
      exports: { ".": "./index.ts", "./server": "./server.ts" },
    });
    writeSource(root, "bounded-contexts/widgets/index.ts", `export const module = {};`);
    writeSource(
      root,
      "bounded-contexts/widgets/server.ts",
      `export { widgetRateLimitPolicy } from "./support/rate-limit-support";`,
    );
    writeSource(
      root,
      "bounded-contexts/widgets/support/rate-limit-support.ts",
      `
        import { showToast } from "@chase-sets/design-system";
        export function widgetRateLimitPolicy() {
          showToast("noop");
          return { windowMs: 1000 };
        }
      `,
    );

    const violations = await findServerBarrelReactFreeViolations({
      repoRoot: root,
      contextManifests: contextManifestsFor([{ root: "bounded-contexts/widgets", packageName: "@chase-sets/widgets" }]),
    });

    expect(violations).toEqual([
      expect.objectContaining({
        entryFile: "bounded-contexts/widgets/server.ts",
        type: "design-system-import",
        file: "bounded-contexts/widgets/support/rate-limit-support.ts",
        specifier: "@chase-sets/design-system",
      }),
    ]);
  });

  it("does not flag a type-only import of a .tsx module or the design-system package", async () => {
    const root = createRepo();
    writeDesignSystemPackage(root);
    writePackageJson(root, "bounded-contexts/widgets", {
      name: "@chase-sets/widgets",
      exports: { ".": "./index.ts", "./server": "./server.ts" },
    });
    writeSource(root, "bounded-contexts/widgets/index.ts", `export const module = {};`);
    writeSource(
      root,
      "bounded-contexts/widgets/server.ts",
      `
        import type { ButtonProps } from "@chase-sets/design-system";
        import type { WidgetFeedbackPromptProps } from "./features/widgets/ui/widget-feedback-prompt";
        export type { ButtonProps, WidgetFeedbackPromptProps };
        export { createWidgetRequestApiClient } from "./support/request-support/api-client";
      `,
    );
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/ui/widget-feedback-prompt.tsx",
      `export type WidgetFeedbackPromptProps = { title: string };`,
    );
    writeSource(
      root,
      "bounded-contexts/widgets/support/request-support/api-client.ts",
      `export function createWidgetRequestApiClient() { return {}; }`,
    );

    const violations = await findServerBarrelReactFreeViolations({
      repoRoot: root,
      contextManifests: contextManifestsFor([{ root: "bounded-contexts/widgets", packageName: "@chase-sets/widgets" }]),
    });

    expect(violations).toEqual([]);
  });

  it("only checks index.ts when a platform-api/platform-worker deployable value-imports the bare package", async () => {
    const root = createRepo();
    writePackageJson(root, "bounded-contexts/widgets", {
      name: "@chase-sets/widgets",
      exports: { ".": "./index.ts" },
    });
    writeSource(
      root,
      "bounded-contexts/widgets/index.ts",
      `export { WidgetFeedbackPrompt } from "./features/widgets/ui/widget-feedback-prompt";`,
    );
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/ui/widget-feedback-prompt.tsx",
      `export function WidgetFeedbackPrompt() { return null; }`,
    );

    const manifests = contextManifestsFor([{ root: "bounded-contexts/widgets", packageName: "@chase-sets/widgets" }]);

    const withoutConsumer = await findServerBarrelReactFreeViolations({ repoRoot: root, contextManifests: manifests });
    expect(withoutConsumer).toEqual([]);

    writeSource(
      root,
      "deployables/platform-api/src/app.ts",
      `import { module as widgetsModule } from "@chase-sets/widgets";`,
    );

    const withConsumer = await findServerBarrelReactFreeViolations({ repoRoot: root, contextManifests: manifests });
    expect(withConsumer).toEqual([
      expect.objectContaining({
        entryFile: "bounded-contexts/widgets/index.ts",
        type: "tsx-module",
      }),
    ]);
  });

  it("a type-only bare import of a context does not mark its index.ts as deployable-server-consumed", async () => {
    const root = createRepo();
    writePackageJson(root, "bounded-contexts/widgets", {
      name: "@chase-sets/widgets",
      exports: { ".": "./index.ts" },
    });
    writeSource(
      root,
      "bounded-contexts/widgets/index.ts",
      `export { WidgetFeedbackPrompt } from "./features/widgets/ui/widget-feedback-prompt";`,
    );
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/ui/widget-feedback-prompt.tsx",
      `export function WidgetFeedbackPrompt() { return null; }`,
    );
    writeSource(
      root,
      "deployables/platform-api/src/app.ts",
      `import type { WidgetsModule } from "@chase-sets/widgets";`,
    );

    const violations = await findServerBarrelReactFreeViolations({
      repoRoot: root,
      contextManifests: contextManifestsFor([{ root: "bounded-contexts/widgets", packageName: "@chase-sets/widgets" }]),
    });

    expect(violations).toEqual([]);
  });

  it("follows a bare @chase-sets/* re-export across a workspace package boundary", async () => {
    const root = createRepo();
    writePackageJson(root, "infrastructure/shared-runtime", {
      name: "@chase-sets/shared-runtime",
      exports: { ".": "./index.ts" },
    });
    writeSource(
      root,
      "infrastructure/shared-runtime/index.ts",
      `export { WidgetFeedbackPrompt } from "./widget-feedback-prompt";`,
    );
    writeSource(
      root,
      "infrastructure/shared-runtime/widget-feedback-prompt.tsx",
      `export function WidgetFeedbackPrompt() { return null; }`,
    );
    writePackageJson(root, "bounded-contexts/widgets", {
      name: "@chase-sets/widgets",
      exports: { ".": "./index.ts", "./server": "./server.ts" },
    });
    writeSource(root, "bounded-contexts/widgets/index.ts", `export const module = {};`);
    writeSource(
      root,
      "bounded-contexts/widgets/server.ts",
      `export { WidgetFeedbackPrompt } from "@chase-sets/shared-runtime";`,
    );

    const violations = await findServerBarrelReactFreeViolations({
      repoRoot: root,
      contextManifests: contextManifestsFor([{ root: "bounded-contexts/widgets", packageName: "@chase-sets/widgets" }]),
    });

    expect(violations).toEqual([
      expect.objectContaining({
        entryFile: "bounded-contexts/widgets/server.ts",
        type: "tsx-module",
        chain: [
          "bounded-contexts/widgets/server.ts",
          "infrastructure/shared-runtime/index.ts",
          "infrastructure/shared-runtime/widget-feedback-prompt.tsx",
        ],
      }),
    ]);
  });

  it("does not follow a bare import of an unrelated npm package (e.g. react, hono)", async () => {
    const root = createRepo();
    writePackageJson(root, "bounded-contexts/widgets", {
      name: "@chase-sets/widgets",
      exports: { ".": "./index.ts", "./server": "./server.ts" },
    });
    writeSource(root, "bounded-contexts/widgets/index.ts", `export const module = {};`);
    writeSource(
      root,
      "bounded-contexts/widgets/server.ts",
      `
        import { Hono } from "hono";
        export function createWidgetRoutes() {
          return new Hono();
        }
      `,
    );

    const violations = await findServerBarrelReactFreeViolations({
      repoRoot: root,
      contextManifests: contextManifestsFor([{ root: "bounded-contexts/widgets", packageName: "@chase-sets/widgets" }]),
    });

    expect(violations).toEqual([]);
  });

  it("skips a context with no server.ts and a non-consumed index.ts", async () => {
    const root = createRepo();
    writePackageJson(root, "bounded-contexts/widgets", {
      name: "@chase-sets/widgets",
      exports: { ".": "./index.ts" },
    });
    writeSource(
      root,
      "bounded-contexts/widgets/index.ts",
      `export { WidgetFeedbackPrompt } from "./features/widgets/ui/widget-feedback-prompt";`,
    );
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/ui/widget-feedback-prompt.tsx",
      `export function WidgetFeedbackPrompt() { return null; }`,
    );

    const violations = await findServerBarrelReactFreeViolations({
      repoRoot: root,
      contextManifests: contextManifestsFor([{ root: "bounded-contexts/widgets", packageName: "@chase-sets/widgets" }]),
    });

    expect(violations).toEqual([]);
  });

  it("keeps every real bounded context's server.ts (and deployable-server-consumed index.ts) React-free", async () => {
    const result = await validateServerBarrelReactFree();

    expect(result.violations, result.violations.join("\n")).toEqual([]);
  }, 30_000);
});

describe("resolveExportsSubpath", () => {
  it("resolves an exact subpath entry", () => {
    expect(resolveExportsSubpath({ "./server": "./server.ts" }, "./server")).toBe("./server.ts");
  });

  it("resolves a wildcard export pattern", () => {
    expect(resolveExportsSubpath({ "./*": "./*.ts" }, "./responses")).toBe("./responses.ts");
  });

  it("resolves the root '.' entry from a bare string exports field", () => {
    expect(resolveExportsSubpath("./index.ts", ".")).toBe("./index.ts");
  });

  it("returns null for an unmatched subpath", () => {
    expect(resolveExportsSubpath({ "./server": "./server.ts" }, "./missing")).toBeNull();
  });
});
