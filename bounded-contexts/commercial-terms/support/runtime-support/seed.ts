import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { commercialTermsSeedIds } from "../seed-support/ids";
import { createCommercialTermsServices } from "./services";

function createSeedContext() {
  return {
    tenantId: "tnt_identity" as never,
    audit: {
      performedByUserId: identitySeedIds.support.userId as never,
      forAccountId: identitySeedIds.seller.accountId as never,
    },
  };
}

async function drainProjectors(projectors: readonly { runOnce: () => Promise<{ processed: number }> }[]) {
  let processed = 0;

  do {
    processed = 0;
    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export async function seedCommercialTermsDatabase(pool: PgTransactionalPool) {
  const services = createCommercialTermsServices(pool);

  try {
    const existing = await services.db.query(
      "SELECT COUNT(*) AS count FROM commercial_terms_schedule_pages",
    );
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Commercial Terms already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  const context = createSeedContext();
  const effectiveFrom = "2026-01-01T00:00:00.000Z";

  await services.schedules.commandHandler({
    streamId: `commercial-terms.schedule-${commercialTermsSeedIds.schedules.personalDefault}`,
    command: {
      type: "CreateSchedule",
      scheduleId: commercialTermsSeedIds.schedules.personalDefault,
      label: "Personal Default",
      accountType: "personal",
      marketplaceFeePercentageBps: 900,
      marketplaceFeeFixedAmount: "0.15",
      paymentFeePercentageBps: 300,
      paymentFeeFixedAmount: "0.30",
      status: "active",
      effectiveFrom,
      effectiveUntil: null,
    },
    context,
  });

  await services.schedules.commandHandler({
    streamId: `commercial-terms.schedule-${commercialTermsSeedIds.schedules.businessDefault}`,
    command: {
      type: "CreateSchedule",
      scheduleId: commercialTermsSeedIds.schedules.businessDefault,
      label: "Business Default",
      accountType: "business",
      marketplaceFeePercentageBps: 850,
      marketplaceFeeFixedAmount: "0.10",
      paymentFeePercentageBps: 290,
      paymentFeeFixedAmount: "0.30",
      status: "active",
      effectiveFrom,
      effectiveUntil: null,
    },
    context,
  });

  await services.schedules.commandHandler({
    streamId: `commercial-terms.schedule-${commercialTermsSeedIds.schedules.enterpriseDefault}`,
    command: {
      type: "CreateSchedule",
      scheduleId: commercialTermsSeedIds.schedules.enterpriseDefault,
      label: "Enterprise Default",
      accountType: "enterprise",
      marketplaceFeePercentageBps: 600,
      marketplaceFeeFixedAmount: "0.00",
      paymentFeePercentageBps: 240,
      paymentFeeFixedAmount: "0.20",
      status: "active",
      effectiveFrom,
      effectiveUntil: null,
    },
    context,
  });

  await services.agreements.commandHandler({
    streamId: `commercial-terms.agreement-${commercialTermsSeedIds.agreements.sellerOverride}`,
    command: {
      type: "CreateAgreement",
      agreementId: commercialTermsSeedIds.agreements.sellerOverride,
      accountId: identitySeedIds.seller.accountId,
      label: "Chase Sets Seller Agreement",
      marketplaceFeePercentageBps: 700,
      marketplaceFeeFixedAmount: "0.05",
      paymentFeePercentageBps: 275,
      paymentFeeFixedAmount: "0.25",
      status: "active",
      effectiveFrom,
      effectiveUntil: null,
    },
    context,
  });

  await drainProjectors(services.projectors);
}
