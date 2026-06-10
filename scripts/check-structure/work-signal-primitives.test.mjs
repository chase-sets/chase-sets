import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scanRoots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages", "scripts"];
const ignoredDirectories = new Set([".git", ".turbo", "artifacts", "build", "coverage", "dist", "node_modules"]);
const sourceExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);
const ignoredFilePatterns = [/\.test\.[cm]?[jt]sx?$/, /\.config\.[cm]?[jt]s$/, /\.generated\./];

const workSignalPrimitivePatterns = [
  /\bpg_notify\b/i,
  /\bcreatePostgresRealtimeWakeSignal\b/,
  /\bquery\s*\(\s*(?:`|"|')\s*(?:LISTEN|UNLISTEN)\b/,
];

const approvedDirectWorkSignalPrimitiveFiles = {
  "deployables/platform-api/src/main.ts": {
    owner: "platform-runtime",
    reason:
      "Wires the current realtime SSE wake signal; #1248 decides whether it migrates to the composite relay path or remains a budgeted exception.",
  },
  "infrastructure/platform-runtime/control-plane.ts": {
    owner: "platform-runtime",
    reason:
      "Owns current platform projection operation event notifications; #1248 folds this into the work-signal composite contract.",
  },
  "infrastructure/platform-runtime/durable-job-store.ts": {
    owner: "platform-runtime",
    reason:
      "Owns current durable job event notifications and wait hooks; #1248 keeps job tables as durable truth while sharing waiter primitives.",
  },
  "infrastructure/platform-runtime/durable-job-work-units.ts": {
    owner: "platform-runtime",
    reason:
      "Owns current same-job work-unit progress notifications; #1248 covers migration to shared waiter/metrics primitives.",
  },
  "infrastructure/platform-runtime/realtime-outbox-store.ts": {
    owner: "platform-runtime",
    reason: "Owns current realtime outbox notifications; #1248 reviews this path against listener budgets.",
  },
  "infrastructure/platform-runtime/realtime.ts": {
    owner: "platform-runtime",
    reason:
      "Owns the current realtime Postgres LISTEN wake signal; #1236/#1248 require migration or a budgeted local-listener exception.",
  },
};

describe("platform work-signal primitive guardrail", () => {
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
