export type PolicyDocumentCandidate = Readonly<{
  documentId: string;
  value: unknown;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

/**
 * How long a process may keep using a policy key's candidate set, measured
 * from the moment the read that produced it began.
 */
export const POLICY_CACHE_MAX_AGE_MS = 1_000;

export type LoadedPolicyCandidates = Readonly<{
  candidates: readonly PolicyDocumentCandidate[];
  readStartedAtMs: number;
}>;

/**
 * In-process cache of each policy key's active candidate documents. Reads
 * are hot (every resolution) and revisions are rare, so the cache holds the
 * whole active-candidate set per key rather than a single pre-picked value:
 * that lets `resolvePolicy` pick the window-correct candidate for any
 * requested instant, including one whose `effectiveFrom` is still in the
 * future, as wall-clock time moves past a document's boundary.
 *
 * A set is fresh for `POLICY_CACHE_MAX_AGE_MS` from the start of its read,
 * so every process follows the read model within that bound whether or not
 * it applies the policy projection. A process that does apply it also
 * invalidates on each created or revised document (see `projection.ts`'s
 * `onPolicyRevised` hook). `get` returns fresh sets only; `lastLoaded`
 * returns the last set this process loaded at any age, which is what
 * `resolvePolicy` serves when a refresh fails.
 *
 * `now` is the age clock in epoch milliseconds. It is unrelated to the
 * instant a policy is resolved at.
 */
export type PolicyCache = Readonly<{
  now: () => number;
  get: (policyKey: string) => readonly PolicyDocumentCandidate[] | undefined;
  lastLoaded: (policyKey: string) => LoadedPolicyCandidates | undefined;
  /** `readStartedAtMs` defaults to `now()`. */
  set: (policyKey: string, candidates: readonly PolicyDocumentCandidate[], readStartedAtMs?: number) => void;
  invalidate: (policyKey: string) => void;
  invalidateAll: () => void;
}>;

type PolicyCacheEntry = LoadedPolicyCandidates & { invalidated: boolean };

export function createPolicyCache(options: Readonly<{ now?: () => number }> = {}): PolicyCache {
  const now = options.now ?? Date.now;
  const store = new Map<string, PolicyCacheEntry>();

  return {
    now,
    get: (policyKey) => {
      const entry = store.get(policyKey);
      if (!entry || entry.invalidated) {
        return undefined;
      }
      // A stamp ahead of the clock means the clock stepped back, so the age is unknown.
      const ageMs = now() - entry.readStartedAtMs;
      return ageMs >= 0 && ageMs < POLICY_CACHE_MAX_AGE_MS ? entry.candidates : undefined;
    },
    lastLoaded: (policyKey) => {
      const entry = store.get(policyKey);
      return entry ? { candidates: entry.candidates, readStartedAtMs: entry.readStartedAtMs } : undefined;
    },
    set: (policyKey, candidates, readStartedAtMs = now()) => {
      store.set(policyKey, { candidates, readStartedAtMs, invalidated: false });
    },
    invalidate: (policyKey) => {
      const entry = store.get(policyKey);
      if (entry) {
        entry.invalidated = true;
      }
    },
    invalidateAll: () => {
      for (const entry of store.values()) {
        entry.invalidated = true;
      }
    },
  };
}
