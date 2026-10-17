import { resolve } from "node:path";
import { defineConfig, type UserConfig } from "vite";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";
import { buildConnectorManifest } from "@chase-sets/channels";
import { connectorHostRegistry } from "./src/host-registry";
import {
  assertHarnessOrigins,
  connectorHostRegistry as harnessHosts,
  platformOrigin as harnessPlatform,
} from "./__tests__/harness/origins";

export const manifestInput = {
  platformOrigin: process.env.VITE_PLATFORM_API_URL ?? process.env.PLATFORM_API_URL ?? "http://localhost:6182",
  hostRegistry: connectorHostRegistry,
  permissionRegistry: ["identity", "storage", "alarms"],
};

export function connectorViteConfig(mode = "production"): UserConfig {
  const harness = mode === "harness";
  const input = harness
    ? { ...manifestInput, platformOrigin: harnessPlatform, hostRegistry: harnessHosts }
    : manifestInput;
  if (harness) {
    assertHarnessOrigins(process.env.VITE_PLATFORM_API_URL ?? harnessPlatform, input.hostRegistry);
    if (
      Object.keys(process.env).some((key) =>
        /^TCGPLAYER_|PROVIDER.*(?:SESSION|CREDENTIAL)|CONNECTOR.*CONFIG_ROOT/i.test(key),
      )
    )
      throw new Error("connector-harness-environment-refused");
  }
  return {
    resolve: {
      alias: [
        ...createWorkspaceSourceAliases(),
        ...(harness
          ? [
              {
                find: "./executors",
                replacement: resolve(import.meta.dirname, "__tests__/harness/executors.harness.ts"),
              },
              { find: "./host-registry", replacement: resolve(import.meta.dirname, "__tests__/harness/origins.ts") },
            ]
          : []),
      ],
    },
    define: {
      "import.meta.env.VITE_PLATFORM_API_URL": JSON.stringify(input.platformOrigin),
      "import.meta.env.VITE_CONNECTOR_CLIENT_ID": JSON.stringify(process.env.VITE_CONNECTOR_CLIENT_ID ?? ""),
      ...(harness
        ? {
            "import.meta.env.VITE_HARNESS_EXECUTOR_UNIT": JSON.stringify(
              process.env.CONNECTOR_HARNESS_EXECUTOR_UNIT ?? "operation",
            ),
          }
        : {}),
    },
    build: {
      outDir: harness ? "dist-harness" : "dist",
      emptyOutDir: true,
      rolldownOptions: {
        preserveEntrySignatures: "strict",
        input: {
          background: resolve(
            import.meta.dirname,
            harness ? "__tests__/harness/entry.harness.ts" : "src/background.ts",
          ),
        },
        output: { entryFileNames: "[name].js", codeSplitting: false },
      },
    },
    plugins: [
      {
        name: "connector-closed-entry-graph",
        generateBundle(_options, bundle) {
          const worker = bundle["background.js"];
          if (
            Object.keys(bundle).join() !== "background.js" ||
            !worker ||
            worker.type !== "chunk" ||
            worker.imports.length ||
            worker.dynamicImports.length ||
            /\bnode:|\bimportScripts\s*\(|\bsetPopup\s*\(|\beval\s*\(|\bnew Function\s*\(/.test(worker.code)
          )
            throw new Error("connector-entry-graph-refused");
          if (
            !harness &&
            (Object.keys(worker.modules).some((id) => /[\\/]__tests__[\\/]|[\\/]e2e[\\/]|[\\/]tests[\\/]/.test(id)) ||
              /127\.0\.0\.1:4617[45]|SYNTHETIC_7940/.test(worker.code))
          )
            throw new Error("connector-product-harness-leak");
          const manifest = buildConnectorManifest(input);
          this.emitFile({ type: "asset", fileName: "manifest.json", source: `${JSON.stringify(manifest, null, 2)}\n` });
        },
      },
    ],
  };
}
export default defineConfig(({ mode }) => connectorViteConfig(mode));
