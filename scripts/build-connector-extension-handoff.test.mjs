import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TCGPLAYER_CONNECTOR_EXTENSION_KEY } from "../bounded-contexts/channels/features/connector-client/domain/identity.ts";
import { buildConnectorExtensionHandoff } from "./build-connector-extension-handoff.mjs";

const roots = [];
const clientId = "cc_client_00000000-0000-4000-8000-000000000000";
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "connector-handoff-contract-"));
  roots.push(root);
  mkdirSync(join(root, "deployables/tcgplayer-connector-extension"), { recursive: true });
  writeFileSync(join(root, "README.md"), "synthetic");
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
    expect(handoff.twoBuildsIdentical).toBe(true);
    expect(handoff.files).toEqual({ "background.js": expect.any(String), "manifest.json": expect.any(String) });
    expect(handoff.files).toEqual(expect.objectContaining({ "background.js": expect.any(String) }));
    expect(existsSync(join(root, "artifacts/connector-extension/staging/background.js"))).toBe(true);
  });

  it.each(["extra", "byte"])("refuses the second-build %s mutant", async (mutant) => {
    await expect(
      buildConnectorExtensionHandoff({ root: fixture(), target: "staging", clientId, buildExtension: builder(mutant) }),
    ).rejects.toThrow("connector-handoff-builds-differ");
  });

  it("refuses an untracked file before building", async () => {
    const root = fixture();
    writeFileSync(join(root, "untracked.txt"), "dirty");
    await expect(
      buildConnectorExtensionHandoff({ root, target: "staging", clientId, buildExtension: builder("none") }),
    ).rejects.toThrow("connector-handoff-dirty-worktree");
  });
});
