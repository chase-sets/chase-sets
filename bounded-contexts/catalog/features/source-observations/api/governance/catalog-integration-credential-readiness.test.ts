import { describe, expect, expectTypeOf, it } from "vitest";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  PROVIDER_CREDENTIAL_REDACTED_VALUE,
  redactProviderCredentialReadinessEvidence,
  redactProviderCredentialReadinessScope,
  type ProviderCredentialReadiness,
  type ProviderCredentialReadinessEvidence,
  type ProviderCredentialReadinessScope,
  type ProviderCredentialReadinessState,
  type ProviderCredentialRequirement,
  type ProviderCredentialSourceKind,
} from "@chase-sets/provider-credentials";
import type { CatalogIntegrationUnitKey } from "./integration-unit";
import {
  catalogProviderCredentialReadinessBlocksImport,
  catalogProviderCredentialReadinessDiagnosticCode,
  catalogProviderCredentialReadinessToTransportDiagnostic,
  CATALOG_PROVIDER_CREDENTIAL_REDACTED_VALUE,
  createCatalogProviderCredentialReadiness,
  redactCatalogProviderCredentialReadinessEvidence,
  redactCatalogProviderCredentialReadinessScope,
  summarizeCatalogProviderCredentialReadinessForAudit,
  type CatalogProviderCredentialReadiness,
  type CatalogProviderCredentialReadinessEvidence,
  type CatalogProviderCredentialReadinessScope,
  type CatalogProviderCredentialReadinessState,
  type CatalogProviderCredentialRequirement,
  type CatalogProviderCredentialSourceKind,
} from "./catalog-integration-credential-readiness";

describe("Catalog provider credential readiness", () => {
  it("keeps omitted diagnostics unchanged and permits a bounded adapter override", () => {
    const input = {
      providerKey: "tcgplayer",
      requirement: "required" as const,
      sourceKind: "operator-session" as const,
      state: "invalid" as const,
      message: "Authentication rejected.",
    };
    expect(createCatalogProviderCredentialReadiness(input).diagnosticCode).toBe("credential-invalid");
    expect(
      createCatalogProviderCredentialReadiness({ ...input, diagnosticCode: "credential-refresh-needed" }),
    ).toMatchObject({ diagnosticCode: "credential-refresh-needed", importBlocking: true });
    expect(createCatalogProviderCredentialReadiness({ ...input, diagnosticCode: null }).diagnosticCode).toBeNull();
  });
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

// Frozen pre-extraction shapes: aliases alone would widen together undetected.
type OriginalRequirement = "not-required" | "required";
type OriginalSourceKind = "none" | "environment-secret" | "managed-secret" | "operator-session" | "local-fake";
type OriginalState = "not-required" | "configured" | "missing" | "invalid" | "expired" | "revoked" | "unknown";
type OriginalScope = Readonly<{ environmentKey?: string; accountKey?: string; secretReference?: string }>;
type OriginalEvidence = Readonly<Record<string, JsonValue>>;
type OriginalReadiness = Readonly<{
  providerKey: string;
  unitKey?: CatalogIntegrationUnitKey;
  requirement: OriginalRequirement;
  sourceKind: OriginalSourceKind;
  state: OriginalState;
  importBlocking: boolean;
  optionQueryBlocking: boolean;
  diagnosticCode: string | null;
  message: string;
  checkedAt: string | null;
  scope: OriginalScope;
  expiresAt?: string | null;
  rotationRequiredAt?: string | null;
  revokedAt?: string | null;
  evidence: OriginalEvidence;
}>;

describe("Catalog shared credential contract compatibility", () => {
  it("keeps every alias bidirectionally identical to the shared and original types", () => {
    expectTypeOf<CatalogProviderCredentialRequirement>().toEqualTypeOf<ProviderCredentialRequirement>();
    expectTypeOf<CatalogProviderCredentialSourceKind>().toEqualTypeOf<ProviderCredentialSourceKind>();
    expectTypeOf<CatalogProviderCredentialReadinessState>().toEqualTypeOf<ProviderCredentialReadinessState>();
    expectTypeOf<CatalogProviderCredentialReadinessScope>().toEqualTypeOf<ProviderCredentialReadinessScope>();
    expectTypeOf<CatalogProviderCredentialReadinessEvidence>().toEqualTypeOf<ProviderCredentialReadinessEvidence>();
    expectTypeOf<CatalogProviderCredentialReadiness>().toEqualTypeOf<
      ProviderCredentialReadiness<string, CatalogIntegrationUnitKey>
    >();
    expectTypeOf<CatalogProviderCredentialRequirement>().toEqualTypeOf<OriginalRequirement>();
    expectTypeOf<CatalogProviderCredentialSourceKind>().toEqualTypeOf<OriginalSourceKind>();
    expectTypeOf<CatalogProviderCredentialReadinessState>().toEqualTypeOf<OriginalState>();
    expectTypeOf<CatalogProviderCredentialReadinessScope>().toEqualTypeOf<OriginalScope>();
    expectTypeOf<CatalogProviderCredentialReadinessEvidence>().toEqualTypeOf<OriginalEvidence>();
    expectTypeOf<CatalogProviderCredentialReadiness>().toEqualTypeOf<OriginalReadiness>();
  });

  it("distinguishes widened unions and lost optional or null members", () => {
    expectTypeOf<CatalogProviderCredentialReadinessState | "new-state">().not.toEqualTypeOf<OriginalState>();
    expectTypeOf<Required<CatalogProviderCredentialReadiness>>().not.toEqualTypeOf<OriginalReadiness>();
    expectTypeOf<
      Omit<CatalogProviderCredentialReadiness, "expiresAt"> & { readonly expiresAt?: string }
    >().not.toEqualTypeOf<OriginalReadiness>();
  });

  it("keeps the legacy marker and redaction output identical", () => {
    expect(CATALOG_PROVIDER_CREDENTIAL_REDACTED_VALUE).toBe(PROVIDER_CREDENTIAL_REDACTED_VALUE);
    const evidence = {
      nested: [{ token: "synthetic-token", safe: "safe" }, "Bearer synthetic.token", "cookie: synthetic"],
      count: 0,
      absent: undefined,
    };
    expect(redactCatalogProviderCredentialReadinessEvidence(evidence)).toEqual({
      nested: [
        { token: PROVIDER_CREDENTIAL_REDACTED_VALUE, safe: "safe" },
        PROVIDER_CREDENTIAL_REDACTED_VALUE,
        PROVIDER_CREDENTIAL_REDACTED_VALUE,
      ],
      count: 0,
      absent: null,
    });
    expect(redactCatalogProviderCredentialReadinessEvidence(evidence)).toEqual(
      redactProviderCredentialReadinessEvidence(evidence),
    );
    for (const secretReference of [" vault/example/session ", " Bearer synthetic.token ", " "]) {
      const scope = { environmentKey: " test ", accountKey: " example ", secretReference };
      expect(redactCatalogProviderCredentialReadinessScope(scope)).toEqual(
        redactProviderCredentialReadinessScope(scope),
      );
    }
  });

  it.each([
    ["not-required", false, null],
    ["configured", false, null],
    ["missing", true, "credential-missing"],
    ["invalid", true, "credential-invalid"],
    ["expired", true, "credential-expired"],
    ["revoked", true, "credential-revoked"],
    ["unknown", true, "adapter-authentication-failed"],
  ] as const)("preserves Catalog normalization, policy and audit for %s", (state, blocking, diagnosticCode) => {
    const readiness = createCatalogProviderCredentialReadiness({
      providerKey: " EXAMPLE ",
      requirement: "required",
      sourceKind: "local-fake",
      state,
      message: "Synthetic readiness",
      expiresAt: null,
      rotationRequiredAt: "2026-09-29T00:00:00.000Z",
    });
    expect(readiness).toEqual({
      providerKey: "example",
      requirement: "required",
      sourceKind: "local-fake",
      state,
      message: "Synthetic readiness",
      importBlocking: blocking,
      optionQueryBlocking: blocking,
      diagnosticCode,
      checkedAt: null,
      scope: {},
      evidence: {},
      expiresAt: null,
      rotationRequiredAt: "2026-09-29T00:00:00.000Z",
    });
    expect(catalogProviderCredentialReadinessBlocksImport(state)).toBe(blocking);
    expect(catalogProviderCredentialReadinessDiagnosticCode(state)).toBe(diagnosticCode);
    expect(catalogProviderCredentialReadinessToTransportDiagnostic(readiness)).toEqual(
      diagnosticCode ? { code: diagnosticCode, severity: "error", message: "Synthetic readiness" } : null,
    );
    expect(summarizeCatalogProviderCredentialReadinessForAudit(readiness)).toEqual({
      eventName: "provider-credential-readiness-changed",
      providerKey: "example",
      unitKey: null,
      state,
      importBlocking: blocking,
      optionQueryBlocking: blocking,
      sourceKind: "local-fake",
      diagnosticCode,
      checkedAt: null,
      scope: {},
      evidence: {},
    });
  });
});
