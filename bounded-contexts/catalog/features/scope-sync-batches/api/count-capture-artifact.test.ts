import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  syntheticCountLifecycleReceipt,
  syntheticCountLifecycleStopReceipt,
} from "../tests/count-lifecycle-receipt-fixture";
import { countLifecycleArtifactPath } from "../domain/count-lifecycle-receipt";
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
const refusal = /^count-capture-artifact-refused$/;
const marker = 'synthetic-session-"-marker';

describe("rejects unsafe lifecycle uploads", () => {
  it("writes the sole validated projection create-once and the upload scan reads back every field", async () => {
    const root = await workspace();
    const receipt = syntheticCountLifecycleReceipt();
    expect(await writeCountCaptureArtifact(receipt, [marker], root)).toMatchObject({
      valid: true,
      classification: { verdict: "CONFORMING" },
    });
    expect(await readdir(join(root, "artifacts/catalog-count-lifecycle"))).toEqual(["receipt.json"]);
    expect(JSON.parse(await readFile(join(root, countLifecycleArtifactPath), "utf8"))).toEqual(receipt);
    expect(await validateCountCaptureArtifacts([marker], root)).toMatchObject({ valid: true });
    await expect(writeCountCaptureArtifact(receipt, [], root)).rejects.toThrow(refusal);
  });

  it("retains a failure receipt and its evidence through the same normalization and upload scan", async () => {
    const root = await workspace();
    const receipt = syntheticCountLifecycleReceipt();
    receipt.effects.final.enqueues += 1;
    const failed = { verdict: "FAILED", reasons: ["authority-unbound", "unexpected-effects"] };
    const stop = {
      ...syntheticCountLifecycleStopReceipt(),
      evidence: { effects: receipt.effects, attribution: receipt.attribution },
      classification: { ...failed, acceptance: { "9431-ac7": failed, "9424-ac5": failed } },
    };
    expect(await writeCountCaptureArtifact(stop, [], root)).toMatchObject({ valid: true, classification: failed });
    expect(JSON.parse(await readFile(join(root, countLifecycleArtifactPath), "utf8"))).toEqual(stop);
  });

  it.each([
    ["attribution", (r: Record<string, unknown>) => Reflect.deleteProperty(r.attribution as object, "packetHash")],
    ["authority", (r: Record<string, unknown>) => Reflect.deleteProperty(r.authority as object, "collection")],
    ["consumption", (r: Record<string, unknown>) => Reflect.deleteProperty((r.consumption as object[])[0]!, "readAt")],
    ["classification", (r: Record<string, unknown>) => Reflect.deleteProperty(r, "classification")],
  ])("refuses a projection that dropped a required %s field before creating anything", async (_field, drop) => {
    const root = await workspace();
    const receipt = syntheticCountLifecycleReceipt();
    drop(receipt);
    await expect(writeCountCaptureArtifact(receipt, [], root)).rejects.toThrow(refusal);
    expect(await readdir(root)).toEqual([]);
  });

  it("proves scanner sensitivity with a leak-positive synthetic marker control", async () => {
    const control = syntheticCountLifecycleReceipt();
    await expect(writeCountCaptureArtifact(control, [marker], await workspace())).resolves.toMatchObject({
      valid: true,
    });
    const leaked = syntheticCountLifecycleReceipt();
    Reflect.set(leaked.authority.deployment, "jobName", `Deploy ${marker}`);
    const root = await workspace();
    await expect(writeCountCaptureArtifact(leaked, [marker], root)).rejects.toThrow(refusal);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ["raw", marker],
    ["escaped", JSON.stringify(marker)],
    ["uri", encodeURIComponent(marker)],
    ["base64", Buffer.from(marker).toString("base64")],
    ["session", "chase_sets_session"],
    ["bearer", "Bearer synthetic"],
    ["url", "https://synthetic.example"],
  ])("refuses a %s marker in any value before creating an artifact", async (_mode, value) => {
    const root = await workspace();
    const receipt = syntheticCountLifecycleReceipt();
    Reflect.set(receipt.authority.deployment, "stepName", value.slice(0, 256));
    await expect(writeCountCaptureArtifact(receipt, [marker], root)).rejects.toThrow(refusal);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a marker hidden behind JSON unicode escapes or placed in a key at the upload scan", async () => {
    const root = await workspace();
    await writeCountCaptureArtifact(syntheticCountLifecycleReceipt(), [], root);
    const path = join(root, countLifecycleArtifactPath);
    const escaped = (await readFile(path, "utf8")).replace(
      '"jobName":"Deploy Staging"',
      `"jobName":"Deploy \\u0073ynthetic-late-marker"`,
    );
    await writeFile(path, escaped);
    await expect(validateCountCaptureArtifacts(["synthetic-late-marker"], root)).rejects.toThrow(refusal);
    const keyed = escaped.replace('"jobName":', '"sessionCookie":');
    await writeFile(path, keyed);
    await expect(validateCountCaptureArtifacts([], root)).rejects.toThrow(refusal);
  });

  it.each(["trace.zip", "video.webm", "storage-state.json", "login.png"])(
    "refuses an unexpected %s beside the receipt at the final upload scan",
    async (file) => {
      const root = await workspace();
      await writeCountCaptureArtifact(syntheticCountLifecycleReceipt(), [], root);
      await writeFile(join(root, "artifacts/catalog-count-lifecycle", file), "synthetic");
      await expect(validateCountCaptureArtifacts([], root)).rejects.toThrow(refusal);
    },
  );

  it("refuses an oversized or reclassified receipt at the final upload scan", async () => {
    const root = await workspace();
    await writeCountCaptureArtifact(syntheticCountLifecycleReceipt(), [], root);
    const path = join(root, countLifecycleArtifactPath);
    const receipt = JSON.parse(await readFile(path, "utf8"));
    receipt.effects.complete = false;
    await writeFile(path, JSON.stringify(receipt));
    await expect(validateCountCaptureArtifacts([], root)).rejects.toThrow(refusal);
    await writeFile(path, " ".repeat(128_001));
    await expect(validateCountCaptureArtifacts([], root)).rejects.toThrow(refusal);
  });
});
