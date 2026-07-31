import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishArtifact, readAndValidateArtifact } from "./runner.mts";
import { makeArtifact } from "./test-support.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "route-census-publication-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("atomic exact-payload publication", () => {
  it("writes one sibling temp, flushes/closes, renames, and leaves no residue", async () => {
    const directory = await temporaryDirectory();
    const output = path.join(directory, "artifact.json");
    const { artifact } = await makeArtifact();
    await publishArtifact(output, artifact);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(artifact);
    expect(await readdir(directory)).toEqual(["artifact.json"]);
  });

  it("creates the fresh GUID parent used by the literal downstream workflow", async () => {
    const directory = await temporaryDirectory();
    const output = path.join(directory, "route-census", "fresh-guid", "artifact.json");
    const { artifact } = await makeArtifact();
    await publishArtifact(output, artifact);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(artifact);
    expect(await readdir(path.dirname(output))).toEqual(["artifact.json"]);
  });

  it("preserves an existing sentinel byte-for-byte", async () => {
    const directory = await temporaryDirectory();
    const output = path.join(directory, "artifact.json");
    await writeFile(output, "sentinel", "utf8");
    const { artifact } = await makeArtifact();
    await expect(publishArtifact(output, artifact)).rejects.toMatchObject({ code: "E_OUTPUT_EXISTS" });
    expect(await readFile(output, "utf8")).toBe("sentinel");
    expect(await readdir(directory)).toEqual(["artifact.json"]);
  });

  it.each([
    ["missing", null],
    ["wrong", "[]"],
    ["duplicate", '{"schemaVersion":"chase-sets-route-parity/v4","schemaVersion":"chase-sets-route-parity/v4"}'],
    ["malformed", "{"],
  ])("refuses %s canonical payload", async (name, bytes) => {
    const directory = await temporaryDirectory();
    const artifactPath = path.join(directory, `${name}.json`);
    if (bytes !== null) await writeFile(artifactPath, bytes, "utf8");
    await expect(
      readAndValidateArtifact(artifactPath, {
        baseHead: "0".repeat(40),
        candidateHead: "0".repeat(40),
        harnessHead: "0".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "E_ARTIFACT_INVALID" });
  });

  it("refuses a nonempty directory in place of the exact payload", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "something.json"), "{}", "utf8");
    await expect(
      readAndValidateArtifact(directory, {
        baseHead: "0".repeat(40),
        candidateHead: "0".repeat(40),
        harnessHead: "0".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "E_ARTIFACT_INVALID" });
  });
});
