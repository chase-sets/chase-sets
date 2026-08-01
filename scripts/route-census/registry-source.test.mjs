import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  legacyApiContextRegistrySourcePath,
  movedApiContextRegistrySourcePath,
  resolveApiContextRegistrySource,
} from "./registry-source.mts";

const tempRoots = [];

function root() {
  const value = mkdtempSync(path.join(tmpdir(), "route-census-registry-source-"));
  tempRoots.push(value);
  return value;
}

function plant(rootDir, relativePath) {
  const absolutePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, "export const apiContextRegistry = [] as const;\n", "utf8");
}

afterEach(() => {
  for (const rootDir of tempRoots.splice(0)) rmSync(rootDir, { recursive: true, force: true });
});

describe("per-target-root API context registry resolution", () => {
  it("resolves the one moved path", () => {
    const rootDir = root();
    plant(rootDir, movedApiContextRegistrySourcePath);
    expect(resolveApiContextRegistrySource(rootDir).relativePath).toBe(movedApiContextRegistrySourcePath);
  });

  it("fails closed when both allowed paths exist", () => {
    const rootDir = root();
    plant(rootDir, movedApiContextRegistrySourcePath);
    plant(rootDir, legacyApiContextRegistrySourcePath);
    expect(() => resolveApiContextRegistrySource(rootDir)).toThrow(/contains both allowed API context registry paths/);
  });

  it("fails closed when neither allowed path exists", () => {
    expect(() => resolveApiContextRegistrySource(root())).toThrow(/contains neither allowed API context registry path/);
  });
});
