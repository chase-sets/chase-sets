import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readContractSource = (fileName: string) => readFileSync(new URL(fileName, import.meta.url), "utf8");

describe("identity seed contract purity", () => {
  it("has no reverse dependency on Identity runtime", () => {
    const productionSource = [readContractSource("ids.ts"), readContractSource("index.ts")].join("\n");
    const packageManifest = JSON.parse(readContractSource("package.json")) as {
      dependencies?: Record<string, string>;
    };

    expect(productionSource).not.toMatch(/@chase-sets\/identity(?:\/|["'])/);
    expect(productionSource).not.toContain("bounded-contexts/identity");
    expect(Object.keys(packageManifest.dependencies ?? {})).toStrictEqual(["@chase-sets/primitives"]);
  });
});
