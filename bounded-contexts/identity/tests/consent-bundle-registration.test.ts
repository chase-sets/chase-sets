import { describe, expect, it, vi } from "vitest";
import { publicPolicyPublicationRecords } from "@chase-sets/public-docs";
import type { IdentityServices } from "../support/runtime-support/services";
import { buildIdentityApi } from "../api";
import { registrationConsentBundle } from "../features/consents/domain/consent-bundle";
import {
  mintRegistrationConsentResolution,
  type SignedRegistrationConsentResolution,
} from "../features/consents/domain/registration-consent";
import { resolveRegistrationConsentSigningKeys } from "../support/runtime-support/registration-consent-signing";

/**
 * The registration bundle, driven through the real no-options entry points --
 * the anonymous mint route and the registration route -- against the shipped
 * policy corpus. Nothing here supplies requirements, versions, or members.
 */
function createServices() {
  return {
    db: {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("INSERT INTO identity_account_display_name_reservations")
          ? [{ display_name_key: "pokebash tcg" }]
          : [],
      })),
    },
    accounts: { commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })) },
    users: { commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })) },
    memberships: { commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })) },
    consents: { commandHandler: vi.fn(async () => ({ version: 1, state: { status: "recorded" } })) },
    policies: {
      resolvePolicy: vi.fn(async () => ({ value: { version: "v1" } })),
      consentActivation: {
        read: vi.fn(() => {
          throw new Error("No member of the shipped corpus is consent-activatable, so no authority is read.");
        }),
      },
    },
    projectors: [],
  } as unknown as IdentityServices;
}

async function mintThroughTheRoute(services: IdentityServices) {
  const response = await buildIdentityApi(services).request("/internal/auth/registration-consent");
  return { status: response.status, resolution: (await response.json()) as SignedRegistrationConsentResolution };
}

describe("the registration bundle against the shipped corpus", () => {
  it("declares two members while every shipped artifact is non-consent-activatable", () => {
    expect(registrationConsentBundle.members.map((member) => member.policyKey)).toEqual([
      "terms-of-service",
      "privacy-policy",
    ]);
    for (const member of registrationConsentBundle.members) {
      expect(publicPolicyPublicationRecords[member.policyKey].consentActivatable).toBe(false);
    }
  });

  it("omits a non-activatable member from the requirement set", async () => {
    const { status, resolution } = await mintThroughTheRoute(createServices());

    expect(status).toBe(200);
    expect(resolution.requirements).toEqual([]);
  });

  it("resolves an empty ordered requirement set for the current corpus", async () => {
    const { resolution } = await mintThroughTheRoute(createServices());

    expect(resolution.requirements).toEqual([]);
    expect(resolution.bundleKey).toBe("registration");
  });

  it("an empty requirement set does not disable the invariant", async () => {
    const services = createServices();

    // The mint still signs and still carries a resolution instant...
    const { resolution } = await mintThroughTheRoute(services);
    expect(resolution.signature.length).toBeGreaterThan(0);
    expect(resolution.resolvedAt).toMatch(/Z$/);

    // ...and registration still refuses to proceed without one.
    const withoutResolution = await buildIdentityApi(services).request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@pokebash.example", displayName: "PokeBash TCG" }),
    });

    expect(withoutResolution.status).toBe(400);
    expect(services.accounts.commandHandler).not.toHaveBeenCalled();
    expect(services.consents.commandHandler).not.toHaveBeenCalled();
  });

  it("registers against the minted empty resolution and records no consent", async () => {
    const services = createServices();
    const { resolution } = await mintThroughTheRoute(services);

    const response = await buildIdentityApi(services).request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@pokebash.example",
        displayName: "PokeBash TCG",
        registrationConsent: { resolution, affirmed: false },
      }),
    });

    expect(response.status).toBe(201);
    expect(services.consents.commandHandler).not.toHaveBeenCalled();
  });

  it("never consults the cached active-version policy on the registration path", async () => {
    const services = createServices();
    const resolution = mintRegistrationConsentResolution({
      requirements: [],
      resolvedAt: new Date().toISOString(),
      signingKeys: resolveRegistrationConsentSigningKeys(),
    });

    await buildIdentityApi(services).request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@pokebash.example",
        displayName: "PokeBash TCG",
        registrationConsent: { resolution, affirmed: false },
      }),
    });

    expect(services.policies.resolvePolicy).not.toHaveBeenCalled();
  });
});
