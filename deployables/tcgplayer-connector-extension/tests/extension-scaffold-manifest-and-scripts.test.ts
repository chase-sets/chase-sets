import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(import.meta.dirname, "..", file), "utf8");

describe("extension-scaffold-manifest-and-scripts", () => {
  it("retains the registered scripts without a DB-profile-only unit alias", () => {
    expect(JSON.parse(read("package.json")).scripts).toEqual({
      build: "vite build --configLoader runner",
      typecheck: "tsc -p ./tsconfig.json --noEmit",
      test: "vitest run --config ./vitest.config.ts",
      "test:watch": "vitest --config ./vitest.config.ts",
      "test:chromium": "vite build --configLoader runner && playwright test --config ./playwright.config.ts",
    });
  });
  it("retains workspace aliases and both restart and product selectors", () => {
    for (const file of ["vite.config.ts", "vitest.config.ts"])
      expect(read(file)).toContain("createWorkspaceSourceAliases()");
    expect(read("playwright.config.ts")).toContain(
      '"e2e/**/*.spec.ts", "__tests__/extension-restart-probe-chromium.spec.ts"',
    );
    expect(read("vitest.config.ts")).toContain('"tests/**/*.test.ts", "__tests__/support/**/*.test.ts"');
  });
});
