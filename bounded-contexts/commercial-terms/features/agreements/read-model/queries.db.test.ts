import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";
import { resolutionAccountSchemaSql } from "../../resolutions/integrations/account-source/account-schema";
import { commercialTermsAgreementPolicyKey } from "../../../support/runtime-support/terms-policy";
import { getAgreement, listAgreements, listCommercialTermsAccountOptions } from "./queries";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;
const contextNames = ["commercial-terms"] as const;

describeDb("commercial agreement account identity against PostgreSQL", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, contextNames, "agreement_accounts");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools["commercial-terms"];
    await resetMultiContextTestSchemas(pools);
    await pool.query(platformPolicySchemaSql);
    await pool.query(resolutionAccountSchemaSql);
    await pool.query(`INSERT INTO commercial_terms_account_pages
      (account_id, name, display_name, account_type, status, updated_at) VALUES
      ('acc_demo', 'Demo Account', 'Chase Sets', 'business', 'active', '2026-07-01T00:00:00Z'),
      ('acc_empty', '', 'Display only', 'personal', 'active', '2026-07-01T00:00:00Z'),
      ('acc_inactive', 'Inactive Account', 'Hidden', 'business', 'inactive', '2026-07-01T00:00:00Z')`);
    for (const [id, accountId, updatedAt] of [
      ["cag_demo", "acc_demo", "2026-07-03T00:00:00Z"],
      ["cag_empty", "acc_empty", "2026-07-02T00:00:00Z"],
      ["cag_missing", "acc_missing", "2026-07-01T00:00:00Z"],
    ]) {
      await pool.query(
        `INSERT INTO platform_policy_documents
        (document_id, policy_key, context_name, schema_summary, status, value, effective_from, effective_until, created_at, updated_at)
        VALUES ($1, $2, 'commercial-terms', '{}', 'active', $3::jsonb, '2026-07-01T00:00:00Z', NULL, $4, $4)`,
        [
          id,
          commercialTermsAgreementPolicyKey(accountId),
          JSON.stringify({
            accountId,
            label: `Override ${accountId}`,
            marketplaceSalesFeePercentageBps: 250,
            marketplaceSalesFeeFixedAmount: "0.10",
            shippingAllowancePercentageBps: 650,
          }),
          updatedAt,
        ],
      );
    }
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("selects qualified account names in list and detail joins while preserving ordering and nullable identities", async () => {
    const expected = [
      {
        agreement_id: "cag_demo",
        account_id: "acc_demo",
        account_name: "Demo Account",
        account_display_name: "Chase Sets",
        account_type: "business",
      },
      {
        agreement_id: "cag_empty",
        account_id: "acc_empty",
        account_name: "",
        account_display_name: "Display only",
        account_type: "personal",
      },
      {
        agreement_id: "cag_missing",
        account_id: "acc_missing",
        account_name: null,
        account_display_name: null,
        account_type: null,
      },
    ];
    const result = await listAgreements(pool);
    expect(result.total).toBe(3);
    expect(result.items).toMatchObject(expected);
    expect((await listAgreements(pool, { limit: 1, offset: 1 })).items).toMatchObject([expected[1]]);
    for (const identity of expected) {
      expect(await getAgreement(pool, identity.agreement_id)).toMatchObject({ ...identity, history: [] });
    }
    expect(await getAgreement(pool, "cag_unknown")).toBeNull();
  });

  it("selects names in real account options without changing display-name ordering or active filtering", async () => {
    expect(await listCommercialTermsAccountOptions(pool)).toEqual([
      { account_id: "acc_demo", account_name: "Demo Account", display_name: "Chase Sets", account_type: "business" },
      { account_id: "acc_empty", account_name: "", display_name: "Display only", account_type: "personal" },
    ]);
  });
});
