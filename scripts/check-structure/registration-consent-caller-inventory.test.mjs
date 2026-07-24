import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import {
  analyzeRegistrationConsentCallerSources,
  validateRegistrationConsentCallerInventory,
} from "./registration-consent-caller-inventory.mjs";

function entry(file, classification, surfaces) {
  return {
    file,
    classification,
    surfaces,
    binding: "fixture binding",
  };
}

const canonicalClientSource = `
export function createAuthApiClient() {
  const buildUrl = (path) => path;
  return {
    async resolveRegistrationConsent() {
      return fetch(buildUrl("registration-consent"));
    },
    async registerWithConsentSubmission<T>(body, submission) {
      return fetch(buildUrl("register"), {
        body: JSON.stringify({
          ...body,
          registrationConsent: submission,
        }),
      });
    },
    async registerWithAuthoritativeConsent<T>(body, options) {
      const resolution = await this.resolveRegistrationConsent();
      return this.registerWithConsentSubmission(body, {
        operationId: resolution.operationId,
        snapshot: resolution.snapshot,
        affirmed: options.affirmed,
      });
    },
  };
}
`;

describe("registration consent caller inventory", () => {
  it("covers every caller discovered in the repository", () => {
    const result = validateRegistrationConsentCallerInventory({ repoRoot });
    expect(result.violations).toEqual([]);
  });

  it("rejects the historical alternate-route shape that drops affirmation and snapshot", () => {
    const file = "bounded-contexts/auth/support/api-support/alternate-registration-routes.ts";
    const result = analyzeRegistrationConsentCallerSources({
      activationEnabled: true,
      inventory: [entry(file, "registration-route", ["identity-personal-identity"])],
      sources: [
        {
          file,
          content: `
            await identityMutations.createPersonalIdentity({
              email,
              displayName,
            });
          `,
        },
      ],
    });

    expect(result.violations).toEqual([
      expect.stringContaining("must submit the exact canonical registrationConsent operation ID"),
    ]);
  });

  it("rejects the historical arbitrary-path direct register client", () => {
    const result = analyzeRegistrationConsentCallerSources({
      activationEnabled: true,
      inventory: [],
      sources: [
        {
          file: "deployables/another-web/e2e/support/account.ts",
          content: `
            await page.request.post(origin + "/api/auth/register", {
              data: { email, password, displayName },
            });
          `,
        },
      ],
    });

    expect(result.violations).toEqual([expect.stringContaining("unknown first-use identity/account creation caller")]);
  });

  it("rejects an inventoried raw client as soon as consent activation lands", () => {
    const file = "scripts/preactivation-registration-probe.mjs";
    const result = analyzeRegistrationConsentCallerSources({
      activationEnabled: true,
      inventory: [entry(file, "preactivation-direct-client", ["auth-register-http"])],
      sources: [
        {
          file,
          content: `await fetch("/api/auth/register", { method: "POST", body });`,
        },
      ],
    });

    expect(result.violations).toEqual([
      expect.stringContaining("direct /api/auth/register client is forbidden after registration consent activation"),
    ]);
  });

  it("allows the canonical client to resolve and submit the exact ordered bundle", () => {
    const file = "bounded-contexts/auth/client.ts";
    const result = analyzeRegistrationConsentCallerSources({
      activationEnabled: true,
      inventory: [entry(file, "canonical-client", ["auth-register-http"])],
      sources: [{ file, content: canonicalClientSource }],
    });

    expect(result.violations).toEqual([]);
  });

  it("allows sign-in-only paths that cannot create an identity", () => {
    const result = analyzeRegistrationConsentCallerSources({
      activationEnabled: true,
      inventory: [],
      sources: [
        {
          file: "bounded-contexts/auth/support/api-support/sign-in-only.ts",
          content: `await fetch("/api/auth/password-sign-in", { method: "POST", body });`,
        },
      ],
    });

    expect(result.violations).toEqual([]);
  });

  it("allows inventoried direct clients and routes only while the authoritative bundle is pre-activation empty", () => {
    const routeFile = "bounded-contexts/auth/support/api-support/register-routes.ts";
    const clientFile = "scripts/preactivation-registration-probe.mjs";
    const result = analyzeRegistrationConsentCallerSources({
      activationEnabled: false,
      inventory: [
        entry(routeFile, "registration-route", ["identity-personal-identity"]),
        entry(clientFile, "preactivation-direct-client", ["auth-register-http"]),
      ],
      sources: [
        {
          file: routeFile,
          content: `await identityMutations.createPersonalIdentity({ email, displayName });`,
        },
        {
          file: clientFile,
          content: `await fetch("/api/auth/register", { method: "POST", body });`,
        },
      ],
    });

    expect(result.violations).toEqual([]);
    expect(result.activationEnabled).toBe(false);
  });

  it("fails closed for an unknown direct aggregate creator", () => {
    const result = analyzeRegistrationConsentCallerSources({
      activationEnabled: false,
      inventory: [],
      sources: [
        {
          file: "scripts/new-bootstrap.mjs",
          content: `await handler({ command: { type: "CreateUser", userId } });`,
        },
      ],
    });

    expect(result.violations).toEqual([expect.stringContaining("unknown first-use identity/account creation caller")]);
  });

  it("fails closed when an inventoried file remains but its creation surface disappears", () => {
    const file = "scripts/preactivation-registration-probe.mjs";
    const result = analyzeRegistrationConsentCallerSources({
      activationEnabled: false,
      inventory: [entry(file, "preactivation-direct-client", ["auth-register-http"])],
      sources: [{ file, content: `export const probeName = "registration";` }],
    });

    expect(result.violations).toEqual([
      expect.stringContaining("stale caller inventory surface(s) auth-register-http"),
    ]);
  });
});
