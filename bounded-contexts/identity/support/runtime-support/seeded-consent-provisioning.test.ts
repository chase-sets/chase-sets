import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { resolveSeededConsentAdmission, requireSeedEventStore } from "./seeded-consent-provisioning";

const operatorContext = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: "usr_policy_operator", forAccountId: "acc_policy_operator" },
  trace: {},
} as unknown as EventStoreContext;

describe("seeded Consent admission against the shipped corpus", () => {
  it("abstains for every seeded caller while nothing is consent-activatable", async () => {
    // The real compiled corpus, unmocked. Every Identity seeding path that
    // records Consent directly consults this same function, so this is the
    // shared answer they all get today.
    const memory = createInMemoryEventStore();

    const admission = await resolveSeededConsentAdmission(memory.eventStore, "terms-of-service", "v1");

    expect(admission.admitted).toBe(false);
    expect(admission).toMatchObject({
      reason: expect.stringContaining("consent_policy_not_publication_activatable"),
    });
    // Deciding to abstain never writes: no authority stream is even created.
    expect(memory.readAllEvents()).toHaveLength(0);
  });

  it("abstains for the legacy history-only key rather than recording new history", async () => {
    const memory = createInMemoryEventStore();

    await expect(resolveSeededConsentAdmission(memory.eventStore, "terms", "2026-03-03")).resolves.toMatchObject({
      admitted: false,
      reason: expect.stringContaining("consent_policy_not_bundle_member"),
    });
  });

  it("requires an event store rather than silently skipping the rule", () => {
    expect(() => requireSeedEventStore(undefined)).toThrow(/requires Identity services composed with an event store/);
  });
});

describe("seeded Consent admission once a document is published", () => {
  it("still abstains until the activation authority says active", async () => {
    vi.resetModules();
    vi.doMock("@chase-sets/public-docs", async (importOriginal) => {
      const { publicDocsWithConsentActivatable } =
        await import("../../features/consents/domain/consent-publication-test-support");
      return publicDocsWithConsentActivatable(importOriginal, ["terms-of-service"]);
    });

    const module = await import("./seeded-consent-provisioning");
    const memory = createInMemoryEventStore();

    await expect(
      module.resolveSeededConsentAdmission(memory.eventStore, "terms-of-service", "v1"),
    ).resolves.toMatchObject({ admitted: false, reason: expect.stringContaining("consent_policy_not_activated") });

    vi.doUnmock("@chase-sets/public-docs");
    vi.resetModules();
  });

  it("admits once publication and activation both confirm", async () => {
    vi.resetModules();
    vi.doMock("@chase-sets/public-docs", async (importOriginal) => {
      const { publicDocsWithConsentActivatable } =
        await import("../../features/consents/domain/consent-publication-test-support");
      return publicDocsWithConsentActivatable(importOriginal, ["terms-of-service"]);
    });

    const module = await import("./seeded-consent-provisioning");
    const support = await import("../../features/consents/domain/consent-bundle-test-support");
    const memory = createInMemoryEventStore();
    await support.activateConsentPolicyForTest(memory.eventStore, "terms-of-service", "v1", operatorContext);

    await expect(module.resolveSeededConsentAdmission(memory.eventStore, "terms-of-service", "v1")).resolves.toEqual({
      admitted: true,
      version: "v1",
    });

    vi.doUnmock("@chase-sets/public-docs");
    vi.resetModules();
  });
});
