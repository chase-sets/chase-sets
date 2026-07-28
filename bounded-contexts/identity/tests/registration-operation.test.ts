import { describe, expect, it } from "vitest";
import {
  deriveRegistrationOperation,
  registrationOperationConsentBundleAgrees,
  REGISTRATION_OPERATION_KEY_VERSION,
  REGISTRATION_OPERATION_STREAM_PREFIX,
  type RegistrationOperationClaim,
} from "../support/runtime-support/registration-operation";

function keyFor(params: Readonly<{ email?: string | null; phone?: string | null }>) {
  return deriveRegistrationOperation(params)?.key ?? null;
}

describe("registration operation identity", () => {
  it("namespaces and versions the key so a normalization change cannot re-point a claim", () => {
    const operation = deriveRegistrationOperation({ email: "owner@pokebash.example" });

    expect(operation?.key).toBe(
      `identity.registration-operation:${REGISTRATION_OPERATION_KEY_VERSION}:email:owner@pokebash.example`,
    );
    expect(operation?.streamId.startsWith(REGISTRATION_OPERATION_STREAM_PREFIX)).toBe(true);
    expect(operation?.streamId.slice(REGISTRATION_OPERATION_STREAM_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
  });

  describe("the key is not too narrow: the same person retries onto the same operation", () => {
    const sameOperation: readonly (readonly [string, Readonly<{ email?: string | null; phone?: string | null }>])[] = [
      ["mixed casing", { email: "Owner@PokeBash.Example" }],
      ["surrounding whitespace", { email: "  owner@pokebash.example  " }],
      ["casing and whitespace together", { email: "\tOWNER@POKEBASH.EXAMPLE\n" }],
      ["an added phone alongside the same email", { email: "owner@pokebash.example", phone: "+15555550123" }],
    ];

    it.each(sameOperation)("converges %s", (_label, params) => {
      expect(keyFor(params)).toBe(keyFor({ email: "owner@pokebash.example" }));
    });
  });

  describe("the key is not too wide: different people never share an operation", () => {
    const distinct: readonly (readonly [string, Readonly<{ email?: string | null; phone?: string | null }>])[] = [
      ["a different local part", { email: "other@pokebash.example" }],
      ["a different domain", { email: "owner@other.example" }],
      ["a phone-only registration", { phone: "+15555550123" }],
    ];

    it.each(distinct)("keeps %s separate", (_label, params) => {
      expect(keyFor(params)).not.toBe(keyFor({ email: "owner@pokebash.example" }));
    });
  });

  it("prefers email over phone so an email-only retry converges with an email-and-phone first attempt", () => {
    const both = deriveRegistrationOperation({ email: "owner@pokebash.example", phone: "+15555550123" });
    const emailOnly = deriveRegistrationOperation({ email: "owner@pokebash.example" });
    const phoneOnly = deriveRegistrationOperation({ phone: "+15555550123" });

    expect(both?.contactType).toBe("email");
    expect(both?.key).toBe(emailOnly?.key);
    expect(both?.key).not.toBe(phoneOnly?.key);
  });

  it("normalizes phone contacts onto one operation across separator styles", () => {
    expect(keyFor({ phone: "(555) 555-0123" })).toBe(keyFor({ phone: "+15555550123" }));
    expect(deriveRegistrationOperation({ phone: "+15555550123" })?.contactType).toBe("phone");
  });

  const contactless: readonly (readonly [string, Readonly<{ email?: string | null; phone?: string | null }>])[] = [
    ["nothing at all", {}],
    ["explicit nulls", { email: null, phone: null }],
    ["blank strings", { email: "   ", phone: "  " }],
  ];

  it.each(contactless)("derives no operation from %s", (_label, params) => {
    expect(deriveRegistrationOperation(params)).toBeNull();
  });

  describe("consent bundle agreement", () => {
    function claim(consents: readonly Readonly<{ policyKey: string; policyVersion: string }>[]) {
      return { consents } as unknown as RegistrationOperationClaim;
    }

    it("agrees with the exact ordered bundle it recorded", () => {
      expect(
        registrationOperationConsentBundleAgrees(
          claim([
            { policyKey: "terms-of-service", policyVersion: "v1" },
            { policyKey: "privacy-policy", policyVersion: "v3" },
          ]),
          [
            { policyKey: "terms-of-service", version: "v1" },
            { policyKey: "privacy-policy", version: "v3" },
          ],
        ),
      ).toBe(true);
    });

    const disagreements: readonly (readonly [string, readonly Readonly<{ policyKey: string; version: string }>[]])[] = [
      ["a bumped version", [{ policyKey: "terms-of-service", version: "v2" }]],
      ["a different policy", [{ policyKey: "privacy-policy", version: "v1" }]],
      ["an empty bundle", []],
      [
        "an extra requirement",
        [
          { policyKey: "terms-of-service", version: "v1" },
          { policyKey: "privacy-policy", version: "v3" },
        ],
      ],
    ];

    it.each(disagreements)("fails closed on %s", (_label, requirements) => {
      expect(
        registrationOperationConsentBundleAgrees(
          claim([{ policyKey: "terms-of-service", policyVersion: "v1" }]),
          requirements,
        ),
      ).toBe(false);
    });

    it("fails closed on a reordered bundle", () => {
      expect(
        registrationOperationConsentBundleAgrees(
          claim([
            { policyKey: "terms-of-service", policyVersion: "v1" },
            { policyKey: "privacy-policy", policyVersion: "v3" },
          ]),
          [
            { policyKey: "privacy-policy", version: "v3" },
            { policyKey: "terms-of-service", version: "v1" },
          ],
        ),
      ).toBe(false);
    });
  });
});
