import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { syntheticCountLifecycleReceipt } from "../tests/count-lifecycle-receipt-fixture";
import { validateCountCaptureArtifacts, writeCountCaptureArtifact } from "./count-capture-artifact";

const roots: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "count-capture-artifact-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes("count-capture-artifact-"))
      throw new Error("unsafe-test-cleanup");
    await rm(root, { recursive: true });
  }
});

describe("rejects unsafe lifecycle uploads", () => {
  it("writes and independently reads the sole validated projection, never a trace", async () => {
    const root = await workspace();
    const receipt = syntheticCountLifecycleReceipt();
    expect(await writeCountCaptureArtifact(receipt, ["synthetic-private-session-marker"], root)).toMatchObject({
      verdict: "CONFORMING",
    });
    expect(await readdir(join(root, "artifacts/catalog-count-lifecycle"))).toEqual(["receipt.json"]);
    expect(JSON.parse(await readFile(join(root, "artifacts/catalog-count-lifecycle/receipt.json"), "utf8"))).toEqual(
      receipt,
    );
    expect(await validateCountCaptureArtifacts([], root)).toMatchObject({ valid: true });
    await expect(writeCountCaptureArtifact(receipt, [], root)).rejects.toThrow(/^count-capture-artifact-refused$/);
  });
  it("retains a stopped projection without representing unobserved effects as zero", async () => {
    const root = await workspace();
    expect(
      await writeCountCaptureArtifact(
        {
          schemaVersion: "scope-sync-count-lifecycle-stop/v1",
          stoppedAt: "2026-10-13T08:00:00Z",
          phase: "baseline",
          reason: "authority-unbound",
          evidence: {},
        },
        [],
        root,
      ),
    ).toMatchObject({ valid: true, verdict: "INCOMPLETE" });
  });
  it.each(["raw", "escaped", "base64", "session"])("refuses %s marker before creating any artifact", async (mode) => {
    const root = await workspace();
    const marker = 'synthetic-secret-"-with-escape';
    const receipt = syntheticCountLifecycleReceipt();
    receipt.authority.deployment.jobName =
      mode === "base64"
        ? Buffer.from(marker).toString("base64")
        : mode === "session"
          ? "chase_sets_session"
          : mode === "escaped"
            ? JSON.stringify(marker)
            : marker;
    await expect(writeCountCaptureArtifact(receipt, [marker], root)).rejects.toThrow(
      /^count-capture-artifact-refused$/,
    );
    expect(await readdir(root)).toEqual([]);
  });
  it.each(["trace.zip", "video.webm", "storage-state.json", "login.png"])(
    "refuses an unexpected %s at the final upload scan",
    async (file) => {
      const root = await workspace();
      await writeCountCaptureArtifact(syntheticCountLifecycleReceipt(), [], root);
      await writeFile(join(root, "artifacts/catalog-count-lifecycle", file), "synthetic-session-marker");
      await expect(validateCountCaptureArtifacts(["synthetic-session-marker"], root)).rejects.toThrow(
        /^count-capture-artifact-refused$/,
      );
    },
  );
  it("detects a marker introduced after the initial writer validation", async () => {
    const root = await workspace();
    const receipt = syntheticCountLifecycleReceipt();
    await writeCountCaptureArtifact(receipt, [], root);
    receipt.authority.deployment.jobName = "synthetic-late-secret";
    await writeFile(join(root, "artifacts/catalog-count-lifecycle/receipt.json"), JSON.stringify(receipt));
    await expect(validateCountCaptureArtifacts(["synthetic-late-secret"], root)).rejects.toThrow(
      /^count-capture-artifact-refused$/,
    );
  });
});
