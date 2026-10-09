import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceSourceAliases } from "../../../scripts/workspace-source-aliases.mjs";
import { connectorViteConfig } from "../vite.config";

describe("connector Vite aliases", () => {
  it.each(["production", "harness"])("preserves workspace alias array entries in %s mode", (mode) => {
    const aliases = connectorViteConfig(mode).resolve?.alias;
    const workspaceAliases = createWorkspaceSourceAliases();
    expect(Array.isArray(aliases)).toBe(true);
    expect(aliases).toEqual([
      ...workspaceAliases,
      ...(mode === "harness"
        ? [
            {
              find: "./executors",
              replacement: resolve(import.meta.dirname, "../__tests__/harness/executors.harness.ts"),
            },
            { find: "./host-registry", replacement: resolve(import.meta.dirname, "../__tests__/harness/origins.ts") },
          ]
        : []),
    ]);
    expect(workspaceAliases.length).toBeGreaterThan(0);
  });
});
