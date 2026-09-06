import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDockerComposeArgs,
  buildSandboxEnv,
  ensureWorktreeSandboxEnvironment,
  getContextDatabaseEnvName,
  listSandboxDatabases,
  mergeSandboxEnvFile,
  normalizeSandboxWorktreeIdentity,
  resolveWorktreeSandbox,
} from "./lib/sandbox.mjs";
import { repoRoot } from "./lib/repo.mjs";
import { primeBrowserE2eProjectionWakeRelayCursors } from "./browser-e2e-readiness.mjs";

const temporaryRoots = [];

function createTempRepo() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "chase-sets-sandbox-"));
  temporaryRoots.push(rootDir);
  writeContext(rootDir, "catalog", { contextName: "catalog", apiDeployables: ["platform-api"] });
  writeContext(rootDir, "marketplace", {
    contextName: "marketplace",
    sourceRuntimeDeployables: ["platform-api"],
  });
  return rootDir;
}

function writeContext(rootDir, dirName, manifest) {
  const contextDir = path.join(rootDir, "bounded-contexts", dirName);
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(path.join(contextDir, "context.json"), `${JSON.stringify(manifest)}\n`);
  writeFileSync(path.join(contextDir, "package.json"), `${JSON.stringify({ name: `@chase-sets/${dirName}` })}\n`);
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { force: true, recursive: true });
  }
});

describe("worktree sandbox", () => {
  it("derives stable sandbox identity and ports from the worktree path", () => {
    const rootDir = createTempRepo();
    const left = resolveWorktreeSandbox({ rootDir, env: {} });
    const right = resolveWorktreeSandbox({ rootDir, env: {} });

    expect(left.id).toBe(right.id);
    expect(left.basePort).toBe(right.basePort);
    expect(left.ports.platformApi).toBe(left.basePort + 12);
    expect(left.ports.postgres).toBe(left.basePort + 20);
  });

  it("canonicalizes Windows-shaped worktree identities case-insensitively on every host", () => {
    const upper = resolveWorktreeSandbox({
      rootDir: "C:\\Repos\\Chase Sets\\Feature",
      env: {},
      contextNames: [],
    });
    const lower = resolveWorktreeSandbox({
      rootDir: "c:\\repos\\chase sets\\feature",
      env: {},
      contextNames: [],
    });

    expect(upper.id).toBe(lower.id);
    expect(upper.basePort).toBe(lower.basePort);
  });

  it("derives Windows-shaped sandbox identities before native path resolution on every host", () => {
    const upperWindowsWorktree = "C:\\Repos\\Chase Sets\\Feature";
    const lowerWindowsWorktree = "c:\\repos\\chase sets\\feature";
    const nativeResolve = path.resolve;
    const resolve = vi.spyOn(path, "resolve").mockImplementation((...segments) => {
      if (segments.length === 1 && [upperWindowsWorktree, lowerWindowsWorktree].includes(segments[0])) {
        return path.posix.resolve("/synthetic-linux-host", segments[0]);
      }
      return nativeResolve(...segments);
    });

    try {
      const upper = resolveWorktreeSandbox({
        rootDir: upperWindowsWorktree,
        env: {},
        contextNames: [],
      });
      const lower = resolveWorktreeSandbox({
        rootDir: lowerWindowsWorktree,
        env: {},
        contextNames: [],
      });

      expect(upper.id).toBe(lower.id);
      expect(upper.basePort).toBe(lower.basePort);
    } finally {
      resolve.mockRestore();
    }
  });

  it("canonicalizes Windows UNC worktree identities case-insensitively on every host", () => {
    expect(normalizeSandboxWorktreeIdentity("\\\\Server\\Share\\Chase Sets\\Feature")).toBe(
      normalizeSandboxWorktreeIdentity("\\\\server\\share\\chase sets\\feature"),
    );
  });

  it("preserves POSIX-shaped worktree identity case on every host", () => {
    const upper = "/repos/Chase Sets/Feature";
    const lower = "/repos/chase sets/feature";

    expect(normalizeSandboxWorktreeIdentity(upper)).toBe(upper);
    expect(normalizeSandboxWorktreeIdentity(lower)).toBe(lower);
    expect(normalizeSandboxWorktreeIdentity(upper)).not.toBe(normalizeSandboxWorktreeIdentity(lower));
  });

  it("honors explicit id and port overrides", () => {
    const rootDir = createTempRepo();
    const sandbox = resolveWorktreeSandbox({
      rootDir,
      env: {
        CHASE_SETS_SANDBOX_ID: "feature-checkout",
        CHASE_SETS_SANDBOX_BASE_PORT: "7400",
        CHASE_SETS_PORT_PLATFORM_API: "8123",
      },
    });

    expect(sandbox.id).toBe("feature-checkout");
    expect(sandbox.basePort).toBe(7400);
    expect(sandbox.ports.portal).toBe(7400);
    expect(sandbox.ports.platformApi).toBe(8123);
  });

  it("builds generated env without relying on shared local env files", () => {
    const rootDir = createTempRepo();
    const sandbox = resolveWorktreeSandbox({
      rootDir,
      env: { CHASE_SETS_SANDBOX_ID: "abc123", CHASE_SETS_SANDBOX_BASE_PORT: "7000" },
    });
    const env = buildSandboxEnv(sandbox);

    expect(env.TEST_DATABASE_URL).toBe("postgresql://postgres:postgres@localhost:7020/postgres");
    expect(env.PLATFORM_CONTROL_DATABASE_URL).toContain("/cs_abc123_control");
    expect(env.PLATFORM_WORK_SIGNAL_DATABASE_URL).toBe(env.PLATFORM_CONTROL_DATABASE_URL);
    expect(env.CHASE_SETS_SANDBOX_WORKTREE).toBe(normalizeSandboxWorktreeIdentity(rootDir));
    expect(env[getContextDatabaseEnvName("catalog")]).toContain("/cs_abc123_catalog");
    expect(env[getContextDatabaseEnvName("marketplace")]).toContain("/cs_abc123_marketplace");
    expect(env.STRIPE_WEBHOOK_FORWARD_URL).toBe("http://host.docker.internal:7012/api/payments/provider/webhooks");
  });

  it("exposes the canonical coordinated database inventory as control plus every discovered context", () => {
    const rootDir = createTempRepo();
    const sandbox = resolveWorktreeSandbox({
      rootDir,
      env: { CHASE_SETS_SANDBOX_ID: "inventory", CHASE_SETS_SANDBOX_BASE_PORT: "7000" },
    });

    expect(listSandboxDatabases(sandbox).map(({ key }) => key)).toEqual(["control", "catalog", "marketplace"]);
  });

  it("sandbox-platform-api-database-owner-parity matches the generated registry and rejects a deletion mutant", () => {
    const registrySource = readFileSync(
      path.join(repoRoot, "deployables", "platform-api", "src", "generated", "api-context-registry.ts"),
      "utf8",
    );
    const generatedContextNames = [...registrySource.matchAll(/^\s+contextName: "([^"]+)",$/gmu)].map(
      ([, contextName]) => contextName,
    );
    const sandbox = resolveWorktreeSandbox({ rootDir: repoRoot, env: {}, contextNames: undefined });

    expect(sandbox.contextNames).toEqual(generatedContextNames);
    expect(sandbox.contextNames).not.toEqual(generatedContextNames.slice(1));

    const injected = resolveWorktreeSandbox({ rootDir: repoRoot, env: {}, contextNames: ["neutral-injected"] });
    expect(injected.contextNames).toEqual(["neutral-injected"]);
    expect(Object.keys(injected.contextDatabaseUrls)).toEqual(["neutral-injected"]);
  });

  it("sandbox-excludes-behavior-free-context from databases, environment, and cursor targets", () => {
    const rootDir = createTempRepo();
    writeContext(rootDir, "neutral-foundation", { contextName: "neutral-foundation" });

    const sandbox = resolveWorktreeSandbox({
      rootDir,
      env: { CHASE_SETS_SANDBOX_ID: "behavior-free", CHASE_SETS_SANDBOX_BASE_PORT: "7000" },
    });
    const env = buildSandboxEnv(sandbox);

    expect(sandbox.contextNames).toEqual(["catalog", "marketplace"]);
    expect(sandbox.contextDatabaseUrls).not.toHaveProperty("neutral-foundation");
    expect(listSandboxDatabases(sandbox).map(({ key }) => key)).toEqual(["control", "catalog", "marketplace"]);
    expect(env).not.toHaveProperty(getContextDatabaseEnvName("neutral-foundation"));
  });

  it("channels-behavior-backed-sandbox-inclusion keeps the registered context in database, env, and cursor targets", async () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "bounded-contexts/channels/context.json"), "utf8"));
    expect(manifest.contextName).toBe("channels");
    const sandbox = resolveWorktreeSandbox({ rootDir: repoRoot, env: {} });
    expect(sandbox.contextNames).toContain("channels");
    expect(sandbox.contextDatabaseUrls).toHaveProperty("channels");
    expect(listSandboxDatabases(sandbox).map(({ key }) => key)).toContain("channels");
    expect(buildSandboxEnv(sandbox)).toHaveProperty("DATABASE_URL_CHANNELS");

    const queried = [];
    await primeBrowserE2eProjectionWakeRelayCursors({
      sandbox,
      createClient: (connectionString) => ({
        connect: async () => undefined,
        end: async () => undefined,
        query: async (sql) => {
          if (sql.includes("FROM event_store_events")) queried.push(connectionString);
          return { rows: [{ max_position: "0" }] };
        },
      }),
    });
    expect(queried.sort()).toEqual(Object.values(sandbox.contextDatabaseUrls).sort());
    expect(queried).toContain(sandbox.contextDatabaseUrls.channels);

    const rootDir = createTempRepo();
    const unregisteredManifest = {
      ...manifest,
      apiDeployables: [],
      sourceRuntimeDeployables: [],
      sourceRuntimeProfiles: [],
    };
    writeContext(rootDir, "channels", unregisteredManifest);
    expect(resolveWorktreeSandbox({ rootDir, env: {} }).contextNames).not.toContain("channels");
    writeContext(rootDir, "channels", { ...unregisteredManifest, apiDeployables: ["platform-api"] });
    const registered = resolveWorktreeSandbox({ rootDir, env: {} });
    expect(registered.contextNames).toContain("channels");
    expect(buildSandboxEnv(registered)).toHaveProperty("DATABASE_URL_CHANNELS");
  });

  it("sandbox-database-owner-consumer-parity keeps every owner consumer on one resolved set", () => {
    const rootDir = createTempRepo();
    writeContext(rootDir, "profile-owner", {
      contextName: "profile-owner",
      sourceRuntimeProfiles: ["neutral-profile"],
    });
    writeContext(rootDir, "sibling-host", {
      contextName: "sibling-host",
      apiDeployables: ["sibling-api"],
    });

    const sandbox = resolveWorktreeSandbox({
      rootDir,
      env: { CHASE_SETS_SANDBOX_ID: "consumers", CHASE_SETS_SANDBOX_BASE_PORT: "7000" },
    });
    const env = buildSandboxEnv(sandbox);
    const ownerNames = ["catalog", "marketplace", "profile-owner"];

    expect(sandbox.contextNames).toEqual(ownerNames);
    expect(Object.keys(sandbox.contextDatabaseUrls)).toEqual(ownerNames);
    expect(listSandboxDatabases(sandbox).map(({ key }) => key)).toEqual(["control", ...ownerNames]);
    expect(ownerNames.map(getContextDatabaseEnvName).filter((envName) => envName in env)).toEqual(
      ownerNames.map(getContextDatabaseEnvName),
    );
    expect(env).not.toHaveProperty(getContextDatabaseEnvName("sibling-host"));
  });

  it("sandbox-database-owner-discovery-fail-closed excludes ghosts and rejects malformed manifests before env output", () => {
    const rootDir = createTempRepo();
    const ghostDir = path.join(rootDir, "bounded-contexts", "neutral-ghost", "node_modules");
    mkdirSync(ghostDir, { recursive: true });
    writeFileSync(path.join(ghostDir, "ignored.txt"), "ignored\n");

    expect(resolveWorktreeSandbox({ rootDir, env: {} }).contextNames).toEqual(["catalog", "marketplace"]);

    const malformedDir = path.join(rootDir, "bounded-contexts", "neutral-malformed");
    const envFilePath = path.join(rootDir, "malformed.env");
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(path.join(malformedDir, "context.json"), '{"contextName":\n');
    writeFileSync(
      path.join(malformedDir, "package.json"),
      `${JSON.stringify({ name: "@chase-sets/neutral-malformed" })}\n`,
    );

    expect(() =>
      ensureWorktreeSandboxEnvironment({
        rootDir,
        env: { CHASE_SETS_SANDBOX_ENV_FILE: envFilePath },
      }),
    ).toThrow(SyntaxError);
    expect(existsSync(envFilePath)).toBe(false);
  });

  it("sandbox-environment-drops-legacy-owner-database-url from both the ensure and merge paths", () => {
    const rootDir = createTempRepo();
    writeContext(rootDir, "neutral-foundation", {
      contextName: "neutral-foundation",
      apiDeployables: ["platform-api"],
    });
    const envFilePath = path.join(rootDir, "legacy.env");
    const baseEnv = {
      CHASE_SETS_SANDBOX_ID: "legacy",
      CHASE_SETS_SANDBOX_BASE_PORT: "7000",
      CHASE_SETS_SANDBOX_ENV_FILE: envFilePath,
    };

    const { env: legacyEnv } = mergeSandboxEnvFile({ NEUTRAL_RETAINED_SETTING: "kept" }, { rootDir, env: baseEnv });
    expect(legacyEnv).toHaveProperty("DATABASE_URL_NEUTRAL_FOUNDATION");
    writeContext(rootDir, "neutral-foundation", { contextName: "neutral-foundation" });

    const { env: ensuredEnv } = ensureWorktreeSandboxEnvironment({ rootDir, env: baseEnv });

    expect(ensuredEnv).not.toHaveProperty("DATABASE_URL_NEUTRAL_FOUNDATION");
    expect(ensuredEnv.NEUTRAL_RETAINED_SETTING).toBe("kept");
    expect(ensuredEnv[getContextDatabaseEnvName("catalog")]).toContain("/cs_legacy_catalog");
    const publishedAfterEnsure = readFileSync(envFilePath, "utf8");
    expect(publishedAfterEnsure).not.toContain("DATABASE_URL_NEUTRAL_FOUNDATION");
    expect(publishedAfterEnsure).toContain("NEUTRAL_RETAINED_SETTING=kept");

    writeFileSync(
      envFilePath,
      `${publishedAfterEnsure}DATABASE_URL_NEUTRAL_FOUNDATION=postgresql://stale-owner-again\n`,
    );

    const { env: mergedEnv } = mergeSandboxEnvFile({ NEUTRAL_MERGE_SETTING: "kept-too" }, { rootDir, env: baseEnv });

    expect(mergedEnv).not.toHaveProperty("DATABASE_URL_NEUTRAL_FOUNDATION");
    expect(mergedEnv.NEUTRAL_RETAINED_SETTING).toBe("kept");
    expect(mergedEnv.NEUTRAL_MERGE_SETTING).toBe("kept-too");
    expect(mergedEnv[getContextDatabaseEnvName("marketplace")]).toContain("/cs_legacy_marketplace");
    const publishedAfterMerge = readFileSync(envFilePath, "utf8");
    expect(publishedAfterMerge).not.toContain("DATABASE_URL_NEUTRAL_FOUNDATION");
  });

  it("writes and updates the ignored per-worktree sandbox env file", () => {
    const rootDir = createTempRepo();
    const { sandbox } = ensureWorktreeSandboxEnvironment({
      rootDir,
      env: {
        CHASE_SETS_SANDBOX_ID: "docs",
        CHASE_SETS_SANDBOX_BASE_PORT: "7600",
      },
    });

    expect(readFileSync(sandbox.envFilePath, "utf8")).toContain("CHASE_SETS_SANDBOX_ID=docs");

    mergeSandboxEnvFile(
      { STRIPE_WEBHOOK_SECRET: "whsec_test" },
      {
        rootDir,
        env: {
          CHASE_SETS_SANDBOX_ID: "docs",
          CHASE_SETS_SANDBOX_BASE_PORT: "7600",
        },
      },
    );

    expect(readFileSync(sandbox.envFilePath, "utf8")).toContain("STRIPE_WEBHOOK_SECRET=whsec_test");

    ensureWorktreeSandboxEnvironment({
      rootDir,
      env: {
        CHASE_SETS_SANDBOX_ID: "docs",
        CHASE_SETS_SANDBOX_BASE_PORT: "7600",
      },
    });

    expect(readFileSync(sandbox.envFilePath, "utf8")).toContain("STRIPE_WEBHOOK_SECRET=whsec_test");
  });

  it("builds project-scoped Docker Compose arguments", () => {
    const rootDir = createTempRepo();
    const sandbox = resolveWorktreeSandbox({
      rootDir,
      env: { CHASE_SETS_SANDBOX_ID: "ports" },
    });

    expect(buildDockerComposeArgs(sandbox, ["up", "-d", "postgres"])).toEqual([
      "compose",
      "--env-file",
      sandbox.envFilePath,
      "-f",
      "docker-compose.dev.yml",
      "-p",
      "chase-sets-ports",
      "up",
      "-d",
      "postgres",
    ]);
  });
});
