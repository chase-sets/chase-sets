import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { paymentsReservedSeedIds } from "@chase-sets/payments/seed-support/ids";
import { settlementReservedSeedIds } from "@chase-sets/settlement/seed-support/ids";
import { normalizeCurrencyCode } from "./common";
import { createSettlementServices } from "./services";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { TenantId } from "@chase-sets/primitives/typed-ids";

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

export async function seedSettlementDatabase(pool: PgTransactionalPool) {
  const { createFakeMoneyMovementGateway } = await import("@chase-sets/money-movement/test-support");
  const services = createSettlementServices(pool, {
    moneyMovementGateway: createFakeMoneyMovementGateway(),
  });

  try {
    const existing = await services.db.query("SELECT COUNT(*) AS count FROM settlement_payout_pages");
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Settlement already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  const context = createSeedContext();
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
