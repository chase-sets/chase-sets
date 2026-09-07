import { describe, expect, it, vi } from "vitest";
import { createChannelProviderRegistry } from "../../publication-port/api/registry";
import type { ChannelProviderDescriptor } from "../../publication-port/domain/contracts";
import { resolveConnectionExecutionAdmission } from "../domain/admission";

const identity = { providerKey: "synthetic-inline", environment: "sandbox" } as const;
const connection = { connectionId: "connection-1", status: "active", ...identity } as const;
const setup = {
  ...identity,
  requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
} as const;

describe("outbound-provider-state-disposition-table", () => {
  it("covers absent, publication-unregistered, claimed, and inline admission without a default arm", () => {
    expect(resolveConnectionExecutionAdmission(createChannelProviderRegistry([]), connection)).toEqual({
      kind: "blocked",
      reason: "provider-descriptor-unregistered",
    });
    expect(
      resolveConnectionExecutionAdmission(createChannelProviderRegistry([{ identity, setup }]), connection),
    ).toEqual({ kind: "blocked", reason: "provider-publication-unregistered" });

    const claimed = createChannelProviderRegistry([{ identity, setup, publication: { execution: "claimed" } }]);
    expect(resolveConnectionExecutionAdmission(claimed, connection)).toEqual({ kind: "claimed", providerIdentity: identity });

    const publishListing = vi.fn();
    const updatePriceQuantity = vi.fn();
    const delistListing = vi.fn();
    const inline = createChannelProviderRegistry([
      { identity, setup, publication: { execution: "inline", publishListing, updatePriceQuantity, delistListing } },
    ] satisfies readonly ChannelProviderDescriptor[]);
    expect(resolveConnectionExecutionAdmission(inline, connection)).toMatchObject({
      kind: "inline",
      providerIdentity: identity,
    });
    expect(publishListing).not.toHaveBeenCalled();
    expect(updatePriceQuantity).not.toHaveBeenCalled();
    expect(delistListing).not.toHaveBeenCalled();
  });
});
