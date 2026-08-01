import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../lib/repo.mjs";

export const contextRegistryMembershipArms = Object.freeze([
  Object.freeze({
    id: "api-apiDeployables",
    kind: "api",
    matches: (manifest, host) => manifest.apiDeployables?.includes(host) === true,
  }),
  Object.freeze({
    id: "api-sourceRuntimeDeployables",
    kind: "api",
    matches: (manifest, host) => manifest.sourceRuntimeDeployables?.includes(host) === true,
  }),
  Object.freeze({
    id: "api-sourceRuntimeProfiles",
    kind: "api",
    matches: (manifest) => (manifest.sourceRuntimeProfiles?.length ?? 0) > 0,
  }),
  Object.freeze({
    id: "worker-runtimeDeployables",
    kind: "worker",
    matches: (manifest, host) => manifest.runtimeDeployables?.includes(host) === true,
  }),
  Object.freeze({
    id: "worker-sourceRuntimeDeployables",
    kind: "worker",
    matches: (manifest, host) => manifest.sourceRuntimeDeployables?.includes(host) === true,
  }),
  Object.freeze({
    id: "worker-sourceRuntimeProfiles",
    kind: "worker",
    matches: (manifest) => (manifest.sourceRuntimeProfiles?.length ?? 0) > 0,
  }),
  Object.freeze({
    id: "web-deployableContributions",
    kind: "web",
    matches: (manifest, host) =>
      manifest.deployableContributions?.some((contribution) => contribution.deployable === host) === true,
  }),
  Object.freeze({
    id: "web-shellContributions",
    kind: "web",
    matches: (manifest, host) =>
      manifest.shellContributions?.some((contribution) => contribution.deployable === host) === true,
  }),
]);

const registryTargets = Object.freeze([
  Object.freeze({
    host: "platform-api",
    kind: "api",
    relativePath: "deployables/platform-api/src/context-registry.ts",
  }),
  Object.freeze({
    host: "platform-worker",
    kind: "worker",
    relativePath: "deployables/platform-worker/src/context-registry.ts",
  }),
  Object.freeze({ host: "admin-web", kind: "web", relativePath: "deployables/admin-web/app/context-registry.ts" }),
  Object.freeze({
    host: "marketplace-web",
    kind: "web",
    relativePath: "deployables/marketplace/app/context-registry.ts",
  }),
  Object.freeze({ host: "public-web", kind: "web", relativePath: "deployables/public-web/app/context-registry.ts" }),
]);

export const legacyContextRegistryPaths = Object.freeze([
  "deployables/platform-api/src/generated/api-context-registry.ts",
  "deployables/platform-worker/src/generated/worker-context-registry.ts",
  "deployables/admin-web/app/generated/web-context-registry.ts",
  "deployables/marketplace/app/generated/web-context-registry.ts",
  "deployables/public-web/app/generated/web-context-registry.ts",
]);

function listManifests(rootDir, violations) {
  const contextsRoot = path.join(rootDir, "bounded-contexts");
  if (!existsSync(contextsRoot)) {
    violations.push("bounded-contexts: context manifest root is missing");
    return [];
  }
  const manifests = [];
  for (const entry of readdirSync(contextsRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const relativePath = `bounded-contexts/${entry.name}/context.json`;
    const manifestPath = path.join(rootDir, relativePath);
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.contextName !== "string" || manifest.contextName.length === 0) {
        violations.push(`${relativePath}: contextName must be a non-empty string`);
      } else {
        manifests.push(manifest);
      }
    } catch (error) {
      violations.push(
        `${relativePath}: manifest could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return manifests.sort((left, right) => left.contextName.localeCompare(right.contextName));
}

function readCommittedNames(rootDir, target, violations) {
  const registryPath = path.join(rootDir, target.relativePath);
  if (!existsSync(registryPath)) {
    violations.push(`${target.relativePath}: context registry is missing`);
    return [];
  }
  const source = readFileSync(registryPath, "utf8");
  const names = [...source.matchAll(/\bcontextName:\s*["']([^"']+)["']/g)].map((match) => match[1]);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    violations.push(`${target.relativePath}: duplicate context entries: ${[...new Set(duplicates)].join(", ")}`);
  }
  return names;
}

export function validateContextRegistries({ rootDir = repoRoot, membershipArms = contextRegistryMembershipArms } = {}) {
  const violations = [];
  const manifests = listManifests(rootDir, violations);
  for (const target of registryTargets) {
    const applicableArms = membershipArms.filter((arm) => arm.kind === target.kind);
    const expected = manifests
      .filter((manifest) => applicableArms.some((arm) => arm.matches(manifest, target.host)))
      .map((manifest) => manifest.contextName);
    const committed = readCommittedNames(rootDir, target, violations);
    if (JSON.stringify(committed) !== JSON.stringify(expected)) {
      const missing = expected.filter((name) => !committed.includes(name));
      const extra = committed.filter((name) => !expected.includes(name));
      const details = [
        missing.length > 0 ? `missing ${missing.join(", ")}` : null,
        extra.length > 0 ? `unexpected ${extra.join(", ")}` : null,
        missing.length === 0 && extra.length === 0 ? "entry order differs from manifest order" : null,
      ].filter(Boolean);
      violations.push(`${target.relativePath}: ${target.host} membership drift (${details.join("; ")})`);
    }
  }
  for (const relativePath of legacyContextRegistryPaths) {
    if (existsSync(path.join(rootDir, relativePath))) {
      violations.push(`${relativePath}: legacy generated context registry must be absent`);
    }
  }
  return { violations, warnings: [] };
}
