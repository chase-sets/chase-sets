import type { BcSeedOptions, EnvironmentDataProfile } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { buildCreatePolicyDocumentCommand } from "@chase-sets/platform-policy/commands";
import { commercialTermsSeedIds } from "../seed-support/ids";
import { createCommercialTermsServices } from "./services";
import { agreementStreamId, scheduleStreamId } from "./policy-runtime";
import {
  CHECKOUT_PROCESSING_FEE_LAUNCH_POLICY_VALUE,
  checkoutProcessingFeePolicy,
} from "../../features/checkout-processing-fee/domain/policy";
import {
  COMMERCIAL_TERMS_SCHEDULE_LAUNCH_VALUES,
  commercialTermsAgreementPolicy,
  commercialTermsSchedulePolicy,
} from "./terms-policy";
import type { CommercialAccountType } from "./common";
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
      accountType: "personal",
      effectiveFrom,
    });

    await seedDefaultScheduleIfMissing(services, context, {
      scheduleId: commercialTermsSeedIds.schedules.businessDefault,
      accountType: "business",
      effectiveFrom,
    });

    await seedDefaultScheduleIfMissing(services, context, {
      scheduleId: commercialTermsSeedIds.schedules.enterpriseDefault,
      accountType: "enterprise",
      effectiveFrom,
    });

    await seedCheckoutProcessingFeePolicyIfMissing(services, context, "2026-05-03T00:00:00.000Z");
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
        shippingAllowancePercentageBps: 500,
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

function profileEnabled(options: BcSeedOptions | undefined, profile: "critical-bootstrap" | "scenario-seed") {
  const defaultProfiles: readonly EnvironmentDataProfile[] = [
    "critical-bootstrap",
    "catalog-integration-bootstrap",
    "scenario-seed",
  ];

  return (options?.enabledDataProfiles ?? defaultProfiles).includes(profile);
}

/**
 * Seeds a schedule with its schema-declared launch value
 * (`COMMERCIAL_TERMS_SCHEDULE_LAUNCH_VALUES`, defined once in
 * `terms-policy.ts` and shared with the compiled fallback) so behavior is
 * byte-identical at cutover -- seed values are derived from the same
 * schema-declared defaults the resolver falls back to, not restated. A
 * policy document's id is normally assigned by the machinery itself, but
 * schedules keep a pre-registered seed id (`commercialTermsSeedIds`) for
 * deterministic fixtures across bootstrap runs.
 */
async function seedDefaultScheduleIfMissing(
  services: ReturnType<typeof createCommercialTermsServices>,
  context: ReturnType<typeof createSeedContext>,
  input: Readonly<{
    scheduleId: string;
    accountType: CommercialAccountType;
    effectiveFrom: string;
  }>,
) {
  if (await policyDocumentExistsById(services.db, input.scheduleId)) {
    return;
  }

  const definition = commercialTermsSchedulePolicy(input.accountType);
  const value = COMMERCIAL_TERMS_SCHEDULE_LAUNCH_VALUES[input.accountType];

  // A prior, interrupted bootstrap may have already appended the
  // CreatePolicyDocument event without the projection having caught up to
  // write the row yet. Re-issuing the command would replay the stream and
  // hit "Policy document has already been created" -- upsert the row
  // directly from the known seed value instead, same as the projection
  // would once it catches up.
  if (await streamExists(services.db, scheduleStreamId(input.scheduleId))) {
    await upsertSeedPolicyDocumentPage(services.db, {
      documentId: input.scheduleId,
      policyKey: definition.policyKey,
      contextName: definition.contextName,
      schemaSummary: definition.schemaSummary,
      value,
      effectiveFrom: input.effectiveFrom,
    });
    return;
  }

  const command = buildCreatePolicyDocumentCommand(definition, {
    documentId: input.scheduleId,
    value,
    status: "active",
    effectiveFrom: input.effectiveFrom,
    effectiveUntil: null,
    actorUserId: identitySeedIds.support.userId,
  });
  await services.policies.commandHandler({
    streamId: scheduleStreamId(input.scheduleId),
    command,
    context,
  });
}

async function streamExists(db: Pick<PgTransactionalPool, "query">, streamId: string): Promise<boolean> {
  return rowExists(db, "SELECT 1 FROM event_store_streams WHERE stream_id = $1 LIMIT 1", [streamId]);
}

async function upsertSeedPolicyDocumentPage(
  db: Pick<PgTransactionalPool, "query">,
  input: Readonly<{
    documentId: string;
    policyKey: string;
    contextName: string;
    schemaSummary: string;
    value: unknown;
    effectiveFrom: string;
  }>,
): Promise<void> {
  await db.query(
    `INSERT INTO platform_policy_documents (
       document_id,
       policy_key,
       context_name,
       schema_summary,
       status,
       value,
       effective_from,
       effective_until,
       created_at,
       updated_at
     ) VALUES (
       $1, $2, $3, $4, 'active', $5::jsonb, $6, NULL, $6, $6
     )
     ON CONFLICT (document_id) DO UPDATE
     SET policy_key = EXCLUDED.policy_key,
         context_name = EXCLUDED.context_name,
         schema_summary = EXCLUDED.schema_summary,
         status = EXCLUDED.status,
         value = EXCLUDED.value,
         effective_from = EXCLUDED.effective_from,
         effective_until = EXCLUDED.effective_until,
         updated_at = EXCLUDED.updated_at`,
    [
      input.documentId,
      input.policyKey,
      input.contextName,
      input.schemaSummary,
      JSON.stringify(input.value),
      input.effectiveFrom,
    ],
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
