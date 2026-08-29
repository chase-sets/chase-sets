#!/usr/bin/env node
// Scope verifier for the Ordering cleanup-authority change.
//
// The issue authorizes an exact maximum footprint. A diff that reaches outside
// it -- another context's schema, a projection, a subscriber, a provider
// adapter, a cancellation path, or any write surface -- is a scope failure
// even when every other gate is green, because those are precisely the
// surfaces this read-only observation is forbidden to touch.
//
// Usage:
//   node scripts/cleanup-authority-footprint.mjs [--base <ref>] [--out <path>]
//
// The classifier below is pure so the script battery can drive it against
// planted scope mutants without a git tree.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/** Exact, closed manifest attributable to the cleanup-authority delivery. */
export const AUTHORIZED_PATHS = Object.freeze([
  "bounded-contexts/discovery/tests/acceptance/marketplace-search.test.ts",
  "bounded-contexts/inventory/GLOSSARY.md",
  "bounded-contexts/inventory/features/holds/api/cleanup-authority-source-index.db.test.ts",
  "bounded-contexts/inventory/features/holds/api/cleanup-authority.test.ts",
  "bounded-contexts/inventory/features/holds/api/cleanup-authority.ts",
  "bounded-contexts/inventory/features/holds/read-model/schema.ts",
  "bounded-contexts/inventory/package.json",
  "bounded-contexts/inventory/server.ts",
  "bounded-contexts/inventory/support/runtime-support/schema.ts",
  "bounded-contexts/inventory/support/runtime-support/services.ts",
  "bounded-contexts/ordering/GLOSSARY.md",
  "bounded-contexts/ordering/client.ts",
  "bounded-contexts/ordering/context.json",
  "bounded-contexts/ordering/features/orders/api/cleanup-authority-route.test.ts",
  "bounded-contexts/ordering/features/orders/api/cleanup-authority.test.ts",
  "bounded-contexts/ordering/features/orders/api/cleanup-authority.ts",
  "bounded-contexts/ordering/features/orders/api/route.test.ts",
  "bounded-contexts/ordering/features/orders/api/route.ts",
  "bounded-contexts/ordering/features/orders/api/runtime-test-harness.ts",
  "bounded-contexts/ordering/features/orders/api/runtime.ts",
  "bounded-contexts/ordering/server.ts",
  "bounded-contexts/ordering/support/runtime-support/seed.ts",
  "bounded-contexts/ordering/support/runtime-support/services.ts",
  "bounded-contexts/ordering/tests/cleanup-authority-composition.test.ts",
  "bounded-contexts/ordering/tests/test-support/cleanup-authority.ts",
  "contracts/localization/locales/en/ordering.ts",
  "deployables/marketplace-seed-testing/index.ts",
  "deployables/marketplace-seed-testing/tests/representative-catalog.test.ts",
  "deployables/platform-api/__tests__/cleanup-authority-host-capability.test.ts",
  "deployables/platform-api/src/app.ts",
  "deployables/platform-worker/__tests__/cleanup-authority-host-capability.test.ts",
  "deployables/platform-worker/__tests__/projection-wake-interest-graph.test.ts",
  "deployables/platform-worker/__tests__/scheduled-runners.db.test.ts",
  "deployables/platform-worker/src/bootstrap.ts",
  "deployables/platform-worker/src/main.ts",
  "scripts/check-structure/authoritative-stream-read-classification.test.mjs",
  "scripts/check-structure/authoritative-stream-read-detachment.test.mjs",
  "scripts/check-structure/sql-execution-surface-partition.json",
  "scripts/check-structure/sql-execution-surface.test.mjs",
  "scripts/cleanup-authority-footprint.mjs",
  "scripts/cleanup-authority-footprint.test.mjs",
]);

/**
 * Names the scope class a rejected path belongs to, so a failure says which
 * forbidden surface the diff reached rather than only that it was unexpected.
 */
export function classifyOutOfFootprintReason(filePath) {
  if (
    /(^|\/)(schema|migrations?)[^/]*\.(ts|sql)$/.test(filePath) ||
    /unlogged-projection-migrations\.ts$/.test(filePath)
  ) {
    return "schema";
  }
  if (/(^|\/)read-model\//.test(filePath) || /projection[^/]*\.ts$/.test(filePath)) {
    return "projection";
  }
  // Cancellation outranks the subscriber and provider classes: a cancellation
  // reaction is both, and "cancellation" is the surface the scope fence names.
  if (/cancel/i.test(filePath)) {
    return "cancellation";
  }
  if (/(subscription|subscriber|reaction)[^/]*\.ts$/.test(filePath)) {
    return "subscriber";
  }
  if (/(^|\/)integrations\//.test(filePath) || /(provider|gateway|adapter)[^/]*\.ts$/.test(filePath)) {
    return "provider";
  }
  if (/(^|\/)domain\//.test(filePath) || /(runtime|workflow|command)[^/]*\.ts$/.test(filePath)) {
    return "write";
  }
  return "out-of-footprint";
}

export function isAuthorizedPath(filePath) {
  return AUTHORIZED_PATHS.includes(filePath);
}

export function classifyCleanupAuthorityFootprint(changedPaths) {
  const normalized = [
    ...new Set(changedPaths.map((entry) => String(entry).replaceAll("\\", "/")).filter(Boolean)),
  ].sort();
  const authorized = normalized.filter((entry) => isAuthorizedPath(entry));
  const violations = normalized
    .filter((entry) => !isAuthorizedPath(entry))
    .map((entry) => ({ path: entry, reason: classifyOutOfFootprintReason(entry) }));

  return { authorized, violations, ok: violations.length === 0 };
}

export function renderFootprintArtifact(result) {
  const lines = [
    "# cleanup-authority-footprint",
    "",
    `Result: ${result.ok ? "within the authorized cleanup-authority footprint" : "OUT OF SCOPE"}`,
    "",
    `## Authorized changed files (${result.authorized.length})`,
    "",
    ...result.authorized.map((entry) => `- ${entry}`),
  ];

  if (result.violations.length > 0) {
    lines.push("", `## Out-of-footprint changes (${result.violations.length})`, "");
    for (const violation of result.violations) {
      lines.push(`- ${violation.path} (${violation.reason})`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { base: "origin/main", out: "artifacts/cleanup-authority-footprint.md" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base" && argv[index + 1]) {
      args.base = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--out" && argv[index + 1]) {
      args.out = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function changedPathsFromGit(base) {
  const output = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return output.split(/\r?\n/).filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = classifyCleanupAuthorityFootprint(changedPathsFromGit(args.base));
  const artifact = renderFootprintArtifact(result);
  const outPath = path.resolve(repoRoot, args.out);

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, artifact, "utf8");
  process.stdout.write(`${artifact}\n`);

  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
