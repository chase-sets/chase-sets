import { describe, expect, it } from "vitest";
import {
  catalogProviderCredentialReadinessBlocksImport,
  catalogProviderCredentialReadinessToTransportDiagnostic,
  createCatalogProviderCredentialReadiness,
  redactCatalogProviderCredentialReadinessEvidence,
  summarizeCatalogProviderCredentialReadinessForAudit,
} from "./catalog-integration-credential-readiness";

describe("Catalog provider credential readiness", () => {
  it("redacts credential material from readiness evidence and scope", () => {
    const readiness = createCatalogProviderCredentialReadiness({
      providerKey: "TCGPLAYER",
      unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
      requirement: "required",
      sourceKind: "environment-secret",
      state: "invalid",
      message: "Credential validation failed.",
      checkedAt: "2026-06-06T00:00:00.000Z",
      scope: {
        environmentKey: "production",
        secretReference: "vault/catalog/tcgplayer-session",
      },
      evidence: {
        Authorization: "Bearer super-secret-token",
        cookie: "TCGAuthTicket=abc123",
        nested: {
          token: "abc123",
          safeLabel: "tcgplayer automation session",
        },
      },
    });

    expect(readiness).toMatchObject({
      providerKey: "tcgplayer",
      state: "invalid",
      importBlocking: true,
      optionQueryBlocking: true,
      diagnosticCode: "credential-invalid",
      scope: {
        environmentKey: "production",
        secretReference: "vault/catalog/tcgplayer-session",
      },
    });
    expect(JSON.stringify(readiness)).not.toMatch(/super-secret-token|TCGAuthTicket|abc123/i);
    expect(JSON.stringify(readiness)).toContain("[redacted-provider-credential]");
  });

  it("maps missing, invalid, expired, and revoked credentials to import-blocking diagnostics", () => {
    for (const state of ["missing", "invalid", "expired", "revoked"] as const) {
      const readiness = createCatalogProviderCredentialReadiness({
        providerKey: "provider",
        requirement: "required",
        sourceKind: "managed-secret",
        state,
        message: `${state} credential`,
      });

      expect(catalogProviderCredentialReadinessBlocksImport(state)).toBe(true);
      expect(catalogProviderCredentialReadinessToTransportDiagnostic(readiness)).toMatchObject({
        severity: "error",
        message: `${state} credential`,
      });
    }
  });

  it("allows explicit local fake credentials without treating them as production signoff", () => {
    const readiness = createCatalogProviderCredentialReadiness({
      providerKey: "example",
      requirement: "required",
      sourceKind: "local-fake",
      state: "configured",
      message: "Local fake credential is configured for deterministic tests.",
      evidence: {
        environment: "local",
        productionSignoff: false,
      },
    });

    expect(readiness.importBlocking).toBe(false);
    expect(readiness.sourceKind).toBe("local-fake");
    expect(readiness.diagnosticCode).toBeNull();
    expect(catalogProviderCredentialReadinessToTransportDiagnostic(readiness)).toBeNull();
  });

  it("produces a secret-free audit summary", () => {
    const readiness = createCatalogProviderCredentialReadiness({
      providerKey: "tcgplayer",
      requirement: "required",
      sourceKind: "operator-session",
      state: "expired",
      message: "Credential expired.",
      evidence: redactCatalogProviderCredentialReadinessEvidence({
        password: "do-not-store",
        credentialAgeDays: 91,
      }),
    });

    const summary = summarizeCatalogProviderCredentialReadinessForAudit(readiness);

    expect(summary).toMatchObject({
      eventName: "provider-credential-readiness-changed",
      providerKey: "tcgplayer",
      state: "expired",
      importBlocking: true,
      diagnosticCode: "credential-expired",
    });
    expect(JSON.stringify(summary)).not.toMatch(/do-not-store/i);
  });
});
