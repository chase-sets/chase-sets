import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type {
  BcSeedAggregateStateReport,
  BcSeedOptions,
  EnvironmentDataProfile,
} from "@chase-sets/bounded-context-module";
import {
  createSeedAggregateReconciler,
  loadSeedStreamEvents,
  reconcileSeedAggregates,
  type SeedAggregateReconciler,
} from "@chase-sets/bounded-context-runtime";
import type { DomainEvent } from "@chase-sets/event-core";
import {
  decidePayout,
  evolvePayout,
  initialPayoutState,
  type PayoutCommand,
  type PayoutEvent,
  type PayoutState,
} from "../../features/payouts/domain/domain";
import { identitySeedIds } from "@chase-sets/identity-seed";
import { paymentsReservedSeedIds } from "@chase-sets/payments/seed-support/ids";
import { settlementReservedSeedIds } from "@chase-sets/settlement/seed-support/ids";
import type { PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import { normalizeCurrencyCode } from "./common";
import { createSettlementServices, type SettlementServices } from "./services";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId } from "@chase-sets/primitives/typed-ids";
import {
  SETTLEMENT_CLEARANCE_LAUNCH_POLICY_VALUE,
  settlementClearancePolicy,
} from "../../features/wallets/domain/clearance-policy";
import { payoutAmountPolicy, settlementPayoutBoundsPolicy } from "../../features/payouts/domain/payout-policy";

type SeedPaymentSourceRow = Readonly<{
  amount: string;
  currency_code: string;
  status: string;
  captured_at: string | null;
}>;

function createSeedContext(): EventStoreContext {
  return {
    tenantId: "tnt_seed_development" as TenantId,
    audit: {
      performedByUserId: identitySeedIds.demo.userId,
      forAccountId: identitySeedIds.demo.accountId,
    },
  };
}

export async function seedSettlementDatabase(pool: PgTransactionalPool, _services?: unknown, options?: BcSeedOptions) {
  const { createFakeMoneyMovementGateway } = await import("@chase-sets/money-movement/test-support");
  const services = createSettlementServices(pool, {
    moneyMovementGateway: createFakeMoneyMovementGateway(),
  });
  const shouldSeedCritical = profileEnabled(options, "critical-bootstrap");
  const shouldSeedScenario = profileEnabled(options, "scenario-seed");

  if (!shouldSeedCritical && !shouldSeedScenario) {
    console.log("Settlement seed skipped for selected data profiles.");
    return;
  }

  const context = createSeedContext();

  if (shouldSeedCritical) {
    await reconcileCriticalSettlementPolicies(services, context);
  }

  if (!shouldSeedScenario) {
    return;
  }

  const sellerAccountId = identitySeedIds.demo.accountId;
  // `settlement_payout_pages` is UNLOGGED, so PostgreSQL truncates it on crash
  // recovery while the logged `settlement.*` streams survive. Decide what is
  // left to author from the wallet and payout streams themselves.
  const wallet = await loadSeedWalletLedger(services.db, sellerAccountId);
  const payoutReconcilers = buildSeedPayoutReconcilers(services, context, sellerAccountId);
  const capturedPayment = await services.db.query<SeedPaymentSourceRow>(
    `SELECT amount::text AS amount,
            currency_code,
            status,
            captured_at
       FROM settlement_payment_sources
      WHERE payment_id = $1`,
    [paymentsReservedSeedIds.payments.acceptedOfferCaptured],
  );

  const seedPayment = capturedPayment.rows[0];
  if (!seedPayment || seedPayment.status !== "captured") {
    console.log(
      `Settlement seed is waiting for captured payment ${paymentsReservedSeedIds.payments.acceptedOfferCaptured}. Skipping payouts for this pass.`,
    );
    return;
  }

  await services.wallets.ensureWallet(
    {
      accountId: sellerAccountId,
      currencyCode: normalizeCurrencyCode(seedPayment.currency_code),
      openedAt: seedPayment.captured_at ?? "2026-03-24T08:00:00.000Z",
    },
    context,
  );
  if (!wallet.hasEntry(settlementReservedSeedIds.ledgerEntries.pendingSaleCredit)) {
    await services.wallets.postEntry(
      {
        accountId: sellerAccountId,
        ledgerEntryId: settlementReservedSeedIds.ledgerEntries.pendingSaleCredit,
        kind: "sale",
        direction: "credit",
        amount: seedPayment.amount,
        currencyCode: normalizeCurrencyCode(seedPayment.currency_code),
        fundsStatus: "pending",
        paymentId: paymentsReservedSeedIds.payments.acceptedOfferCaptured,
        description: "Captured order awaiting settlement release",
        postedAt: seedPayment.captured_at ?? "2026-03-24T08:05:00.000Z",
      },
      context,
    );
  }
  if (!wallet.hasAvailableEntry(settlementReservedSeedIds.ledgerEntries.pendingSaleCredit)) {
    await services.wallets.releasePendingEntry(
      {
        accountId: sellerAccountId,
        ledgerEntryId: settlementReservedSeedIds.ledgerEntries.pendingSaleCredit,
        availableAt: "2026-03-24T09:00:00.000Z",
      },
      context,
    );
  }
  if (!wallet.hasEntry(settlementReservedSeedIds.ledgerEntries.availableAdjustmentCredit)) {
    await services.wallets.postEntry(
      {
        accountId: sellerAccountId,
        ledgerEntryId: settlementReservedSeedIds.ledgerEntries.availableAdjustmentCredit,
        kind: "adjustment",
        direction: "credit",
        amount: "30.00",
        currencyCode: "usd",
        fundsStatus: "available",
        description: "Manual credit adjustment for seeded balance coverage",
        postedAt: "2026-03-24T09:05:00.000Z",
      },
      context,
    );
  }

  if (!wallet.hasEntry(settlementReservedSeedIds.ledgerEntries.payoutDebitCompleted)) {
    await services.wallets.postEntry(
      {
        accountId: sellerAccountId,
        ledgerEntryId: settlementReservedSeedIds.ledgerEntries.payoutDebitCompleted,
        kind: "payout",
        direction: "debit",
        amount: "50.00",
        currencyCode: "usd",
        fundsStatus: "available",
        payoutId: settlementReservedSeedIds.payouts.completed,
        description: "Completed payout debit",
        postedAt: "2026-03-24T10:00:00.000Z",
      },
      context,
    );
  }
  await payoutReconcilers[0]?.reconcile(true);

  if (!wallet.hasEntry(settlementReservedSeedIds.ledgerEntries.payoutDebitFailed)) {
    await services.wallets.postEntry(
      {
        accountId: sellerAccountId,
        ledgerEntryId: settlementReservedSeedIds.ledgerEntries.payoutDebitFailed,
        kind: "payout",
        direction: "debit",
        amount: "20.00",
        currencyCode: "usd",
        fundsStatus: "available",
        payoutId: settlementReservedSeedIds.payouts.failed,
        description: "Failed payout debit",
        postedAt: "2026-03-24T11:00:00.000Z",
      },
      context,
    );
  }
  await payoutReconcilers[1]?.reconcile(true);

  if (!wallet.hasEntry(settlementReservedSeedIds.ledgerEntries.payoutReversalFailed)) {
    await services.wallets.postEntry(
      {
        accountId: sellerAccountId,
        ledgerEntryId: settlementReservedSeedIds.ledgerEntries.payoutReversalFailed,
        kind: "payout-reversal",
        direction: "credit",
        amount: "20.00",
        currencyCode: "usd",
        fundsStatus: "available",
        payoutId: settlementReservedSeedIds.payouts.failed,
        description: "Failed payout reversal",
        postedAt: "2026-03-24T11:10:00.000Z",
      },
      context,
    );
  }
}

const SETTLEMENT_BOOTSTRAP_LABEL = "Settlement seed bootstrap";

const seededWalletLedgerEntries = [
  {
    ledgerEntryId: settlementReservedSeedIds.ledgerEntries.pendingSaleCredit,
    key: "pending-sale-credit",
    expectsAvailable: true,
  },
  {
    ledgerEntryId: settlementReservedSeedIds.ledgerEntries.availableAdjustmentCredit,
    key: "available-adjustment-credit",
    expectsAvailable: false,
  },
  {
    ledgerEntryId: settlementReservedSeedIds.ledgerEntries.payoutDebitCompleted,
    key: "payout-debit-completed",
    expectsAvailable: false,
  },
  {
    ledgerEntryId: settlementReservedSeedIds.ledgerEntries.payoutDebitFailed,
    key: "payout-debit-failed",
    expectsAvailable: false,
  },
  {
    ledgerEntryId: settlementReservedSeedIds.ledgerEntries.payoutReversalFailed,
    key: "payout-reversal-failed",
    expectsAvailable: false,
  },
] as const;

const settlementWalletStreamId = (accountId: string) => `settlement.wallet-${accountId}`;

type SeedWalletLedger = Readonly<{
  events: readonly DomainEvent[];
  hasEntry: (ledgerEntryId: string) => boolean;
  hasAvailableEntry: (ledgerEntryId: string) => boolean;
}>;

/**
 * Folds the seller wallet stream so each seeded ledger entry is decided on its
 * own committed evidence. A truncated `settlement_payout_pages` (or any other
 * UNLOGGED settlement projection) can no longer make the seed re-post entries
 * the logged stream already carries.
 */
async function loadSeedWalletLedger(db: PgQueryable, accountId: string): Promise<SeedWalletLedger> {
  const events = await loadSeedStreamEvents(db, settlementWalletStreamId(accountId));
  const ledgerEntryIdOf = (event: DomainEvent) => (event.data as Readonly<{ ledgerEntryId?: unknown }>).ledgerEntryId;

  return {
    events,
    hasEntry: (ledgerEntryId) =>
      events.some(
        (event) => event.type === "settlement.wallet.ledger-entry-posted" && ledgerEntryIdOf(event) === ledgerEntryId,
      ),
    hasAvailableEntry: (ledgerEntryId) =>
      events.some(
        (event) =>
          event.type === "settlement.wallet.ledger-entry-available-recorded" &&
          ledgerEntryIdOf(event) === ledgerEntryId,
      ),
  };
}

function buildSeedPayoutReconcilers(
  services: SettlementServices,
  context: EventStoreContext,
  sellerAccountId: AccountId,
): readonly SeedAggregateReconciler[] {
  const payoutReconciler = (id: string, key: string, steps: readonly PayoutCommand[]) =>
    createSeedAggregateReconciler<PayoutState, PayoutCommand, PayoutEvent>({
      db: services.db,
      contextName: "settlement",
      bootstrapLabel: SETTLEMENT_BOOTSTRAP_LABEL,
      aggregateName: "Payout",
      id,
      key,
      streamId: `settlement.payout-${id}`,
      initialState: initialPayoutState,
      decide: decidePayout,
      evolve: evolvePayout,
      steps,
      send: (streamId, command) => services.payouts.commandHandler({ streamId, command, context }),
    });

  return [
    payoutReconciler(settlementReservedSeedIds.payouts.completed, "bank_seed_completed", [
      {
        type: "RequestPayout",
        payoutId: settlementReservedSeedIds.payouts.completed,
        accountId: sellerAccountId,
        amount: "50.00",
        currencyCode: "usd",
        destinationReference: "bank_seed_completed",
        note: "Completed payout seed",
        notificationEmail: "demo@chasesets.test",
        requestedAt: "2026-03-24T10:00:00.000Z",
      },
      { type: "MarkPayoutInTransit", sentAt: "2026-03-24T10:05:00.000Z" },
      { type: "CompletePayout", completedAt: "2026-03-24T10:15:00.000Z" },
    ]),
    payoutReconciler(settlementReservedSeedIds.payouts.failed, "bank_seed_failed", [
      {
        type: "RequestPayout",
        payoutId: settlementReservedSeedIds.payouts.failed,
        accountId: sellerAccountId,
        amount: "20.00",
        currencyCode: "usd",
        destinationReference: "bank_seed_failed",
        note: "Failed payout seed",
        requestedAt: "2026-03-24T11:00:00.000Z",
      },
      {
        type: "FailPayout",
        failureReason: "Bank account temporarily unavailable",
        failedAt: "2026-03-24T11:10:00.000Z",
      },
    ]),
  ];
}

/**
 * Reports the Settlement seed's base aggregate state from the authoritative
 * `settlement.*` streams. The scenario wallet and payout aggregates are the
 * only ones this seed authors; the critical-bootstrap policy documents are
 * logged platform-policy state, not an UNLOGGED projection.
 */
export async function inspectSettlementSeedState(
  pool: PgTransactionalPool,
  options?: BcSeedOptions,
): Promise<readonly BcSeedAggregateStateReport[]> {
  if (!profileEnabled(options, "scenario-seed")) {
    return [];
  }

  const { createFakeMoneyMovementGateway } = await import("@chase-sets/money-movement/test-support");
  const services = createSettlementServices(pool, {
    moneyMovementGateway: createFakeMoneyMovementGateway(),
  });
  const sellerAccountId = identitySeedIds.demo.accountId;
  const wallet = await loadSeedWalletLedger(services.db, sellerAccountId);

  const walletReports = seededWalletLedgerEntries.map((entry) => {
    const posted = wallet.hasEntry(entry.ledgerEntryId);
    const available = wallet.hasAvailableEntry(entry.ledgerEntryId);
    const complete = posted && (!entry.expectsAvailable || available);

    return {
      contextName: "settlement",
      aggregateName: "Wallet Ledger Entry",
      id: entry.ledgerEntryId,
      key: entry.key,
      streamId: settlementWalletStreamId(sellerAccountId),
      kind: complete ? ("active" as const) : posted ? ("draft" as const) : ("absent" as const),
      status: complete ? "settled" : posted ? "posted" : null,
      eventCount: wallet.events.length,
    };
  });

  const payoutReports = await reconcileSeedAggregates(
    buildSeedPayoutReconcilers(services, createSeedContext(), sellerAccountId),
    false,
  );

  return [...walletReports, ...payoutReports];
}

export async function reconcileSettlementBootstrapState(
  pool: PgTransactionalPool,
  services?: SettlementServices,
  options?: BcSeedOptions,
) {
  if (!profileEnabled(options, "critical-bootstrap")) {
    return;
  }

  if (services) {
    await reconcileCriticalSettlementPolicies(services, createSeedContext());
    return;
  }

  const { createFakeMoneyMovementGateway } = await import("@chase-sets/money-movement/test-support");
  await reconcileCriticalSettlementPolicies(
    createSettlementServices(pool, { moneyMovementGateway: createFakeMoneyMovementGateway() }),
    createSeedContext(),
  );
}

async function reconcileCriticalSettlementPolicies(
  services: ReturnType<typeof createSettlementServices>,
  context: EventStoreContext,
) {
  await seedSettlementPolicyDocumentIfMissing(
    services,
    context,
    settlementClearancePolicy,
    SETTLEMENT_CLEARANCE_LAUNCH_POLICY_VALUE,
    "2026-01-01T00:00:00.000Z",
  );
  await seedSettlementPolicyDocumentIfMissing(
    services,
    context,
    settlementPayoutBoundsPolicy,
    payoutAmountPolicy,
    "2026-01-01T00:00:00.000Z",
  );
}

function profileEnabled(options: BcSeedOptions | undefined, profile: "critical-bootstrap" | "scenario-seed") {
  const defaultProfiles: readonly EnvironmentDataProfile[] = [
    "critical-bootstrap",
    "catalog-integration-bootstrap",
    "scenario-seed",
  ];

  return (options?.enabledDataProfiles ?? defaultProfiles).includes(profile);
}

/**
 * Seeds a platform-policy document with the launch value so behavior is
 * byte-identical at cutover: the compiled fallback and this seeded document
 * agree on every value. A policy document's id is assigned by the
 * platform-policy machinery itself (not pre-registered), so idempotency is
 * checked against the policy key rather than a fixed seed id.
 */
async function seedSettlementPolicyDocumentIfMissing<Value>(
  services: ReturnType<typeof createSettlementServices>,
  context: EventStoreContext,
  definition: PolicyDefinition<Value>,
  value: Value,
  effectiveFrom: string,
) {
  if (await policyDocumentExists(services.db, definition.policyKey)) {
    return;
  }

  await services.policies.createPolicyDocument(
    definition,
    {
      value,
      status: "active",
      effectiveFrom,
      effectiveUntil: null,
      actorUserId: identitySeedIds.demo.userId,
    },
    context,
  );
}

async function policyDocumentExists(db: Pick<PgTransactionalPool, "query">, policyKey: string): Promise<boolean> {
  try {
    const existing = await db.query(
      "SELECT 1 FROM platform_policy_documents WHERE policy_key = $1 AND status = 'active' LIMIT 1",
      [policyKey],
    );
    return existing.rows.length > 0;
  } catch {
    return false;
  }
}
