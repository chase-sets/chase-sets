import type { BcSeedOptions, EnvironmentDataProfile } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { buildCreatePolicyDocumentCommand } from "@chase-sets/platform-policy/commands";
import { commercialTermsSeedIds } from "../seed-support/ids";
import { createCommercialTermsServices, type CommercialTermsServices } from "./services";
import { agreementStreamId } from "./policy-runtime";
import {
  CHECKOUT_PROCESSING_FEE_LAUNCH_POLICY_VALUE,
  checkoutProcessingFeePolicy,
} from "../../features/checkout-processing-fee/domain/policy";
import { commercialTermsAgreementPolicy, commercialTermsSchedulePolicy } from "./terms-policy";
import { DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS, type CommercialAccountType } from "./common";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE,
  marketplaceSalesFeeSchedulePolicy,
} from "../../features/marketplace-sales-fee/domain/policy";

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
    await reconcileCriticalCommercialTermsPolicies(services, context);
  }

  if (
    shouldSeedScenario &&
    !(await policyDocumentExistsById(services.db, commercialTermsSeedIds.agreements.sellerOverride))
  ) {
    const definition = commercialTermsAgreementPolicy(identitySeedIds.demo.accountId);
    const command = buildCreatePolicyDocumentCommand(definition, {
      documentId: commercialTermsSeedIds.agreements.sellerOverride,
      value: {
        label: "Chase Sets Seller Agreement",
        accountId: identitySeedIds.demo.accountId,
        marketplaceSalesFeePercentageBps: 700,
        marketplaceSalesFeeFixedAmount: "0.05",
        shippingAllowancePercentageBps: DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
      },
      status: "active",
      effectiveFrom,
      effectiveUntil: null,
      actorUserId: identitySeedIds.support.userId,
    });
    await services.policies.commandHandler({
      streamId: agreementStreamId(commercialTermsSeedIds.agreements.sellerOverride),
      command,
      context,
    });
  }
}

export async function reconcileCommercialTermsBootstrapState(
  pool: PgTransactionalPool,
  services?: CommercialTermsServices,
  options?: BcSeedOptions,
) {
  if (!profileEnabled(options, "critical-bootstrap")) {
    return;
  }

  await reconcileCriticalCommercialTermsPolicies(services ?? createCommercialTermsServices(pool), createSeedContext());
}

async function reconcileCriticalCommercialTermsPolicies(
  services: ReturnType<typeof createCommercialTermsServices>,
  context: ReturnType<typeof createSeedContext>,
) {
  await supersedeLegacyScheduleIfActive(services, context, {
    scheduleId: commercialTermsSeedIds.schedules.personalDefault,
    accountType: "personal",
  });

  await supersedeLegacyScheduleIfActive(services, context, {
    scheduleId: commercialTermsSeedIds.schedules.businessDefault,
    accountType: "business",
  });

  await supersedeLegacyScheduleIfActive(services, context, {
    scheduleId: commercialTermsSeedIds.schedules.enterpriseDefault,
    accountType: "enterprise",
  });

  await seedMarketplaceSalesFeeScheduleIfMissing(services, context, "2026-07-03T00:00:00.000Z");
  await seedCheckoutProcessingFeePolicyIfMissing(services, context, "2026-05-03T00:00:00.000Z");
}

function profileEnabled(options: BcSeedOptions | undefined, profile: "critical-bootstrap" | "scenario-seed") {
  const defaultProfiles: readonly EnvironmentDataProfile[] = [
    "critical-bootstrap",
    "catalog-integration-bootstrap",
    "scenario-seed",
  ];

  return (options?.enabledDataProfiles ?? defaultProfiles).includes(profile);
}

export async function supersedeLegacyScheduleIfActive(
  services: ReturnType<typeof createCommercialTermsServices>,
  context: ReturnType<typeof createSeedContext>,
  input: Readonly<{
    scheduleId: string;
    accountType: CommercialAccountType;
  }>,
) {
  const result = await services.db.query<{
    status: string;
    value: {
      label: string;
      accountType: CommercialAccountType;
      marketplaceSalesFeePercentageBps: number;
      marketplaceSalesFeeFixedAmount: string;
      shippingAllowancePercentageBps: number;
    };
    effective_from: string;
    effective_until: string | null;
  }>(
    `SELECT status, value, effective_from::text, effective_until::text
     FROM platform_policy_documents
     WHERE document_id = $1`,
    [input.scheduleId],
  );
  const current = result.rows[0];
  if (!current || current.status !== "active") {
    return;
  }

  const definition = commercialTermsSchedulePolicy(input.accountType);
  await services.policies.reviseScheduleDocument(
    definition,
    input.scheduleId,
    {
      value: current.value,
      status: "inactive",
      effectiveFrom: current.effective_from,
      effectiveUntil: current.effective_until,
      actorUserId: identitySeedIds.support.userId,
    },
    context,
  );
}

async function seedMarketplaceSalesFeeScheduleIfMissing(
  services: ReturnType<typeof createCommercialTermsServices>,
  context: ReturnType<typeof createSeedContext>,
  effectiveFrom: string,
) {
  if (await policyDocumentExistsByKey(services.db, marketplaceSalesFeeSchedulePolicy.policyKey)) {
    return;
  }
  await services.policies.createPolicyDocument(
    marketplaceSalesFeeSchedulePolicy,
    {
      value: MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE,
      status: "active",
      effectiveFrom,
      effectiveUntil: null,
      actorUserId: identitySeedIds.support.userId,
    },
    context,
  );
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
  if (await policyDocumentExistsByKey(services.db, checkoutProcessingFeePolicy.policyKey)) {
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

async function policyDocumentExistsById(db: Pick<PgTransactionalPool, "query">, documentId: string): Promise<boolean> {
  return rowExists(db, "SELECT 1 FROM platform_policy_documents WHERE document_id = $1 LIMIT 1", [documentId]);
}

async function policyDocumentExistsByKey(db: Pick<PgTransactionalPool, "query">, policyKey: string): Promise<boolean> {
  return rowExists(db, "SELECT 1 FROM platform_policy_documents WHERE policy_key = $1 AND status = 'active' LIMIT 1", [
    policyKey,
  ]);
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
