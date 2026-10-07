import { afterEach, expect, test, vi } from "vitest";
const fault = vi.hoisted(() => ({ suffix: null }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original();
  return {
    ...fs,
    open: (...args) => {
      if (fault.suffix && args[0].endsWith(fault.suffix)) throw new Error("SYNTHETIC_PRIVATE_WRITE_ERROR");
      return fs.open(...args);
    },
  };
});
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { publishCapturePacket } from "./publish-test-window.mjs";

const roots = [];
afterEach(async () => {
  fault.suffix = null;
  for (const root of roots.splice(0)) {
    if (!root.startsWith(resolve(tmpdir()) + "/") && !root.startsWith(resolve(tmpdir()) + "\\"))
      throw new Error("test-cleanup-path");
    await rm(root, { recursive: true, force: true });
  }
});

test("changing serialization cannot replace the manifest binding", async () => {
  const f = await fixture();
  let reads = 0;
  Object.defineProperty(f.packet, "manifestDigest", {
    enumerable: true,
    get: () => (++reads <= 2 ? f.digest : "0".repeat(64)),
  });
  await expect(publishCapturePacket(f.packet, f.manifestPath, f.digest)).rejects.toThrow(/^packet-invalid$/);
  expect(await readdir(f.root)).toEqual(["manifest.json"]);
});

test("a second-file failure removes only the owned partial and exposes no packet or private error", async () => {
  const f = await fixture();
  fault.suffix = "sha256.txt";
  await expect(publishCapturePacket(f.packet, f.manifestPath, f.digest)).rejects.toThrow(/^packet-invalid$/);
  expect(await readdir(f.root)).toEqual(["manifest.json"]);
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "boundary-publication-"));
  roots.push(root);
  const destination = join(root, "published");
  const manifestPath = join(root, "manifest.json");
  const manifest = {
    version: "provider-test-window/v1",
    noRetry: true,
    heads: { candidate: "a".repeat(40), executor: "a".repeat(40), journal: "b".repeat(40), deployed: "c".repeat(40) },
    configuration: { configDigest: "d".repeat(64) },
    paths: { packetDirectory: destination },
  };
  const bytes = JSON.stringify(manifest);
  await writeFile(manifestPath, bytes, { mode: 0o600 });
  const digest = createHash("sha256").update(bytes).digest("hex");
  const packet = {
    version: "provider-lifecycle-capture/v1",
    classification: "invalid",
    code: "cleanup-obligation-retained",
    replayQualified: false,
    manifestDigest: digest,
  };
  return { root, destination, manifestPath, digest, packet };
}
test("publication hashes only the validated bytes and atomically exposes both files", async () => {
  const f = await fixture();
  const result = await publishCapturePacket(f.packet, f.manifestPath, f.digest);
  const bytes = await readFile(join(f.destination, "packet.json"));
  expect(JSON.parse(bytes)).toEqual(f.packet);
  expect(await readFile(join(f.destination, "sha256.txt"), "utf8")).toBe(result.packetDigest);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(result.packetDigest);
  expect(await readdir(f.root)).toEqual(["manifest.json", "published"]);
});
test("concurrent publication has one winner and never replaces existing data", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([1, 2].map(() => publishCapturePacket(f.packet, f.manifestPath, f.digest)));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  await expect(publishCapturePacket(f.packet, f.manifestPath, f.digest)).rejects.toThrow(/^packet-invalid$/);
  expect(JSON.parse(await readFile(join(f.destination, "packet.json")))).toEqual(f.packet);
});
test("invalid private bytes, digest mismatch and existing partial directory publish nothing", async () => {
  const f = await fixture();
  for (const packet of [
    { ...f.packet, marker: "SYNTHETIC_PRIVATE_MARKER" },
    { ...f.packet, manifestDigest: "0".repeat(64) },
  ])
    await expect(publishCapturePacket(packet, f.manifestPath, f.digest)).rejects.toThrow(/^packet-invalid$/);
  expect(await readdir(f.root)).toEqual(["manifest.json"]);
  await mkdir(f.destination + ".partial");
  await writeFile(join(f.destination + ".partial", "owner"), "SYNTHETIC_PRIVATE_MARKER");
  await expect(publishCapturePacket(f.packet, f.manifestPath, f.digest)).rejects.toThrow(/^packet-invalid$/);
  expect(await readFile(join(f.destination + ".partial", "owner"), "utf8")).toBe("SYNTHETIC_PRIVATE_MARKER");
});
