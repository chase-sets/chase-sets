export type PolicyDocumentCandidate = Readonly<{
  documentId: string;
  value: unknown;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

/**
 * In-process cache of each policy key's active candidate documents. Reads
 * are hot (every resolution) and revisions are rare, so the cache holds the
 * whole active-candidate set per key rather than a single pre-picked value:
 * that lets `resolvePolicy` pick the window-correct candidate for any
 * requested instant, including one whose `effectiveFrom` is still in the
 * future, without the cache going stale as wall-clock time moves past a
 * document's boundary. The set only changes when a document is created or
 * revised, so invalidation is entirely push-based (see `projection.ts`'s
 * `onPolicyRevised` hook) -- there is no TTL and nothing polls Postgres.
 */
export type PolicyCache = Readonly<{
  get: (policyKey: string) => readonly PolicyDocumentCandidate[] | undefined;
  set: (policyKey: string, candidates: readonly PolicyDocumentCandidate[]) => void;
  invalidate: (policyKey: string) => void;
  invalidateAll: () => void;
}>;

export function createPolicyCache(): PolicyCache {
  const store = new Map<string, readonly PolicyDocumentCandidate[]>();

  return {
    get: (policyKey) => store.get(policyKey),
    set: (policyKey, candidates) => {
      store.set(policyKey, candidates);
    },
    invalidate: (policyKey) => {
      store.delete(policyKey);
    },
    invalidateAll: () => {
      store.clear();
    },
  };
}
