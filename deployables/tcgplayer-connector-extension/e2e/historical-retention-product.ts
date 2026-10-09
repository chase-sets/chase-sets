import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { build } from "vite";
import { buildConnectorManifest } from "@chase-sets/channels";
import { connectorViteConfig } from "../vite.config";
import { packageRoot, proofRoot, retain } from "./coordinator-observation";
import { platformOrigin } from "../__tests__/harness/origins";
import { synthetic } from "./loopback-platform";

export const retentionProductHead = "e0d8ef5c001cde4397b16eed95ad8e22457bc71c";
export async function buildHistoricalRetentionProduct() {
  const root = resolve(packageRoot, "../..");
  try {
    execFileSync("git", ["cat-file", "-e", `${retentionProductHead}^{commit}`], { cwd: root, stdio: "pipe" });
  } catch {
    execFileSync("git", ["fetch", "--no-tags", "origin", retentionProductHead], { cwd: root, stdio: "pipe" });
  }
  const sources = new Map<string, string>();
  const destination = resolve(proofRoot, "product-7922-v1");
  await build({
    root: packageRoot,
    configFile: false,
    logLevel: "warn",
    resolve: connectorViteConfig().resolve,
    define: {
      "import.meta.env.VITE_PLATFORM_API_URL": JSON.stringify(platformOrigin),
      "import.meta.env.VITE_CONNECTOR_CLIENT_ID": JSON.stringify(synthetic.clientId),
    },
    build: {
      outDir: destination,
      emptyOutDir: true,
      rolldownOptions: {
        preserveEntrySignatures: "strict",
        input: { background: resolve(packageRoot, "src/background.ts") },
        output: { entryFileNames: "[name].js", codeSplitting: false },
      },
    },
    plugins: [
      {
        name: "exact-landed-7922-product-source",
        enforce: "pre",
        load(id) {
          const file = relative(root, id).replaceAll("\\", "/");
          if (
            !(
              file.startsWith("bounded-contexts/channels/features/connector-client/") ||
              file === "bounded-contexts/channels/client.ts" ||
              file.startsWith("deployables/tcgplayer-connector-extension/src/")
            )
          )
            return null;
          if (!sources.has(file))
            sources.set(
              file,
              execFileSync("git", ["show", `${retentionProductHead}:${file}`], {
                cwd: root,
                encoding: "utf8",
                maxBuffer: 1048576,
              }),
            );
          return sources.get(file);
        },
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "manifest.json",
            source: JSON.stringify(
              buildConnectorManifest({
                platformOrigin,
                hostRegistry: [],
                permissionRegistry: ["identity", "storage", "alarms"],
              }),
            ),
          });
        },
      },
    ],
  });
  retain("historical-product-source", { head: retentionProductHead, files: [...sources.keys()].sort() });
  mkdirSync(destination, { recursive: true });
  writeFileSync(
    resolve(destination, "seed.js"),
    'import * as product from "./background.js"; globalThis.__connectorSeed = product;',
  );
  const manifest = buildConnectorManifest({
    platformOrigin,
    hostRegistry: [],
    permissionRegistry: ["identity", "storage", "alarms"],
  });
  writeFileSync(
    resolve(destination, "manifest.json"),
    JSON.stringify({ ...manifest, background: { ...manifest.background, service_worker: "seed.js" } }),
  );
  return destination;
}
