import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { recordPlatformPolicyStaleServed } from "@chase-sets/observability";
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
 * -- falls back to `definition.defaultValue` rather than throwing.
 *
 * While reads succeed and return within `POLICY_CACHE_MAX_AGE_MS`, the
 * candidate set is read through `db` at most once per key per that age, and
 * resolutions that find no fresh set share one read. A slower read is
 * already expired when it is stored, so the next resolution reads again.
 * When a read fails after this process loaded a set for the
 * key, the resolution serves the loaded set, records the stale-served signal
 * and caches nothing, so the next resolution reads again. It rejects only
 * when no set was ever loaded.
 */
export function createPolicyResolver(options: CreatePolicyResolverOptions): PolicyResolver {
  const cache = options.cache ?? createPolicyCache();
  const now = options.now ?? (() => new Date());
  const readsInFlight = new Map<string, Promise<readonly PolicyDocumentCandidate[]>>();

  async function readCandidates(policyKey: string): Promise<readonly PolicyDocumentCandidate[]> {
    const readStartedAtMs = cache.now();
    const rows = await listActivePolicyDocuments(options.db, policyKey);
    const candidates = rows.map(
      (row): PolicyDocumentCandidate => ({
        documentId: row.document_id,
        value: row.value,
        effectiveFrom: row.effective_from,
        effectiveUntil: row.effective_until,
      }),
    );
    cache.set(policyKey, candidates, readStartedAtMs);
    return candidates;
  }

  function sharedRead(policyKey: string): Promise<readonly PolicyDocumentCandidate[]> {
    const inFlight = readsInFlight.get(policyKey);
    if (inFlight) {
      return inFlight;
    }

    const read = readCandidates(policyKey).finally(() => {
      readsInFlight.delete(policyKey);
    });
    readsInFlight.set(policyKey, read);
    return read;
  }

  async function loadCandidates(definition: PolicyDefinition<unknown>): Promise<readonly PolicyDocumentCandidate[]> {
    const fresh = cache.get(definition.policyKey);
    if (fresh) {
      return fresh;
    }

    try {
      return await sharedRead(definition.policyKey);
    } catch (error) {
      const loaded = cache.lastLoaded(definition.policyKey);
      if (!loaded) {
        throw error;
      }
      recordPlatformPolicyStaleServed({
        policyKey: definition.policyKey,
        contextName: definition.contextName,
        ageMs: cache.now() - loaded.readStartedAtMs,
      });
      return loaded.candidates;
    }
  }

  async function resolvePolicy<Value>(
    definition: PolicyDefinition<Value>,
    params: Readonly<{ at?: string }> = {},
  ): Promise<ResolvedPolicy<Value>> {
    const at = params.at ?? now().toISOString();
    const candidates = await loadCandidates(definition);
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
