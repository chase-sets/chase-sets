#!/usr/bin/env node
import { fileURLToPath } from "node:url";

export const EPHEMERAL_VERIFICATION_VERSION = "ephemeral-verification/v1";
export const VERIFICATION_NAMESPACE_PATTERN = /^chase-sets-verify-([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/u;
export const VERIFICATION_NAMESPACE_MAX_AGE_HOURS = 24;

export function verificationIdentity(runId, runAttempt) {
  const id = String(runId ?? "").trim();
  const attempt = String(runAttempt ?? "").trim();
  if (!/^\d+$/u.test(id) || !/^\d+$/u.test(attempt)) throw new Error("run id and attempt must be positive integers.");
  const slug = `verify-${id}-${attempt}`;
  return { slug, namespace: `chase-sets-${slug}`, release: `csv-${id}-${attempt}` };
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

async function main() {
  const input = JSON.parse(await new Response(process.stdin).text());
  const matrix = {
    include: selectStaleVerificationNamespaces(input.items, {
      maxAgeHours: process.env.VERIFICATION_NAMESPACE_MAX_AGE_HOURS ?? VERIFICATION_NAMESPACE_MAX_AGE_HOURS,
    }),
  };
  process.stdout.write(`${JSON.stringify(matrix)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
