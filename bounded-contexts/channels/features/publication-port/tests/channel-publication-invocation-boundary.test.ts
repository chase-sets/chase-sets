import { describe, expect, it } from "vitest";
import { createChannelProviderRegistry } from "../api/registry";
import type {
  ChannelPublicationCapability,
  ChannelPublicationResult,
  DelistListingInput,
  PublishListingInput,
  UpdatePriceQuantityInput,
} from "../domain/contracts";
import { collectPublicationCallerEvidence, listTrackedProductionSources, type SourceFileMap } from "./source-evidence";
import {
  createDelistInput,
  createInlineDescriptor,
  createPublishInput,
  createUpdateInput,
  createValidDraft,
  fixtureInlineIdentity,
} from "./test-support";

describe("channel-publication-invocation-boundary", () => {
  it("throws before permissive adapter invocation for malformed input and returns provider validation unchanged", async () => {
    let calls = 0;
    const providerRejection = { kind: "rejected", code: "validation" } as const;
    const permissive = createCapability(async () => {
      calls += 1;
      return providerRejection;
    });
    const publication = requireInline(createChannelProviderRegistry([createInlineDescriptor(permissive)]));
    const malformed = createPublishInput({
      draft: createValidDraft({ price: { amountMinor: -1, currency: "USD" } }),
    });

    await expect(publication.publishListing(malformed)).rejects.toMatchObject({ code: "invalid-input" });
    expect(calls).toBe(0);
    await expect(publication.publishListing(createPublishInput())).resolves.toBe(providerRejection);
    expect(calls).toBe(1);
    await expect(publication.updatePriceQuantity(createUpdateInput())).resolves.toBe(providerRejection);
    await expect(publication.delistListing(createDelistInput())).resolves.toBe(providerRejection);
    expect(calls).toBe(3);
  });

  it("validates closed provider results after exactly one adapter call", async () => {
    let calls = 0;
    const malformedResult = { kind: "rejected", code: "validation", message: "fixture provider text" };
    const publication = requireInline(
      createChannelProviderRegistry([
        createInlineDescriptor(
          // @ts-expect-error synthetic adapter deliberately violates the provider-result contract
          createCapability(async () => {
            calls += 1;
            return malformedResult;
          }),
        ),
      ]),
    );

    await expect(publication.publishListing(createPublishInput())).rejects.toMatchObject({
      code: "invalid-input",
      message: expect.stringMatching(/^provider result/),
    });
    expect(calls).toBe(1);
  });

  it("wraps each distinct registered method with a different resolved function identity", async () => {
    const adapterCalls: string[] = [];
    async function rawPublish(_input: PublishListingInput): Promise<ChannelPublicationResult> {
      adapterCalls.push("publish");
      return { kind: "succeeded", externalListingId: "fixture-external-listing" };
    }
    async function rawUpdate(_input: UpdatePriceQuantityInput): Promise<ChannelPublicationResult> {
      adapterCalls.push("update");
      return { kind: "succeeded", externalListingId: "fixture-external-listing" };
    }
    async function rawDelist(_input: DelistListingInput): Promise<ChannelPublicationResult> {
      adapterCalls.push("delist");
      return { kind: "succeeded", externalListingId: "fixture-external-listing" };
    }
    const registered: Extract<ChannelPublicationCapability, { execution: "inline" }> = {
      execution: "inline",
      publishListing: rawPublish,
      updatePriceQuantity: rawUpdate,
      delistListing: rawDelist,
      fetchChannelState: async () => ({
        kind: "complete",
        items: [],
        collectedCount: 0,
        authorityTotal: 0,
        pageCount: 1,
      }),
      fetchSales: async () => ({ kind: "complete", lines: [], collectedCount: 0, authorityTotal: 0, pageCount: 1 }),
    };
    const publication = requireInline(createChannelProviderRegistry([createInlineDescriptor(registered)]));

    expect(publication.publishListing).not.toBe(rawPublish);
    expect(publication.updatePriceQuantity).not.toBe(rawUpdate);
    expect(publication.delistListing).not.toBe(rawDelist);
    await publication.publishListing(createPublishInput());
    await publication.updatePriceQuantity(createUpdateInput());
    await publication.delistListing(createDelistInput());
    expect(adapterCalls).toEqual(["publish", "update", "delist"]);

    await rawPublish(createPublishInput());
    expect(adapterCalls).toEqual(["publish", "update", "delist", "publish"]);
  });

  it("enumerates production source by code shape, rejects a direct imported raw call, and accepts registry lookup", () => {
    const files = listTrackedProductionSources();
    const evidence = collectPublicationCallerEvidence(files);
    expect(evidence.scanned).toBeGreaterThan(0);
    expect(evidence.operationCallFiles).toContain(
      "bounded-contexts/channels/features/publication-port/api/registry.ts",
    );
    expect(evidence.violations).toEqual([]);

    const directRawMutant = withSource(
      files,
      "bounded-contexts/neutral/features/alpha/api/direct.ts",
      [
        'import type { ChannelPublicationCapability } from "@chase-sets/channels";',
        'import { publishListing as send } from "./fixture-adapter";',
        "declare const capability: ChannelPublicationCapability;",
        "export const execute = async (input: unknown) => send(input);",
        "void capability;",
      ].join("\n"),
    );
    expect(collectPublicationCallerEvidence(directRawMutant).violations).toEqual([
      "bounded-contexts/neutral/features/alpha/api/direct.ts:publishListing",
    ]);

    const registryMutant = withSource(
      files,
      "bounded-contexts/neutral/features/alpha/api/resolved.ts",
      [
        'import { channelProviderRegistry } from "@chase-sets/channels";',
        "export async function execute(identity: Parameters<typeof channelProviderRegistry.get>[0], input: never) {",
        "  const provider = channelProviderRegistry.get(identity);",
        '  if (provider?.publication?.execution !== "inline") return null;',
        "  return provider.publication.publishListing(input);",
        "}",
      ].join("\n"),
    );
    expect(collectPublicationCallerEvidence(registryMutant).violations).toEqual([]);

    const legalDescriptorHolder = withSource(
      files,
      "bounded-contexts/neutral/features/alpha/integrations/descriptor.ts",
      [
        'import type { ChannelProviderDescriptor } from "@chase-sets/channels";',
        "declare const rawPublication: ChannelProviderDescriptor['publication'];",
        "export const descriptor = rawPublication;",
      ].join("\n"),
    );
    expect(collectPublicationCallerEvidence(legalDescriptorHolder).violations).toEqual([]);
  });
});

function createCapability(
  invoke: () => Promise<ChannelPublicationResult>,
): Extract<ChannelPublicationCapability, { execution: "inline" }> {
  return {
    execution: "inline",
    publishListing: invoke,
    updatePriceQuantity: invoke,
    delistListing: invoke,
    fetchChannelState: async () => ({
      kind: "complete",
      items: [],
      collectedCount: 0,
      authorityTotal: 0,
      pageCount: 1,
    }),
    fetchSales: async () => ({ kind: "complete", lines: [], collectedCount: 0, authorityTotal: 0, pageCount: 1 }),
  };
}

function requireInline(registry: ReturnType<typeof createChannelProviderRegistry>) {
  const publication = registry.get(fixtureInlineIdentity)?.publication;
  if (!publication || publication.execution !== "inline") throw new Error("Expected fixture inline capability.");
  return publication;
}

function withSource(files: SourceFileMap, relativePath: string, source: string): Map<string, string> {
  return new Map([...files, [relativePath, source]]);
}
