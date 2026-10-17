import { describe, expect, it } from "vitest";
import { createChannelProviderRegistry } from "../../publication-port/api/registry";
import type { ChannelProviderDescriptor, ChannelStateFetchResult } from "../../publication-port/domain/contracts";

describe("channel-state-fetch-completeness", () => {
  it("accepts only an independently total complete result through the production registry wrapper", async () => {
    const complete = registry(async () => ({
      kind: "complete",
      items: [item("external-1", "1")],
      collectedCount: 1,
      authorityTotal: 1,
      pageCount: 1,
    }));
    await expect(publication(complete).fetchChannelState({ connectionId: "connection-1" })).resolves.toMatchObject({
      kind: "complete",
      collectedCount: 1,
      authorityTotal: 1,
    });

    const mismatch = registry(async () => ({
      kind: "complete",
      items: [item("external-1", "1")],
      collectedCount: 1,
      authorityTotal: 2,
      pageCount: 1,
    }));
    await expect(publication(mismatch).fetchChannelState({ connectionId: "connection-1" })).rejects.toThrow(
      /completeness counts/,
    );
  });

  it("rejects duplicate identity even when all declared counts agree", async () => {
    const duplicate = registry(async () => ({
      kind: "complete",
      items: [item("external-1", "1"), item("external-1", "2")],
      collectedCount: 2,
      authorityTotal: 2,
      pageCount: 1,
    }));
    await expect(publication(duplicate).fetchChannelState({ connectionId: "connection-1" })).rejects.toThrow(
      /duplicate identity/,
    );
  });
});

describe("channel-state-fetch-cap-boundary", () => {
  it("retains bounded unknown rather than publishing the current-looking item before the decisive capped item", async () => {
    const capped = registry(async () => ({ kind: "bounded-unknown", reason: "hard-cap" }));
    await expect(publication(capped).fetchChannelState({ connectionId: "connection-1" })).resolves.toEqual({
      kind: "bounded-unknown",
      reason: "hard-cap",
    });
  });
});

function registry(fetchChannelState: () => Promise<ChannelStateFetchResult>) {
  return createChannelProviderRegistry([
    {
      identity: { providerKey: "synthetic-reconciliation", environment: "sandbox" },
      setup: {
        providerKey: "synthetic-reconciliation",
        environment: "sandbox",
        requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
      },
      publication: {
        execution: "inline",
        publishListing: async () => ({ kind: "succeeded", externalListingId: "unused" }),
        updatePriceQuantity: async () => ({ kind: "succeeded", externalListingId: "unused" }),
        delistListing: async () => ({ kind: "succeeded", externalListingId: "unused" }),
        fetchChannelState: async () => fetchChannelState(),
        fetchSales: async () => ({ kind: "complete", lines: [], collectedCount: 0, authorityTotal: 0, pageCount: 1 }),
      },
    } satisfies ChannelProviderDescriptor,
  ]);
}

function publication(value: ReturnType<typeof registry>) {
  const capability = value.get({ providerKey: "synthetic-reconciliation", environment: "sandbox" })?.publication;
  if (capability?.execution !== "inline") throw new Error("Expected inline synthetic descriptor.");
  return capability;
}

function item(externalListingId: string, revision: string) {
  return {
    externalListingId,
    externalOfferId: null,
    revision,
    price: { amountMinor: 1_000, currency: "USD" },
    quantity: 1,
    fingerprint: revision.repeat(64),
  };
}
