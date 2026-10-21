import { z } from "zod";
import {
  scrydexCacheCaptureOrigin,
  scrydexCacheCaptureUnits,
  type ScrydexCacheCaptureUnitKey,
} from "./scrydex-cache-capture";

export const scrydexOptionRefreshSchemaVersion = "scrydex-option-refresh/v1" as const;
export const scrydexOptionRefreshJourneyScope = "scrydex-force-refresh-bounded" as const;
export const scrydexOptionRefreshOrigin = scrydexCacheCaptureOrigin;
export const scrydexOptionRefreshArtifactPath = "artifacts/catalog-scrydex-option-refresh/receipt.json" as const;
export const scrydexOptionRefreshDiagnosticArtifactPath =
  "artifacts/catalog-scrydex-option-refresh-diagnostic/receipt.json" as const;
export const scrydexOptionRefreshMinimumCredits = 1000;
export const scrydexOptionRefreshPageSize = 100;
export const scrydexOptionRefreshMaxTotal = 1000;
export const scrydexOptionRefreshMaxBytes = 1_000_000;

export type ScrydexOptionRefreshUnitKey = ScrydexCacheCaptureUnitKey;
export type ScrydexOptionRefreshResponse = Readonly<{ status: number; body: unknown }>;

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().regex(/^[1-9]\d{0,19}$/);
const instant = z.string().datetime({ offset: true });
const cache = z
  .object({
    status: z.enum(["bypass", "live"]),
    source: z.literal("live"),
    fetchedAt: instant,
    expiresAt: instant,
    staleUntil: instant,
  })
  .strict();
const unit = z
  .object({
    unitKey: z.enum(
      scrydexCacheCaptureUnits.map(({ unitKey }) => unitKey) as [
        ScrydexOptionRefreshUnitKey,
        ...ScrydexOptionRefreshUnitKey[],
      ],
    ),
    status: z.union([z.literal("bypass"), z.literal("live"), z.literal("not-attempted"), z.literal("uncertain")]),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    cache: cache.nullable(),
    total: z.number().int().min(0).max(scrydexOptionRefreshMaxTotal).nullable(),
    providerPagesUpperBound: z.number().int().min(1).max(11).nullable(),
    completedAt: instant.nullable(),
  })
  .strict();
const preflight = z
  .object({
    creditBalance: z.number().int().nonnegative().nullable(),
    creditAllowance: z.number().int().nonnegative().nullable(),
    observedAt: instant.nullable(),
    readiness: z.enum(["ready", "degraded", "blocked", "unknown"]),
    freshness: z.enum(["fresh", "stale", "unavailable", "never-observed"]),
  })
  .strict();
const receipt = z
  .object({
    schemaVersion: z.literal(scrydexOptionRefreshSchemaVersion),
    outcome: z.enum(["complete", "refused", "stopped"]),
    reason: z
      .string()
      .regex(/^[a-z0-9-]{1,64}(?::[A-Za-z0-9._:-]{1,200})?$/)
      .nullable(),
    runner: z
      .object({
        sha,
        runId: id,
        runAttempt: id,
        journeyScope: z.literal(scrydexOptionRefreshJourneyScope),
        origin: z.literal(new URL(scrydexOptionRefreshOrigin).host),
      })
      .strict(),
    deployment: z
      .object({
        beforeSha: sha.nullable(),
        beforeImageDigest: digest.nullable(),
        afterSha: sha.nullable(),
        afterImageDigest: digest.nullable(),
      })
      .strict(),
    startedAt: instant,
    finishedAt: instant,
    preflight: preflight,
    requests: z.object({ forced: z.number().int().min(0).max(5), refusals: z.number().int().min(0).max(50) }).strict(),
    units: z.array(unit).length(5),
    creditsSpentUpperBound: z.number().int().min(0).max(56),
    assumptions: z.array(z.string().min(1).max(300)).max(10),
  })
  .strict();

export type ScrydexOptionRefreshReceipt = z.infer<typeof receipt>;
export type ScrydexOptionRefreshPreflight = z.infer<typeof preflight>;
export type ScrydexOptionRefreshUnitResult = z.infer<typeof unit>;

export function providerPagesUpperBound(total: number): number | null {
  if (!Number.isInteger(total) || total < 0 || total > scrydexOptionRefreshMaxTotal) return null;
  return Math.max(1, Math.ceil(total / scrydexOptionRefreshPageSize)) + 1;
}

export function evaluateScrydexUsagePreflight(
  value: unknown,
):
  | { admitted: true; preflight: ScrydexOptionRefreshPreflight }
  | { admitted: false; reason: string; preflight: ScrydexOptionRefreshPreflight } {
  const candidate = (value ?? {}) as Record<string, unknown>;
  const usage = (candidate.usageBudget ?? {}) as Record<string, unknown>;
  const preflight = {
    creditBalance: typeof usage.creditBalance === "number" ? usage.creditBalance : null,
    creditAllowance: typeof usage.creditAllowance === "number" ? usage.creditAllowance : null,
    observedAt: typeof usage.observedAt === "string" ? usage.observedAt : null,
    readiness:
      usage.readiness === "ready" || usage.readiness === "degraded" || usage.readiness === "blocked"
        ? usage.readiness
        : "unknown",
    freshness:
      usage.freshness === "fresh" || usage.freshness === "stale" || usage.freshness === "unavailable"
        ? usage.freshness
        : "never-observed",
  } as ScrydexOptionRefreshPreflight;
  const reason =
    !candidate.providerKey || candidate.providerKey !== "scrydex"
      ? "provider-missing"
      : preflight.readiness !== "ready"
        ? `usage-readiness:${preflight.readiness}`
        : preflight.freshness !== "fresh"
          ? `usage-stale:${preflight.freshness}`
          : preflight.creditAllowance === null
            ? "usage-allowance-missing"
            : preflight.creditBalance === null
              ? "usage-balance-missing"
              : preflight.creditBalance < scrydexOptionRefreshMinimumCredits
                ? "usage-balance-low"
                : candidate.providerReadiness === "blocked"
                  ? "provider-readiness:blocked"
                  : null;
  return reason ? { admitted: false, reason, preflight } : { admitted: true, preflight };
}

export type ScrydexOptionRefreshRequest = Readonly<{ method: string; url: string; unitKey?: string | null }>;
export function classifyScrydexOptionRefreshRequest(
  request: ScrydexOptionRefreshRequest,
  seen: ReadonlySet<string> = new Set(),
): { allowed: boolean; unitKey: ScrydexOptionRefreshUnitKey | null; reason: string } {
  let url: URL;
  try {
    url = new URL(request.url, scrydexOptionRefreshOrigin);
  } catch {
    return { allowed: false, unitKey: null, reason: "unparseable-url" };
  }
  if (url.origin !== scrydexOptionRefreshOrigin) return { allowed: false, unitKey: null, reason: "cross-origin" };
  if (request.method.toUpperCase() !== "GET") return { allowed: false, unitKey: null, reason: "mutation" };
  if (/tcgplayer/i.test(url.href)) return { allowed: false, unitKey: null, reason: "tcgplayer" };
  if (url.pathname !== "/api/catalog/source-observations/integration-options")
    return { allowed: false, unitKey: null, reason: "path" };
  const p = url.searchParams;
  const unitKey = p.get("ingestionUnitKey");
  const allowed =
    [
      "providerKey",
      "profileKey",
      "profileVersion",
      "ingestionUnitKey",
      "queryKind",
      "scope",
      "parentScope",
      "parentValue",
      "languageCode",
      "limit",
      "forceRefresh",
    ].every((k) => [...p.keys()].filter((x) => x === k).length <= 1) &&
    p.get("providerKey") === "scrydex" &&
    p.get("queryKind") === "sets" &&
    p.get("forceRefresh") === "true" &&
    !p.has("cacheOnly") &&
    !p.has("cursor") &&
    scrydexCacheCaptureUnits.some((u) => u.unitKey === unitKey) &&
    p.get("limit") === "100";
  if (!allowed) return { allowed: false, unitKey: null, reason: "request-shape" };
  if (seen.has(unitKey!))
    return { allowed: false, unitKey: unitKey as ScrydexOptionRefreshUnitKey, reason: "duplicate-unit" };
  return { allowed: true, unitKey: unitKey as ScrydexOptionRefreshUnitKey, reason: "forced-option-read" };
}

export function buildScrydexOptionRefreshReceipt(
  input: Omit<ScrydexOptionRefreshReceipt, "schemaVersion">,
): ScrydexOptionRefreshReceipt {
  return { schemaVersion: scrydexOptionRefreshSchemaVersion, ...input };
}

export function validateScrydexOptionRefreshReceipt(value: unknown): readonly string[] {
  const parsed = receipt.safeParse(value);
  if (!parsed.success)
    return parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "receipt"}: ${issue.code}`);
  const r = parsed.data;
  const errors: string[] = [];
  if (Date.parse(r.startedAt) > Date.parse(r.finishedAt)) errors.push("finishedAt: precedes startedAt");
  if (
    r.outcome === "complete" &&
    (r.reason !== null ||
      r.requests.forced !== 5 ||
      r.requests.refusals !== 0 ||
      r.units.some((u) => u.status !== "bypass" && u.status !== "live") ||
      r.deployment.beforeSha !== r.runner.sha ||
      r.deployment.afterSha !== r.runner.sha)
  )
    errors.push("complete: requires five live units, zero refusals and equal deployment binds");
  if (r.outcome !== "complete" && r.reason === null) errors.push("reason: required for refused or stopped");
  for (const u of r.units) {
    const expected = u.total === null ? null : providerPagesUpperBound(u.total);
    if (u.providerPagesUpperBound !== expected && u.status !== "not-attempted")
      errors.push(`units.${u.unitKey}: page bound mismatch`);
    if ((u.status === "uncertain" || u.status === "not-attempted") && u.total !== null)
      errors.push(`units.${u.unitKey}: uncertain total must be null`);
  }
  return errors;
}
