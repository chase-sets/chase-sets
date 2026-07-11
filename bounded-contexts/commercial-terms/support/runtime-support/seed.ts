import type { BcSeedOptions, EnvironmentDataProfile } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { commercialTermsSeedIds } from "../seed-support/ids";
import { createCommercialTermsServices } from "./services";
import {
  CHECKOUT_PROCESSING_FEE_LAUNCH_POLICY_VALUE,
  checkoutProcessingFeePolicy,
} from "../../features/checkout-processing-fee/domain/policy";
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

    await seedCheckoutProcessingFeePolicyIfMissing(services, context, "2026-05-03T00:00:00.000Z");
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
  if (await schedulePageExists(services.db, input.scheduleId)) {
    return;
  }

  if (await streamExists(services.db, `commercial-terms.schedule-${input.scheduleId}`)) {
    await upsertSeedSchedulePage(services.db, input);
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

async function schedulePageExists(db: Pick<PgTransactionalPool, "query">, scheduleId: string): Promise<boolean> {
  return rowExists(db, "SELECT 1 FROM commercial_terms_schedule_pages WHERE schedule_id = $1 LIMIT 1", [scheduleId]);
}

/**
 * Seeds the checkout processing-fee policy with the launch values (290bps +
 * $0.30 card, 50bps bank, 0bps credit) so behavior is byte-identical at
 * cutover: Payments' compiled fallback and this seeded document agree on
 * every value. Unlike schedules/agreements, a policy document's id is
 * assigned by the platform-policy machinery itself (not pre-registered), so
 * idempotency is checked against the policy key rather than a fixed seed id.
 */
async function seedCheckoutProcessingFeePolicyIfMissing(
  services: ReturnType<typeof createCommercialTermsServices>,
  context: ReturnType<typeof createSeedContext>,
  effectiveFrom: string,
) {
  if (await policyDocumentExists(services.db, checkoutProcessingFeePolicy.policyKey)) {
    return;
  }

  await services.policies.createPolicyDocument(
    checkoutProcessingFeePolicy,
    {
      value: CHECKOUT_PROCESSING_FEE_LAUNCH_POLICY_VALUE,
      status: "active",
      effectiveFrom,
      effectiveUntil: null,
      actorUserId: identitySeedIds.support.userId,
    },
    context,
  );
}

async function policyDocumentExists(db: Pick<PgTransactionalPool, "query">, policyKey: string): Promise<boolean> {
  return rowExists(db, "SELECT 1 FROM platform_policy_documents WHERE policy_key = $1 AND status = 'active' LIMIT 1", [
    policyKey,
  ]);
}

async function agreementExists(db: PgTransactionalPool, agreementId: string): Promise<boolean> {
  return (
    (await rowExists(db, "SELECT 1 FROM commercial_terms_agreement_pages WHERE agreement_id = $1 LIMIT 1", [
      agreementId,
    ])) ||
    (await rowExists(db, "SELECT 1 FROM event_store_streams WHERE stream_id = $1 LIMIT 1", [
      `commercial-terms.agreement-${agreementId}`,
    ]))
  );
}

async function streamExists(db: Pick<PgTransactionalPool, "query">, streamId: string): Promise<boolean> {
  return rowExists(db, "SELECT 1 FROM event_store_streams WHERE stream_id = $1 LIMIT 1", [streamId]);
}

async function upsertSeedSchedulePage(
  db: Pick<PgTransactionalPool, "query">,
  input: Readonly<{
    scheduleId: string;
    label: string;
    accountType: "personal" | "business" | "enterprise";
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    effectiveFrom: string;
  }>,
): Promise<void> {
  await db.query(
    `INSERT INTO commercial_terms_schedule_pages (
       schedule_id,
       label,
       account_type,
       marketplace_sales_fee_percentage_bps,
       marketplace_sales_fee_fixed_amount,
       shipping_allowance_percentage_bps,
       status,
       effective_from,
       effective_until,
       created_at,
       updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, 500, 'active', $6, NULL, $6, $6
     )
     ON CONFLICT (schedule_id) DO UPDATE
     SET label = EXCLUDED.label,
         account_type = EXCLUDED.account_type,
         marketplace_sales_fee_percentage_bps = EXCLUDED.marketplace_sales_fee_percentage_bps,
         marketplace_sales_fee_fixed_amount = EXCLUDED.marketplace_sales_fee_fixed_amount,
         shipping_allowance_percentage_bps = EXCLUDED.shipping_allowance_percentage_bps,
         status = EXCLUDED.status,
         effective_from = EXCLUDED.effective_from,
         effective_until = EXCLUDED.effective_until,
         updated_at = EXCLUDED.updated_at`,
    [
      input.scheduleId,
      input.label,
      input.accountType,
      input.marketplaceSalesFeePercentageBps,
      input.marketplaceSalesFeeFixedAmount,
      input.effectiveFrom,
    ],
  );
}

async function rowExists(
  db: Pick<PgTransactionalPool, "query">,
  sql: string,
  params: readonly unknown[],
): Promise<boolean> {
  try {
    const existing = await db.query(sql, params);
    return existing.rows.length > 0;
  } catch {
    return false;
  }
}
