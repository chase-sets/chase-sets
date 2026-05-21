import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverEnvTargets, syncLocalEnvFiles } from "./local-env.mjs";

const temporaryRoots = [];

function createTempRepo() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "chase-sets-local-env-"));
  const envHome = path.join(rootDir, "shared-env");
  temporaryRoots.push(rootDir);

  return { envHome, rootDir };
}

function write(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { encoding: "utf8", flush: true });
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { force: true, recursive: true });
  }
});

describe("local env sync", () => {
  it("discovers root test env and deployables with env examples", () => {
    const { envHome, rootDir } = createTempRepo();
    write(rootDir, "deployables/platform-api/.env.example", "PORT=6182\n");
    write(rootDir, "deployables/marketplace/package.json", "{}\n");

    expect(discoverEnvTargets({ envHome, rootDir }).map((target) => target.worktreeRelativePath)).toEqual([
      ".env.test.local",
      "deployables/platform-api/.env.local",
    ]);
  });

  it("seeds shared env from existing local env files", () => {
    const { envHome, rootDir } = createTempRepo();
    write(rootDir, ".env.test.local", "TEST_DATABASE_URL=postgresql://localhost/postgres\n");
    write(rootDir, "deployables/platform-api/.env.example", "PORT=6182\n");
    write(rootDir, "deployables/platform-api/.env.local", "STRIPE_SECRET_KEY=sk_test\n");

    const results = syncLocalEnvFiles({ command: "sync", envHome, rootDir });

    expect(
      results.filter((result) => result.action === "push").map((result) => result.target.worktreeRelativePath),
    ).toEqual([".env.test.local", "deployables/platform-api/.env.local"]);
  });

  it("hydrates a new worktree from shared env files", () => {
    const { envHome, rootDir } = createTempRepo();
    write(rootDir, "deployables/platform-api/.env.example", "PORT=6182\n");
    write(envHome, ".env.test.local", "TEST_DATABASE_URL=postgresql://localhost/postgres\n");
    write(envHome, "deployables/platform-api/.env.local", "STRIPE_SECRET_KEY=sk_test\n");

    const results = syncLocalEnvFiles({ command: "sync", envHome, rootDir });

    expect(
      results.filter((result) => result.action === "pull").map((result) => result.target.worktreeRelativePath),
    ).toEqual([".env.test.local", "deployables/platform-api/.env.local"]);
  });

  it("reports drift without writing during check", () => {
    const { envHome, rootDir } = createTempRepo();
    write(rootDir, "deployables/platform-api/.env.example", "PORT=6182\n");
    write(rootDir, "deployables/platform-api/.env.local", "STRIPE_SECRET_KEY=local\n");
    write(envHome, "deployables/platform-api/.env.local", "STRIPE_SECRET_KEY=shared\n");

    const results = syncLocalEnvFiles({ command: "check", envHome, rootDir });

    const result = results.find((entry) => entry.target.worktreeRelativePath === "deployables/platform-api/.env.local");

    expect(result).toMatchObject({ status: "drifted" });
    expect(["pull", "push"]).toContain(result.action);
  });
});
