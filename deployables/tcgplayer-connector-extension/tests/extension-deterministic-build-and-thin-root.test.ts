import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../vite.config";

const root = resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

function assertThinRoot(worker: string) {
  expect(worker).toContain("createConnectorBackground({");
  expect(worker).not.toMatch(/\bchrome\.|\b(?:if|switch|for|while)\s*\(|\bclass\s|\.then\(/);
  expect(worker).toContain("sweep: retentionStore,");
  expect(worker).toContain("createConnectorRetentionStore({");
  expect(worker).toContain("const session = chromeSession();");
  expect(worker).toContain("const alarms = chromeAlarms();");
  expect(worker).toContain("...chromeIndexedDB(),");
  for (const adapter of ["Storage", "Identity", "Action", "Runtime"])
    expect(worker).toContain(`: chrome${adapter}(),`);
  expect(worker.match(/\bawait\b/g)).toBeNull();
  expect(worker.match(/background\.boot\(\)/g)).toHaveLength(1);
}

describe("extension-deterministic-build-and-thin-root", () => {
  it("keeps one composition-only entry, seven adapters, and no superseded probe sources", () => {
    const worker = read("src/background.ts");
    assertThinRoot(worker);
    expect(readdirSync(resolve(root, "src/adapters")).sort()).toEqual([
      "chrome-action.ts",
      "chrome-alarms.ts",
      "chrome-identity.ts",
      "chrome-indexeddb.ts",
      "chrome-runtime.ts",
      "chrome-session.ts",
      "chrome-storage.ts",
    ]);
    for (const name of [
      "manifest",
      "manifest-contract",
      "popup",
      "popup-sandboxed",
      "probe-canary",
      "probe-records",
      "authority-candidate",
    ])
      expect(existsSync(resolve(root, `src/${name}.ts`)), name).toBe(false);
    expect(worker).not.toMatch(/(?:setPopup|query|code_verifier|access_token|refresh_token)/);
  });

  it("kills omitted-adapter, pre-custody sweep and install-reset root mutants", () => {
    const worker = read("src/background.ts");
    assertThinRoot(worker);
    for (const mutant of [
      worker.replace("const session = chromeSession();", ""),
      `await sweep.run({ reason: 'boot' });\n${worker}`,
      `${worker}\nchrome.runtime.onInstalled.addListener(() => chrome.storage.local.clear());`,
    ])
      expect(() => assertThinRoot(mutant)).toThrow();
  });

  it("refuses HTML, chunks, imports and remote-code mutants in the actual build plugin", () => {
    const plugin = (config.plugins as { name: string; generateBundle: (...args: unknown[]) => void }[])[0]!;
    const emitted: unknown[] = [];
    const run = (bundle: object) =>
      plugin.generateBundle.call({ emitFile: (asset: unknown) => emitted.push(asset) }, {}, bundle);
    const worker = { type: "chunk", code: "const safe = true;", imports: [], dynamicImports: [] };
    run({ "background.js": worker });
    expect(emitted).toHaveLength(1);
    for (const mutant of [
      { "background.js": worker, "popup.html": { type: "asset", source: "" } },
      { "background.js": worker, "chunk.js": worker },
      { "background.js": { ...worker, imports: ["node:crypto"] } },
      { "background.js": { ...worker, dynamicImports: ["https://example.com/code.js"] } },
      { "background.js": { ...worker, code: "importScripts('https://example.com/code.js')" } },
      { "background.js": { ...worker, code: "chrome.action.setPopup({})" } },
    ])
      expect(() => run(mutant)).toThrow("connector-entry-graph-refused");
  });
});
