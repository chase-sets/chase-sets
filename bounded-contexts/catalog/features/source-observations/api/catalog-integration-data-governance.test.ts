import { describe, expect, it } from "vitest";
import {
  catalogIntegrationDataGovernancePolicies,
  catalogIntegrationDataGovernancePoliciesByKey,
  catalogIntegrationProviderDataSignoffChecklist,
  evaluateCatalogIntegrationProviderDataUse,
  getCatalogIntegrationDataGovernancePolicy,
  redactCatalogIntegrationProviderData,
  type CatalogIntegrationGovernedDataClassKey,
} from "./catalog-integration-data-governance";

describe("Catalog integration data governance", () => {
  it("defines the #794 governed provider-data class inventory", () => {
    const expected: readonly CatalogIntegrationGovernedDataClassKey[] = [
      "raw-provider-payload",
      "sampled-provider-payload",
      "fixture-payload",
      "dry-run-input-payload",
      "dry-run-output-evidence",
      "engine-diagnostic",
      "provider-transport-diagnostic",
      "provider-credential-readiness",
      "audit-evidence",
      "job-progress-summary",
    ];

    expect(catalogIntegrationDataGovernancePolicies.map((policy) => policy.key)).toEqual(expected);
    expect(Object.keys(catalogIntegrationDataGovernancePoliciesByKey).sort()).toEqual([...expected].sort());
  });

  it("requires every data class to declare retention, redaction, access, export, logging, and evidence policy", () => {
    for (const policy of catalogIntegrationDataGovernancePolicies) {
      expect(policy.displayName.length).toBeGreaterThan(10);
      expect(policy.owner).toMatch(/^(catalog-source-observations|provider-adapter)$/);
      expect(policy.retentionPolicy.length).toBeGreaterThan(0);
      expect(policy.rawBodyPolicy.length).toBeGreaterThan(0);
      expect(policy.adminVisibility.length).toBeGreaterThan(0);
      expect(policy.exportPolicy.length).toBeGreaterThan(0);
      expect(policy.loggingPolicy).toMatch(/log|logs/i);
      expect(policy.allowedEvidence.length).toBeGreaterThan(0);
      expect(policy.redactedPathPatterns.length).toBeGreaterThan(0);
    }
  });

  it("gates raw provider, sampled provider, fixture, and dry-run body retention behind signoff", () => {
    expect(getCatalogIntegrationDataGovernancePolicy("raw-provider-payload")).toMatchObject({
      retentionPolicy: "request-only",
      rawBodyPolicy: "forbidden",
      exportPolicy: "no-export",
    });
    expect(getCatalogIntegrationDataGovernancePolicy("sampled-provider-payload").signoffTriggers).toEqual(
      expect.arrayContaining(["retain-real-provider-sample", "store-raw-body"]),
    );
    expect(getCatalogIntegrationDataGovernancePolicy("fixture-payload").signoffTriggers).toEqual(
      expect.arrayContaining(["retain-fixture-body", "include-provider-imagery"]),
    );
    expect(getCatalogIntegrationDataGovernancePolicy("dry-run-input-payload").signoffTriggers).toEqual(
      expect.arrayContaining(["retain-dry-run-body"]),
    );
  });

  it("blocks retained real-provider fixture use without policy/legal signoff and retained-data exception", () => {
    const findings = evaluateCatalogIntegrationProviderDataUse({
      dataClass: "fixture-payload",
      providerKey: "tcgdex",
      retainsFixtureBody: true,
      includesProviderImagery: true,
      hasPolicyLegalSignoff: false,
      retainedDataExceptionIssue: null,
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      "provider-data-signoff-required",
      "retained-data-exception-required",
    ]);
  });

  it("allows redacted sampled payload retention only after signoff and exception evidence exists", () => {
    expect(
      evaluateCatalogIntegrationProviderDataUse({
        dataClass: "sampled-provider-payload",
        providerKey: "tcgdex",
        retainsRealProviderSample: true,
        hasPolicyLegalSignoff: true,
        retainedDataExceptionIssue: 804,
      }),
    ).toEqual([]);
  });

  it("redacts provider secrets, seller/account facts, price, inventory, and listing evidence recursively", () => {
    const redacted = redactCatalogIntegrationProviderData({
      id: "provider-card-1",
      name: "Furret",
      headers: {
        Authorization: "Bearer token",
        Cookie: "TCGAuthTicket_Production=session",
      },
      seller: {
        sellerId: 123,
        sellerName: "Seller Name",
        sellerEmail: "seller@example.com",
        phone: "555-1234",
      },
      skus: [
        {
          skuId: 100,
          price: 1.23,
          inventoryQuantity: 9,
          condition: "Near Mint",
        },
      ],
      listingUrl: "https://example.test/listing/1",
    });

    expect(redacted).toEqual({
      id: "provider-card-1",
      name: "Furret",
      headers: {
        Authorization: "<redacted>",
        Cookie: "<redacted>",
      },
      seller: {
        sellerId: "<redacted>",
        sellerName: "<redacted>",
        sellerEmail: "<redacted>",
        phone: "<redacted>",
      },
      skus: [
        {
          skuId: 100,
          price: "<redacted>",
          inventoryQuantity: "<redacted>",
          condition: "Near Mint",
        },
      ],
      listingUrl: "<redacted>",
    });
  });

  it("publishes the provider-data signoff checklist for release verification", () => {
    expect(catalogIntegrationProviderDataSignoffChecklist()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("governed data class"),
        expect.stringContaining("policy/legal signoff"),
        expect.stringContaining("Admin UI surfaces"),
        expect.stringContaining("logs, metrics, traces"),
      ]),
    );
  });
});
