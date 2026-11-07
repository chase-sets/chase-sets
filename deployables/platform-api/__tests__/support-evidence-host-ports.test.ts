import { describe, expect, it, vi } from "vitest";
import { module as platformOperationsModule } from "@chase-sets/platform-operations";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";

/**
 * The registry forwards only the host ports a context declares, so a port that main.ts supplies but
 * context.json omits reaches the context as undefined. Support evidence staging needs both of these
 * ports and refuses with storage-unavailable when either is missing (#10911).
 */
describe("support evidence host ports", () => {
  it("forwards the attachment storage and the canonicalizer from the real host to Platform Operations", async () => {
    const pools = createPlatformApiPools({
      runtimeProfile: "public",
      sharedDatabaseUrl: "postgresql://localhost/shared",
      contextDatabaseUrls: {},
      port: 6182,
    });
    const create = vi.spyOn(platformOperationsModule, "createServices");
    const supportEvidenceAttachmentStorage = { putPrivate: vi.fn(), verifyPrivate: vi.fn(), readPrivate: vi.fn() };
    const supportEvidenceCanonicalizer = { canonicalize: vi.fn() };
    try {
      createPlatformApiHost({
        runtimeProfile: "public",
        pools,
        hostPorts: {
          capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
          processorGateway: createFakePaymentProcessorGateway(),
          supportEvidenceAttachmentStorage,
          supportEvidenceCanonicalizer,
        },
      });
      expect(create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ supportEvidenceAttachmentStorage, supportEvidenceCanonicalizer }),
        expect.anything(),
      );
    } finally {
      create.mockRestore();
      await closePlatformApiPools(pools);
    }
  });
});
