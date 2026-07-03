import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scanRoots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages", "scripts"];
const ignoredDirectories = new Set([".git", ".turbo", "artifacts", "build", "coverage", "dist", "node_modules"]);
const sourceExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);
const ignoredFilePatterns = [
  /\.test\.[cm]?[jt]sx?$/,
  /\.config\.[cm]?[jt]s$/,
  /\.generated\./,
  // Extracted test-support harnesses fake the database client, so their
  // pg_notify/LISTEN strings are fixtures, not runtime primitive use.
  /-test-harness\.[cm]?[jt]sx?$/,
];

const workSignalPrimitivePatterns = [
  /\bpg_notify\b/i,
  /\bcreatePostgresRealtimeWakeSignal\b/,
  /\bquery\s*\(\s*(?:`|"|')\s*(?:LISTEN|UNLISTEN)\b/,
];

// Durable-job event notifications/waits, same-job work-unit notifications,
// realtime outbox wake emission, and the platform-api realtime SSE wake
// signal migrated onto the composite primitives (#1248/#1238), so they no
// longer appear here. The remaining direct users are the composite owner
// itself plus two reviewed exceptions.
const approvedDirectWorkSignalPrimitiveFiles = {
  "infrastructure/event-core-postgres/event-store.ts": {
    owner: "event-core-postgres",
    reason:
      "Owns the lower-level after-commit event-store wake notification emission for #1219; the worker-owned relay consumes these composite-compatible envelopes in #1242, and the emission stays direct until the envelope helpers can move to a shared package without an event-core-postgres -> platform-runtime cycle.",
  },
  "infrastructure/platform-runtime/projection-wake-relay.ts": {
    owner: "platform-runtime",
    reason:
      "Owns the worker-owned source-context LISTEN runtime for #1242; this is the approved relay implementation that prevents every API/worker process from listening to every source database.",
  },
  "infrastructure/platform-runtime/work-signal-composite.ts": {
    owner: "platform-runtime",
    reason:
      "Owns the supported composite Postgres notification emission and listener/waiter primitives; other direct uses must migrate here or carry a tracked exception.",
  },
};

describe("platform work-signal primitive guardrail", () => {
  it("keeps platform control-plane reads on the control pool when work signals split", () => {
    const platformApiMain = readFileSync(path.resolve("deployables/platform-api/src/main.ts"), "utf8");

    expect(platformApiMain).toMatch(/createPostgresPlatformControlPlane\s*\(\s*pools\.control\b/);
    expect(platformApiMain).not.toMatch(/createPostgresPlatformControlPlane\s*\(\s*pools\.workSignal\b/);
  });

  it("requires direct notification and listener primitives to have a composite migration disposition", () => {
    const findings = collectWorkSignalPrimitiveFiles().filter((file) => {
      return !approvedDirectWorkSignalPrimitiveFiles[file];
    });

    expect(findings).toEqual([]);
  });

  it("keeps the approved direct primitive inventory current and owned", () => {
    for (const [file, approval] of Object.entries(approvedDirectWorkSignalPrimitiveFiles)) {
      const absolutePath = path.resolve(file);
      expect(existsSync(absolutePath), `${file} should still exist`).toBe(true);
      expect(approval.owner, `${file} approval must name an owner`).toMatch(/\S/);
      expect(approval.reason, `${file} approval must explain migration or exception disposition`).toMatch(/\S/);

      const content = readFileSync(absolutePath, "utf8");
      expect(containsWorkSignalPrimitive(content), `${file} should still contain a guarded primitive`).toBe(true);
    }
  });
});

function collectWorkSignalPrimitiveFiles() {
  const files = [];

  for (const root of scanRoots) {
    walk(root, files);
  }

  return files
    .filter((file) => {
      const content = readFileSync(path.resolve(file), "utf8");
      return containsWorkSignalPrimitive(content);
    })
    .sort();
}

function containsWorkSignalPrimitive(content) {
  return workSignalPrimitivePatterns.some((pattern) => pattern.test(content));
}

function walk(relativeDirectory, files) {
  const absoluteDirectory = path.resolve(relativeDirectory);

  if (!existsSync(absoluteDirectory)) {
    return;
  }

  for (const entry of readdirSync(absoluteDirectory)) {
    if (ignoredDirectories.has(entry)) {
      continue;
    }

    const absoluteEntry = path.join(absoluteDirectory, entry);
    const relativeEntry = path.relative(process.cwd(), absoluteEntry).replaceAll(path.sep, "/");
    const stats = statSync(absoluteEntry);

    if (stats.isDirectory()) {
      walk(relativeEntry, files);
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    if (!sourceExtensions.has(path.extname(entry))) {
      continue;
    }

    if (ignoredFilePatterns.some((pattern) => pattern.test(entry))) {
      continue;
    }

    files.push(relativeEntry);
  }
}
