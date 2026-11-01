import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTEXT_REGISTRY_ADMISSION_ARMS,
  contextRegistryTargets,
  validateContextRegistries,
} from "./context-registry-guard.mjs";
import { listBoundedContextManifests, repoRoot } from "../lib/repo.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("context registry guard", () => {
  it("checks every owner path against admitted manifests without importing registry values", () => {
    expect(contextRegistryTargets).toHaveLength(5);
    expect(CONTEXT_REGISTRY_ADMISSION_ARMS).toHaveLength(8);
    expect(validateContextRegistries(repoRoot)).toEqual([]);
  });

  it("rejects an omitted entry even when a decoy comment names it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "context-registry-guard-"));
    temporaryRoots.push(root);
    for (const target of contextRegistryTargets) {
      const source = readFileSync(path.join(repoRoot, target.relativePath), "utf8");
      const targetPath = path.join(root, target.relativePath);
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, source, "utf8");
    }
    const api = path.join(root, contextRegistryTargets[0].relativePath);
    writeFileSync(
      api,
      readFileSync(api, "utf8").replace('contextName: "auth",', 'contextName: "omitted-auth",'),
      "utf8",
    );
    expect(validateContextRegistries(root, { contexts: listBoundedContextManifests({ repoRoot }) })).toEqual(
      expect.arrayContaining([expect.stringContaining("membership/order")]),
    );
  });
});
