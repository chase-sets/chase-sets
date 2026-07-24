import { describe, expect, it, vi } from "vitest";
import { publicPolicyPublicationRecords, type PublicPolicyKey } from "@chase-sets/public-docs";
import {
  assertConsentAcceptanceIsActivated,
  resolveActivatedConsentPolicy,
  resolveConsentBundleRequirements,
  type ConsentPublicationRegistry,
} from "./consent-activation";

function publicationsWith(
  overrides: Partial<Record<PublicPolicyKey, Partial<ConsentPublicationRegistry[PublicPolicyKey]>>>,
): ConsentPublicationRegistry {
  return Object.fromEntries(
    Object.entries(publicPolicyPublicationRecords).map(([policyKey, publication]) => [
      policyKey,
      { ...publication, ...overrides[policyKey as PublicPolicyKey] },
    ]),
  ) as ConsentPublicationRegistry;
}

function policies(
  values: Partial<Record<PublicPolicyKey, Readonly<{ source: "policy" | "fallback"; version: `v${number}` }>>>,
) {
  return {
    resolvePolicy: vi.fn(async (definition: { policyKey: string }) => {
      const policyKey = definition.policyKey
        .replace(/^identity\./, "")
        .replace(/-active-version$/, "") as PublicPolicyKey;
      const value = values[policyKey] ?? { source: "fallback" as const, version: "v1" as const };
      return {
        policyKey: definition.policyKey,
        value: { version: value.version },
        source: value.source,
        documentId: value.source === "policy" ? `pol_${policyKey}` : null,
        effectiveFrom: value.source === "policy" ? "2026-07-24T00:00:00.000Z" : null,
        effectiveUntil: null,
        resolvedAt: "2026-07-24T00:00:00.000Z",
      };
    }),
  };
}

describe("consent activation", () => {
  it("omits unpublished members without resolving an active-version policy", async () => {
    const runtime = policies({});

    await expect(resolveConsentBundleRequirements(runtime as never, "registration")).resolves.toEqual([]);
    expect(runtime.resolvePolicy).not.toHaveBeenCalled();
  });

  it("omits readiness-valid publications until an exact version is actively set", async () => {
    const publications = publicationsWith({
      "terms-of-service": { publicationStatus: "published", consentActivatable: true },
    });

    await expect(
      resolveActivatedConsentPolicy(
        policies({ "terms-of-service": { source: "fallback", version: "v1" } }) as never,
        "terms-of-service",
        publications,
      ),
    ).resolves.toBeNull();
    await expect(
      resolveActivatedConsentPolicy(
        policies({ "terms-of-service": { source: "policy", version: "v2" } }) as never,
        "terms-of-service",
        publications,
      ),
    ).resolves.toBeNull();
  });

  it("returns bundle members in bundle order only for exact published and activated versions", async () => {
    const publications = publicationsWith({
      "terms-of-service": { publicationStatus: "published", consentActivatable: true },
      "privacy-policy": { publicationStatus: "published", consentActivatable: true },
    });
    const runtime = policies({
      "terms-of-service": { source: "policy", version: "v1" },
      "privacy-policy": { source: "policy", version: "v1" },
    });

    await expect(resolveConsentBundleRequirements(runtime as never, "registration", publications)).resolves.toEqual([
      {
        policyKey: "terms-of-service",
        version: "v1",
        href: publicPolicyPublicationRecords["terms-of-service"].href,
      },
      {
        policyKey: "privacy-policy",
        version: "v1",
        href: publicPolicyPublicationRecords["privacy-policy"].href,
      },
    ]);
  });

  it("rejects acceptance of unpublished, unactivated, or outdated versions", async () => {
    const publications = publicationsWith({
      "terms-of-service": { publicationStatus: "published", consentActivatable: true },
    });

    await expect(
      assertConsentAcceptanceIsActivated(
        policies({ "terms-of-service": { source: "fallback", version: "v1" } }) as never,
        {
          policyKey: "terms-of-service",
          version: "v1",
        },
        publications,
      ),
    ).rejects.toThrow(/not published and activated/);
    await expect(
      assertConsentAcceptanceIsActivated(
        policies({ "terms-of-service": { source: "policy", version: "v1" } }) as never,
        {
          policyKey: "terms-of-service",
          version: "v2",
        },
        publications,
      ),
    ).rejects.toThrow(/not published and activated/);
  });
});
