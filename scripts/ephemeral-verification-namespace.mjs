#!/usr/bin/env node
// Canonical parser for the disposable verification namespaces created on the
// staging DOKS cluster. Two verification kinds exist, and this module is the
// ONLY namespace parser for both (platform-kubernetes-deployment.mjs and the
// preview-cleanup stale-matrix jobs consume these exports; never add a
// parallel parser):
//
//   - post-production ephemeral verification: chase-sets-verify-<run>-<attempt>
//     (platform-ephemeral-verification.yml). Backstop contract is prefix
//     membership plus 24-hour age — label-independent, because the namespace
//     is created before it is labeled and a cancellation between create and
//     label must not leak it.
//   - merge-gate verification: chase-sets-gate-<run>-<attempt>
//     (platform-merge-gate-verification.yml). Gate namespaces are
//     created atomically WITH their labels and annotations (single manifest
//     apply), so the backstop selects by strict label plus bounded naming and
//     refuses unlabeled or foreign-labeled namespaces: an unlabeled
//     chase-sets-gate-* namespace was not created by the gate workflow and is
//     reported instead of deleted.
import { fileURLToPath } from "node:url";

export const EPHEMERAL_VERIFICATION_VERSION = "ephemeral-verification/v1";
export const VERIFICATION_NAMESPACE_PATTERN = /^chase-sets-verify-([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/u;
export const VERIFICATION_NAMESPACE_MAX_AGE_HOURS = 24;

// Merge-gate verification namespaces. Bounded naming: exactly
// chase-sets-gate-<run-id>-<run-attempt> with numeric run identity — no free
// suffixes, so staging/production/preview and renamed lookalikes never match.
export const MERGE_GATE_NAMESPACE_PATTERN = /^chase-sets-gate-(\d+)-(\d+)$/u;
// Orphan SLO: no merge-gate resource lives longer than 6 hours. The
// cleanup-deadline annotation written at creation is the primary backstop
// trigger; this age bound is the fallback when the annotation is unreadable.
export const MERGE_GATE_NAMESPACE_MAX_AGE_HOURS = 6;
export const NAMESPACE_PURPOSE_LABEL_KEY = "chasesets.com/purpose";
export const MERGE_GATE_PURPOSE_LABEL = "merge-gate-verification";
export const MERGE_GATE_CLEANUP_DEADLINE_ANNOTATION = "chasesets.com/cleanup-deadline";

export function verificationIdentity(runId, runAttempt) {
  const id = String(runId ?? "").trim();
  const attempt = String(runAttempt ?? "").trim();
  if (!/^\d+$/u.test(id) || !/^\d+$/u.test(attempt)) throw new Error("run id and attempt must be positive integers.");
  const slug = `verify-${id}-${attempt}`;
  return { slug, namespace: `chase-sets-${slug}`, release: `csv-${id}-${attempt}` };
}

export function mergeGateIdentity(runId, runAttempt) {
  const id = String(runId ?? "").trim();
  const attempt = String(runAttempt ?? "").trim();
  if (!/^\d+$/u.test(id) || !/^\d+$/u.test(attempt)) throw new Error("run id and attempt must be positive integers.");
  const slug = `gate-${id}-${attempt}`;
  return { slug, namespace: `chase-sets-${slug}`, release: `csg-${id}-${attempt}` };
}

export function selectStaleVerificationNamespaces(items, options = {}) {
  const now = new Date(options.now ?? new Date());
  const maxAgeMs = Number(options.maxAgeHours ?? VERIFICATION_NAMESPACE_MAX_AGE_HOURS) * 60 * 60 * 1000;
  return (Array.isArray(items) ? items : [])
    .filter((item) => VERIFICATION_NAMESPACE_PATTERN.test(item?.metadata?.name ?? ""))
    .filter((item) => {
      const created = Date.parse(item?.metadata?.creationTimestamp ?? "");
      return Number.isFinite(created) && now.getTime() - created >= maxAgeMs;
    })
    .map((item) => {
      const namespace = item.metadata.name;
      const match = VERIFICATION_NAMESPACE_PATTERN.exec(namespace);
      return { namespace, release: `csv-${match[1]}`, slug: `verify-${match[1]}` };
    })
    .sort((left, right) => left.namespace.localeCompare(right.namespace));
}

// Merge-gate stale selection: strict label plus bounded naming. Eligible
// namespaces carry the merge-gate purpose label AND are past their
// cleanup-deadline annotation (fallback: 6-hour age when the deadline or
// creation timestamp is unreadable). Gate-named namespaces WITHOUT the
// merge-gate purpose label are refused and reported — the gate workflow
// creates labels atomically with the namespace, so an unlabeled match is
// foreign and must never be auto-deleted. Everything else (staging,
// production, previews, verify namespaces, renamed lookalikes) never matches
// the bounded name and is only counted as scanned.
export function selectStaleMergeGateNamespaces(items, options = {}) {
  const now = new Date(options.now ?? new Date());
  const maxAgeMs = Number(options.maxAgeHours ?? MERGE_GATE_NAMESPACE_MAX_AGE_HOURS) * 60 * 60 * 1000;
  const scannedItems = Array.isArray(items) ? items : [];
  const eligible = [];
  const refused = [];

  for (const item of scannedItems) {
    const namespace = item?.metadata?.name ?? "";
    const match = MERGE_GATE_NAMESPACE_PATTERN.exec(namespace);
    if (!match) continue;

    const purpose = item?.metadata?.labels?.[NAMESPACE_PURPOSE_LABEL_KEY];
    if (purpose !== MERGE_GATE_PURPOSE_LABEL) {
      refused.push({
        namespace,
        reason:
          purpose === undefined || purpose === null || purpose === ""
            ? "unlabeled: gate-named namespace without the merge-gate purpose label was not created by the gate workflow"
            : `foreign purpose label ${JSON.stringify(purpose)}`,
      });
      continue;
    }

    const [, id, attempt] = match;
    const entry = { namespace, release: `csg-${id}-${attempt}`, slug: `gate-${id}-${attempt}` };
    const deadline = Date.parse(item?.metadata?.annotations?.[MERGE_GATE_CLEANUP_DEADLINE_ANNOTATION] ?? "");
    if (Number.isFinite(deadline)) {
      if (now.getTime() >= deadline) {
        eligible.push({ ...entry, reason: "past-cleanup-deadline" });
      }
      continue;
    }

    const created = Date.parse(item?.metadata?.creationTimestamp ?? "");
    if (!Number.isFinite(created)) {
      // Labeled ours but with no readable timestamps: fail toward cleanup —
      // the label proves gate ownership and an unreadable deadline must not
      // grant immortality.
      eligible.push({ ...entry, reason: "unreadable-timestamps" });
      continue;
    }
    if (now.getTime() - created >= maxAgeMs) {
      eligible.push({ ...entry, reason: "missing-deadline-age-fallback" });
    }
  }

  eligible.sort((left, right) => left.namespace.localeCompare(right.namespace));
  refused.sort((left, right) => left.namespace.localeCompare(right.namespace));
  return { scanned: scannedItems.length, eligible, refused };
}

async function main(argv) {
  const input = JSON.parse(await new Response(process.stdin).text());
  const kindIndex = argv.indexOf("--kind");
  const kind = kindIndex >= 0 ? argv[kindIndex + 1] : "verify";

  if (kind === "gate") {
    const selection = selectStaleMergeGateNamespaces(input.items, {
      maxAgeHours: process.env.MERGE_GATE_NAMESPACE_MAX_AGE_HOURS ?? MERGE_GATE_NAMESPACE_MAX_AGE_HOURS,
    });
    const reportIndex = argv.indexOf("--report");
    if (reportIndex >= 0 && argv[reportIndex + 1]) {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      const report = {
        schemaVersion: "merge-gate-stale-sweep/v1",
        scanned: selection.scanned,
        eligible: selection.eligible,
        refused: selection.refused,
        generatedAt: new Date().toISOString(),
      };
      await mkdir(dirname(argv[reportIndex + 1]), { recursive: true });
      await writeFile(argv[reportIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify({ include: selection.eligible })}\n`);
    return;
  }

  if (kind !== "verify") {
    throw new Error(`unknown namespace kind ${JSON.stringify(kind)}; expected verify or gate.`);
  }

  const matrix = {
    include: selectStaleVerificationNamespaces(input.items, {
      maxAgeHours: process.env.VERIFICATION_NAMESPACE_MAX_AGE_HOURS ?? VERIFICATION_NAMESPACE_MAX_AGE_HOURS,
    }),
  };
  process.stdout.write(`${JSON.stringify(matrix)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
