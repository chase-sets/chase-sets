import { expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishCapturePacket } from "./publish-test-window.mjs";
import { syntheticHash, syntheticManifest } from "./test-window-fixtures.mjs";

it("AC-06 markers: atomic digest publication, interrupted invalid packet, collisions and partials never expose raw markers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "8255-synthetic-publication-"));
  const manifest = syntheticManifest();
  manifest.paths.packetDirectory = join(directory, "packet");
  const bytes = JSON.stringify(manifest);
  const path = join(directory, "manifest.json");
  await writeFile(path, bytes);
  const digest = syntheticHash(bytes);
  const packet = {
    version: "provider-lifecycle-capture/v1",
    classification: "invalid",
    code: "child-interrupted",
    manifestDigest: digest,
    replayQualified: false,
  };
  await expect(publishCapturePacket({ ...packet, raw: "SYNTHETIC_PRIVATE_MARKER" }, path, digest)).rejects.toThrow(
    "packet-invalid",
  );
  expect(await readdir(directory)).toEqual(["manifest.json"]);
  const result = await publishCapturePacket(packet, path, digest);
  const output = await readFile(join(manifest.paths.packetDirectory, "packet.json"));
  expect(syntheticHash(output)).toBe(result.packetDigest);
  expect(await readFile(join(manifest.paths.packetDirectory, "sha256.txt"), "utf8")).toBe(result.packetDigest);
  expect(JSON.parse(output).classification).toBe("invalid");
  expect(output.includes("SYNTHETIC_PRIVATE_MARKER")).toBe(false);
  expect((await readdir(manifest.paths.packetDirectory)).sort()).toEqual(["packet.json", "sha256.txt"]);
  await expect(publishCapturePacket(packet, path, digest)).rejects.toThrow("packet-exists");
  const interruptedManifest = syntheticManifest();
  interruptedManifest.paths.packetDirectory = join(directory, "interrupted");
  const interruptedBytes = JSON.stringify(interruptedManifest);
  const interruptedDigest = syntheticHash(interruptedBytes);
  const interruptedPath = join(directory, "interrupted-manifest.json");
  await writeFile(interruptedPath, interruptedBytes);
  await mkdir(`${interruptedManifest.paths.packetDirectory}.partial`);
  await expect(
    publishCapturePacket({ ...packet, manifestDigest: interruptedDigest }, interruptedPath, interruptedDigest),
  ).rejects.toThrow();
  expect((await readdir(directory)).includes("interrupted")).toBe(false);
});
