import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DB_TEST_SCRIPT_SELECTOR, runWorkspaceScripts } from "../../../../../../scripts/run-workspaces.mjs";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const roots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages"];
const dbFile = "features/notification-center/integrations/source-events/cancellation-delivery.db.test.ts";

function trackedFiles() {
  return execFileSync("git", ["ls-files", "--cached", "-z", "--", ...roots], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
    .split("\0")
    .filter(Boolean)
    .sort();
}

describe("cancellation delivery ownership", () => {
  it("cancellation DB profile is selected and unit-excluded", async () => {
    const manifests = trackedFiles().filter((file) => /^[^/]+\/[^/]+\/package\.json$/.test(file));
    const workspaces = manifests.map((file) => {
      const packageJson = JSON.parse(readFileSync(path.join(repoRoot, file), "utf8")) as {
        name: string;
        scripts: Record<string, string>;
        chaseSets?: { testProfile?: string };
      };
      return { name: packageJson.name, packageJson };
    });
    const notifications = workspaces.find((workspace) => workspace.name === "@chase-sets/notifications");
    if (!notifications) throw new Error("Notifications workspace absent");
    const durationHintRegistry = JSON.parse(
      readFileSync(path.join(repoRoot, "scripts/workspace-test-duration-hints-v1.json"), "utf8"),
    );
    async function assertEnrollment(candidates: typeof workspaces, registry = durationHintRegistry) {
      const invocations: string[][] = [];
      await runWorkspaceScripts({
        argv: [DB_TEST_SCRIPT_SELECTOR, "--workspace=@chase-sets/notifications"],
        durationHintRegistry: registry,
        listWorkspaces: () => candidates,
        loadEnvironment: () => undefined,
        appendSummary: () => undefined,
        run: async (_command, args) => {
          invocations.push([...args]);
        },
      });
      expect(invocations, "exactly one Notifications DB script invocation").toHaveLength(1);
      expect(invocations[0]?.slice(-4)).toEqual(["--filter", "@chase-sets/notifications", "run", "test:db"]);
      const selected = candidates.find((workspace) => workspace.name === notifications!.name)!;
      expect(selected.packageJson.chaseSets?.testProfile).toBe("db");
      expect(selected.packageJson.scripts["test:db"]).toBe(`vitest run --config ./tests/vitest.config.mjs ${dbFile}`);
      for (const script of ["test", "test:unit", "test:fast", "test:watch"])
        expect(selected.packageJson.scripts[script], `${script} excludes DB tests`).toContain(
          "--exclude **/*.db.test.ts",
        );
    }
    await assertEnrollment(workspaces);
    const withoutScript = structuredClone(workspaces);
    delete withoutScript.find((workspace) => workspace.name === notifications.name)!.packageJson.scripts["test:db"];
    const withoutHint = {
      ...durationHintRegistry,
      entries: durationHintRegistry.entries.filter(
        (entry: { workspace: string; script: string }) =>
          entry.workspace !== notifications.name || entry.script !== "test:db",
      ),
    };
    await expect(assertEnrollment(withoutScript, withoutHint)).rejects.toThrow(
      "exactly one Notifications DB script invocation",
    );
    const withoutExclusion = structuredClone(workspaces);
    const scripts = withoutExclusion.find((workspace) => workspace.name === notifications.name)!.packageJson.scripts;
    scripts["test:unit"] = scripts["test:unit"]!.replace(" --exclude **/*.db.test.ts", "");
    await expect(assertEnrollment(withoutExclusion)).rejects.toThrow("test:unit excludes DB tests");
  });
});
