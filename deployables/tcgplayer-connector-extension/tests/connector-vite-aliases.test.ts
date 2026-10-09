import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceSourceAliases } from "../../../scripts/workspace-source-aliases.mjs";
import { connectorViteConfig } from "../vite.config";
import { platformOrigin } from "../__tests__/harness/origins";

afterEach(() => vi.unstubAllEnvs());

describe("connector Vite aliases", () => {
  it.each(["production", "harness"])("preserves workspace alias array entries in %s mode", (mode) => {
    vi.stubEnv("VITE_PLATFORM_API_URL", platformOrigin);
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
