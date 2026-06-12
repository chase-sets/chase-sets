import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanLogs, findLogCleanupTargets } from "./clean-logs.mjs";

const temporaryRoots = [];

function createTempRepo() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "chase-sets-clean-logs-"));
  temporaryRoots.push(rootDir);
  return rootDir;
}

function write(rootDir, relativePath, content = "") {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { encoding: "utf8", flush: true });
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { force: true, recursive: true });
  }
});

describe("clean logs", () => {
  it("finds root log files and direct .tmp contents", () => {
    const rootDir = createTempRepo();
    write(rootDir, ".codex-public-web-copy-review.out.log");
    write(rootDir, "tmp-public-web.log");
    write(rootDir, "tmp-public-web.log.1");
    write(rootDir, ".tmp/cache/db.sqlite");
    write(rootDir, ".tmp/session.jsonl");
    write(rootDir, "nested/.codex-public-web-copy-review.out.log");
    write(rootDir, "server.log");

    expect(findLogCleanupTargets({ rootDir }).map((target) => target.relativePath)).toEqual([
      ".codex-public-web-copy-review.out.log",
      ".tmp/cache",
      ".tmp/session.jsonl",
      "tmp-public-web.log",
      "tmp-public-web.log.1",
    ]);
  });

  it("removes only the requested root logs and .tmp contents", () => {
    const rootDir = createTempRepo();
    write(rootDir, ".codex-public-web-copy-review.out.log");
    write(rootDir, "tmp-public-web.log.1");
    write(rootDir, ".tmp/cache/db.sqlite");
    write(rootDir, ".tmp/session.jsonl");
    write(rootDir, ".codex.log");
    write(rootDir, ".codex-note.txt");
    write(rootDir, "nested/tmp-public-web.log");
    write(rootDir, "server.log");

    expect(cleanLogs({ rootDir })).toEqual([
      ".codex-public-web-copy-review.out.log",
      ".tmp/cache",
      ".tmp/session.jsonl",
      "tmp-public-web.log.1",
    ]);

    expect(existsSync(path.join(rootDir, ".codex-public-web-copy-review.out.log"))).toBe(false);
    expect(existsSync(path.join(rootDir, "tmp-public-web.log.1"))).toBe(false);
    expect(readdirSync(path.join(rootDir, ".tmp"))).toEqual([]);
    expect(existsSync(path.join(rootDir, ".codex.log"))).toBe(true);
    expect(existsSync(path.join(rootDir, ".codex-note.txt"))).toBe(true);
    expect(existsSync(path.join(rootDir, "nested", "tmp-public-web.log"))).toBe(true);
    expect(existsSync(path.join(rootDir, "server.log"))).toBe(true);
  });
});
