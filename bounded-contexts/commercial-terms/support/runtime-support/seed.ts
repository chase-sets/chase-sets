import type { BcSeedOptions, EnvironmentDataProfile } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { commercialTermsSeedIds } from "../seed-support/ids";
import { createCommercialTermsServices } from "./services";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";

function createSeedContext() {
  return {
    tenantId: "tnt_identity" as TenantId,
    audit: {
      performedByUserId: identitySeedIds.support.userId as UserId,
      forAccountId: identitySeedIds.demo.accountId as AccountId,
    },
  };
}

export async function seedCommercialTermsDatabase(
  pool: PgTransactionalPool,
  _services?: unknown,
  options?: BcSeedOptions,
) {
  const services = createCommercialTermsServices(pool);
  const shouldSeedCritical = profileEnabled(options, "critical-bootstrap");
  const shouldSeedScenario = profileEnabled(options, "scenario-seed");

  if (!shouldSeedCritical && !shouldSeedScenario) {
    console.log("Commercial Terms seed skipped for selected data profiles.");
    return;
  }

  const context = createSeedContext();
  const effectiveFrom = "2026-01-01T00:00:00.000Z";

  if (shouldSeedCritical) {
    await seedDefaultScheduleIfMissing(services, context, {
      scheduleId: commercialTermsSeedIds.schedules.personalDefault,
      label: "Personal Default",
      accountType: "personal",
      marketplaceSalesFeePercentageBps: 900,
      marketplaceSalesFeeFixedAmount: "0.15",
      effectiveFrom,
    });

    await seedDefaultScheduleIfMissing(services, context, {
      scheduleId: commercialTermsSeedIds.schedules.businessDefault,
      label: "Business Default",
      accountType: "business",
      marketplaceSalesFeePercentageBps: 850,
      marketplaceSalesFeeFixedAmount: "0.10",
      effectiveFrom,
    });

    await seedDefaultScheduleIfMissing(services, context, {
      scheduleId: commercialTermsSeedIds.schedules.enterpriseDefault,
      label: "Enterprise Default",
      accountType: "enterprise",
      marketplaceSalesFeePercentageBps: 600,
      marketplaceSalesFeeFixedAmount: "0.00",
      effectiveFrom,
    });
  }

  if (shouldSeedScenario && !(await agreementExists(pool, commercialTermsSeedIds.agreements.sellerOverride))) {
    await services.agreements.commandHandler({
      streamId: `commercial-terms.agreement-${commercialTermsSeedIds.agreements.sellerOverride}`,
      command: {
        type: "CreateAgreement",
        agreementId: commercialTermsSeedIds.agreements.sellerOverride,
        accountId: identitySeedIds.demo.accountId,
        label: "Chase Sets Seller Agreement",
        marketplaceSalesFeePercentageBps: 700,
        marketplaceSalesFeeFixedAmount: "0.05",
        status: "active",
        effectiveFrom,
        effectiveUntil: null,
        createdByUserId: identitySeedIds.support.userId,
      },
      context,
    });
  }
}

function profileEnabled(options: BcSeedOptions | undefined, profile: "critical-bootstrap" | "scenario-seed") {
  const defaultProfiles: readonly EnvironmentDataProfile[] = [
    "critical-bootstrap",
    "catalog-integration-bootstrap",
    "scenario-seed",
  ];

  return (options?.enabledDataProfiles ?? defaultProfiles).includes(profile);
}

async function seedDefaultScheduleIfMissing(
  services: ReturnType<typeof createCommercialTermsServices>,
  context: ReturnType<typeof createSeedContext>,
  input: Readonly<{
    scheduleId: string;
    label: string;
    accountType: "personal" | "business" | "enterprise";
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    effectiveFrom: string;
  }>,
) {
  if (await scheduleExists(services.db, input.scheduleId)) {
    return;
  }

  await services.schedules.commandHandler({
    streamId: `commercial-terms.schedule-${input.scheduleId}`,
    command: {
      type: "CreateSchedule",
      scheduleId: input.scheduleId,
      label: input.label,
      accountType: input.accountType,
      marketplaceSalesFeePercentageBps: input.marketplaceSalesFeePercentageBps,
      marketplaceSalesFeeFixedAmount: input.marketplaceSalesFeeFixedAmount,
      status: "active",
      effectiveFrom: input.effectiveFrom,
      effectiveUntil: null,
      createdByUserId: identitySeedIds.support.userId,
    },
    context,
  });
}

async function scheduleExists(db: Pick<PgTransactionalPool, "query">, scheduleId: string): Promise<boolean> {
  try {
    const existing = await db.query("SELECT 1 FROM commercial_terms_schedule_pages WHERE schedule_id = $1 LIMIT 1", [
      scheduleId,
    ]);
    return existing.rows.length > 0;
  } catch {
    return false;
  }
}

async function agreementExists(db: PgTransactionalPool, agreementId: string): Promise<boolean> {
  try {
    const existing = await db.query("SELECT 1 FROM commercial_terms_agreement_pages WHERE agreement_id = $1 LIMIT 1", [
      agreementId,
    ]);
    return existing.rows.length > 0;
  } catch {
    return false;
  }
}
