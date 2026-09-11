import { describe, expect, it, vi } from "vitest";
import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import { assertEnqueueOutboundOperation, payloadDigest } from "../domain/validation";

const draft = {
  channelListingId: "channel-listing-1",
  listingRevision: 7,
  title: "Synthetic card",
  description: "Synthetic fixture",
  categoryKey: "category-1",
  conditionKey: "condition-1",
  price: { amountMinor: 1234, currency: "USD" },
  quantity: 2,
  attributes: [{ key: "finish", value: "foil" }],
} as const;

function desiredState(payload: unknown = { kind: "draft", draft }) {
  return {
    connectionId: "connection-1",
    channelListingId: "channel-listing-1",
    listingId: "listing-1",
    operationKind: "publish",
    listingRevision: 7,
    desiredStateSequence: 11,
    desiredStateHash: "a".repeat(64),
    payload,
    envelope: {
      sourceEventId: "event-1",
      sourceStreamId: "channels.channel-listing-channel-listing-1",
      sourceStreamVersion: 11,
      sourceGlobalPosition: parseGlobalPosition("81"),
      sourceOccurredAt: "2026-09-07T19:00:00.000Z",
    },
  };
}

describe("outbound closed payload contract", () => {
  it("validates the canonical draft and keeps payload digest distinct from producer hash", () => {
    const input = desiredState();
    assertEnqueueOutboundOperation(input, vi.fn());
    expect(payloadDigest(input.payload as never)).toMatch(/^[a-f0-9]{64}$/);
    expect(payloadDigest(input.payload as never)).not.toBe(input.desiredStateHash);
  });

  it("rejects nested unknown keys, duplicate attributes, unsafe numbers, and date-only instants", () => {
    const cases = [
      desiredState({ kind: "draft", draft: { ...draft, price: { ...draft.price, extra: true } } }),
      desiredState({ kind: "draft", draft: { ...draft, attributes: [draft.attributes[0], draft.attributes[0]] } }),
      desiredState({ kind: "draft", draft: { ...draft, listingRevision: Number.MAX_SAFE_INTEGER + 1 } }),
      { ...desiredState(), envelope: { ...desiredState().envelope, sourceOccurredAt: "2026-09-07" } },
      { ...desiredState(), desiredStateSequence: 12 },
      desiredState({ kind: "draft", draft: { ...draft, channelListingId: "different-link" } }),
    ];
    for (const candidate of cases) expect(() => assertEnqueueOutboundOperation(candidate, vi.fn())).toThrow();
  });

  it("delegates the delist member to the canonical producer validator and never supplies a default", () => {
    const assertDelistDirective = vi.fn();
    const input = {
      ...desiredState({ kind: "delist", delist: { canonical: "producer-owned" } }),
      operationKind: "delist",
    };
    assertEnqueueOutboundOperation(input, assertDelistDirective);
    expect(assertDelistDirective).toHaveBeenCalledExactlyOnceWith({ canonical: "producer-owned" });
  });
});
