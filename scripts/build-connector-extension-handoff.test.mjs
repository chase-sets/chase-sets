import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TCGPLAYER_CONNECTOR_EXTENSION_ID,
  TCGPLAYER_CONNECTOR_EXTENSION_KEY,
} from "../bounded-contexts/channels/features/connector-client/domain/identity.ts";
import { operatorFileInventory } from "./prepare-operator-extension-evidence.mjs";
import { buildConnectorExtensionHandoff, buildOnce } from "./build-connector-extension-handoff.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";

const roots = [];
const clientId = "cc_client_00000000-0000-4000-8000-000000000000";
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "connector-handoff-contract-"));
  roots.push(root);
  mkdirSync(join(root, "deployables/tcgplayer-connector-extension"), { recursive: true });
  writeFileSync(join(root, "README.md"), "synthetic");
  writeFileSync(join(root, ".gitignore"), "artifacts/\n");
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-m", "fixture"],
    {
      cwd: root,
      stdio: "ignore",
    },
  );
  return root;
}

function builder(mutant) {
  let count = 0;
  return async ({ outDir }) => {
    count++;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "manifest.json"),
      JSON.stringify({
        key: TCGPLAYER_CONNECTOR_EXTENSION_KEY,
        ...(mutant === "version" ? {} : { version: "0.1.0" }),
        host_permissions: ["https://marketplace.staging.chasesets.com/*"],
      }),
    );
    writeFileSync(join(outDir, "background.js"), mutant === "byte" && count === 2 ? "changed" : "stable");
    if (mutant === "extra" && count === 2) writeFileSync(join(outDir, "extra.js"), "extra");
  };
}

describe("build-connector-extension-handoff", () => {
  it("retains the first reproducible build and writes a complete handoff", async () => {
    const root = fixture();
    const handoff = await buildConnectorExtensionHandoff({
      root,
      target: "staging",
      clientId,
      buildExtension: builder("none"),
    });
    expect(handoff).toEqual({
      schemaVersion: 1,
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      target: "staging",
      platformOrigin: "https://marketplace.staging.chasesets.com",
      clientId,
      extensionId: TCGPLAYER_CONNECTOR_EXTENSION_ID,
      version: "0.1.0",
      twoBuildsIdentical: true,
      files: {
        "background.js": expect.stringMatching(/^[a-f0-9]{64}$/),
        "manifest.json": expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(operatorFileInventory(join(root, "artifacts/connector-extension/staging"))).toEqual(handoff.files);
    expect(JSON.parse(readFileSync(join(root, "artifacts/connector-extension/handoff.json"), "utf8"))).toEqual(handoff);
    expect(
      await buildConnectorExtensionHandoff({ root, target: "staging", clientId, buildExtension: builder("none") }),
    ).toEqual(handoff);
  });

  it.each(["extra", "byte"])("refuses the second-build %s mutant", async (mutant) => {
    const root = fixture();
    await expect(
      buildConnectorExtensionHandoff({ root, target: "staging", clientId, buildExtension: builder(mutant) }),
    ).rejects.toThrow("connector-handoff-builds-differ");
    expectNoHandoff(root);
  });

  it("refuses an untracked file before building", async () => {
    const root = fixture();
    writeFileSync(join(root, "untracked.txt"), "dirty");
    await expect(
      buildConnectorExtensionHandoff({ root, target: "staging", clientId, buildExtension: builder("none") }),
    ).rejects.toThrow("connector-handoff-dirty-worktree");
    expectNoHandoff(root);
  });

  it("refuses an incomplete version payload without publishing", async () => {
    const root = fixture();
    await expect(
      buildConnectorExtensionHandoff({ root, target: "staging", clientId, buildExtension: builder("version") }),
    ).rejects.toThrow("connector-handoff-version-refused");
    expectNoHandoff(root);
  });

  it("removes the retained directory when the handoff cannot be written", async () => {
    const root = fixture();
    await expect(
      buildConnectorExtensionHandoff({
        root,
        target: "staging",
        clientId,
        buildExtension: builder("none"),
        output: root,
      }),
    ).rejects.toThrow();
    expectNoHandoff(root);
  });

  it("buildOnce emits the real staging artifact with the supplied public client", async () => {
    acquireHeavySlot("build");
    const outDir = mkdtempSync(join(tmpdir(), "connector-real-staging-"));
    roots.push(outDir);
    await buildOnce({
      root: join(import.meta.dirname, ".."),
      mode: "connector-staging",
      outDir,
      env: { VITE_CONNECTOR_CLIENT_ID: clientId },
    });
    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.host_permissions).toEqual([
      "https://marketplace.staging.chasesets.com/*",
      "https://store.tcgplayer.com/*",
    ]);
    const bundle = readFileSync(join(outDir, "background.js"), "utf8");
    expect(bundle).toContain(clientId);
    expect(bundle).toContain("https://marketplace.staging.chasesets.com");
    expect(Object.keys(operatorFileInventory(outDir))).toEqual(["background.js", "manifest.json"]);
  });
});

function expectNoHandoff(root) {
  expect(existsSync(join(root, "artifacts/connector-extension/handoff.json"))).toBe(false);
  expect(existsSync(join(root, "artifacts/connector-extension/staging"))).toBe(false);
}
