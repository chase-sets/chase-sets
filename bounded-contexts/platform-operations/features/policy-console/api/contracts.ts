import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CreatePolicyDocumentParams, RevisePolicyDocumentParams } from "@chase-sets/platform-policy/commands";
import type { PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { ResolvedPolicy } from "@chase-sets/platform-policy/resolver";
import type { JsonValue } from "@chase-sets/primitives/json";

/**
 * The platform policy console is registry-driven: it lists
 * every policy declared with `definePolicy` across the contexts that have
 * migrated onto the shared platform-policy machinery, grouped by owning
 * context, with history and scheduled-revision support.
 *
 * Reads go straight at each owning context's own `platform_policy_documents`
 * table -- the shared read model, one copy per context's own database --
 * using the generic query functions the machinery already exports
 * (`listPolicyRegistry`, `listActivePolicyDocuments`, `getPolicyDocument`,
 * `listPolicyDocumentHistory`). Writes delegate to that context's own,
 * already-running `PolicyRuntime` instance -- reusing its cache and its
 * event store -- instead of building a parallel one, so a console revision
 * invalidates exactly the same cache the owning context's own resolvers
 * read from.
 *
 * Settlement's and Commercial Terms' policies are cross-context sources,
 * injected as an opaque host port (`policyConsoleCrossContext`; see
 * `../../../support/runtime-support/services.ts`) assembled once in the
 * `platform-api` composition root. Platform Operations never imports those
 * contexts' domain code directly -- this keeps `allowedContextDependencies`
 * empty for this context while still letting the console aggregate across
 * contexts.
 *
 * Commercial Terms' schedules and agreements (per-account-type /
 * per-account policy keys) deliberately do NOT appear here -- they keep
 * their own `/terms` admin surface with its richer, account-targeted
 * semantics. The console links out to that
 * surface instead of listing every schedule/agreement policy key.
 */

export type PolicyConsoleWritePort = Readonly<{
  createPolicyDocument: <Value>(
    definition: PolicyDefinition<Value>,
    params: Omit<CreatePolicyDocumentParams<Value>, "documentId">,
    context: EventStoreContext,
  ) => Promise<{ documentId: string; version: number }>;
  revisePolicyDocument: <Value>(
    definition: PolicyDefinition<Value>,
    documentId: string,
    params: RevisePolicyDocumentParams<Value>,
    context: EventStoreContext,
  ) => Promise<{ documentId: string; version: number }>;
  resolvePolicy: <Value>(
    definition: PolicyDefinition<Value>,
    params?: Readonly<{ at?: string }>,
  ) => Promise<ResolvedPolicy<Value>>;
}>;

/** One cross-context source: a context's own read pool, its declared policy definitions, and its write port. */
export type PolicyConsoleCrossContextSource = Readonly<{
  contextName: string;
  db: PgQueryable;
  definitions: readonly PolicyDefinition<JsonValue>[];
  write: PolicyConsoleWritePort;
}>;

/** The host port Platform Operations declares and `platform-api` fulfills at composition time. */
export type PolicyConsoleCrossContextPort = Readonly<{
  sources: readonly PolicyConsoleCrossContextSource[];
}>;

/** One registry entry the console renders: a resolved (context, db, definition, write port) tuple. */
export type PolicyConsoleEntry = Readonly<{
  policyKey: string;
  contextName: string;
  db: PgQueryable;
  definition: PolicyDefinition<JsonValue>;
  write: PolicyConsoleWritePort;
}>;

export type PolicyConsoleRegistryItem = Readonly<{
  policyKey: string;
  contextName: string;
  schemaSummary: string;
  status: string;
  value: JsonValue;
  effectiveFrom: string;
  effectiveUntil: string | null;
  updatedAt: string;
}>;

export type PolicyConsoleUpcomingRevision = Readonly<{
  documentId: string;
  status: string;
  value: JsonValue;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

export type PolicyConsoleOverview = Readonly<{
  policyKey: string;
  contextName: string;
  schemaSummary: string;
  current: Readonly<{
    source: "policy" | "fallback";
    documentId: string | null;
    status: string | null;
    value: JsonValue;
    effectiveFrom: string | null;
    effectiveUntil: string | null;
  }>;
  upcoming: readonly PolicyConsoleUpcomingRevision[];
}>;

export type CreatePolicyConsoleRevisionRequest = Readonly<{
  value: JsonValue;
  status: "active" | "inactive";
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;
