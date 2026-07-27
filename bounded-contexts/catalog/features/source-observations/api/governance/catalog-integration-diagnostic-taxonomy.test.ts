import { describe, expect, it } from "vitest";
import {
  assertCatalogIntegrationDiagnosticTaxonomyCoverage,
  catalogIntegrationDiagnosticCodes,
  catalogIntegrationDiagnosticTaxonomy,
  getCatalogIntegrationDiagnosticDefinition,
  toCatalogIntegrationDiagnostic,
} from "./catalog-integration-diagnostic-taxonomy";

describe("Catalog Integration diagnostic taxonomy", () => {
  it("defines unique diagnostic codes and metric keys with actionable remediation", () => {
    const codes = catalogIntegrationDiagnosticTaxonomy.map((entry) => entry.code);
    const metricKeys = catalogIntegrationDiagnosticTaxonomy.map((entry) => entry.metricKey);

    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(metricKeys).size).toBe(metricKeys.length);
    expect(catalogIntegrationDiagnosticCodes).toEqual(codes);

    for (const entry of catalogIntegrationDiagnosticTaxonomy) {
      expect(entry.code).toMatch(/^[a-z0-9_-]+$/);
      expect(entry.metricKey).toMatch(/^catalog\.integration\.diagnostic\.[a-z0-9_]+$/);
      expect(entry.remediation.length).toBeGreaterThan(10);
      expect(entry.groupingKeys.length).toBeGreaterThan(0);
    }
  });

  it("covers every source, severity, blocking behavior, visibility, and evidence policy required by #796", () => {
    expect(new Set(catalogIntegrationDiagnosticTaxonomy.map((entry) => entry.source))).toEqual(
      new Set([
        "adapter",
        "profile-section",
        "fixture",
        "engine",
        "job",
        "read-model",
        "credential-readiness",
        "projection-lag",
        "admin-route",
        "alias-equivalence",
        "provider-comparison",
      ]),
    );
    expect(new Set(catalogIntegrationDiagnosticTaxonomy.map((entry) => entry.severity))).toEqual(
      new Set(["info", "warning", "error", "blocked"]),
    );
    expect(new Set(catalogIntegrationDiagnosticTaxonomy.map((entry) => entry.blockingBehavior))).toEqual(
      new Set([
        "activation-blocking",
        "import-blocking",
        "promotion-blocking",
        "rollback-blocking",
        "retirement-blocking",
        "read-model-blocking",
        "advisory",
        "retryable",
      ]),
    );
    expect(new Set(catalogIntegrationDiagnosticTaxonomy.map((entry) => entry.operatorVisibility))).toEqual(
      new Set(["summary", "detail", "support", "metric-only"]),
    );
    expect(new Set(catalogIntegrationDiagnosticTaxonomy.map((entry) => entry.evidencePolicy))).toEqual(
      new Set([
        "no-evidence",
        "safe-catalog-evidence",
        "redacted-provider-evidence",
        "credential-redacted",
        "projection-metadata-only",
      ]),
    );
  });

  it("covers existing profile, section, fixture, mapping, engine, promotion, and route diagnostic codes", () => {
    const existingCodes = [
      "provider-key-mismatch",
      "missing-profile-version",
      "missing-profile-fixture-flow",
      "missing-retirement-plan",
      "missing-executable-mapping-contract",
      "mapping-contract-mismatch",
      "mapping-contract-diagnostic",
      "ingestion-unit-provider-mismatch",
      "raw-graded-unit-split",
      "fixture-live-provider-calls",
      "fixture-missing-flow",
      "activation-fixture-covered-flow",
      "missing-fixture-flow",
      "live-provider-calls-in-fixtures",
      "unsafe-owner-for-catalog-use",
      "secret-used-as-catalog-fact",
      "missing-required-path",
      "null-not-allowed",
      "expected-array",
      "empty-array",
      "unregistered-named-selector",
      "unregistered-named-transform",
      "transform-type-mismatch",
      "coerce-failed",
      "lookup-miss",
      "missing-provider-value",
      "missing-schema-dimension",
      "inactive-schema-dimension",
      "unknown-provider-option",
      "inactive-schema-option",
      "missing-reference-value",
      "missing-selected-options",
      "repeated-ambiguous-reference",
      "wrong-target-level",
      "integration-unit-mismatch",
      "normalized-observation-identity-mismatch",
      "no-provider-payloads",
      "missing-promotion-capability",
      "unsupported-profile-mapping-kind",
      "unsupported-observation-kind",
      "ambiguous-duplicate-candidates",
      "missing-catalog-item-target",
      "runtime-preflight-failed",
      "external-key-change",
      "source-hash-change",
      "selected-option-change",
      "reference-target-level-change",
      "promotion-plan-change",
      "missing-migration-evidence",
      "import-eligibility",
      "fixture-harness-failure",
      "reference-fixtures-ready",
      "fixture-backed-provider",
      "invalid_json_body",
      "invalid_profile_section_command",
      "profile_activation_blocked",
      "one-piece-provider-disagreement",
      "one-piece-fallback-source-unapproved",
    ] as const;

    expect(() => assertCatalogIntegrationDiagnosticTaxonomyCoverage(existingCodes)).not.toThrow();
  });

  it("covers the alias-equivalence pipeline diagnostics required by #1913", () => {
    const aliasCodes = [
      "alias-provider-endpoint-missing",
      "alias-coverage-incomplete",
      "alias-pending-candidates-block-high-confidence-search",
      "alias-resolved-projection-lag",
      "alias-stale-resolved-hash",
      "alias-search-rollout-disabled",
      "alias-native-script-tokenization-gap",
    ] as const;

    expect(() => assertCatalogIntegrationDiagnosticTaxonomyCoverage(aliasCodes)).not.toThrow();

    // The seven cover provider endpoint missing, alias coverage incomplete,
    // pending candidates blocking high-confidence search, projection lag, a stale
    // resolved-alias hash, the rollout kill-switch, and native-script tokenization
    // gaps — the failure modes the e2e proof exercises.
    expect(getCatalogIntegrationDiagnosticDefinition("alias-coverage-incomplete")).toMatchObject({
      source: "alias-equivalence",
      blockingBehavior: "advisory",
    });
    expect(getCatalogIntegrationDiagnosticDefinition("alias-resolved-projection-lag")).toMatchObject({
      source: "projection-lag",
      blockingBehavior: "retryable",
      evidencePolicy: "projection-metadata-only",
    });
    expect(getCatalogIntegrationDiagnosticDefinition("alias-search-rollout-disabled")).toMatchObject({
      source: "alias-equivalence",
      severity: "info",
    });
    // Every alias-equivalence diagnostic groups by the alias target/type/language
    // dimensions so operators can triage by what failed, not just by provider.
    for (const code of aliasCodes) {
      const definition = getCatalogIntegrationDiagnosticDefinition(code);
      if (definition.source === "alias-equivalence") {
        expect(definition.groupingKeys).toContain("aliasType");
      }
    }
  });

  it("covers One Piece provider-comparison diagnostics with redacted field-class grouping", () => {
    expect(() =>
      assertCatalogIntegrationDiagnosticTaxonomyCoverage([
        "one-piece-provider-disagreement",
        "one-piece-fallback-source-unapproved",
      ]),
    ).not.toThrow();

    expect(getCatalogIntegrationDiagnosticDefinition("one-piece-provider-disagreement")).toMatchObject({
      source: "provider-comparison",
      severity: "warning",
      blockingBehavior: "advisory",
      evidencePolicy: "redacted-provider-evidence",
      groupingKeys: ["providerKey", "unitKey", "comparisonSourceKey", "externalId", "fieldClass", "decisionPath"],
    });
    expect(getCatalogIntegrationDiagnosticDefinition("one-piece-fallback-source-unapproved")).toMatchObject({
      source: "provider-comparison",
      severity: "blocked",
      blockingBehavior: "promotion-blocking",
      evidencePolicy: "redacted-provider-evidence",
    });
    expect(
      toCatalogIntegrationDiagnostic({
        code: "one-piece-provider-disagreement",
        path: "validation.cardNumber",
        diagnosticText: "Scrydex and Bandai comparison disagreed.",
        providerKey: "scrydex",
        unitKey: "scrydex:one-piece:single-card:source-observation-import",
        comparisonSourceKey: "bandai-one-piece-official",
        externalId: "redacted-card-id",
        fieldClass: "card number",
        decisionPath: "one-piece-card-release-validation/card-number/manual-review",
      }),
    ).toMatchObject({
      source: "provider-comparison",
      severity: "warning",
      remediation: "Review the redacted One Piece provider comparison before promotion.",
      comparisonSourceKey: "bandai-one-piece-official",
      fieldClass: "card number",
      decisionPath: "one-piece-card-release-validation/card-number/manual-review",
    });
  });

  it("uses blocking behavior consistently for readiness and destructive workflow gates", () => {
    const activationCodes = catalogIntegrationDiagnosticTaxonomy.filter((entry) =>
      entry.code.startsWith("activation-"),
    );
    expect(activationCodes.every((entry) => entry.blockingBehavior === "activation-blocking")).toBe(true);

    for (const code of [
      "missing-promotion-capability",
      "unsupported-profile-mapping-kind",
      "unsupported-observation-kind",
      "ambiguous-duplicate-candidates",
      "missing-catalog-item-target",
      "runtime-preflight-failed",
    ] as const) {
      expect(getCatalogIntegrationDiagnosticDefinition(code).blockingBehavior).toBe("promotion-blocking");
    }

    expect(getCatalogIntegrationDiagnosticDefinition("retirement-active-profile")).toMatchObject({
      blockingBehavior: "retirement-blocking",
      source: "profile-section",
    });
    expect(getCatalogIntegrationDiagnosticDefinition("credential-missing")).toMatchObject({
      blockingBehavior: "import-blocking",
      evidencePolicy: "credential-redacted",
    });
    expect(getCatalogIntegrationDiagnosticDefinition("credential-invalid")).toMatchObject({
      source: "credential-readiness",
      blockingBehavior: "import-blocking",
      evidencePolicy: "credential-redacted",
    });
    expect(getCatalogIntegrationDiagnosticDefinition("credential-revoked")).toMatchObject({
      source: "credential-readiness",
      blockingBehavior: "import-blocking",
      evidencePolicy: "credential-redacted",
    });
    expect(getCatalogIntegrationDiagnosticDefinition("read-model-unavailable")).toMatchObject({
      blockingBehavior: "read-model-blocking",
      evidencePolicy: "projection-metadata-only",
    });
  });

  it("normalizes emitted diagnostics with taxonomy defaults while preserving instance-specific detail", () => {
    expect(
      toCatalogIntegrationDiagnostic({
        code: "profile_activation_blocked",
        path: "activation",
        diagnosticText: "Activation is blocked.",
        providerKey: "tcgdex",
        profileVersion: "2026.06.03",
      }),
    ).toMatchObject({
      source: "admin-route",
      severity: "blocked",
      remediation: "Resolve nested activation diagnostics.",
      providerKey: "tcgdex",
      profileVersion: "2026.06.03",
    });
  });
});
