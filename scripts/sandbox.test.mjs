import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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

const temporaryRoots = [];

function createTempRepo() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "chase-sets-sandbox-"));
  temporaryRoots.push(rootDir);
  mkdirSync(path.join(rootDir, "bounded-contexts", "catalog"), { recursive: true });
  mkdirSync(path.join(rootDir, "bounded-contexts", "marketplace"), { recursive: true });
  writeFileSync(path.join(rootDir, "bounded-contexts", "catalog", "context.json"), "{}\n");
  writeFileSync(path.join(rootDir, "bounded-contexts", "catalog", "package.json"), "{}\n");
  writeFileSync(path.join(rootDir, "bounded-contexts", "marketplace", "context.json"), "{}\n");
  writeFileSync(path.join(rootDir, "bounded-contexts", "marketplace", "package.json"), "{}\n");
  return rootDir;
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
