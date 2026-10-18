import { resolve } from "node:path";
import { defineConfig, type UserConfig } from "vite";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";
import { buildConnectorManifest } from "@chase-sets/channels";
import { linkIntentOrigins } from "@chase-sets/platform-runtime/link-intents";
import { connectorHostRegistry } from "./src/host-registry";
import {
  assertHarnessOrigins,
  connectorHostRegistry as harnessHosts,
  platformOrigin as harnessPlatform,
} from "./__tests__/harness/origins";

const clientIdPattern = /^cc_client_[0-9a-f-]{36}$/;
const localOriginPattern = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
export const connectorTargets = {
  staging: linkIntentOrigins["marketplace-web"].staging,
  production: linkIntentOrigins["marketplace-web"].production,
} as const;

export type ConnectorBuildMode = "connector-local" | "connector-staging" | "connector-production" | "harness";

function configuredClientId() {
  return process.env.VITE_CONNECTOR_CLIENT_ID ?? "";
}

function localPlatformOrigin() {
  const configured = process.env.VITE_PLATFORM_API_URL;
  if (configured === undefined || configured === "") return "http://localhost:6182";
  if (
    !localOriginPattern.test(configured) ||
    new URL(configured).pathname !== "/" ||
    new URL(configured).search ||
    new URL(configured).hash
  )
    throw new Error("connector-local-origin-refused");
  return configured;
}

function deployedPlatformOrigin(target: "staging" | "production") {
  const expected = connectorTargets[target];
  for (const value of [process.env.VITE_PLATFORM_API_URL, process.env.PLATFORM_API_URL])
    if (value !== undefined && value !== "" && value !== expected) throw new Error("connector-deployed-origin-refused");
  const clientId = configuredClientId();
  if (!clientIdPattern.test(clientId)) throw new Error("connector-client-id-refused");
  return expected;
}

export const manifestInput = {
  platformOrigin: localPlatformOrigin(),
  hostRegistry: connectorHostRegistry,
  permissionRegistry: ["identity", "storage", "alarms"],
};

export function connectorViteConfig(mode: ConnectorBuildMode = "connector-local"): UserConfig {
  const harness = mode === "harness";
  if (!harness && !["connector-local", "connector-staging", "connector-production"].includes(mode))
    throw new Error("connector-build-mode-refused");
  const target = mode === "connector-staging" ? "staging" : mode === "connector-production" ? "production" : null;
  const platformOrigin = harness ? harnessPlatform : target ? deployedPlatformOrigin(target) : localPlatformOrigin();
  const input = harness
    ? { ...manifestInput, platformOrigin: harnessPlatform, hostRegistry: harnessHosts }
    : { ...manifestInput, platformOrigin };
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
      "import.meta.env.VITE_CONNECTOR_CLIENT_ID": JSON.stringify(configuredClientId()),
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
export default defineConfig(({ mode }) => connectorViteConfig(mode as ConnectorBuildMode));
