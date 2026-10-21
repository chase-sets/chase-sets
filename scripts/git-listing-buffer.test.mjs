import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GIT_LISTING_MAX_BUFFER, gitListingOptions } from "./lib/git-listing.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

function listingSiteInventory({ root = repoRoot, sources } = {}) {
  const tracked =
    sources ??
    execFileSync("git", ["-C", root, "ls-files", "-z", "--", "scripts"], gitListingOptions({ encoding: "utf8" }))
      .split("\0")
      .filter((file) => /^scripts\/.*\.[cm]?[jt]sx?$/.test(file) && file !== "scripts/git-listing-buffer.test.mjs");
  const sites = [];
  for (const relativePath of tracked) {
    const file = path.join(root, relativePath);
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const direct = /execFile(?:Sync|Async)?\s*\(\s*["']git["']\s*,\s*\[([\s\S]*?)\][\s,]*\{([\s\S]*?)\}/g;
    for (const match of source.matchAll(direct)) {
      if (isInsideString(source, match.index)) continue;
      if (!listingToken(match[1])) continue;
      sites.push({ file: relativePath, kind: "direct", compliant: hasCapacity(match[2]) });
    }
    if (!relativePath.includes(".test.")) {
      const wrapper = /execFileSync\s*\(\s*["']git["']\s*,\s*args\s*,\s*\{([\s\S]*?)\}/g;
      for (const match of source.matchAll(wrapper)) {
        if (isInsideString(source, match.index)) continue;
        const context = source.slice(match.index, match.index + 600);
        if (!hasCapacity(match[1]) && !/\bmaxBuffer\s*:/.test(context))
          sites.push({ file: relativePath, kind: "wrapper", compliant: false });
      }
    }
  }
  return sites;
}

function hasCapacity(options) {
  if (/\bmaxBuffer\s*:\s*GIT_LISTING_MAX_BUFFER\b/.test(options)) return true;
  const numeric = /\bmaxBuffer\s*:\s*(\d+(?:\s*\*\s*\d+)*)/.exec(options)?.[1];
  if (!numeric) return false;
  return Function(`return (${numeric})`)() >= GIT_LISTING_MAX_BUFFER;
}

function isInsideString(source, index) {
  let quote = null;
  let escaped = false;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const char = source[cursor];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (quote && char === quote) {
      quote = null;
    } else if (!quote && (char === "'" || char === '"' || char === "`")) {
      quote = char;
    }
  }
  return quote !== null;
}

function listingToken(args) {
  return /\bls-(?:files|tree)\b/.test(args) || /["']ls-["']\s*\+\s*["'](?:files|tree)["']/.test(args);
}

function fixtureInventory(source) {
  const direct = /execFileSync\s*\(\s*["']git["']\s*,\s*\[([\s\S]*?)\][\s,]*\{([\s\S]*?)\}/g;
  return [...source.matchAll(direct)]
    .filter((match) => listingToken(match[1]))
    .map((match) => ({ kind: "direct", compliant: hasCapacity(match[2]) }));
}

describe("Git listing buffer contract", () => {
  it("derives a complete tracked scripts inventory with no ambiguous rows", () => {
    const inventory = listingSiteInventory();
    expect(inventory.length).toBeGreaterThan(0);
    expect(inventory.filter((site) => !site.compliant)).toEqual([]);
  });

  it("fails closed for direct and wrapper/default planted violations", () => {
    const direct = fixtureInventory('execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });');
    expect(direct).toEqual([{ kind: "direct", compliant: false }]);
    const wrapper = fixtureInventory(
      'function list(args) { return execFileSync("git", ["ls-files", ...args], { encoding: "utf8" }); }',
    );
    expect(wrapper).toEqual([{ kind: "direct", compliant: false }]);
  });

  it("preserves exact complete output above Node's default buffer", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cs-git-listing-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      const names = Array.from(
        { length: 12_000 },
        (_, index) => `tracked-${String(index).padStart(5, "0")}-${"x".repeat(80)}.txt`,
      );
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: "x\n" }).toString().trim();
      const indexInfo = names.map((name) => `100644 ${blob}\t${name}`).join("\n") + "\n";
      execFileSync("git", ["update-index", "--index-info"], { cwd: root, input: indexInfo });
      assert.throws(() => execFileSync("git", ["ls-files", "-z"], { cwd: root }), /ENOBUFS|maxBuffer/i);
      const listing = execFileSync("git", ["ls-files", "-z"], gitListingOptions({ cwd: root }));
      expect(listing.toString("utf8").split("\0").filter(Boolean)).toEqual(names);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
