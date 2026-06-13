import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDesignSystemDeadExports, collectDesignSystemPublicExports } from "./check-design-system-dead-exports.mjs";

const temporaryRoots = [];

function createTempRepo() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "chase-sets-ds-dead-exports-"));
  temporaryRoots.push(rootDir);
  return rootDir;
}

function writeText(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

describe("checkDesignSystemDeadExports", () => {
  it("resolves export-star chains and named aliases from the design-system entrypoint", () => {
    const rootDir = createTempRepo();
    writeText(
      rootDir,
      "packages/design-system/src/index.ts",
      `
export * from "./components";
export { InternalThing as PublicThing, type InternalThingProps as PublicThingProps } from "./named";
`,
    );
    writeText(
      rootDir,
      "packages/design-system/src/components/index.ts",
      `
export function UsedButton() {}
export interface UsedButtonProps {}
`,
    );
    writeText(
      rootDir,
      "packages/design-system/src/named.ts",
      `
export function InternalThing() {}
export interface InternalThingProps {}
`,
    );

    expect(collectDesignSystemPublicExports({ repoRoot: rootDir })).toEqual(["PublicThing", "UsedButton"]);
  });

  it("fails on unlisted zero-consumer exports and accepts one-line allowlist reasons", async () => {
    const rootDir = createTempRepo();
    writeText(
      rootDir,
      "packages/design-system/src/index.ts",
      `
export * from "./components";
`,
    );
    writeText(
      rootDir,
      "packages/design-system/src/components.tsx",
      `
export function UsedButton() {}
export function ReservedPanel() {}
export function UnusedPanel() {}
`,
    );
    writeText(
      rootDir,
      "bounded-contexts/catalog/features/items/ui/page.tsx",
      `
import { UsedButton, ReservedPanel, UnusedPanel } from "@chase-sets/design-system";

export function Page() {
  return <UsedButton>Saved</UsedButton>;
}
`,
    );

    const result = await checkDesignSystemDeadExports({
      repoRoot: rootDir,
      allowedZeroConsumerExports: [{ symbol: "ReservedPanel", reason: "reserved test fixture" }],
    });

    expect(result.passed).toBe(false);
    expect(result.zeroConsumerExports).toEqual(["ReservedPanel", "UnusedPanel"]);
    expect(result.allowlistedExports).toEqual([{ symbol: "ReservedPanel", reason: "reserved test fixture" }]);
    expect(result.unlistedZeroConsumerExports).toEqual(["UnusedPanel"]);
    expect(result.violations).toEqual([expect.stringContaining("UnusedPanel has zero production consumers")]);
  });

  it("ignores test-file usage and counts namespace property usage in production files", async () => {
    const rootDir = createTempRepo();
    writeText(
      rootDir,
      "packages/design-system/src/index.ts",
      `
export const NamespaceUsed = "used";
export const TestOnly = "test";
`,
    );
    writeText(
      rootDir,
      "bounded-contexts/catalog/features/items/ui/page.tsx",
      `
import * as DesignSystem from "@chase-sets/design-system";

export const pageTitle = DesignSystem.NamespaceUsed;
`,
    );
    writeText(
      rootDir,
      "bounded-contexts/catalog/features/items/ui/page.test.tsx",
      `
import { TestOnly } from "@chase-sets/design-system";

export const testTitle = TestOnly;
`,
    );

    const result = await checkDesignSystemDeadExports({
      repoRoot: rootDir,
      allowedZeroConsumerExports: [{ symbol: "TestOnly", reason: "test fixture" }],
    });

    expect(result.passed).toBe(true);
    expect(result.consumersBySymbol.NamespaceUsed).toEqual(["bounded-contexts/catalog/features/items/ui/page.tsx"]);
    expect(result.zeroConsumerExports).toEqual(["TestOnly"]);
  });
});
