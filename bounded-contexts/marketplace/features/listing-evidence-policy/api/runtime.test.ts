import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { LISTING_EVIDENCE_LAUNCH_POLICY_VALUE, marketplaceListingEvidencePolicy } from "../domain/policy";
import { createListingEvidencePolicyRuntime } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_admin" as never, forAccountId: "acc_admin" as never },
};

function createDb() {
  return {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      if (sql.includes("FROM marketplace_listing_pages")) return { rows: [], rowCount: 0 };
      if (sql.includes(" = ANY($1::text[])")) {
        const ids = (values[0] as readonly string[]) ?? [];
        return { rows: ids.map((id) => ({ id })) as Row[], rowCount: ids.length };
      }
      if (sql.includes("FROM platform_policy_documents")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  } as PgQueryable;
}

function createPolicies() {
  const documents = new Map<string, Record<string, unknown>>();
  let nextId = 1;
  const policies = {
    async createPolicyDocument(_definition: unknown, params: Record<string, unknown>) {
      const documentId = `pol_${nextId++}`;
      documents.set(documentId, {
        document_id: documentId,
        policy_key: marketplaceListingEvidencePolicy.policyKey,
        context_name: "marketplace",
        schema_summary: "Listing Evidence Policy",
        ...params,
        value: params.value,
        status: params.status,
        effective_from: params.effectiveFrom,
        effective_until: params.effectiveUntil,
        created_at: "2026-07-13T00:00:00.000Z",
        updated_at: "2026-07-13T00:00:00.000Z",
        history: [{ history_id: "1" }],
      });
      return { documentId, version: 1 };
    },
    async revisePolicyDocument(_definition: unknown, documentId: string, params: Record<string, unknown>) {
      const current = documents.get(documentId)!;
      const history = [...(current.history as readonly unknown[]), { history_id: "next" }];
      documents.set(documentId, {
        ...current,
        value: params.value,
        status: params.status,
        effective_from: params.effectiveFrom,
        effective_until: params.effectiveUntil,
        history,
      });
      return { documentId, version: history.length };
    },
    async getPolicyDocument(documentId: string) {
      return documents.get(documentId) ?? null;
    },
    async resolvePolicy() {
      const active = [...documents.values()].find((document) => document.status === "active");
      if (!active) {
        return {
          policyKey: marketplaceListingEvidencePolicy.policyKey,
          value: LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
          source: "fallback" as const,
          documentId: null,
          effectiveFrom: null,
          effectiveUntil: null,
          resolvedAt: "2026-07-13T00:00:00.000Z",
        };
      }
      return {
        policyKey: marketplaceListingEvidencePolicy.policyKey,
        value: active.value,
        source: "policy" as const,
        documentId: active.document_id,
        effectiveFrom: active.effective_from,
        effectiveUntil: active.effective_until,
        resolvedAt: "2026-07-13T00:00:00.000Z",
      };
    },
  };
  return { policies: policies as unknown as PolicyRuntime, documents };
}

describe("Listing Evidence Policy runtime", () => {
  it("persists an auditable draft, validates impact, activates a new version, and creates rollback drafts", async () => {
    const { policies, documents } = createPolicies();
    const runtime = createListingEvidencePolicyRuntime({
      db: createDb(),
      policies,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    });

    const draft = await runtime.createDraft(
      { policyName: "August evidence", rules: LISTING_EVIDENCE_LAUNCH_POLICY_VALUE.rules, actorUserId: "usr_admin" },
      context,
    );
    const validation = await runtime.validateDraft(draft.documentId, "usr_reviewer", context);

    expect(validation).toMatchObject({ valid: true, version: 2, semanticDiff: { addedRuleIds: [] } });
    await expect(
      runtime.activateDraft(
        draft.documentId,
        {
          effectiveFrom: "2026-08-01T00:00:00.000Z",
          effectiveUntil: null,
          impactAcknowledgmentHash: "stale-preview",
          actorUserId: "usr_activator",
        },
        context,
      ),
    ).rejects.toThrow("acknowledgment");

    const activation = await runtime.activateDraft(
      draft.documentId,
      {
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        effectiveUntil: null,
        impactAcknowledgmentHash: validation.impactPreview.previewHash,
        actorUserId: "usr_activator",
      },
      context,
    );
    expect(activation).toMatchObject({ version: 1, scheduled: true, policyHash: validation.policyHash });
    expect(documents.get(draft.documentId)?.value).toMatchObject({ lifecycle: "superseded" });

    const rollback = await runtime.createRollbackDraft(activation.policyId, "usr_admin", context);
    const rollbackValue = documents.get(rollback.documentId)?.value as Record<string, unknown>;
    expect(rollbackValue).toMatchObject({
      lifecycle: "draft",
      sourcePolicyDocumentId: activation.policyId,
    });
    expect(rollbackValue.rules).toEqual(LISTING_EVIDENCE_LAUNCH_POLICY_VALUE.rules);
  });

  it("reports stale stable-identity references without validating the draft", async () => {
    const { policies } = createPolicies();
    const db = createDb();
    const query = vi.spyOn(db, "query").mockImplementation(async (sql: string) => {
      if (sql.includes("FROM marketplace_listing_pages")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const runtime = createListingEvidencePolicyRuntime({ db, policies });
    const rule = LISTING_EVIDENCE_LAUNCH_POLICY_VALUE.rules[2]!;
    const draft = await runtime.createDraft(
      {
        policyName: "Bad reference",
        actorUserId: "usr_admin",
        rules: [{ ...rule, selector: { ...rule.selector, categoryIds: ["category_missing"] } }],
      },
      context,
    );

    const validation = await runtime.validateDraft(draft.documentId, "usr_reviewer", context);

    expect(validation.valid).toBe(false);
    expect(validation.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid_reference", path: "categoryIds" }),
    );
    expect(query).toHaveBeenCalled();
  });
});
