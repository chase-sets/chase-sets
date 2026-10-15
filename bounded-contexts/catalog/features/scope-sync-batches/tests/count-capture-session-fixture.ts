import { vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ProviderUsageSnapshot } from "../../source-observations/api/provider-adapters/provider-adapter";
import { createScrydexOnePieceProviderAdapter } from "../../source-observations/api/providers/scrydex/adapter";
import { countFingerprint, type CountAuthority } from "../domain/count-acquisition";
import { countCaptureUnitKeys } from "../domain/count-capture-plan";
import { syntheticCountCaptureAuthority } from "./count-lifecycle-receipt-fixture";
import { countCaptureSearchFrom } from "../domain/count-lifecycle-receipt";
import {
  createCountCaptureStore,
  type CountCaptureBaseline,
  type CountCaptureHost,
  type CountCaptureStore,
} from "../read-model/count-capture-store";
import { createCountCaptureLifecycle, type CountCaptureRoster } from "../api/count-capture-lifecycle";
import type { CountCaptureSession } from "../api/count-capture-lifecycle";

// Completely synthetic controls: no value here is a live staging, provider,
// deployment, review, session or spend observation.
export const captureAt = "2026-10-13T08:02:00.000Z";
export const captureScope = "scope-synthetic-op01";
export const captureContext: EventStoreContext = {
  tenantId: "tnt_synthetic_9585",
  audit: { performedByUserId: "usr_synthetic_9585", forAccountId: "acc_synthetic_9585" },
};
const stagingAdmin = "https://admin.staging.chasesets.com";
const row = <T extends Record<string, unknown>>(value: T) => value;

type History = { position: number; run_id: string; owner_hash: string; payload: unknown };

// The capture store's own five statements over an in-memory history. Any other
// statement is a test failure, so the store cannot reach anything else unseen.
// Appends become visible only on COMMIT, as in PostgreSQL.
export function createMemoryCapturePool() {
  const history: History[] = [];
  let position = 0;
  const query = async (text: string, values: readonly unknown[] = [], pending?: History[]) => {
    const sql = text.replace(/\s+/g, " ").trim();
    const visible = [...history, ...(pending ?? [])];
    const latestPerRun = (rows: History[]) =>
      [...new Map(rows.sort((a, b) => a.position - b.position).map((entry) => [entry.run_id, entry])).values()]
        .sort((a, b) => (a.run_id < b.run_id ? -1 : 1))
        .map((entry) => ({ payload: structuredClone(entry.payload) }));
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT pg_advisory_xact_lock(")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("INSERT INTO catalog_scope_sync_count_capture_history")) {
      const entry = {
        position: ++position,
        run_id: String(values[0]),
        owner_hash: String(values[1]),
        payload: JSON.parse(String(values[2])),
      };
      if (!pending) throw new Error("Capture history appends only inside a transaction.");
      pending.push(entry);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT payload FROM catalog_scope_sync_count_capture_history WHERE run_id = $1")) {
      const rows = visible.filter((entry) => entry.run_id === values[0]).sort((a, b) => b.position - a.position);
      return { rows: rows.slice(0, 1).map((entry) => ({ payload: structuredClone(entry.payload) })), rowCount: 1 };
    }
    if (
      sql.startsWith(
        "SELECT DISTINCT ON (run_id) payload FROM catalog_scope_sync_count_capture_history WHERE owner_hash",
      )
    )
      return { rows: latestPerRun(visible.filter((entry) => entry.owner_hash === values[0])), rowCount: 0 };
    if (sql.startsWith("SELECT DISTINCT ON (run_id) payload FROM catalog_scope_sync_count_capture_history"))
      return { rows: latestPerRun(visible), rowCount: 0 };
    throw new Error(`Unexpected capture statement: ${sql.slice(0, 80)}`);
  };
  // One transaction at a time stands in for the advisory lock.
  let tail = Promise.resolve();
  const pool: PgTransactionalPool = {
    query: ((text: string, values?: readonly unknown[]) => query(text, values)) as PgTransactionalPool["query"],
    connect: async (): Promise<PgPoolClient> => {
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>((resolve) => (release = resolve));
      await previous;
      const pending: History[] = [];
      const client = (async (text: string, values?: readonly unknown[]) => {
        const sql = text.trim();
        if (sql === "COMMIT") history.push(...pending.splice(0));
        if (sql === "ROLLBACK") pending.splice(0);
        return query(text, values, pending);
      }) as PgPoolClient["query"];
      return { query: client, release: () => release() };
    },
  };
  return { pool, history };
}

export function captureActor(overrides: Partial<ResolvedActor> = {}): ResolvedActor {
  return {
    sessionId: "synthetic-session-9585",
    tenantId: captureContext.tenantId,
    userId: captureContext.audit.performedByUserId,
    accountId: captureContext.audit.forAccountId,
    membershipId: "synthetic-membership-9585",
    roleKey: "platform-admin",
    permissions: ["catalog.view", "catalog.manage"],
    ...overrides,
  };
}

export function captureSession(
  input: { actor?: ResolvedActor | null; origin?: string | null; method?: string; url?: string; site?: string } = {},
): CountCaptureSession {
  const headers = new Headers();
  const origin = input.origin === undefined ? stagingAdmin : input.origin;
  if (origin !== null) headers.set("origin", origin);
  headers.set("sec-fetch-site", input.site ?? "same-origin");
  return {
    request: new Request(input.url ?? `${stagingAdmin}/api/catalog/scope-sync-batches/count-capture/baseline`, {
      method: input.method ?? "POST",
      headers,
    }),
    actor: input.actor === undefined ? captureActor() : input.actor,
    context: captureContext,
  };
}

export const captureProfiles = [
  ["one-piece-set-reference-data", countCaptureUnitKeys[0]],
  ["one-piece-card-print-source-observation", countCaptureUnitKeys[1]],
  ["one-piece-sealed-product-source-observation", countCaptureUnitKeys[2]],
] as const;

// The local roster of the capture scope: one active OP01 set, its three accepted
// Scrydex mappings and one active profile version per unit.
export function captureRoster(): CountCaptureRoster {
  return {
    records: [
      row({
        scope_record_id: captureScope,
        product_domain: "one-piece",
        scope_kind: "set",
        lifecycle_status: "active",
        updated_at: new Date("2026-10-13T07:00:00.000Z"),
      }),
    ],
    mappings: countCaptureUnitKeys.map((unitKey, index) =>
      row({
        mapping_id: `mapping-synthetic-${index}`,
        scope_record_id: captureScope,
        provider_key: "scrydex",
        unit_key: unitKey,
        set_id: "OP01",
        review_status: "accepted",
        updated_at: new Date("2026-10-13T07:00:00.000Z"),
      }),
    ),
    profiles: captureProfiles.map(([profileKey, unitKey]) => ({
      profileKey,
      profileVersion: "2026.06.22",
      active: true,
      lifecycle: "active",
      unitKey,
    })),
  };
}

export const captureAuthority = () => syntheticCountCaptureAuthority();

// The synthetic envelope shifted so it is fresh at `nowMs`, for real-clock compositions.
export function freshCaptureAuthority(nowMs: number, dispatchId = "synthetic-dispatch") {
  const at = (offsetMs: number) => new Date(Math.floor((nowMs + offsetMs) / 1000) * 1000).toISOString();
  const authority = syntheticCountCaptureAuthority();
  const startedAt = at(-20 * 60_000);
  return {
    ...authority,
    dispatchId,
    dispatchedAt: at(-60_000),
    budget: { ...authority.budget, observedAt: at(-60_000) },
    deployment: { ...authority.deployment, startedAt, completedAt: at(-15 * 60_000) },
    pods: { ...authority.pods, observedAt: at(-50_000) },
    collection: { ...authority.collection, collectedAt: at(-40_000), createdFrom: countCaptureSearchFrom(startedAt) },
  };
}

export function captureHost(dispatchId = "synthetic-dispatch"): CountCaptureHost {
  const sha = "a".repeat(40);
  return {
    fingerprint: countFingerprint({ dispatchId }),
    dispatchId,
    packetHash: "c".repeat(64),
    runnerSha: sha,
    deployment: { runId: "100", jobId: "200", sha, digest: `sha256:${"b".repeat(64)}` },
    netCredits: 25,
  };
}

export function captureBaseline(): CountCaptureBaseline {
  return {
    recordedAt: captureAt,
    selection: {
      scopeRecordId: captureScope,
      scopeRecordVersion: "2026-10-13T07:00:00.000Z",
      accountRevision: "runtime",
      productDomain: "one-piece",
      parentValue: "OP01",
      languageCode: "en",
    },
    units: captureProfiles.map(([profileKey, unitKey], index) => ({
      unitKey,
      profileKey,
      profileVersion: "2026.06.22",
      mappingId: `mapping-synthetic-${index}`,
      mappingVersion: "2026-10-13T07:00:00.000Z",
      setCoordinate: "OP01" as const,
    })),
    countAuthority: { fingerprint: "e".repeat(64), headroom: 30, allowed: true },
    effects: { at: captureAt, batches: 0, reservations: 0, jobs: 0, enqueues: 0, imports: 0 },
  };
}

// Walks a fresh run through the stages before `phase` with the store's own
// methods, then begins `phase`.
export async function beginCapturePhase(
  store: CountCaptureStore,
  runId: string,
  phase: Parameters<CountCaptureStore["begin"]>[1],
) {
  if (phase === "baseline") return store.begin(runId, phase);
  const baseline = await store.begin(runId, "baseline");
  await store.recordBaseline(baseline, {
    ...captureBaseline(),
    selection: { ...captureBaseline().selection, scopeRecordId: (await store.read(runId)).scopeRecordId },
  });
  await store.finish(baseline);
  await store.recordInitialNotice(runId);
  if (phase === "bootstrap") return store.begin(runId, phase);
  const bootstrap = await store.begin(runId, "bootstrap");
  await store.recordUsage(bootstrap, { state: "skipped", required: 11, authority: captureBaseline().countAuthority });
  await store.finish(bootstrap);
  return store.begin(runId, phase);
}

const usageBody = (remaining: number) => ({
  data: {
    credits_remaining: remaining,
    total_credits_consumed: 0,
    overage_credits_consumed: 0,
    period_start: "2026-01-01T00:00:00Z",
    period_end: "2027-01-01T00:00:00Z",
  },
});

// A durable count authority backed by the retained usage snapshot, as the count
// store derives it: fresh, checked usage less known commitments.
export function createCaptureAuthorityFixture(input: { retained?: number | null; committed?: number } = {}) {
  let retained: ProviderUsageSnapshot | null = null;
  let seeded = input.retained ?? null;
  const committed = input.committed ?? 0;
  const authority = vi.fn(async (): Promise<CountAuthority> => {
    const remaining = retained?.attemptState === "checked" ? retained.remainingCredits : seeded;
    const headroom = remaining === null || remaining === undefined ? null : Math.max(0, remaining - committed);
    return { fingerprint: countFingerprint({ remaining, committed }), headroom, allowed: headroom !== null };
  });
  const retainUsage = vi.fn(async (snapshot: ProviderUsageSnapshot) => {
    retained = snapshot;
    seeded = null;
  });
  // Drops retained usage, as if durable authority had aged out while the adapter stayed warm.
  const forget = () => {
    retained = null;
    seeded = null;
  };
  return { authority, retainUsage, forget };
}

// The real Scrydex adapter's usage path over a counting synthetic transport.
export function createCaptureUsageFixture(
  input: { remaining?: number; onUsageObserved?: ((snapshot: ProviderUsageSnapshot) => Promise<void>) | null } = {},
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    if (String(url) !== "https://api.scrydex.com/account/v1/usage")
      throw new Error("Unexpected synthetic provider call.");
    return Response.json(usageBody(input.remaining ?? 30));
  });
  const adapter = createScrydexOnePieceProviderAdapter({
    fetch,
    credentials: { apiKey: "synthetic-capture-key", teamId: "synthetic-capture-team" },
    now: () => new Date(captureAt),
    ...(input.onUsageObserved ? { onUsageObserved: input.onUsageObserved } : {}),
  });
  return { fetch, getUsageSnapshot: vi.fn(() => adapter.getUsageSnapshot()) };
}

// The capture lifecycle over the real store, an in-memory history and synthetic
// local reads. Every provider send is counted by `fetch`.
export function createCaptureLifecycleFixture(
  input: {
    environment?: string;
    roster?: () => CountCaptureRoster | Promise<CountCaptureRoster>;
    retained?: number | null;
    remaining?: number;
    callback?: boolean;
    clock?: { now: string };
  } = {},
) {
  const clock = input.clock ?? { now: captureAt };
  const memory = createMemoryCapturePool();
  const store = createCountCaptureStore(memory.pool, () => clock.now);
  const counts = createCaptureAuthorityFixture({ retained: input.retained === undefined ? 30 : input.retained });
  const usage = createCaptureUsageFixture({
    remaining: input.remaining,
    onUsageObserved: input.callback === false ? null : counts.retainUsage,
  });
  const readRoster = vi.fn(async () => (input.roster ?? captureRoster)());
  const readEffects = vi.fn(async (at: string) => ({
    at,
    batches: 2,
    reservations: 0,
    jobs: 5,
    enqueues: 1,
    imports: 7,
  }));
  const deps = {
    environment: input.environment ?? "staging",
    accountRevision: "runtime",
    store,
    readRoster,
    readEffects,
    countAuthority: counts.authority,
    observeUsage: usage.getUsageSnapshot,
    now: () => clock.now,
  };
  return {
    lifecycle: createCountCaptureLifecycle(deps),
    deps,
    store,
    memory,
    counts,
    usage,
    readRoster,
    readEffects,
    clock,
  };
}
