import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./repo.mjs";

describe("tracked checkout write guard", () => {
  it("rejects the old real-checkout writer shape before bytes change", () => {
    const target = path.join(repoRoot, "scripts/lib/tracked-checkout-write-guard.test.mjs");
    const original = readFileSync(target, "utf8");
    expect(() => writeFileSync(target, original, "utf8")).toThrow(
      "tracked-checkout-write-guard: refusing write to tracked path 'scripts/lib/tracked-checkout-write-guard.test.mjs'",
    );
    expect(readFileSync(target, "utf8")).toEqual(original);
  });

  it("allows tracked files in private committed fixtures and ignored artifacts", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "chase-sets-write-guard-"));
    try {
      const tracked = path.join(fixture, "scripts/lib/tracked-checkout-write-guard.test.mjs");
      mkdirSync(path.dirname(tracked), { recursive: true });
      writeFileSync(tracked, "before\n");
      execFileSync("git", ["init", "--quiet"], { cwd: fixture });
      execFileSync("git", ["add", "."], { cwd: fixture });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: fixture });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: fixture });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: fixture });
      writeFileSync(tracked, "after\n", "utf8");
      expect(readFileSync(tracked, "utf8")).toBe("after\n");
      const ignored = path.join(repoRoot, "artifacts", "tracked-checkout-write-guard-test.txt");
      mkdirSync(path.dirname(ignored), { recursive: true });
      expect(execFileSync("git", ["check-ignore", ignored], { cwd: repoRoot, encoding: "utf8" }).trim()).toBeTruthy();
      try {
        writeFileSync(ignored, "ignored\n", "utf8");
        expect(readFileSync(ignored, "utf8")).toBe("ignored\n");
      } finally {
        rmSync(ignored, { force: true });
      }
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  it("allows a read-only callback open of a tracked real-checkout path", async () => {
    const target = path.join(repoRoot, "scripts/lib/tracked-checkout-write-guard.test.mjs");
    await expect(
      new Promise((resolve, reject) =>
        fs.open(target, (error, fd) => (error ? reject(error) : fs.close(fd, resolve))),
      ),
    ).resolves.toBeNull();
  });
});
