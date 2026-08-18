import { describe, expect, it } from "vitest";
import { findJsonImportAttributeViolation, validateJsonImportAttributes } from "./json-import-attributes.mjs";
import { findContextRootExportViolation } from "./run.mjs";

describe("findJsonImportAttributeViolation", () => {
  it("accepts canonical JSON imports and re-exports with standard attributes", () => {
    const content = `
      export { default as contextManifest } from "./context.json" with { type: "json" };
      import contextManifest from "./context.json" with { type: "json" };
    `;

    expect(
      findJsonImportAttributeViolation(content, [
        'export { default as contextManifest } from "./context.json" with { type: "json" };',
        'import contextManifest from "./context.json" with { type: "json" };',
      ]),
    ).toBeNull();
  });

  it("rejects a noncanonical JSON declaration", () => {
    const content = `
      export { default as contextManifest } from "./context.json";
      import contextManifest from "./context.json" with { type: "json" };
    `;

    expect(
      findJsonImportAttributeViolation(content, [
        'export { default as contextManifest } from "./context.json" with { type: "json" };',
        'import contextManifest from "./context.json" with { type: "json" };',
      ]),
    ).toBe(
      'must use the standard JSON import attribute: export { default as contextManifest } from "./context.json" with { type: "json" };',
    );
  });
});

describe("findContextRootExportViolation", () => {
  it("accepts the attributed canonical context-root export", () => {
    expect(
      findContextRootExportViolation(
        'export { default as contextManifest } from "./context.json" with { type: "json" };\nexport const module = {};',
      ),
    ).toBeNull();
  });

  it("rejects an un-attributed context-root export with the existing diagnostic", () => {
    expect(
      findContextRootExportViolation(
        'export { default as contextManifest } from "./context.json";\nexport const module = {};',
      ),
    ).toBe("context root entrypoints must export only contextManifest and module");
  });
});

describe("validateJsonImportAttributes", () => {
  it("keeps all real bounded-context roots and catalog authoring support attributed", async () => {
    const result = await validateJsonImportAttributes();

    expect(result.violations, result.violations.join("\n")).toEqual([]);
  });
});
