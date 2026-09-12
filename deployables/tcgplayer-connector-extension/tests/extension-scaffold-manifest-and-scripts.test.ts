import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extensionKeyCandidate } from "../src/authority-candidate";
import { createProbeManifest } from "../src/manifest";

const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("extension-scaffold-manifest-and-scripts", () => {
  it("pins the five package scripts and omits the DB-profile-only unit alias", () => {
    expect(packageJson.scripts).toEqual({
      build: "vite build",
      typecheck: "tsc -p ./tsconfig.json --noEmit",
      test: "vitest run --config ./vitest.config.ts",
      "test:watch": "vitest --config ./vitest.config.ts",
      "test:chromium": "vite build && playwright test --config ./playwright.config.ts",
    });
    expect(packageJson.scripts).not.toHaveProperty("test:unit");
  });

  it("emits the public key, exact probe entries, and no host permission", () => {
    const manifest = createProbeManifest();
    expect(manifest).toMatchObject({
      key: extensionKeyCandidate,
      background: { service_worker: "background.js", type: "module" },
      permissions: ["identity", "storage"],
      action: { default_popup: "popup.html" },
      sandbox: { pages: ["popup-sandboxed.html"] },
    });
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest.content_security_policy.extension_pages).toBe("script-src 'self'; object-src 'none'");
    expect(manifest.content_security_policy.sandbox).toContain("sandbox allow-scripts allow-popups");
  });

  it("kills a host-permission mutant", () => {
    const mutant = { ...createProbeManifest(), host_permissions: ["https://provider.invalid/synthetic-host-mutant/*"] };
    const assertNoHostPermission = (manifest: unknown) => expect(manifest).not.toHaveProperty("host_permissions");
    assertNoHostPermission(createProbeManifest());
    expect(() => assertNoHostPermission(mutant)).toThrow();
  });

  it("keeps private key material out of the package source contract", () => {
    const packageSources = ["../src/manifest.ts", "../vite.config.ts", "../package.json"]
      .map((file) => readFileSync(resolve(import.meta.dirname, file), "utf8"))
      .join("\n");
    expect(packageSources).not.toMatch(/PRIVATE KEY|privateKey|BEGIN (?:RSA )?PRIVATE KEY/);
  });
});
