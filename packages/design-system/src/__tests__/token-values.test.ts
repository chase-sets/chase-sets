import { describe, expect, it } from "vitest";
import {
  candidateFailures,
  cssValues,
  declarations,
  fixture,
  sha256,
  stylesheet,
  stylesheetStructure,
} from "./token-contract";

const structureDigest = "fb2b325a760302c0a1c8bc55d30daafb865e108c72b4512700b75f66417bf2ea";

function assertDeclarationInventory(css: string) {
  const blocks = declarations(css).filter((block) => block.entries.length > 0);
  const actual = blocks.map((block) => ({
    count: block.entries.length,
    sha256: sha256(block.entries.map(([name]) => name).join("\n")),
  }));
  expect(
    actual,
    `declaration inventory by block: ${JSON.stringify(blocks.map((block) => ({ selector: block.selector, names: block.entries.map(([name]) => name) })))}`,
  ).toEqual([
    { count: 128, sha256: "85ab25638b8301f117ea8f41e6e3efc86ac5b5d8e26f4764c4ea87041ea75377" },
    { count: 70, sha256: "a8f0283fdc4c8679ab7c3ff4f2f262a94ae3533759aa48f6b0db685f9ed9d755" },
    { count: 70, sha256: "eb87795ec6e9d37bf5f6dc1fcf39f49fdee471f0fc3fafa58b372a8b4b133885" },
    { count: 70, sha256: "eb87795ec6e9d37bf5f6dc1fcf39f49fdee471f0fc3fafa58b372a8b4b133885" },
    { count: 90, sha256: "07c8338c3d221b605c7d1105315b4b43ed8d453e569d82fe4f1d68a45957f5e2" },
    { count: 14, sha256: "90c3dd2c5be06f45999fdbda901c6915c17b71ab40c0dedf90b32ba71568a92f" },
  ]);
}

describe("Ink & Foil token values", () => {
  for (const mode of ["light", "dark"] as const) {
    const actual = cssValues(mode);
    for (const [name, entry] of Object.entries(fixture[mode])) {
      it(`${mode}/${name} resolves to the independent candidate`, () => {
        expect(actual[name]).toBe(entry.candidate);
      });
    }
  }

  it("preserves every selector, declaration name/order, alias, import, font, foil and geometry byte", () => {
    assertDeclarationInventory(stylesheet);
    expect(sha256(stylesheetStructure(stylesheet))).toBe(structureDigest);
    console.log(`stylesheet declaration inventory: ${JSON.stringify(declarations(stylesheet))}`);
  });

  it("rejects a one-value drift by mode/property with every other input frozen", () => {
    const mutant = stylesheet.replace("--primary: #4845c6;", "--primary: #1d5fd6;");
    expect(mutant).not.toBe(stylesheet);
    expect(candidateFailures(stylesheet)).toEqual([]);
    expect(candidateFailures(mutant)).toContain("light/--primary: #1d5fd6 != #4845c6");
  });

  it("names an added declaration and its block when the inventory fails", () => {
    const mutant = stylesheet.replace("--primary: #4845c6;", "--primary: #4845c6;\n    --unregistered: #4845c6;");
    expect(() => assertDeclarationInventory(mutant)).toThrow("--unregistered");
  });

  it.each([
    ["added declaration in light block", "--primary: #4845c6;", "--primary: #4845c6;\n    --unregistered: #4845c6;"],
    ["equal-valued alias rebound", "--accent: var(--primary);", "--accent: var(--color-primary);"],
    ["font import", '@import "@fontsource/space-grotesk/latin-400.css";', ""],
  ])("rejects %s independently of candidate value equality", (_label, before, after) => {
    const mutant = stylesheet.replace(before!, after!);
    expect(mutant).not.toBe(stylesheet);
    expect(sha256(stylesheetStructure(mutant))).not.toBe(structureDigest);
  });

  it("rejects drift in the already-landed foil without defining another foil value", () => {
    const entry = Object.entries(fixture.light).find(([name]) => name.includes("logo-mid"));
    expect(entry).toBeDefined();
    const [name, value] = entry!;
    const mutant = stylesheet.replace(`${name}: ${value.candidate};`, `${name}: transparent;`);
    expect(mutant).not.toBe(stylesheet);
    expect(sha256(stylesheetStructure(mutant))).not.toBe(structureDigest);
  });

  it("retains the explicitly excluded trust hues", () => {
    expect(cssValues("light")["--trust"]).toBe("#0f766e");
    expect(cssValues("dark")["--trust"]).toBe("#2dd4bf");
  });
});
