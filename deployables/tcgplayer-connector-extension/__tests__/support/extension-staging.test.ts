import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { attestExtensionFiles, stageExtension } from "./extension-staging";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "connector-staging-test-"));
  roots.push(root);
  const source = join(root, "source");
  const destination = join(root, "destination");
  mkdirSync(join(source, "assets"), { recursive: true });
  mkdirSync(destination);
  for (const name of [
    "background.js",
    "manifest.json",
    "execution-identity.json",
    "fence.html",
    "fence-worker.js",
    "assets/unlisted.js",
  ])
    writeFileSync(join(source, name), `SYNTHETIC ${name}`);
  writeFileSync(join(destination, "seed.js"), "SYNTHETIC stale historical seed");
  return { source, destination };
}

it("stages the complete nested emitted set and removes stale files at both copy boundaries", () => {
  const { source, destination } = fixture();
  const first = stageExtension(source, destination);
  expect(first.stagedFiles).toEqual(first.sourceFiles);
  expect(first.stagedFiles.map(({ name }) => name)).toEqual([
    "assets/unlisted.js",
    "background.js",
    "execution-identity.json",
    "fence-worker.js",
    "fence.html",
    "manifest.json",
  ]);
  const installed = join(destination, "..", "profile", "extension-under-test");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "seed.js"), "SYNTHETIC stale seed");
  expect(stageExtension(destination, installed).stagedFiles).toEqual(first.sourceFiles);
});

it.each(["missing", "extra", "changed"])(
  "rejects a %s file rather than accepting presence-only evidence",
  (mutation) => {
    const { source, destination } = fixture();
    stageExtension(source, destination);
    if (mutation === "missing") rmSync(join(destination, "fence.html"));
    else writeFileSync(join(destination, mutation === "extra" ? "seed.js" : "background.js"), "SYNTHETIC mismatch");
    expect(() => attestExtensionFiles(source, destination)).toThrow("extension-staging-mismatch");
  },
);

it("rejects overlapping source and destination before deleting files", () => {
  const { source } = fixture();
  for (const destination of [source, join(source, "nested"), join(source, "..")])
    expect(() => stageExtension(source, destination)).toThrow("extension-staging-overlapping-paths");
});
