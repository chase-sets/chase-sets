import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build, loadConfigFromFile } from "vite";
import { operatorFileInventory } from "./prepare-operator-extension-evidence.mjs";

const clientIdPattern = /^cc_client_[0-9a-f-]{36}$/;
const targetPattern = /^(staging|production)$/;
const connectorTargets = {
  staging: "https://marketplace.staging.chasesets.com",
  production: "https://marketplace.chasesets.com",
};
const TCGPLAYER_CONNECTOR_EXTENSION_ID = "ebnhngdhefamkdjajldafonajgkadfhh";
const providerEnvironment = /^(?:TCGPLAYER_|PROVIDER.*(?:SESSION|CREDENTIAL)|CONNECTOR.*CONFIG_ROOT)/i;

function deriveChromeExtensionId(publicKey) {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest().subarray(0, 16);
  return [...digest]
    .map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`)
    .join("");
}

export function requireCleanWorktree(root) {
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  if (status.trim()) throw new Error("connector-handoff-dirty-worktree");
}

function requireProviderEnvironmentClean(env) {
  if (Object.keys(env).some((key) => providerEnvironment.test(key)))
    throw new Error("connector-provider-environment-refused");
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function buildOnce({ root, mode, outDir, env }) {
  const previous = process.env.VITE_CONNECTOR_CLIENT_ID;
  process.env.VITE_CONNECTOR_CLIENT_ID = env.VITE_CONNECTOR_CLIENT_ID;
  try {
    const loaded = await loadConfigFromFile(
      { command: "build", mode },
      resolve(root, "deployables/tcgplayer-connector-extension/vite.config.ts"),
      root,
      "silent",
      undefined,
      "runner",
    );
    if (!loaded) throw new Error("connector-handoff-config-missing");
    await build({
      ...loaded.config,
      root: resolve(root, "deployables/tcgplayer-connector-extension"),
      mode,
      build: { ...loaded.config.build, outDir, emptyOutDir: true },
    });
  } finally {
    if (previous === undefined) delete process.env.VITE_CONNECTOR_CLIENT_ID;
    else process.env.VITE_CONNECTOR_CLIENT_ID = previous;
  }
}

export async function buildConnectorExtensionHandoff({
  root = resolve(import.meta.dirname, ".."),
  target,
  clientId,
  output = resolve(root, "artifacts/connector-extension/handoff.json"),
}) {
  if (!targetPattern.test(target)) throw new Error("connector-handoff-target-refused");
  if (!clientIdPattern.test(clientId)) throw new Error("connector-handoff-client-id-refused");
  requireProviderEnvironmentClean(process.env);
  requireCleanWorktree(root);
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const temp = mkdtempSync(join(tmpdir(), "connector-handoff-"));
  const first = join(temp, "first");
  const second = join(temp, "second");
  try {
    const env = { VITE_CONNECTOR_CLIENT_ID: clientId };
    await buildOnce({ root, mode: `connector-${target}`, outDir: first, env });
    await buildOnce({ root, mode: `connector-${target}`, outDir: second, env });
    const firstFiles = operatorFileInventory(first);
    const secondFiles = operatorFileInventory(second);
    const firstManifest = JSON.parse(readFileSync(join(first, "manifest.json"), "utf8"));
    const secondManifest = JSON.parse(readFileSync(join(second, "manifest.json"), "utf8"));
    if (!same(firstFiles, secondFiles) || !same(firstManifest, secondManifest))
      throw new Error("connector-handoff-builds-differ");
    const extensionId = deriveChromeExtensionId(firstManifest.key);
    if (extensionId !== TCGPLAYER_CONNECTOR_EXTENSION_ID) throw new Error("connector-handoff-extension-id-refused");
    const handoff = {
      schemaVersion: 1,
      sourceCommit,
      target,
      platformOrigin: connectorTargets[target],
      clientId,
      extensionId,
      version: firstManifest.version,
      twoBuildsIdentical: true,
      files: firstFiles,
    };
    mkdirSync(resolve(output, ".."), { recursive: true });
    writeFileSync(output, `${JSON.stringify(handoff, null, 2)}\n`);
    return handoff;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const targetIndex = argv.indexOf("--target");
  const clientIndex = argv.indexOf("--client-id");
  return {
    target: targetIndex >= 0 ? argv[targetIndex + 1] : undefined,
    clientId: clientIndex >= 0 ? argv[clientIndex + 1] : undefined,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { target, clientId } = parseArgs(process.argv.slice(2));
  if (!target || !clientId) throw new Error("connector-handoff-arguments-refused");
  await buildConnectorExtensionHandoff({ target, clientId });
}
