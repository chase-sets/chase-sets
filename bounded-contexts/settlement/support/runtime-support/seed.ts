import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { BcSeedOptions, EnvironmentDataProfile } from "@chase-sets/bounded-context-module";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { paymentsReservedSeedIds } from "@chase-sets/payments/seed-support/ids";
import { settlementReservedSeedIds } from "@chase-sets/settlement/seed-support/ids";
import type { PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import { normalizeCurrencyCode } from "./common";
import { createSettlementServices, type SettlementServices } from "./services";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { TenantId } from "@chase-sets/primitives/typed-ids";
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

  try {
    const existing = await services.db.query("SELECT COUNT(*) AS count FROM settlement_payout_pages");
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Settlement already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  const sellerAccountId = identitySeedIds.demo.accountId;
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
  await services.wallets.releasePendingEntry(
    {
      accountId: sellerAccountId,
      ledgerEntryId: settlementReservedSeedIds.ledgerEntries.pendingSaleCredit,
      availableAt: "2026-03-24T09:00:00.000Z",
    },
    context,
  );
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

  await services.payouts.commandHandler({
    streamId: `settlement.payout-${settlementReservedSeedIds.payouts.completed}`,
    command: {
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
    context,
  });
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
  await services.payouts.commandHandler({
    streamId: `settlement.payout-${settlementReservedSeedIds.payouts.completed}`,
    command: {
      type: "MarkPayoutInTransit",
      sentAt: "2026-03-24T10:05:00.000Z",
    },
    context,
  });
  await services.payouts.commandHandler({
    streamId: `settlement.payout-${settlementReservedSeedIds.payouts.completed}`,
    command: {
      type: "CompletePayout",
      completedAt: "2026-03-24T10:15:00.000Z",
    },
    context,
  });

  await services.payouts.commandHandler({
    streamId: `settlement.payout-${settlementReservedSeedIds.payouts.failed}`,
    command: {
      type: "RequestPayout",
      payoutId: settlementReservedSeedIds.payouts.failed,
      accountId: sellerAccountId,
      amount: "20.00",
      currencyCode: "usd",
      destinationReference: "bank_seed_failed",
      note: "Failed payout seed",
      requestedAt: "2026-03-24T11:00:00.000Z",
    },
    context,
  });
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
  await services.payouts.commandHandler({
    streamId: `settlement.payout-${settlementReservedSeedIds.payouts.failed}`,
    command: {
      type: "FailPayout",
      failureReason: "Bank account temporarily unavailable",
      failedAt: "2026-03-24T11:10:00.000Z",
    },
    context,
  });
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
