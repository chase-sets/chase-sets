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
} from "./index";

describe("provider credential vocabulary", () => {
  it("keeps the exact closed unions", () => {
    expectTypeOf<ProviderCredentialRequirement>().toEqualTypeOf<"not-required" | "required">();
    expectTypeOf<ProviderCredentialSourceKind>().toEqualTypeOf<
      "none" | "environment-secret" | "managed-secret" | "operator-session" | "local-fake"
    >();
    expectTypeOf<ProviderCredentialReadinessState>().toEqualTypeOf<
      "not-required" | "configured" | "missing" | "invalid" | "expired" | "revoked" | "unknown"
    >();
    expectTypeOf<ProviderCredentialReadinessScope>().toEqualTypeOf<
      Readonly<{ environmentKey?: string; accountKey?: string; secretReference?: string }>
    >();
    expectTypeOf<ProviderCredentialReadinessEvidence>().toEqualTypeOf<Readonly<Record<string, JsonValue>>>();
  });

  it("supports specialized provider and optional unit keys with nullable timestamps", () => {
    type Readiness = ProviderCredentialReadiness<"example", "example:unit">;
    expectTypeOf<Readiness["providerKey"]>().toEqualTypeOf<"example">();
    expectTypeOf<Readiness["unitKey"]>().toEqualTypeOf<"example:unit" | undefined>();
    expectTypeOf<ProviderCredentialReadiness["providerKey"]>().toEqualTypeOf<string>();
    expectTypeOf<ProviderCredentialReadiness["unitKey"]>().toEqualTypeOf<string | undefined>();
    const readiness: Readiness = {
      providerKey: "example",
      requirement: "required",
      sourceKind: "local-fake",
      state: "configured",
      importBlocking: false,
      optionQueryBlocking: true,
      diagnosticCode: null,
      message: "Synthetic readiness",
      checkedAt: null,
      scope: {},
      evidence: { count: 0, active: false, values: [null, undefined] },
    };
    expect(readiness).not.toHaveProperty("unitKey");
    expect(readiness).not.toHaveProperty("expiresAt");
    const scoped: Readiness = {
      ...readiness,
      unitKey: "example:unit",
      expiresAt: null,
      rotationRequiredAt: "2026-09-29T00:00:00.000Z",
      revokedAt: null,
    };
    expect(scoped).toMatchObject({
      unitKey: "example:unit",
      expiresAt: null,
      rotationRequiredAt: "2026-09-29T00:00:00.000Z",
      revokedAt: null,
      importBlocking: false,
      optionQueryBlocking: true,
    });
  });
});

describe("provider credential redaction", () => {
  const redacted = PROVIDER_CREDENTIAL_REDACTED_VALUE;

  it("redacts nested sensitive keys and values without changing safe data or the input", () => {
    const evidence = {
      nested: {
        Authorization: "synthetic-authorization",
        bearer: "synthetic-bearer",
        Cookie: "synthetic-cookie",
        password: "synthetic-password",
        secret: "synthetic-secret",
        session: "synthetic-session",
        TCGAuthTicket: "synthetic-ticket",
        accessToken: "synthetic-token",
        safe: "provider session label",
      },
      values: [
        "Bearer synthetic.token",
        "TCGAuthTicket=synthetic-ticket",
        "authorization: synthetic",
        "cookie: synthetic",
        "password=synthetic",
        "secret=synthetic",
        "token=synthetic",
        { safe: "safe", token: "synthetic-token" },
        [undefined, null, false, 0, "safe"],
      ],
      absent: undefined,
    };
    const original = structuredClone(evidence);
    const output = redactProviderCredentialReadinessEvidence(evidence);
    expect(output).toEqual({
      nested: {
        Authorization: redacted,
        bearer: redacted,
        Cookie: redacted,
        password: redacted,
        secret: redacted,
        session: redacted,
        TCGAuthTicket: redacted,
        accessToken: redacted,
        safe: "provider session label",
      },
      values: [
        redacted,
        redacted,
        redacted,
        redacted,
        redacted,
        redacted,
        redacted,
        { safe: "safe", token: redacted },
        [null, null, false, 0, "safe"],
      ],
      absent: null,
    });
    expect(evidence).toEqual(original);
    expect(redactProviderCredentialReadinessEvidence(output)).toEqual(output);
  });

  it("normalizes scope and preserves safe secret references", () => {
    expect(
      redactProviderCredentialReadinessScope({
        environmentKey: " test ",
        accountKey: " example ",
        secretReference: " vault/example/session ",
      }),
    ).toEqual({ environmentKey: "test", accountKey: "example", secretReference: "vault/example/session" });
    expect(
      redactProviderCredentialReadinessScope({ environmentKey: " ", accountKey: "", secretReference: " " }),
    ).toEqual({});
    expect(redactProviderCredentialReadinessScope({})).toEqual({});
    for (const secretReference of [" Bearer synthetic.token ", "cookie: synthetic", "token=synthetic"]) {
      expect(redactProviderCredentialReadinessScope({ secretReference })).toEqual({ secretReference: redacted });
    }
  });
});
