import { describe, expect, it } from "vitest";
import {
  CATALOG_INTEGRATION_AUDIT_REDACTED_VALUE,
  catalogIntegrationAuditEvidenceEventNames,
  catalogIntegrationAuditEvidenceRecordToTimelineEntry,
  createCatalogIntegrationAuditEvidenceRecord,
  redactCatalogIntegrationAuditEvidenceText,
  type CatalogIntegrationAuditEvidenceEventName,
  type CatalogIntegrationAuditEvidenceProfilePointer,
} from "./catalog-integration-audit-evidence";
import { createCatalogProviderCredentialReadiness } from "./catalog-integration-credential-readiness";

const profile = {
  schemaVersion: "catalog-provider-profile-version-v1",
  compatibilityPolicy: "provider-profile-version",
  providerKey: "tcgplayer",
  profileKey: "pokemon-tcg",
  profileVersion: "2026.06.06",
  lifecycle: "active",
  active: true,
  connectorKind: "tcgplayer-automation",
  connectorSourceVersion: "2026-06-06",
  sourceMappingFingerprint: "mapping-fingerprint",
} as const satisfies CatalogIntegrationAuditEvidenceProfilePointer;

const unitKey = "tcgplayer:pokemon:single-card:source-observation-import";

describe("Catalog integration audit/evidence model", () => {
  it("defines the canonical #783 lifecycle event inventory", () => {
    const expected: readonly CatalogIntegrationAuditEvidenceEventName[] = [
      "profile-created",
      "profile-cloned",
      "profile-section-edited",
      "fixture-validation-run",
      "dry-run-executed",
      "activation-readiness-evaluated",
      "profile-activated",
      "profile-deprecated",
      "profile-rolled-back",
      "profile-retired",
      "import-job-started",
      "import-job-completed",
      "import-job-failed",
      "source-observation-recorded",
      "source-observation-changed",
      "source-observation-promoted",
      "source-observation-rejected",
      "source-observation-deferred",
      "promotion-plan-generated",
      "promotion-plan-executed",
      "reapply-run-executed",
      "adapter-readiness-changed",
      "provider-credential-readiness-changed",
      "diagnostics-present",
    ];

    expect(catalogIntegrationAuditEvidenceEventNames).toEqual(expected);
  });

  it("creates section-edit audit records with actor, provider, profile, section, and schema metadata", () => {
    const record = createCatalogIntegrationAuditEvidenceRecord({
      eventId: "aud_001",
      eventName: "profile-section-edited",
      occurredAt: "2026-06-06T12:00:00.000Z",
      actor: {
        actorKind: "operator",
        userId: "usr_admin",
        accountId: "acc_ops",
      },
      target: {
        providerKey: "tcgplayer",
        unitKey,
        profile,
        sectionKey: "normalized-observation",
      },
      evidence: [
        {
          dataClass: "audit-evidence",
          summary: "Updated normalized observation mapping summary.",
          value: {
            sectionKey: "normalized-observation",
            changedPaths: ["normalizedObservation.externalKey"],
          },
        },
      ],
    });

    expect(record).toMatchObject({
      schemaVersion: "catalog-audit-evidence-record-v1",
      compatibilityPolicy: "audit-evidence-record",
      category: "profile-section",
      eventName: "profile-section-edited",
      actor: {
        actorKind: "operator",
        userId: "usr_admin",
        accountId: "acc_ops",
      },
      target: {
        providerKey: "tcgplayer",
        unitKey,
        profile,
        sectionKey: "normalized-observation",
      },
    });
    expect(record.evidence[0].redactionState).toBe("not-needed");
  });

  it("redacts provider secrets, seller facts, and commerce fields from retained audit evidence", () => {
    const record = createCatalogIntegrationAuditEvidenceRecord({
      eventId: "aud_002",
      eventName: "dry-run-executed",
      occurredAt: "2026-06-06T12:01:00.000Z",
      actor: { actorKind: "operator", userId: "usr_admin", accountId: "acc_ops" },
      target: { providerKey: "tcgplayer", unitKey, profile },
      evidence: [
        {
          dataClass: "dry-run-output-evidence",
          summary: "Dry run produced token=secret and safe normalized facts.",
          value: {
            normalizedName: "Pikachu",
            headers: { authorization: "Bearer secret-token" },
            seller: { sellerId: 123, sellerName: "Seller Name" },
            skus: [{ price: 1.23, inventoryQuantity: 9, condition: "Near Mint" }],
          },
        },
        {
          dataClass: "raw-provider-payload",
          summary: "Raw provider payload was observed by adapter but excluded from Catalog audit retention.",
          redactionState: "not-needed",
          value: {
            body: "raw body",
          },
        },
      ],
    });

    expect(record.evidence[0]).toMatchObject({
      redactionState: "redacted",
      summary: `Dry run produced ${CATALOG_INTEGRATION_AUDIT_REDACTED_VALUE} and safe normalized facts.`,
      value: {
        normalizedName: "Pikachu",
        headers: { authorization: "<redacted>" },
        seller: CATALOG_INTEGRATION_AUDIT_REDACTED_VALUE,
        skus: [{ price: "<redacted>", inventoryQuantity: "<redacted>", condition: "Near Mint" }],
      },
    });
    expect(record.evidence[1]).toMatchObject({
      dataClass: "raw-provider-payload",
      redactionState: "excluded",
    });
    expect("value" in record.evidence[1]).toBe(false);
  });

  it("records credential readiness changes without secret material", () => {
    const readiness = createCatalogProviderCredentialReadiness({
      providerKey: "tcgplayer",
      unitKey,
      requirement: "required",
      sourceKind: "operator-session",
      state: "invalid",
      message: "Provider rejected the configured session.",
      checkedAt: "2026-06-06T12:02:00.000Z",
      scope: {
        environmentKey: "staging",
        secretReference: "TCGAuthTicket=secret-cookie",
      },
      evidence: {
        cookie: "TCGAuthTicket=secret-cookie",
        validationAttempt: "failed",
      },
    });

    const record = createCatalogIntegrationAuditEvidenceRecord({
      eventId: "aud_003",
      eventName: "provider-credential-readiness-changed",
      occurredAt: "2026-06-06T12:02:00.000Z",
      actor: { actorKind: "provider-adapter", userId: null, accountId: null },
      target: { providerKey: "tcgplayer", unitKey, profile },
      diagnostics: [
        {
          code: "credential-invalid",
          path: "credentialReadiness.state",
          diagnosticText: "Credential is invalid.",
        },
      ],
      evidence: [
        {
          dataClass: "provider-credential-readiness",
          summary: "Credential readiness changed to invalid.",
          value: readiness,
        },
      ],
    });

    expect(JSON.stringify(record)).not.toContain("secret-cookie");
    expect(record.evidence[0].redactionState).toBe("redacted");
    expect(record.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["credential-invalid"]);
  });

  it("adapts canonical records into Admin timeline entries", () => {
    const record = createCatalogIntegrationAuditEvidenceRecord({
      eventId: "aud_004",
      eventName: "source-observation-promoted",
      occurredAt: "2026-06-06T12:03:00.000Z",
      actor: { actorKind: "job-worker", userId: "usr_admin", accountId: "acc_ops" },
      target: {
        providerKey: "tcgplayer",
        unitKey,
        profile,
        jobId: "job_promote",
        observationId: "obs_123",
        catalogItemId: "cat_item_123",
        promotionPlanId: "plan_123",
      },
      evidence: [
        {
          dataClass: "audit-evidence",
          summary: "Promoted Source Observation into Catalog Item.",
          value: { observationId: "obs_123", catalogItemId: "cat_item_123" },
        },
      ],
    });

    expect(catalogIntegrationAuditEvidenceRecordToTimelineEntry(record)).toMatchObject({
      schemaVersion: "catalog-audit-evidence-record-v1",
      compatibilityPolicy: "audit-evidence-record",
      eventId: "aud_004",
      eventName: "source-observation-promoted",
      category: "source-observation",
      actorUserId: "usr_admin",
      accountId: "acc_ops",
      providerKey: "tcgplayer",
      unitKey,
      profile,
      evidenceSummary: "Promoted Source Observation into Catalog Item.",
      relatedJobId: "job_promote",
      relatedObservationId: "obs_123",
      relatedCatalogItemId: "cat_item_123",
      promotionPlanId: "plan_123",
    });
  });

  it("redacts sensitive free text before it can become timeline copy", () => {
    expect(redactCatalogIntegrationAuditEvidenceText("authorization: Bearer secret-token")).toBe(
      CATALOG_INTEGRATION_AUDIT_REDACTED_VALUE,
    );
  });
});
