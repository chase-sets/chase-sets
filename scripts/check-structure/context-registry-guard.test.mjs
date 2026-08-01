import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contextRegistryMembershipArms, validateContextRegistries } from "./context-registry-guard.mjs";

const rows = JSON.parse(
  readFileSync(new URL("./fixtures/context-registry-guard/membership-rows.json", import.meta.url), "utf8"),
);
const tempRoots = [];
const targets = [
  ["platform-api", "deployables/platform-api/src/context-registry.ts"],
  ["platform-worker", "deployables/platform-worker/src/context-registry.ts"],
  ["admin-web", "deployables/admin-web/app/context-registry.ts"],
  ["marketplace-web", "deployables/marketplace/app/context-registry.ts"],
  ["public-web", "deployables/public-web/app/context-registry.ts"],
];

function write(root, relativePath, contents) {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, "utf8");
}

function registrySource(contextName, present) {
  return present
    ? `export const registry = [\n  { contextName: "${contextName}" },\n] as const;\n`
    : "export const registry = [] as const;\n";
}

function createFixture(row) {
  const root = mkdtempSync(path.join(tmpdir(), "context-registry-guard-"));
  tempRoots.push(root);
  const contextName = `fixture-${row.id}`;
  write(
    root,
    `bounded-contexts/${contextName}/context.json`,
    `${JSON.stringify({ contextName, ...row.manifest }, null, 2)}\n`,
  );
  for (const [host, relativePath] of targets) {
    write(root, relativePath, registrySource(contextName, row.present.includes(host)));
  }
  return { root, contextName };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("context registry membership guard", () => {
  it.each(rows)("proves the $id fixture row", (row) => {
    const { root } = createFixture(row);
    expect(validateContextRegistries({ rootDir: root }).violations).toEqual([]);
  });

  it.each(rows.filter((row) => row.id !== "no-matching-arm"))(
    "executes the $id arm-removal mutant and turns its authoritative row red",
    (row) => {
      const { root, contextName } = createFixture(row);
      const mutatedArms = contextRegistryMembershipArms.filter((arm) => arm.id !== row.id);
      const result = validateContextRegistries({ rootDir: root, membershipArms: mutatedArms });
      const expectedHost = row.id.startsWith("api-")
        ? "platform-api"
        : row.id.startsWith("worker-")
          ? "platform-worker"
          : row.present[0];
      expect(result.violations.join("\n")).toContain(contextName);
      expect(result.violations.join("\n")).toContain(expectedHost);
    },
  );

  it("fails when a manifest stops claiming a host but its committed entry remains", () => {
    const row = rows.find((candidate) => candidate.id === "api-apiDeployables");
    const { root, contextName } = createFixture(row);
    write(root, `bounded-contexts/${contextName}/context.json`, `${JSON.stringify({ contextName }, null, 2)}\n`);

    expect(validateContextRegistries({ rootDir: root }).violations.join("\n")).toMatch(
      new RegExp(`platform-api.*unexpected ${contextName}`),
    );
  });

  it("fails when a manifest claims a host but its committed entry is absent", () => {
    const row = rows.find((candidate) => candidate.id === "no-matching-arm");
    const { root, contextName } = createFixture(row);
    write(
      root,
      `bounded-contexts/${contextName}/context.json`,
      `${JSON.stringify({ contextName, apiDeployables: ["platform-api"] }, null, 2)}\n`,
    );

    expect(validateContextRegistries({ rootDir: root }).violations.join("\n")).toMatch(
      new RegExp(`platform-api.*missing ${contextName}`),
    );
  });

  it("rejects a planted legacy path beside the surviving hand-authored module", () => {
    const row = rows.find((candidate) => candidate.id === "api-apiDeployables");
    const { root } = createFixture(row);
    const legacyPath = "deployables/platform-api/src/generated/api-context-registry.ts";
    write(root, legacyPath, "export const legacy = true;\n");

    expect(validateContextRegistries({ rootDir: root }).violations).toContain(
      `${legacyPath}: legacy generated context registry must be absent`,
    );
  });
});
