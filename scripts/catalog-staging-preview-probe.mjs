import { existsSync, readFileSync, statSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  scopeSyncBatchPreviewProbeArtifactPath,
  scopeSyncBatchPreviewProbeCredentialNames,
  validateScopeSyncBatchPreviewProbeReceipt,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/preview-probe-receipt.ts";

// Pre-upload gate for the staging Scope Sync Batch preview receipt.
// The workflow uploads the exact receipt file only after this validates it
// against the admitted SHA/run/attempt and proves the job's admin credential
// values are absent. Output names failures, never values. Runs under tsx
// because the receipt grammar is a Catalog TypeScript module.

export function validatePreviewProbeFile({ file = scopeSyncBatchPreviewProbeArtifactPath, env = process.env } = {}) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    return { ok: false, errors: [`receipt file ${file} is missing`], summary: null };
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, errors: [`receipt file ${file} is not readable JSON`], summary: null };
  }
  const inActions = env.GITHUB_ACTIONS === "true";
  const expected = {
    sha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    forbiddenValues: scopeSyncBatchPreviewProbeCredentialNames.map((name) => env[name] ?? "").filter(Boolean),
  };
  const missingIdentity = inActions
    ? ["GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"].filter((name) => !env[name])
    : [];
  const result = validateScopeSyncBatchPreviewProbeReceipt(receipt, expected);
  const errors = [...missingIdentity.map((name) => `${name} is required to bind the receipt`), ...result.errors];
  return {
    ok: errors.length === 0,
    errors,
    summary: {
      captureStatus: receipt?.captureStatus ?? null,
      rows: Array.isArray(receipt?.rows) ? receipt.rows.length : null,
      incompleteReasons: Array.isArray(receipt?.incompleteReasons) ? receipt.incompleteReasons.length : null,
    },
  };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "validate") {
    console.error("Usage: tsx scripts/catalog-staging-preview-probe.mjs validate [--file <receipt.json>]");
    process.exitCode = 2;
  } else {
    const result = validatePreviewProbeFile({ file: option(rest, "--file") });
    console.log(JSON.stringify({ ok: result.ok, summary: result.summary, errors: result.errors }, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
}
