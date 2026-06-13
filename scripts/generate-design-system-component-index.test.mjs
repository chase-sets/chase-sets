import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDesignSystemComponentIndex,
  syncDesignSystemComponentIndex,
} from "./generate-design-system-component-index.mjs";

const temporaryRoots = [];

function createTempRepo() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "chase-sets-ds-component-index-"));
  temporaryRoots.push(rootDir);
  return rootDir;
}

function writeText(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function createFixtureRepo() {
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
/** Renders the primary saved action. */
export function UsedButton() {}

export function formatUsedLabel() {}
`,
  );
  writeText(
    rootDir,
    "bounded-contexts/catalog/features/items/ui/page.tsx",
    `
import { UsedButton, formatUsedLabel } from "@chase-sets/design-system";

export function Page() {
  const label = formatUsedLabel();
  return <UsedButton>{label}</UsedButton>;
}
`,
  );

  return rootDir;
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

describe("generate design-system component index", () => {
  it("builds rows from the dead-export audit inventory", async () => {
    const rootDir = createFixtureRepo();

    const result = await buildDesignSystemComponentIndex({
      repoRoot: rootDir,
      allowedZeroConsumerExports: [],
    });

    expect(result.rows).toEqual([
      {
        symbol: "formatUsedLabel",
        module: "packages/design-system/src/components.tsx",
        purpose: "Purpose not documented; symbol name suggests: format Used Label.",
        exampleConsumer: "bounded-contexts/catalog/features/items/ui/page.tsx",
      },
      {
        symbol: "UsedButton",
        module: "packages/design-system/src/components.tsx",
        purpose: "Renders the primary saved action.",
        exampleConsumer: "bounded-contexts/catalog/features/items/ui/page.tsx",
      },
    ]);
    expect(result.content).toContain("Runtime exports indexed: 2");
    expect(result.content).toContain("| `UsedButton` | `packages/design-system/src/components.tsx` |");
  });

  it("fails without writing when the committed index is stale", async () => {
    const rootDir = createFixtureRepo();

    await syncDesignSystemComponentIndex({
      repoRoot: rootDir,
      allowedZeroConsumerExports: [],
    });

    await expect(
      syncDesignSystemComponentIndex({
        repoRoot: rootDir,
        check: true,
        allowedZeroConsumerExports: [],
      }),
    ).resolves.toMatchObject({ checked: true });

    const indexPath = path.join(rootDir, "packages/design-system/COMPONENT_INDEX.md");
    const staleContent = "# stale\n";
    writeFileSync(indexPath, staleContent, "utf8");

    await expect(
      syncDesignSystemComponentIndex({
        repoRoot: rootDir,
        check: true,
        allowedZeroConsumerExports: [],
      }),
    ).rejects.toThrow(/packages\/design-system\/COMPONENT_INDEX\.md is stale/);
    expect(readFileSync(indexPath, "utf8")).toBe(staleContent);
  });
});
