import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { JsonValue } from "@chase-sets/primitives/json";
import { createPolicyCache, type PolicyCache, type PolicyDocumentCandidate } from "./cache";
import type { PolicyDefinition } from "./define-policy";
import { listActivePolicyDocuments } from "./queries";

export type ResolvedPolicy<Value> = Readonly<{
  policyKey: string;
  value: Value;
  /** "policy" when an active document's window covered `at`, "fallback" when `definition.defaultValue` was used. */
  source: "policy" | "fallback";
  documentId: string | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  resolvedAt: string;
}>;

export type PolicyResolver = Readonly<{
  resolvePolicy: <Value>(
    definition: PolicyDefinition<Value>,
    params?: Readonly<{ at?: string }>,
  ) => Promise<ResolvedPolicy<Value>>;
  cache: PolicyCache;
}>;

export type CreatePolicyResolverOptions = Readonly<{
  db: PgQueryable;
  cache?: PolicyCache;
  now?: () => Date;
}>;

/**
 * Resolves the effective value for a declared policy at a point in time. A
 * policy with no active document row -- because it was never created, or
 * because the request instant falls outside every active document's window
 * -- always falls back to `definition.defaultValue` rather than throwing:
 * an empty or lagging policy table can never break a hot path.
 */
export function createPolicyResolver(options: CreatePolicyResolverOptions): PolicyResolver {
  const cache = options.cache ?? createPolicyCache();
  const now = options.now ?? (() => new Date());

  async function loadCandidates(policyKey: string): Promise<readonly PolicyDocumentCandidate[]> {
    const cached = cache.get(policyKey);
    if (cached) {
      return cached;
    }

    const rows = await listActivePolicyDocuments(options.db, policyKey);
    const candidates = rows.map(
      (row): PolicyDocumentCandidate => ({
        documentId: row.document_id,
        value: row.value,
        effectiveFrom: row.effective_from,
        effectiveUntil: row.effective_until,
      }),
    );
    cache.set(policyKey, candidates);
    return candidates;
  }

  async function resolvePolicy<Value>(
    definition: PolicyDefinition<Value>,
    params: Readonly<{ at?: string }> = {},
  ): Promise<ResolvedPolicy<Value>> {
    const at = params.at ?? now().toISOString();
    const candidates = await loadCandidates(definition.policyKey);
    const active = pickEffectiveCandidate(candidates, at);

    if (!active) {
      return {
        policyKey: definition.policyKey,
        value: definition.defaultValue,
        source: "fallback",
        documentId: null,
        effectiveFrom: null,
        effectiveUntil: null,
        resolvedAt: at,
      };
    }

    return {
      policyKey: definition.policyKey,
      value: definition.decodeValue(active.value as JsonValue),
      source: "policy",
      documentId: active.documentId,
      effectiveFrom: active.effectiveFrom,
      effectiveUntil: active.effectiveUntil,
      resolvedAt: at,
    };
  }

  return { resolvePolicy, cache };
}

/** Candidates are ordered `effectiveFrom` DESC, so the first window match is the latest applicable revision. */
function pickEffectiveCandidate(
  candidates: readonly PolicyDocumentCandidate[],
  at: string,
): PolicyDocumentCandidate | null {
  const atMs = Date.parse(at);

  for (const candidate of candidates) {
    const fromMs = Date.parse(candidate.effectiveFrom);
    const untilMs = candidate.effectiveUntil === null ? null : Date.parse(candidate.effectiveUntil);
    if (fromMs <= atMs && (untilMs === null || atMs < untilMs)) {
      return candidate;
    }
  }

  return null;
}
