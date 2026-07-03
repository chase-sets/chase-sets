import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findWorkspaceDirectoryManifestViolations } from "./run.mjs";

let tempRoot;

async function createTempRepo() {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "chase-sets-structure-"));
  for (const root of ["bounded-contexts", "contracts", "infrastructure", "packages", "deployables"]) {
    await mkdir(path.join(tempRoot, root), { recursive: true });
  }
  return tempRoot;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("workspace directory manifest guard", () => {
  it("fails package.json-less workspace directories", async () => {
    const repoRoot = await createTempRepo();
    await mkdir(path.join(repoRoot, "contracts", "ghost-contract"));

    await expect(findWorkspaceDirectoryManifestViolations({ repoRoot })).resolves.toContainEqual({
      path: "contracts/ghost-contract/package.json",
      message: "workspace directory must declare package.json or be added to the retired-path list",
    });
  });

  it("fails retired workspace names when they reappear", async () => {
    const repoRoot = await createTempRepo();
    await mkdir(path.join(repoRoot, "bounded-contexts", "support"));

    await expect(findWorkspaceDirectoryManifestViolations({ repoRoot })).resolves.toContainEqual({
      path: "bounded-contexts/support",
      message: "retired workspace directory should not exist",
    });
  });

  it("requires bounded context package directories to keep context manifests", async () => {
    const repoRoot = await createTempRepo();
    const contextRoot = path.join(repoRoot, "bounded-contexts", "catalog");
    await mkdir(contextRoot);
    await writeJson(path.join(contextRoot, "package.json"), { name: "@chase-sets/catalog" });

    await expect(findWorkspaceDirectoryManifestViolations({ repoRoot })).resolves.toContainEqual({
      path: "bounded-contexts/catalog/context.json",
      message: "bounded context workspace directory must declare context.json",
    });
  });

  it("allows approved non-package infrastructure container roots", async () => {
    const repoRoot = await createTempRepo();
    await mkdir(path.join(repoRoot, "infrastructure", "digitalocean"));
    await mkdir(path.join(repoRoot, "infrastructure", "remote-dev"));

    await expect(findWorkspaceDirectoryManifestViolations({ repoRoot })).resolves.toEqual([]);
  });
});
