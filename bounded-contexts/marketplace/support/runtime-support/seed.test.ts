import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { MarketplaceServices } from "./services";
import { seedMarketplaceContextDatabase } from "./seed";
import { seedListingEvidencePolicy } from "../../features/listing-evidence-policy/integrations/seed";

vi.mock("../../features/listing-evidence-policy/integrations/seed", () => ({ seedListingEvidencePolicy: vi.fn() }));

function fixture() {
  const memory = createInMemoryEventStore();
  const withContext = vi.fn();
  const createListing = vi.fn();
  // Synthetic transport dependencies; every refusal must occur before credential use.
  const services = {
    listingAuthority: { eventStore: memory.eventStore },
    listingSeed: { withContext, listings: { createListing } },
  } as unknown as MarketplaceServices;
  return { memory, withContext, createListing, services };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Marketplace fixture Listing seed fence", () => {
  it.each(["production", "staging", " Production ", "STAGING"])(
    "refuses Listing steps in %s even with a credential provider",
    async (environmentName) => {
      const f = fixture();
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await seedMarketplaceContextDatabase({} as never, f.services, {
        environmentName,
        enabledDataProfiles: ["scenario-seed"],
      });
      expect(seedListingEvidencePolicy).toHaveBeenCalledWith(f.services);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toContain(
        "opus-8349-original-authority-decision-r1; opus-8349-r20-routing-decision-r1",
      );
      expect(f.withContext).not.toHaveBeenCalled();
      expect(f.createListing).not.toHaveBeenCalled();
      expect(f.memory.streams.size).toBe(0);
    },
  );

  it.each(["production", "staging"])("refuses a %s process despite non-production options", async (environmentName) => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", environmentName);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const f = fixture();
    await seedMarketplaceContextDatabase({} as never, f.services, {
      environmentName: "test",
      enabledDataProfiles: ["scenario-seed"],
    });
    expect(f.withContext).not.toHaveBeenCalled();
  });

  it("refuses default or missing profile options rather than inventing a non-production environment", async () => {
    const f = fixture();
    for (const options of [
      undefined,
      { environmentName: null, enabledDataProfiles: ["scenario-seed"] as const },
      { environmentName: "test", enabledDataProfiles: [] },
    ]) {
      await expect(seedMarketplaceContextDatabase({} as never, f.services, options)).rejects.toThrow(
        "explicit non-production",
      );
    }
    expect(f.withContext).not.toHaveBeenCalled();
  });

  it("never mints a newer key or re-drives a retained unknown seed attempt", async () => {
    const f = fixture();
    await f.memory.eventStore.appendToStream({
      streamId: "marketplace.listing-seed-scenario",
      expectedVersion: 0,
      context: {
        tenantId: "tnt_synthetic",
        audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
      },
      events: [
        { eventType: "marketplace.listing-seed.started", payload: { seedRunStartedAt: "2000-01-01T00:00:00.000Z" } },
      ],
    });
    const before = structuredClone([...f.memory.streams]);
    await expect(
      seedMarketplaceContextDatabase({} as never, f.services, {
        environmentName: "test",
        enabledDataProfiles: ["scenario-seed"],
      }),
    ).rejects.toThrow("newer key cannot re-drive");
    expect(f.withContext).not.toHaveBeenCalled();
    expect(f.createListing).not.toHaveBeenCalled();
    expect([...f.memory.streams]).toEqual(before);
  });
});
