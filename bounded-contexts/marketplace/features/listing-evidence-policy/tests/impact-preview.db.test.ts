import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { module as marketplaceModule } from "../../../index";
import { createListingEvidencePolicyRuntime } from "../api/runtime";
import {
  LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
  marketplaceListingEvidencePolicy,
  type ListingEvidencePolicyValue,
} from "../domain/policy";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_admin" as never, forAccountId: "acc_admin" as never },
};

const current: ListingEvidencePolicyValue = { ...LISTING_EVIDENCE_LAUNCH_POLICY_VALUE, rules: [] };
const launchRule = LISTING_EVIDENCE_LAUNCH_POLICY_VALUE.rules[0]!;
const draft: ListingEvidencePolicyValue = {
  ...current,
  policyName: "Cards need three photos",
  lifecycle: "draft",
  rules: [
    {
      ...launchRule,
      ruleId: "cards-three-photos",
      selector: { ...launchRule.selector, options: [], categoryIds: ["category_cards"] },
      outcome: { ...launchRule.outcome, minimumPhotoCount: 3, requiredSlots: [] },
    },
  ],
};

/** The policy documents the runtime reads: the draft, and an active policy with no rules. */
function policies(): PolicyRuntime {
  return {
    async getPolicyDocument(documentId: string) {
      if (documentId !== "pol_draft") return null;
      return {
        document_id: "pol_draft",
        policy_key: marketplaceListingEvidencePolicy.policyKey,
        value: draft,
        status: "inactive",
        effective_from: "2026-07-13T00:00:00.000Z",
        effective_until: null,
        history: [{ history_id: "1" }],
      };
    },
    async resolvePolicy() {
      return {
        policyKey: marketplaceListingEvidencePolicy.policyKey,
        value: current,
        source: "policy",
        documentId: "pol_active",
        effectiveFrom: "2026-07-01T00:00:00.000Z",
        effectiveUntil: null,
        resolvedAt: "2026-07-13T00:00:00.000Z",
      };
    },
    async revisePolicyDocument() {
      return { documentId: "pol_draft", version: 2 };
    },
  } as unknown as PolicyRuntime;
}

describeDb("Listing Evidence Policy validation on Marketplace's read model", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["marketplace"], "listing_evidence_impact");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("previews a draft's impact on the listings it selects through their catalog item", async () => {
    const db = pools.marketplace;
    await db.query(
      "INSERT INTO marketplace_catalog_categories (category_id, name, status) VALUES ('category_cards', 'Cards', 'active')",
    );
    await db.query(
      `INSERT INTO marketplace_catalog_items (catalog_item_id, title, status, category_ids)
       VALUES ('cat_card', 'Card', 'active', '["category_cards"]'::jsonb), ('cat_box', 'Box', 'active', '[]'::jsonb)`,
    );
    await db.query(
      "INSERT INTO marketplace_account_pages (account_id, display_name, status) VALUES ('acc_seller', 'Seller', 'active')",
    );
    await db.query(
      `INSERT INTO marketplace_listing_pages
         (listing_id, account_id, inventory_item_id, catalog_catalog_item_id, product_id, price_amount, quantity_cap)
       VALUES ('lst_card', 'acc_seller', 'inv_card', 'cat_card', 'cat_card::', 10.00, 1),
              ('lst_box', 'acc_seller', 'inv_box', 'cat_box', 'cat_box::', 40.00, 1)`,
    );
    const runtime = createListingEvidencePolicyRuntime({ db, policies: policies() });

    const validation = await runtime.validateDraft("pol_draft", "usr_reviewer", context);

    expect(validation).toMatchObject({ valid: true, diagnostics: [], version: 2 });
    expect(validation.impactPreview.impactedListingCount).toBe(1);
    expect(validation.impactPreview.sample).toEqual([
      { listingId: "lst_card", beforeMatchedRuleIds: [], afterMatchedRuleIds: ["cards-three-photos"] },
    ]);
  });
});
