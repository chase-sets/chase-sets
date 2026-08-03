import type {
  BcApiModule,
  BcProjectionHandlerSet,
  BcSeedAggregateStateReport,
  BcSeedOptions,
} from "@chase-sets/bounded-context-module";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  countEventsWithPrefix,
  createCheckpointKey,
  loadSubscriptionCheckpoint,
  seedProfilesOverlap,
} from "@chase-sets/bounded-context-runtime";
import {
  getApiHostEntries,
  getApiHostSeedOrder,
  seedApiHostIfEmpty,
  type ApiContextManifest,
  type ApiHostRuntime,
} from "@chase-sets/platform-runtime/api";
import type { PlatformApiRuntimeProfile } from "@chase-sets/platform-runtime/runtime-profiles";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { paymentsReservedSeedIds } from "@chase-sets/payments/seed-support/ids";
import { settlementReservedSeedIds } from "@chase-sets/settlement/seed-support/ids";
import { describe, expect, it } from "vitest";
import { createPlatformApiHost } from "../src/app";
import type { PlatformApiContextName } from "../src/config";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import {
  createPlatformApiBootstrapTestHarness,
  listingPhotoStorage,
  platformApiContextNames,
  type PlatformApiTestPools,
} from "./bootstrap-db-test-support";

/**
 * DB-tier coverage for #4906 and #6396 across the derived scenario-seed
 * universe: a seed must decide what remains to author from its authoritative
 * `event_store_events` streams, never from a read model that lags — whether
 * because PostgreSQL truncated an UNLOGGED projection on crash recovery or
 * because the projection that fills it is simply behind the stream.
 *
 * Context membership is never hand-written here. Every context list this file
 * asserts on is derived from `apiContextRegistry` through the runtime's own
 * `getApiHostEntries` / mount-role selection, and the prose tables recorded on
 * #6396 are checked against that derived set as diagnostics.
 */
const HOST_NAME = "platform-api";
const SETTLEMENT_PAYOUT_PROJECTION_NAME = "settlement-payout-projection";
const PREDECESSOR_REAUTHOR_ERROR = "PREDECESSOR_WOULD_REAUTHOR_SETTLEMENT";
const registryContextNames = apiContextRegistry.map((entry) => entry.contextName);

/**
 * The #4906 UNLOGGED-truncation fixture. This is deliberately *not* the
 * coverage authority — it is the explicit list of read-model tables this file
 * truncates to prove crash-recovery resume, and it is validated below against
 * the derived inspecting set so it can never name a context that stopped
 * inspecting. The confirmed inventory failure and the resume/fail-closed
 * controls live in the cheaper `inventory-seed-resume.db.test.ts` partition;
 * Catalog's lagging-projection coverage lives in
 * `catalog-seed-aggregate-state.db.test.ts` and is not rebuilt here.
 */
const unloggedGuardProjectionFixture = [
  {
    contextName: "inventory",
    projections: ["inventory_holds", "inventory_items", "inventory_storage_locations"],
  },
  { contextName: "identity", projections: ["identity_accounts"] },
  {
    contextName: "marketplace",
    projections: ["marketplace_review_pages", "marketplace_offer_pages", "marketplace_listing_pages"],
  },
  { contextName: "payments", projections: ["payments_payment_pages"] },
  { contextName: "settlement", projections: ["settlement_payout_pages"] },
  { contextName: "fulfillment", projections: ["fulfillment_shipment_pages"] },
  { contextName: "checkout", projections: ["checkout_cart_line_pages", "checkout_session_pages"] },
  { contextName: "ordering", projections: ["ordering_order_pages", "ordering_postage_policy_pages"] },
  {
    contextName: "platform-operations",
    projections: ["experience_platform_feedback_pages", "support_request_pages"],
  },
] as const satisfies readonly Readonly<{ contextName: PlatformApiContextName; projections: readonly string[] }>[];

/**
 * Mounted contexts that seed but deliberately declare no stream-sourced seed
 * state, with the reason. A newly mounted seeding context is a coverage
 * omission unless it is added here on purpose, which is what makes the
 * enumeration below fail loudly rather than silently shrink.
 */
const seedStateExemptions = new Map<string, string>([
  ["pricing", "seed is a no-op; it authors no aggregate"],
  ["commercial-terms", "authors logged platform-policy documents, not UNLOGGED projections"],
  ["public-presence", "authors logged platform-policy documents and promo-bar rows, not UNLOGGED projections"],
]);

type MountRole = "active" | "source-only";
type ProfileUniverse = Readonly<{
  active: readonly string[];
  sourceOnly: readonly string[];
  omitted: readonly string[];
}>;

/**
 * Profile universes frozen on #6396. These are diagnostics: every one of them
 * is compared against the set derived from the executable manifests below, and
 * the derivation — not this table — is the authority.
 */
const frozenProfileDiagnostics: Readonly<Record<string, ProfileUniverse>> = {
  undefined: {
    active: [
      "auth",
      "authenticity",
      "catalog",
      "checkout",
      "collections",
      "commercial-terms",
      "customer-feedback",
      "discovery",
      "fulfillment",
      "identity",
      "inventory",
      "marketplace",
      "notifications",
      "ordering",
      "payments",
      "platform-operations",
      "pricing",
      "public-presence",
      "settlement",
    ],
    sourceOnly: [],
    omitted: [],
  },
  proof: {
    active: [
      "auth",
      "authenticity",
      "catalog",
      "checkout",
      "collections",
      "commercial-terms",
      "customer-feedback",
      "discovery",
      "fulfillment",
      "identity",
      "inventory",
      "marketplace",
      "notifications",
      "ordering",
      "payments",
      "platform-operations",
      "pricing",
      "public-presence",
      "settlement",
    ],
    sourceOnly: [],
    omitted: [],
  },
  public: {
    active: [
      "auth",
      "authenticity",
      "catalog",
      "checkout",
      "collections",
      "commercial-terms",
      "customer-feedback",
      "discovery",
      "fulfillment",
      "identity",
      "inventory",
      "marketplace",
      "notifications",
      "ordering",
      "payments",
      "platform-operations",
      "pricing",
      "public-presence",
      "settlement",
    ],
    sourceOnly: [],
    omitted: [],
  },
  landing: {
    active: ["auth", "catalog", "identity", "platform-operations", "public-presence"],
    sourceOnly: ["commercial-terms", "fulfillment", "marketplace", "ordering", "settlement"],
    omitted: [
      "authenticity",
      "checkout",
      "collections",
      "customer-feedback",
      "discovery",
      "inventory",
      "notifications",
      "payments",
      "pricing",
    ],
  },
};

/**
 * The exact `undefined` + `scenario-seed` eligible universe recorded on #6396,
 * checked below against `seedProfilesOverlap` over the mounted modules.
 */
const frozenEligibleScenarioSeedContexts = [
  "auth",
  "catalog",
  "checkout",
  "commercial-terms",
  "fulfillment",
  "identity",
  "inventory",
  "marketplace",
  "ordering",
  "payments",
  "platform-operations",
  "pricing",
  "public-presence",
  "settlement",
] as const;

/** The contexts that expose `inspectSeedState`, per #6396. */
const frozenInspectingSeedContexts = [
  "auth",
  "catalog",
  "checkout",
  "fulfillment",
  "identity",
  "inventory",
  "marketplace",
  "ordering",
  "payments",
  "platform-operations",
  "settlement",
] as const;

/** Eligible contexts that deliberately expose no `inspectSeedState`. */
const frozenNonInspectingSeedContexts = ["commercial-terms", "pricing", "public-presence"] as const;

/**
 * Derives active / source-only / omitted membership for one host runtime
 * profile straight from the generated registry manifests, using the same
 * `apiDeployables` + `apiRuntimeProfiles` and `sourceRuntimeDeployables` +
 * `sourceRuntimeProfiles` predicate the runtime mounts with. `undefined`
 * matches every declared profile, which is why it is expressible here and not
 * through `createPlatformApiHost` (that helper defaults `undefined` to
 * `public`). The derivation is cross-checked against the executable mount
 * roles for every profile a host can actually be constructed for.
 */
function deriveProfileUniverse(runtimeProfile: PlatformApiRuntimeProfile | undefined): ProfileUniverse {
  const entries = getApiHostEntries(apiContextRegistry, HOST_NAME, runtimeProfile);
  const mounted = new Set(entries.map((entry) => entry.contextName));
  const active: string[] = [];
  const sourceOnly: string[] = [];

  for (const entry of entries) {
    const manifest = entry.manifest as ApiContextManifest;
    const isActive =
      Boolean(manifest.apiDeployables?.includes(HOST_NAME)) &&
      (!runtimeProfile || Boolean(manifest.apiRuntimeProfiles?.includes(runtimeProfile)));
    (isActive ? active : sourceOnly).push(entry.contextName);
  }

  return {
    active: [...active].sort(),
    sourceOnly: [...sourceOnly].sort(),
    omitted: registryContextNames.filter((contextName) => !mounted.has(contextName)).sort(),
  };
}

/** The mount roles the runtime actually resolves when a host is constructed. */
function executableProfileUniverse(runtimeProfile: PlatformApiRuntimeProfile): ProfileUniverse {
  const runtime = createHost(runtimeProfile);
  const roleOf = (role: MountRole) =>
    runtime.mountedContexts
      .filter((entry) => entry.mountRole === role)
      .map((entry) => entry.contextName)
      .sort();
  const mounted = new Set(runtime.mountedContexts.map((entry) => entry.contextName));

  return {
    active: roleOf("active"),
    sourceOnly: roleOf("source-only"),
    omitted: registryContextNames.filter((contextName) => !mounted.has(contextName)).sort(),
  };
}

function formatUniverse(label: string, universe: ProfileUniverse): string {
  return (
    `[#6396 universe] ${label}: active(${universe.active.length})=${universe.active.join(",") || "-"} | ` +
    `source-only(${universe.sourceOnly.length})=${universe.sourceOnly.join(",") || "-"} | ` +
    `omitted(${universe.omitted.length})=${universe.omitted.join(",") || "-"}`
  );
}

type EligibleSeedContext = Readonly<{
  contextName: string;
  streamPrefix: string;
  inspects: boolean;
}>;

/**
 * The scenario-seed eligible contexts for the mounted runtime, decided by the
 * runtime's own `module.seed` + `seedProfilesOverlap` predicate. An undefined
 * module `seedProfiles` defaults to `["scenario-seed"]`, which is why this
 * cannot be shortened to "every mounted context".
 */
function eligibleScenarioSeedContexts(runtime: ApiHostRuntime): readonly EligibleSeedContext[] {
  return runtime.mountedContexts
    .filter((entry) => Boolean(entry.module.seed) && seedProfilesOverlap(entry.module.seedProfiles, seedOptions))
    .map((entry) => ({
      contextName: entry.contextName,
      streamPrefix: entry.module.streamPrefix,
      inspects: Boolean(entry.module.inspectSeedState),
    }));
}

/**
 * The only per-context append authority this slice recognises:
 * `countEventsWithPrefix(pool, module.streamPrefix)`. Counting every row in
 * `event_store_events` would fold in streams the module does not own.
 */
async function eligiblePrefixCounts(runtime: ApiHostRuntime): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const context of eligibleScenarioSeedContexts(runtime)) {
    counts[context.contextName] = await countEventsWithPrefix(poolFor(context.contextName), context.streamPrefix);
  }
  return counts;
}

/**
 * Relation count per active context database. The harness reset drops every
 * object the test user owns, so a clean case entry is zero relations
 * everywhere — including `event_store_events`, which only the boot creates.
 */
async function activeContextRelationCounts(): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const contextName of platformApiContextNames) {
    const result = await poolFor(contextName).query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );
    counts[contextName] = Number(result.rows[0]?.count ?? 0);
  }
  return counts;
}

/**
 * Re-invokes every eligible module seed in host seed order. This is the caller
 * shape `platform-runtime/api.ts` uses at its three full-drain sites within a
 * single boot: `seed:<context>`, `projection-drain:<context>` (which seeds
 * again between drains), and `seed-reconcile:<context>`.
 */
async function repeatSameBootSeedLifecyclePoint(runtime: ApiHostRuntime): Promise<void> {
  for (const contextName of getApiHostSeedOrder(apiContextRegistry, HOST_NAME, undefined, seedOptions)) {
    const context = runtime.mountedContexts.find((entry) => entry.contextName === contextName);
    if (!context?.module.seed || !seedProfilesOverlap(context.module.seedProfiles, seedOptions)) {
      continue;
    }
    await context.module.seed(context.pool, context.services, seedOptions);
  }
}

const settlementPayoutCheckpointKey = createCheckpointKey({
  projectionName: SETTLEMENT_PAYOUT_PROJECTION_NAME,
  sourceContextName: "settlement",
  subscriptionVersion: 1,
});
const seededPayoutIds = [
  settlementReservedSeedIds.payouts.completed,
  settlementReservedSeedIds.payouts.failed,
] as const;
const settlementSeedPrerequisitePaymentId = paymentsReservedSeedIds.payments.acceptedOfferCaptured;
const settlementSeedSellerAccountId = identitySeedIds.demo.accountId;

/**
 * Clones the executable `landing` runtime, removing only the
 * `projectionHandlerSet` whose `projectionName` is
 * `settlement-payout-projection`. Every other handler set, service, pool, and
 * mount role is the identical object the host resolved. Under `landing`
 * Settlement is source-only, so `resolveModuleSubscriptions` skips it entirely
 * and this local handler set is the sole writer of `settlement_payout_pages`.
 */
function withLaggingSettlementPayoutProjection(runtime: ApiHostRuntime): ApiHostRuntime {
  return {
    ...runtime,
    mountedContexts: runtime.mountedContexts.map((entry) =>
      entry.contextName === "settlement"
        ? {
            ...entry,
            projectionHandlerSets: entry.projectionHandlerSets.filter(
              (set: BcProjectionHandlerSet) => set.projectionName !== SETTLEMENT_PAYOUT_PROJECTION_NAME,
            ),
          }
        : entry,
    ),
  };
}

async function settlementPayoutPageIds(): Promise<readonly string[]> {
  const result = await pools.settlement.query<Readonly<{ payout_id: string }>>(
    "SELECT payout_id FROM settlement_payout_pages ORDER BY payout_id ASC",
  );
  return result.rows.map((row) => row.payout_id);
}

type SettlementPrerequisiteRow = Readonly<{
  payment_id: string;
  amount: string;
  currency_code: string;
  status: string;
  captured_at: string | null;
}>;

async function settlementPaymentSourceRows(): Promise<readonly SettlementPrerequisiteRow[]> {
  const result = await pools.settlement.query<SettlementPrerequisiteRow>(
    `SELECT payment_id, amount::text AS amount, currency_code, status, captured_at::text AS captured_at
       FROM settlement_payment_sources
      ORDER BY payment_id ASC`,
  );
  return result.rows;
}

/**
 * The current, shipped decision: which seeded payouts remain to author, read
 * from the authoritative `settlement.payout-*` streams.
 */
async function payoutsMissingFromStreams(): Promise<readonly string[]> {
  const result = await pools.settlement.query<Readonly<{ stream_id: string }>>(
    "SELECT DISTINCT stream_id FROM event_store_events WHERE stream_id = ANY($1::text[])",
    [seededPayoutIds.map((payoutId) => `settlement.payout-${payoutId}`)],
  );
  const present = new Set(result.rows.map((row) => row.stream_id));
  return seededPayoutIds.filter((payoutId) => !present.has(`settlement.payout-${payoutId}`));
}

/**
 * Reset-equivalent predecessor of that decision: identical in shape and asked
 * of the identical fixture, but sourced from the `settlement_payout_pages`
 * read model instead of the stream — the empty-projection decision #6396
 * exists to keep out. It raises `PREDECESSOR_WOULD_REAUTHOR_SETTLEMENT`
 * instead of appending, so the control cannot corrupt the fixture the
 * current-code assertions share.
 */
async function predecessorEmptyProjectionSeedDecision(): Promise<readonly string[]> {
  const result = await pools.settlement.query<Readonly<{ payout_id: string }>>(
    "SELECT payout_id FROM settlement_payout_pages WHERE payout_id = ANY($1::text[])",
    [[...seededPayoutIds]],
  );
  const present = new Set(result.rows.map((row) => row.payout_id));
  const wouldReauthor = seededPayoutIds.filter((payoutId) => !present.has(payoutId));
  if (wouldReauthor.length > 0) {
    throw new Error(
      `${PREDECESSOR_REAUTHOR_ERROR}: the empty-projection decision would re-issue RequestPayout for ` +
        `${wouldReauthor.join(", ")} while their settlement.payout-* streams are current.`,
    );
  }
  return wouldReauthor;
}

const requiredDraftListingId = "lst_seed_lugia_neo_genesis_draft";
const resolvedSeedSupportRequestId = "sup_seed_resolved_partial_refund";
const resolvedSeedBuyerAttestationId = "sev_seed_resolved_buyer_attestation";
const resolvedSeedPhotoId = "sev_seed_resolved_photo";

let pools: PlatformApiTestPools;
createPlatformApiBootstrapTestHarness("platform_api_authoritative_seed_resume", (state) => {
  pools = state.pools;
});

type SeedingModule = Pick<BcApiModule<unknown, unknown, unknown>, "contextName" | "seed" | "inspectSeedState">;
type SeedLifecycleSupportRequests = Readonly<{
  commandHandler: (
    input: Readonly<{
      streamId: string;
      command: Readonly<Record<string, unknown>>;
      context: EventStoreContext;
    }>,
  ) => Promise<unknown>;
  sweepSupportRequestDeadlines: (
    params: Readonly<{ now?: string; limit?: number }>,
    context: EventStoreContext,
  ) => Promise<Readonly<{ autoClosed: number }>>;
}>;
type SupportSeedOrderSource = Readonly<{
  order_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  total_amount: string;
}>;

/**
 * `public`, `proof`, and the `undefined` profile resolve to the identical
 * 19-active / zero-source-only universe (proved by the derivation case), so a
 * `public` host is the executable stand-in for the `undefined` scenario-seed
 * universe. `landing` is passed explicitly where the source-only path matters.
 */
function createHost(runtimeProfile: PlatformApiRuntimeProfile = "public") {
  return createPlatformApiHost({
    runtimeProfile,
    pools,
    hostPorts: {
      processorGateway: createFakePaymentProcessorGateway(),
      listingPhotoStorage,
    },
  });
}

const seedOptions: BcSeedOptions = {
  enabledDataProfiles: ["critical-bootstrap", "catalog-integration-bootstrap", "scenario-seed"],
  environmentName: "test",
};

async function ordinaryBoot(runtime: ReturnType<typeof createHost>): Promise<void> {
  await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, seedOptions);
}

/**
 * Re-invokes every mounted context's `seed` in host seed order, which is the
 * caller shape `platform-runtime/api.ts` uses at `:468` (seed), `:475`
 * (`projection-drain:<context>`), and `:494` (`seed-reconcile:<context>`)
 * within a single boot.
 */
async function invokeConvertedSeeds(runtime: ReturnType<typeof createHost>): Promise<void> {
  for (const entry of unloggedGuardProjectionFixture) {
    const context = runtime.mountedContexts.find((mounted) => mounted.contextName === entry.contextName);
    if (!context?.module.seed) {
      throw new Error(`Context '${entry.contextName}' is not mounted with a seed.`);
    }
    await context.module.seed(context.pool, context.services, seedOptions);
  }
}

function seedingModules(runtime: ReturnType<typeof createHost>): readonly SeedingModule[] {
  return runtime.mountedModules.map((entry) => entry.module as SeedingModule).filter((module) => Boolean(module.seed));
}

function poolFor(contextName: string) {
  return pools[contextName as PlatformApiContextName];
}

function requirePlatformOperationsContext(runtime: ReturnType<typeof createHost>) {
  const context = runtime.mountedContexts.find((mounted) => mounted.contextName === "platform-operations");
  if (!context?.module.seed || !context.module.inspectSeedState) {
    throw new Error("Platform Operations is not mounted with seed reconciliation and inspection.");
  }
  return context;
}

function supportRequestServices(context: ReturnType<typeof requirePlatformOperationsContext>) {
  return (context.services as unknown as Readonly<{ supportRequests: SeedLifecycleSupportRequests }>).supportRequests;
}

const seedActorContext = {
  tenantId: "tnt_seed_development",
  audit: {
    performedByUserId: "usr_test_issue_6167",
    forAccountId: "acc_test_issue_6167",
  },
} as EventStoreContext;

async function contextEventCount(contextName: string): Promise<number> {
  const result = await poolFor(contextName).query<Readonly<{ count: string }>>(
    "SELECT COUNT(*) AS count FROM event_store_events",
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function allContextEventCounts(): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const entry of unloggedGuardProjectionFixture) {
    counts[entry.contextName] = await contextEventCount(entry.contextName);
  }
  return counts;
}

async function paymentStreamEventCounts(paymentIds: readonly string[]): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const paymentId of paymentIds) {
    const streamId = `payments.payment-${paymentId}`;
    const result = await pools.payments.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id = $1",
      [streamId],
    );
    counts[paymentId] = Number(result.rows[0]?.count ?? 0);
  }
  return counts;
}

async function paymentStreamEventTypes(paymentId: string): Promise<readonly string[]> {
  const result = await pools.payments.query<Readonly<{ event_type: string }>>(
    "SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC",
    [`payments.payment-${paymentId}`],
  );
  return result.rows.map((row) => row.event_type);
}

async function supportRequestStreamEventTypes(supportRequestId: string): Promise<readonly string[]> {
  const result = await pools["platform-operations"].query<Readonly<{ event_type: string }>>(
    "SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC",
    [`support.support-request-${supportRequestId}`],
  );
  return result.rows.map((row) => row.event_type);
}

async function replaceResolvedSeedRequestWithCancelled(supportRequests: SeedLifecycleSupportRequests): Promise<void> {
  const supportRequestId = resolvedSeedSupportRequestId;
  const streamId = `support.support-request-${supportRequestId}`;
  const platformOperationsPool = pools["platform-operations"];
  const orderResult = await platformOperationsPool.query<SupportSeedOrderSource>(
    `SELECT source.order_id,
            source.buyer_account_id,
            source.seller_account_id,
            source.total_amount::text AS total_amount
     FROM support_request_pages AS request
     JOIN support_order_sources AS source ON source.order_id = request.order_id
     WHERE request.support_request_id = $1`,
    [supportRequestId],
  );
  const order = orderResult.rows[0];
  if (!order) {
    throw new Error("Platform Operations support seed order source is absent.");
  }

  await platformOperationsPool.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id = $1", [streamId]);
  await platformOperationsPool.query("DELETE FROM event_store_events WHERE stream_id = $1", [streamId]);
  await platformOperationsPool.query(
    "UPDATE event_store_streams SET current_version = 0, updated_at = now() WHERE stream_id = $1",
    [streamId],
  );
  await platformOperationsPool.query("DELETE FROM support_request_pages WHERE support_request_id = $1", [
    supportRequestId,
  ]);

  await supportRequests.commandHandler({
    streamId,
    command: {
      type: "OpenSupportRequest",
      supportRequestId,
      orderId: order.order_id,
      orderTotalAmount: order.total_amount,
      buyerAccountId: order.buyer_account_id,
      sellerAccountId: order.seller_account_id,
      flowType: "product-damaged",
      openedByAccountId: order.buyer_account_id,
      openedByRole: "buyer",
      openedAt: "2026-03-25T10:00:00.000Z",
    },
    context: seedActorContext,
  });
  await supportRequests.commandHandler({
    streamId,
    command: {
      type: "SubmitSupportEvidence",
      evidenceId: resolvedSeedBuyerAttestationId,
      submittedByAccountId: order.buyer_account_id,
      submittedByRole: "buyer",
      evidenceType: "buyer-attestation",
      summary: "Buyer reports the item arrived with shipping damage.",
      submittedAt: "2026-03-25T10:02:00.000Z",
      attachments: [],
    },
    context: seedActorContext,
  });
  await supportRequests.commandHandler({
    streamId,
    command: {
      type: "SubmitSupportEvidence",
      evidenceId: resolvedSeedPhotoId,
      submittedByAccountId: order.buyer_account_id,
      submittedByRole: "buyer",
      evidenceType: "photo",
      summary: "Photo evidence shows the damaged corner.",
      submittedAt: "2026-03-25T10:04:00.000Z",
      attachments: ["seed://support/damaged-card-corner"],
    },
    context: seedActorContext,
  });
  await supportRequests.commandHandler({
    streamId,
    command: {
      type: "CancelSupportRequest",
      cancelledAt: "2026-03-25T10:10:00.000Z",
      reason: "Cancelled-state seed reconciliation negative control.",
    },
    context: seedActorContext,
  });
}

function summarizeStates(reports: readonly BcSeedAggregateStateReport[]): string {
  const byKind = new Map<string, number>();
  for (const report of reports) {
    byKind.set(report.kind, (byKind.get(report.kind) ?? 0) + 1);
  }
  return [...byKind.entries()].map(([kind, count]) => `${kind}=${count}`).join(" ");
}

describe("authoritative seed resume", () => {
  it("derives the exact active and source-only seed universe for every host profile", async () => {
    const derived: Record<string, ProfileUniverse> = {};
    for (const runtimeProfile of [undefined, "landing", "proof", "public"] as const) {
      const label = runtimeProfile ?? "undefined";
      const universe = deriveProfileUniverse(runtimeProfile);
      derived[label] = universe;
      console.log(formatUniverse(label, universe));

      // Every derived context is accounted for exactly once across the three roles.
      expect([...universe.active, ...universe.sourceOnly, ...universe.omitted].sort()).toEqual(
        [...registryContextNames].sort(),
      );
      expect(universe).toEqual(frozenProfileDiagnostics[label]);
    }

    // Executable cross-check: for every profile a host can be constructed for,
    // the derivation must equal the mount roles the runtime itself resolves.
    // This is what keeps the `undefined` derivation from being a reimplementation
    // that has silently diverged from production selection.
    for (const runtimeProfile of ["landing", "proof", "public"] as const) {
      expect(executableProfileUniverse(runtimeProfile), `executable mount roles for '${runtimeProfile}'`).toEqual(
        derived[runtimeProfile],
      );
    }

    // `undefined` matches every declared profile, so it must equal the profiles
    // whose declared membership is total. This is why a `public` host is the
    // executable stand-in for the `undefined` universe in the boot cases below.
    expect(derived.undefined).toEqual(derived.proof);
    expect(derived.undefined).toEqual(derived.public);
    expect(derived.undefined!.active).toHaveLength(19);
    expect(derived.undefined!.sourceOnly).toEqual([]);

    // Omitted-context negative control: a context omitted under `landing` is
    // absent from the mounted set, absent from both roles, and absent from the
    // host the runtime actually builds — presence in the registry is not
    // presence in the universe.
    const landing = derived.landing!;
    expect(landing.omitted).toContain("payments");
    expect(landing.active).not.toContain("payments");
    expect(landing.sourceOnly).not.toContain("payments");
    const landingRuntime = createHost("landing");
    expect(landingRuntime.mountedContexts.map((entry) => entry.contextName)).not.toContain("payments");
    expect(landingRuntime.mountedContexts).toHaveLength(landing.active.length + landing.sourceOnly.length);

    // Scenario-seed eligibility is decided by `seedProfilesOverlap`, not by
    // mount membership: 19 mounted contexts, 14 eligible, 11 of them inspecting.
    const runtime = createHost();
    const eligible = eligibleScenarioSeedContexts(runtime);
    expect(eligible.map((context) => context.contextName).sort()).toEqual([...frozenEligibleScenarioSeedContexts]);
    expect(
      eligible
        .filter((context) => context.inspects)
        .map((context) => context.contextName)
        .sort(),
    ).toEqual([...frozenInspectingSeedContexts]);
    expect(
      eligible
        .filter((context) => !context.inspects)
        .map((context) => context.contextName)
        .sort(),
    ).toEqual([...frozenNonInspectingSeedContexts]);
    console.log(
      `[#6396 eligibility] mounted=${runtime.mountedContexts.length} eligible=${eligible.length} ` +
        `inspecting=${eligible.filter((context) => context.inspects).length} ` +
        `non-inspecting=${frozenNonInspectingSeedContexts.join(",")}`,
    );
  });

  it("keeps every scenario-seed stream prefix at zero delta on ordinary boot two", async () => {
    const runtime = createHost();
    const eligible = eligibleScenarioSeedContexts(runtime);

    // Schema-isolation receipt: the harness resets all 19 active context schemas
    // before each case. The reset is total — `DROP OWNED BY CURRENT_USER
    // CASCADE` leaves each context database with no relations at all — so this
    // case cannot inherit retained state from any earlier case, and the
    // event-store tables themselves only exist once this boot bootstraps them.
    expect(platformApiContextNames).toHaveLength(19);
    const relationsAtCaseEntry = await activeContextRelationCounts();
    expect(relationsAtCaseEntry, JSON.stringify(relationsAtCaseEntry)).toEqual(
      Object.fromEntries(platformApiContextNames.map((contextName) => [contextName, 0])),
    );

    const bootOneStartedAt = Date.now();
    await ordinaryBoot(runtime);
    const afterBootOne = await eligiblePrefixCounts(runtime);
    const bootOneMs = Date.now() - bootOneStartedAt;

    // Same-boot repetition, proven separately from process boot two: re-invoke
    // the eligible seeds at each of the three full-drain lifecycle points
    // `platform-runtime/api.ts` uses within one boot and assert the settled
    // prefix count is unchanged after each.
    console.log(`[#6396 phase] boot-one=${(bootOneMs / 1000).toFixed(1)}s`);
    for (const lifecyclePoint of ["seed", "projection-drain", "seed-reconcile"] as const) {
      const repeatStartedAt = Date.now();
      await repeatSameBootSeedLifecyclePoint(runtime);
      const afterRepeat = await eligiblePrefixCounts(runtime);
      expect(afterRepeat, `same-boot repeat at ${lifecyclePoint}`).toEqual(afterBootOne);
      console.log(
        `[#6396 same-boot] ${lifecyclePoint} repeat: appended=0 across ${eligible.length} contexts ` +
          `in ${((Date.now() - repeatStartedAt) / 1000).toFixed(1)}s`,
      );
    }

    // Non-inspecting owned outputs captured before boot two so their idempotence
    // is measured rather than assumed.
    const promoBarBefore = await pools["public-presence"].query<Readonly<{ id: string; display_order: number }>>(
      "SELECT id, display_order FROM public_presence_promo_bar_messages ORDER BY id ASC",
    );
    const betaWavePolicyBefore = await pools["public-presence"].query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM platform_policy_documents WHERE status = 'active'",
    );

    const bootTwoStartedAt = Date.now();
    await ordinaryBoot(runtime);
    const afterBootTwo = await eligiblePrefixCounts(runtime);
    const bootTwoMs = Date.now() - bootTwoStartedAt;

    for (const context of eligible) {
      const before = afterBootOne[context.contextName]!;
      const after = afterBootTwo[context.contextName]!;
      console.log(
        `[#6396 delta] ${context.contextName} prefix=${context.streamPrefix} ` +
          `before=${before} after=${after} delta=${after - before} inspects=${context.inspects}`,
      );
    }
    expect(afterBootTwo, "ordinary boot two must append nothing for any eligible context").toEqual(afterBootOne);

    // Honest non-inspector arms: each is reported as what it is, and none is
    // claimed to have inspected aggregate state.
    expect(afterBootTwo["commercial-terms"], "Commercial Terms is stream-prefix-only").toBeGreaterThan(0);
    expect(afterBootTwo["commercial-terms"]! - afterBootOne["commercial-terms"]!).toBe(0);
    expect(afterBootOne.pricing, "Pricing is a declared no-op").toBe(0);
    expect(afterBootTwo.pricing).toBe(0);
    expect(afterBootOne["public-presence"], "Public Presence authors no public-presence.* stream").toBe(0);
    expect(afterBootTwo["public-presence"]).toBe(0);
    const promoBarAfter = await pools["public-presence"].query<Readonly<{ id: string; display_order: number }>>(
      "SELECT id, display_order FROM public_presence_promo_bar_messages ORDER BY id ASC",
    );
    const betaWavePolicyAfter = await pools["public-presence"].query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM platform_policy_documents WHERE status = 'active'",
    );
    expect(promoBarAfter.rows.length, "Public Presence seeds promo-bar rows").toBeGreaterThan(0);
    expect(promoBarAfter.rows, "promo-bar output is idempotent across boot two").toEqual(promoBarBefore.rows);
    expect(betaWavePolicyAfter.rows, "policy output is idempotent across boot two").toEqual(betaWavePolicyBefore.rows);
    for (const contextName of frozenNonInspectingSeedContexts) {
      const context = runtime.mountedContexts.find((entry) => entry.contextName === contextName);
      expect(
        context?.module.inspectSeedState,
        `${contextName} must not claim inspected aggregate state`,
      ).toBeUndefined();
    }

    console.log(
      `[#6396 timing] boot-one=${(bootOneMs / 1000).toFixed(1)}s boot-two=${(bootTwoMs / 1000).toFixed(1)}s ` +
        `eligible=${eligible.length}`,
    );
  }, 300_000);

  it("does not re-author Settlement while its payout projection lags the stream", async () => {
    const runtime = createHost();
    await ordinaryBoot(runtime);

    // Fixture capture, before anything lags. The exact cross-context
    // prerequisite Settlement's seed reads, the retained stream-prefix count,
    // the payout projection checkpoint, and the projected payout rows.
    const prerequisiteRows = await settlementPaymentSourceRows();
    const prerequisite = prerequisiteRows.find((row) => row.payment_id === settlementSeedPrerequisitePaymentId);
    expect(prerequisite, "the exact Settlement seed prerequisite payment source is absent").toBeDefined();
    expect(prerequisite!.status).toBe("captured");
    const retainedSettlementEvents = await countEventsWithPrefix(pools.settlement, "settlement.");
    expect(retainedSettlementEvents).toBeGreaterThan(0);
    const checkpointBefore = await loadSubscriptionCheckpoint(pools.settlement, settlementPayoutCheckpointKey);
    expect(checkpointBefore, "the payout projection checkpoint must exist after a completed boot").not.toBeNull();
    expect(await settlementPayoutPageIds()).toEqual([...seededPayoutIds].sort());

    // Establish the lag: only `settlement_payout_pages` and its checkpoint fall
    // behind. The `settlement.*` streams stay exactly as boot one left them.
    await pools.settlement.query("DELETE FROM settlement_payout_pages");
    await pools.settlement.query("DELETE FROM event_subscription_checkpoints WHERE checkpoint_key = $1", [
      settlementPayoutCheckpointKey,
    ]);
    expect(await settlementPayoutPageIds()).toEqual([]);
    expect(await loadSubscriptionCheckpoint(pools.settlement, settlementPayoutCheckpointKey)).toBeNull();
    expect(await countEventsWithPrefix(pools.settlement, "settlement."), "the stream must stay current").toBe(
      retainedSettlementEvents,
    );
    // Retained lag state exists only where this fixture established it: the
    // other Settlement projection checkpoints are untouched.
    const otherSettlementCheckpoints = await pools.settlement.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM event_subscription_checkpoints WHERE checkpoint_key <> $1",
      [settlementPayoutCheckpointKey],
    );
    expect(Number(otherSettlementCheckpoints.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    // Clone the executable `landing` runtime, withholding only the named
    // projection handler set. Settlement is source-only under `landing`, so the
    // 445-455 seed/drain/seed/drain path is the one that runs.
    const landingRuntime = createHost("landing");
    const settlementMount = landingRuntime.mountedContexts.find((entry) => entry.contextName === "settlement");
    expect(settlementMount?.mountRole, "Settlement must be source-only under landing").toBe("source-only");
    const laggingRuntime = withLaggingSettlementPayoutProjection(landingRuntime);
    const laggingSettlement = laggingRuntime.mountedContexts.find((entry) => entry.contextName === "settlement");
    expect(settlementMount!.projectionHandlerSets.map((set) => set.projectionName)).toContain(
      SETTLEMENT_PAYOUT_PROJECTION_NAME,
    );
    expect(laggingSettlement!.projectionHandlerSets.map((set) => set.projectionName)).not.toContain(
      SETTLEMENT_PAYOUT_PROJECTION_NAME,
    );
    expect(laggingSettlement!.projectionHandlerSets).toHaveLength(settlementMount!.projectionHandlerSets.length - 1);
    // Everything except the withheld handler set is the identical object.
    for (const entry of laggingRuntime.mountedContexts) {
      const original = landingRuntime.mountedContexts.find((candidate) => candidate.contextName === entry.contextName)!;
      expect(entry.pool).toBe(original.pool);
      expect(entry.services).toBe(original.services);
      expect(entry.mountRole).toBe(original.mountRole);
      if (entry.contextName !== "settlement") {
        expect(entry).toBe(original);
      }
    }

    await seedApiHostIfEmpty(apiContextRegistry, HOST_NAME, laggingRuntime, {
      ...seedOptions,
      runtimeProfile: "landing",
    });

    // Current code decides from the stream: nothing is re-authored, and the
    // withheld projection is still visibly behind afterwards.
    const settlementEventsAfterRepeat = await countEventsWithPrefix(pools.settlement, "settlement.");
    expect(settlementEventsAfterRepeat - retainedSettlementEvents).toBe(0);
    expect(await settlementPayoutPageIds(), "the withheld projection must stay behind").toEqual([]);
    expect(await loadSubscriptionCheckpoint(pools.settlement, settlementPayoutCheckpointKey)).toBeNull();
    expect(await payoutsMissingFromStreams(), "the streams still carry both seeded payouts").toEqual([]);
    console.log(
      `[#6396 lag] settlement prefix ${retainedSettlementEvents} -> ${settlementEventsAfterRepeat} (delta 0); ` +
        `settlement_payout_pages=0 rows; checkpoint '${settlementPayoutCheckpointKey}'=absent; ` +
        `prerequisite ${prerequisite!.payment_id} status=${prerequisite!.status}`,
    );

    // Predecessor mutant on that same fixture: identical question, sourced from
    // the empty projection instead of the stream.
    await expect(predecessorEmptyProjectionSeedDecision()).rejects.toThrow(PREDECESSOR_REAUTHOR_ERROR);
    console.log(`[#6396 predecessor] empty-projection decision raised ${PREDECESSOR_REAUTHOR_ERROR}`);

    // Paired prerequisite negative: give the seed real work to do, then prove an
    // unrelated captured row cannot stand in for the exact missing target.
    const completedPayoutStreamId = `settlement.payout-${settlementReservedSeedIds.payouts.completed}`;
    await pools.settlement.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id = $1", [
      completedPayoutStreamId,
    ]);
    await pools.settlement.query("DELETE FROM event_store_events WHERE stream_id = $1", [completedPayoutStreamId]);
    await pools.settlement.query(
      "UPDATE event_store_streams SET current_version = 0, updated_at = now() WHERE stream_id = $1",
      [completedPayoutStreamId],
    );
    expect(await payoutsMissingFromStreams()).toEqual([settlementReservedSeedIds.payouts.completed]);
    const withWorkPending = await countEventsWithPrefix(pools.settlement, "settlement.");

    const unrelatedPaymentId = "pay_seed_unrelated_negative_control";
    await pools.settlement.query("DELETE FROM settlement_payment_sources WHERE payment_id = $1", [
      settlementSeedPrerequisitePaymentId,
    ]);
    await pools.settlement.query(
      `INSERT INTO settlement_payment_sources (
         payment_id, buyer_account_id, amount, currency_code, processor_name,
         processor_payment_reference, processor_status, status, created_at, updated_at, captured_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), now())`,
      [
        unrelatedPaymentId,
        "acc_seed_unrelated_buyer",
        prerequisite!.amount,
        prerequisite!.currency_code,
        "fake",
        "ref_unrelated_negative_control",
        "captured",
        "captured",
      ],
    );
    const negativeRows = await settlementPaymentSourceRows();
    expect(negativeRows.map((row) => row.payment_id)).toContain(unrelatedPaymentId);
    expect(negativeRows.map((row) => row.payment_id)).not.toContain(settlementSeedPrerequisitePaymentId);

    const settlementContext = runtime.mountedContexts.find((entry) => entry.contextName === "settlement")!;
    await settlementContext.module.seed!(settlementContext.pool, settlementContext.services, seedOptions);
    expect(
      await countEventsWithPrefix(pools.settlement, "settlement."),
      "an unrelated captured row must not stand in for the exact missing prerequisite",
    ).toBe(withWorkPending);
    expect(await payoutsMissingFromStreams()).toEqual([settlementReservedSeedIds.payouts.completed]);

    // Restore the exact target and the same seed does the pending work.
    await pools.settlement.query(
      `INSERT INTO settlement_payment_sources (
         payment_id, buyer_account_id, amount, currency_code, processor_name,
         processor_payment_reference, processor_status, status, created_at, updated_at, captured_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), $9)`,
      [
        settlementSeedPrerequisitePaymentId,
        "acc_seed_demo_buyer",
        prerequisite!.amount,
        prerequisite!.currency_code,
        "fake",
        "ref_restored_exact_target",
        "captured",
        "captured",
        prerequisite!.captured_at,
      ],
    );
    await settlementContext.module.seed!(settlementContext.pool, settlementContext.services, seedOptions);
    const afterExactTarget = await countEventsWithPrefix(pools.settlement, "settlement.");
    expect(afterExactTarget, "the exact prerequisite unblocks the pending payout").toBeGreaterThan(withWorkPending);
    expect(await payoutsMissingFromStreams()).toEqual([]);
    console.log(
      `[#6396 prerequisite] unrelated-row-only appends=0 (prefix ${withWorkPending}); ` +
        `exact-target-restored appends=${afterExactTarget - withWorkPending}`,
    );
  }, 300_000);

  it("reconciles every inspecting scenario-seed context to identity-matching active state", async () => {
    const runtime = createHost();
    await ordinaryBoot(runtime);

    const inspecting = eligibleScenarioSeedContexts(runtime).filter((context) => context.inspects);
    expect(inspecting.map((context) => context.contextName).sort()).toEqual([...frozenInspectingSeedContexts]);

    // The whole table is emitted before anything is asserted, so a single
    // non-active aggregate cannot truncate the omission-revealing evidence.
    const notActive: string[] = [];
    const rehydratedNothing: string[] = [];
    const duplicateIdentities: string[] = [];
    for (const context of inspecting) {
      const mount = runtime.mountedContexts.find((entry) => entry.contextName === context.contextName)!;
      const reports = await mount.module.inspectSeedState!(mount.pool, seedOptions);
      expect(reports.length, `${context.contextName} reports no seed aggregates`).toBeGreaterThan(0);
      console.log(
        `[#6396 aggregate-state] ${context.contextName}: ${reports.length} aggregates ${summarizeStates(reports)}`,
      );
      const identities = new Set<string>();
      for (const report of reports) {
        // Identity-matching: every report names a concrete, unique seed identity
        // rehydrated from a non-empty authoritative stream. A present container
        // or a bare stream id is not an aggregate.
        expect(report.id, `${context.contextName} report has no aggregate id`).toBeTruthy();
        expect(report.key, `${context.contextName} '${report.id}' has no seed key`).toBeTruthy();
        expect(report.streamId, `${context.contextName} '${report.key}' has no stream`).toBeTruthy();
        const identity = `${report.aggregateName}:${report.id}`;
        if (identities.has(identity)) {
          duplicateIdentities.push(`${context.contextName} ${identity}`);
        }
        identities.add(identity);
        if (report.kind !== "active") {
          notActive.push(
            `${context.contextName} ${report.aggregateName} '${report.key}' id=${report.id} ` +
              `kind=${report.kind} status=${report.status ?? "-"} events=${report.eventCount} ` +
              `stream=${report.streamId}`,
          );
        }
        if (report.eventCount <= 0) {
          rehydratedNothing.push(`${context.contextName} '${report.key}' id=${report.id}`);
        }
      }
    }
    for (const entry of notActive) {
      console.log(`[#6396 aggregate-state NOT-ACTIVE] ${entry}`);
    }
    expect(duplicateIdentities, "an aggregate identity was reported more than once").toEqual([]);
    expect(notActive, `inspecting contexts finished with non-active seed aggregates:\n${notActive.join("\n")}`).toEqual(
      [],
    );
    expect(
      rehydratedNothing,
      `seed aggregates reported without rehydrating any events:\n${rehydratedNothing.join("\n")}`,
    ).toEqual([]);

    // Marketplace business status `draft` is not aggregate kind `draft`: the
    // seeded draft listing is a complete aggregate whose business status is
    // deliberately draft.
    const marketplaceMount = runtime.mountedContexts.find((entry) => entry.contextName === "marketplace")!;
    const marketplaceReports = await marketplaceMount.module.inspectSeedState!(marketplaceMount.pool, seedOptions);
    expect(marketplaceReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: requiredDraftListingId, kind: "active", status: "draft" }),
      ]),
    );

    // A pre-existing non-active aggregate reconciles rather than failing the
    // boot. Rolling the seeded wallet's release event off the stream leaves the
    // pending sale credit posted-but-not-available, which `inspectSeedState`
    // reports as `draft`.
    const settlementMount = runtime.mountedContexts.find((entry) => entry.contextName === "settlement")!;
    const walletStreamId = `settlement.wallet-${settlementSeedSellerAccountId}`;
    const released = await pools.settlement.query<Readonly<{ stream_version: string }>>(
      `SELECT stream_version
         FROM event_store_events
        WHERE stream_id = $1
          AND event_type = 'settlement.wallet.ledger-entry-available-recorded'
          AND payload->>'ledgerEntryId' = $2`,
      [walletStreamId, settlementReservedSeedIds.ledgerEntries.pendingSaleCredit],
    );
    expect(released.rows, "the seeded pending sale credit was never released").toHaveLength(1);
    await pools.settlement.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id = $1", [walletStreamId]);
    await pools.settlement.query(
      `DELETE FROM event_store_events
        WHERE stream_id = $1
          AND event_type = 'settlement.wallet.ledger-entry-available-recorded'
          AND payload->>'ledgerEntryId' = $2`,
      [walletStreamId, settlementReservedSeedIds.ledgerEntries.pendingSaleCredit],
    );

    const draftReports = await settlementMount.module.inspectSeedState!(settlementMount.pool, seedOptions);
    expect(draftReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: settlementReservedSeedIds.ledgerEntries.pendingSaleCredit,
          kind: "draft",
        }),
      ]),
    );

    await expect(
      settlementMount.module.seed!(settlementMount.pool, settlementMount.services, seedOptions),
    ).resolves.toBeUndefined();

    const reconciledReports = await settlementMount.module.inspectSeedState!(settlementMount.pool, seedOptions);
    expect(reconciledReports.filter((report) => report.kind !== "active")).toEqual([]);
    expect(reconciledReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: settlementReservedSeedIds.ledgerEntries.pendingSaleCredit,
          kind: "active",
        }),
      ]),
    );
    console.log(
      `[#6396 reconcile] inspecting=${inspecting.length} all kind=active; ` +
        "settlement pending-sale-credit draft -> active without boot failure",
    );
  }, 300_000);

  it("enumerates stream-sourced seed-state coverage from the runtime mount list", async () => {
    const runtime = createHost();
    const modules = seedingModules(runtime);
    expect(modules.length).toBeGreaterThan(0);

    const missing = modules
      .filter((module) => !module.inspectSeedState && !seedStateExemptions.has(module.contextName))
      .map((module) => module.contextName);
    expect(missing, `seeding contexts without stream-sourced seed state: ${missing.join(", ")}`).toEqual([]);

    // No stale exemptions: every exempt name must still be a mounted seeding context.
    const mountedNames = new Set(modules.map((module) => module.contextName));
    const staleExemptions = [...seedStateExemptions.keys()].filter((name) => !mountedNames.has(name));
    expect(staleExemptions).toEqual([]);

    // The UNLOGGED-truncation fixture is not the coverage authority, but it may
    // never drift: every context it names must still be a mounted, non-exempt,
    // inspecting seeding context derived from the runtime mount list.
    const derivedInspecting = new Set(
      eligibleScenarioSeedContexts(runtime)
        .filter((context) => context.inspects)
        .map((context) => context.contextName),
    );
    for (const entry of unloggedGuardProjectionFixture) {
      const module = modules.find((candidate) => candidate.contextName === entry.contextName);
      expect(module, `truncation-fixture context '${entry.contextName}' is not mounted`).toBeDefined();
      expect(seedStateExemptions.has(entry.contextName)).toBe(false);
      expect(module?.inspectSeedState, `'${entry.contextName}' declares no inspectSeedState`).toBeDefined();
      expect(
        derivedInspecting.has(entry.contextName),
        `truncation-fixture context '${entry.contextName}' is not in the derived inspecting set`,
      ).toBe(true);
    }

    // Omission negative control: a mounted seeding context that does not declare
    // stream-sourced seed state must be reported by the very same enumeration.
    const withOmission = modules.map((module) =>
      module.contextName === "inventory" ? { contextName: module.contextName, seed: module.seed } : module,
    );
    const omitted = withOmission
      .filter((module) => !module.inspectSeedState && !seedStateExemptions.has(module.contextName))
      .map((module) => module.contextName);
    expect(omitted).toEqual(["inventory"]);
  });

  it("resumes every converted context after its UNLOGGED guard projections are truncated", async () => {
    const runtime = createHost();
    await ordinaryBoot(runtime);

    const afterBootOne = await allContextEventCounts();
    for (const [contextName, count] of Object.entries(afterBootOne)) {
      expect(count, `${contextName} must have seeded events after boot one`).toBeGreaterThan(0);
    }
    const marketplaceModule = seedingModules(runtime).find((module) => module.contextName === "marketplace");
    const marketplaceReports = await marketplaceModule!.inspectSeedState!(poolFor("marketplace"));
    expect(marketplaceReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: requiredDraftListingId,
          kind: "active",
          status: "draft",
        }),
      ]),
    );

    for (const entry of unloggedGuardProjectionFixture) {
      await poolFor(entry.contextName).query(`TRUNCATE TABLE ${entry.projections.join(", ")} CASCADE`);
      for (const projection of entry.projections) {
        const rows = await poolFor(entry.contextName).query<Readonly<{ count: string }>>(
          `SELECT COUNT(*) AS count FROM ${projection}`,
        );
        expect(Number(rows.rows[0]?.count ?? 0), `${entry.contextName}.${projection}`).toBe(0);
      }
    }
    expect(await allContextEventCounts(), "truncating projections must not touch streams").toEqual(afterBootOne);

    // Re-invoke every seed three times against the emptied projections, exactly
    // as one boot does at api.ts:468, :475 and :494. Before this change the
    // inventory pass threw `InventoryDomainError: Storage location has already
    // been created.` and no later context seeded at all.
    for (let invocation = 1; invocation <= 3; invocation += 1) {
      await invokeConvertedSeeds(runtime);
      expect(await allContextEventCounts(), `invocation ${invocation}`).toEqual(afterBootOne);
    }

    const afterBootTwo = await allContextEventCounts();
    expect(afterBootTwo).toEqual(afterBootOne);

    for (const entry of unloggedGuardProjectionFixture) {
      const module = seedingModules(runtime).find((candidate) => candidate.contextName === entry.contextName);
      const reports = await module!.inspectSeedState!(poolFor(entry.contextName));
      console.log(
        `[#4906] ${entry.contextName}: truncated ${entry.projections.join(", ")} -> ` +
          `${reports.length} seed aggregates ${summarizeStates(reports)}, ` +
          `events ${afterBootTwo[entry.contextName]}`,
      );
      for (const report of reports) {
        console.log(
          `[#4906]   ${entry.contextName} ${report.aggregateName} '${report.key}' ` +
            `kind=${report.kind} status=${report.status ?? "-"} events=${report.eventCount} ` +
            `stream=${report.streamId}`,
        );
      }

      expect(reports.length, `${entry.contextName} reports no seed aggregates`).toBeGreaterThan(0);
      // No aggregate may be left half-authored: `draft` after a completed
      // resume is the committed-but-incomplete shape this issue exists to fix.
      const draft = reports.filter((report) => report.kind === "draft");
      expect(draft, `${entry.contextName} left draft aggregates: ${JSON.stringify(draft)}`).toEqual([]);
      expect(
        reports.some((report) => report.kind === "active"),
        `${entry.contextName} resumed no aggregate to active`,
      ).toBe(true);
    }
    // Full-host boot case: same explicit budget the suite already uses for
    // `bootstrap-scenario.db.test.ts`'s single full-host boot.
  }, 300_000);

  it("accepts a seeded resolution after the real deadline sweep advances it to closed", async () => {
    const runtime = createHost();
    await ordinaryBoot(runtime);
    const context = requirePlatformOperationsContext(runtime);
    const supportRequests = supportRequestServices(context);
    const supportRequestId = resolvedSeedSupportRequestId;
    const beforeSweepTypes = await supportRequestStreamEventTypes(supportRequestId);
    expect(beforeSweepTypes).toContain("support.support-request.resolved");
    expect(beforeSweepTypes).not.toContain("support.support-request.closed");

    const sweep = await supportRequests.sweepSupportRequestDeadlines(
      { now: "2026-04-02T10:30:00.000Z" },
      seedActorContext,
    );

    expect(sweep.autoClosed).toBe(1);
    const afterSweepTypes = await supportRequestStreamEventTypes(supportRequestId);
    expect(afterSweepTypes).toEqual([...beforeSweepTypes, "support.support-request.closed"]);
    const afterSweepReports = await context.module.inspectSeedState!(context.pool);
    expect(afterSweepReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: supportRequestId,
          kind: "active",
          status: "closed",
        }),
      ]),
    );

    const afterSweepEventCount = await contextEventCount("platform-operations");
    await expect(context.module.seed!(context.pool, context.services, seedOptions)).resolves.toBeUndefined();
    expect(await contextEventCount("platform-operations")).toBe(afterSweepEventCount);
    const afterReconciliationReports = await context.module.inspectSeedState!(context.pool);
    expect(afterReconciliationReports.filter((report) => report.kind === "draft")).toEqual([]);
    expect(await supportRequestStreamEventTypes(supportRequestId)).toEqual(afterSweepTypes);
    console.log(
      `[#6167 pass-after] status=closed inspection=active seed-reentry-appends=0 ` +
        "counterfactual-resolved-only-complete=false",
    );
  }, 300_000);

  it("keeps a cancelled resolution-bearing seed request incomplete and does not silently repair it", async () => {
    const runtime = createHost();
    await ordinaryBoot(runtime);
    const context = requirePlatformOperationsContext(runtime);
    await replaceResolvedSeedRequestWithCancelled(supportRequestServices(context));
    const supportRequestId = resolvedSeedSupportRequestId;
    const cancelledTypes = await supportRequestStreamEventTypes(supportRequestId);
    expect(cancelledTypes.at(-1)).toBe("support.support-request.cancelled");

    const beforeReconciliationEventCount = await contextEventCount("platform-operations");
    const beforeReconciliationReports = await context.module.inspectSeedState!(context.pool);
    expect(beforeReconciliationReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: supportRequestId,
          kind: "draft",
          status: "cancelled",
        }),
      ]),
    );

    await expect(context.module.seed!(context.pool, context.services, seedOptions)).rejects.toThrow();
    expect(await contextEventCount("platform-operations")).toBe(beforeReconciliationEventCount);
    expect(await supportRequestStreamEventTypes(supportRequestId)).toEqual(cancelledTypes);
    const afterReconciliationReports = await context.module.inspectSeedState!(context.pool);
    expect(afterReconciliationReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: supportRequestId,
          kind: "draft",
          status: "cancelled",
        }),
      ]),
    );
    console.log("[#6167 cancelled-control] inspection=draft seed-reentry=reject appends=0");
  }, 300_000);

  it("recreates only a missing review-eligible payment after a sibling payment has completed", async () => {
    const runtime = createHost();
    await ordinaryBoot(runtime);

    const paymentsContext = runtime.mountedContexts.find((context) => context.contextName === "payments");
    if (!paymentsContext?.module.seed || !paymentsContext.module.inspectSeedState) {
      throw new Error("Payments context is not mounted with seed-state inspection.");
    }
    const paymentReports = (await paymentsContext.module.inspectSeedState(paymentsContext.pool)).filter(
      (report) => report.aggregateName === "Payment",
    );
    const reviewEligibleReport = paymentReports.find((report) => report.key === "review-eligible-captured");
    if (!reviewEligibleReport) {
      throw new Error("Payments seed-state inspection did not report the review-eligible payment.");
    }
    const paymentId = reviewEligibleReport.id;
    const paymentIds = paymentReports.map((report) => report.id);
    const streamId = reviewEligibleReport.streamId;
    const created = await pools.payments.query<Readonly<{ order_id: string }>>(
      `SELECT payload->'orderIds'->>0 AS order_id
       FROM event_store_events
       WHERE stream_id = $1
         AND event_type = 'payments.payment-created'`,
      [streamId],
    );
    const orderId = created.rows[0]?.order_id;
    expect(orderId, "review-eligible payment has no created order").toBeDefined();

    const beforeCrash = await paymentStreamEventCounts(paymentIds);
    expect(beforeCrash[paymentId]).toBeGreaterThan(0);

    await pools.payments.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id = $1", [streamId]);
    await pools.payments.query("DELETE FROM event_store_events WHERE stream_id = $1", [streamId]);
    await pools.payments.query(
      "UPDATE event_store_streams SET current_version = 0, updated_at = now() WHERE stream_id = $1",
      [streamId],
    );
    await pools.payments.query(
      `UPDATE payments_order_inputs
       SET status = 'pending-payment',
           ready_for_fulfillment_at = NULL
       WHERE order_id = $1`,
      [orderId],
    );
    expect((await paymentStreamEventCounts(paymentIds))[paymentId]).toBe(0);

    try {
      await paymentsContext.module.seed(paymentsContext.pool, paymentsContext.services, seedOptions);
    } catch (error) {
      console.log(
        `[#4906 F1 fail-before] error=${error instanceof Error ? error.message : String(error)} ` +
          `missing-stream-events=${(await paymentStreamEventCounts(paymentIds))[paymentId]}`,
      );
      throw error;
    }

    const afterRepair = await paymentStreamEventCounts(paymentIds);
    const siblingAppends = Object.fromEntries(
      Object.entries(afterRepair)
        .filter(([candidateId]) => candidateId !== paymentId)
        .map(([candidateId, count]) => [candidateId, count - (beforeCrash[candidateId] ?? 0)]),
    );
    expect(afterRepair[paymentId]).toBe(3);
    expect(await paymentStreamEventTypes(paymentId)).toEqual([
      "payments.payment-created",
      "payments.payment-captured",
      "payments.csat-outcome-fact.v1",
    ]);
    expect(siblingAppends).toEqual(
      Object.fromEntries(Object.keys(siblingAppends).map((candidateId) => [candidateId, 0])),
    );

    await paymentsContext.module.seed(paymentsContext.pool, paymentsContext.services, seedOptions);
    const afterSteadyState = await paymentStreamEventCounts(paymentIds);
    expect(afterSteadyState).toEqual(afterRepair);
    console.log(
      `[#4906 F1 pass-after] recreated-events=${afterRepair[paymentId]} ` +
        `sibling-appends=${JSON.stringify(siblingAppends)} next-invocation-appends=0`,
    );
  }, 300_000);
});
