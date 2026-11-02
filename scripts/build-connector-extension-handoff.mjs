import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";
import { operatorFileInventory } from "./prepare-operator-extension-evidence.mjs";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID } from "../bounded-contexts/channels/features/connector-client/domain/identity.ts";
import { deriveChromeExtensionId } from "../bounded-contexts/channels/features/connector-client/domain/derive-chrome-extension-id.ts";
import { linkIntentOrigins } from "../infrastructure/platform-runtime/link-intent-origins.generated.ts";

const clientIdPattern = /^cc_client_[0-9a-f-]{36}$/;
const targetPattern = /^(staging|production)$/;
const connectorTargets = {
  staging: linkIntentOrigins["marketplace-web"].staging,
  production: linkIntentOrigins["marketplace-web"].production,
};
const providerEnvironment = /^(?:TCGPLAYER_|PROVIDER.*(?:SESSION|CREDENTIAL)|CONNECTOR.*CONFIG_ROOT)/i;

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

export async function buildOnce({ root, mode, outDir, env }) {
  const previous = process.env.VITE_CONNECTOR_CLIENT_ID;
  process.env.VITE_CONNECTOR_CLIENT_ID = env.VITE_CONNECTOR_CLIENT_ID;
  try {
    await build({
      root: resolve(root, "deployables/tcgplayer-connector-extension"),
      configFile: resolve(root, "deployables/tcgplayer-connector-extension/vite.config.ts"),
      configLoader: "runner",
      mode,
      logLevel: "warn",
      build: { outDir, emptyOutDir: true },
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
  buildExtension = buildOnce,
}) {
  if (!targetPattern.test(target)) throw new Error("connector-handoff-target-refused");
  if (!clientIdPattern.test(clientId)) throw new Error("connector-handoff-client-id-refused");
  requireProviderEnvironmentClean(process.env);
  requireCleanWorktree(root);
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const temp = mkdtempSync(join(tmpdir(), "connector-handoff-"));
  const first = join(temp, "first");
  const second = join(temp, "second");
  const retained = resolve(root, "artifacts/connector-extension", target);
  let publishing = false;
  try {
    const env = { VITE_CONNECTOR_CLIENT_ID: clientId };
    await buildExtension({ root, mode: `connector-${target}`, outDir: first, env });
    await buildExtension({ root, mode: `connector-${target}`, outDir: second, env });
    const firstFiles = operatorFileInventory(first);
    const secondFiles = operatorFileInventory(second);
    const firstManifest = JSON.parse(readFileSync(join(first, "manifest.json"), "utf8"));
    const secondManifest = JSON.parse(readFileSync(join(second, "manifest.json"), "utf8"));
    if (!same(firstFiles, secondFiles) || !same(firstManifest, secondManifest))
      throw new Error("connector-handoff-builds-differ");
    const extensionId = deriveChromeExtensionId(firstManifest.key);
    if (extensionId !== TCGPLAYER_CONNECTOR_EXTENSION_ID) throw new Error("connector-handoff-extension-id-refused");
    if (!firstManifest.host_permissions?.includes(`${connectorTargets[target]}/*`))
      throw new Error("connector-handoff-origin-mismatch");
    if (typeof firstManifest.version !== "string" || !firstManifest.version)
      throw new Error("connector-handoff-version-refused");
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
    const payload = `${JSON.stringify(handoff, null, 2)}\n`;
    rmSync(retained, { recursive: true, force: true });
    publishing = true;
    mkdirSync(retained, { recursive: true });
    cpSync(first, retained, { recursive: true });
    if (!same(operatorFileInventory(retained), handoff.files))
      throw new Error("connector-handoff-retained-files-differ");
    mkdirSync(resolve(output, ".."), { recursive: true });
    writeFileSync(output, payload);
    return handoff;
  } catch (error) {
    if (publishing) rmSync(retained, { recursive: true, force: true });
    if (publishing && existsSync(output) && lstatSync(output).isFile()) rmSync(output);
    throw error;
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
  acquireHeavySlot("build");
  const { target, clientId } = parseArgs(process.argv.slice(2));
  if (!target || !clientId) throw new Error("connector-handoff-arguments-refused");
  await buildConnectorExtensionHandoff({ target, clientId });
}
