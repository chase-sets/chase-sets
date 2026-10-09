import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateConnectorFakeGraph } from "./connector-fake-public-codecs.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fake = "deployables/tcgplayer-connector-extension/__tests__/harness/loopback.ts";
describe("connector-fake-public-codecs", () => {
  it("scans the complete fake dependency graph and requires executed public codec calls", async () => {
    const result = await validateConnectorFakeGraph({ repoRoot });
    expect(result.violations).toEqual([]);
    expect(result.scannedFiles).toBe(result.totalFiles);
    expect(result.scannedFiles).toBeGreaterThan(5);
    console.log(`connector-fake graph scanned=${result.scannedFiles} total=${result.totalFiles}`);
  });
  it.each(["assertConnectorClaim", "assertConnectorReport"])("rejects the unused-import %s mutant", async (codec) => {
    const original = await readFile(new URL(`../../${fake}`, import.meta.url), "utf8");
    const overrides = new Map([[fake, original.replace(`${codec}(input);`, "void input;")]]);
    expect((await validateConnectorFakeGraph({ repoRoot, overrides })).violations.join()).toContain(
      `must call public ${codec}`,
    );
  });
  it.each(["renamed-helper.ts", "nested/opaque-adapter.ts"])(
    "rejects copied grammar under %s with public imports left intact",
    async (name) => {
      const overrides = new Map([
        [
          `deployables/tcgplayer-connector-extension/__tests__/harness/${name}`,
          'export function renamed(value: any) { if (!Array.isArray(value.outcomes)) throw new Error("bad"); }',
        ],
      ]);
      expect((await validateConnectorFakeGraph({ repoRoot, overrides })).violations.join()).toContain(
        "copies producer-owned",
      );
    },
  );
  it("rejects an internal-import mutant in a renamed sibling", async () => {
    const overrides = new Map([
      [
        "deployables/tcgplayer-connector-extension/__tests__/harness/opaque.ts",
        'import { assertConnectorClaim } from "@chase-sets/channels/features/connector-feed/domain/transport";',
      ],
    ]);
    expect((await validateConnectorFakeGraph({ repoRoot, overrides })).violations.join()).toContain(
      "imports context internals",
    );
  });
});
