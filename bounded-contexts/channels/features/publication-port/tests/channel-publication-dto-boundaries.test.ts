import { describe, expect, it } from "vitest";
import { channelPublicationRejectionCodes, type ChannelPublicationRejectionCode } from "../domain/contracts";
import {
  assertChannelPublicationResult,
  assertDelistListingInput,
  assertPublishListingInput,
  assertUpdatePriceQuantityInput,
} from "../domain/validation";
import { createDelistInput, createPublishInput, createUpdateInput, createValidDraft } from "./test-support";

describe("channel-publication-dto-boundaries", () => {
  it("accepts every minimum and maximum while preserving exact attribute order", () => {
    const minimum = createPublishInput({
      operationId: "x",
      connectionId: "x",
      draft: createValidDraft({
        channelListingId: "x",
        listingRevision: 0,
        title: "x",
        description: "",
        categoryKey: "x",
        conditionKey: "x",
        price: { amountMinor: 0, currency: "USD" },
        quantity: 0,
        attributes: [],
      }),
    });
    expect(() => assertPublishListingInput(minimum)).not.toThrow();

    const attributes = Array.from({ length: 200 }, (_, index) => ({
      key: `${index}-${"k".repeat(252)}`.slice(0, 256),
      value: String(index).padStart(4, "0") + "v".repeat(4_092),
    }));
    const maximum = createPublishInput({
      operationId: "o".repeat(128),
      connectionId: "c".repeat(128),
      draft: createValidDraft({
        channelListingId: "l".repeat(128),
        listingRevision: Number.MAX_SAFE_INTEGER,
        title: "t".repeat(4_096),
        description: "d".repeat(100_000),
        categoryKey: "c".repeat(256),
        conditionKey: "n".repeat(256),
        price: { amountMinor: Number.MAX_SAFE_INTEGER, currency: "USD" },
        quantity: 1_000_000,
        attributes,
      }),
    });
    const before = JSON.stringify(maximum.draft.attributes);
    expect(() => assertPublishListingInput(maximum)).not.toThrow();
    expect(JSON.stringify(maximum.draft.attributes)).toBe(before);

    expect(() =>
      assertUpdatePriceQuantityInput(
        createUpdateInput({
          operationId: "o".repeat(128),
          connectionId: "c".repeat(128),
          channelListingId: "l".repeat(128),
          listingRevision: Number.MAX_SAFE_INTEGER,
          price: { amountMinor: Number.MAX_SAFE_INTEGER, currency: "EUR" },
          quantity: 1_000_000,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertDelistListingInput(
        createDelistInput({
          operationId: "o".repeat(128),
          connectionId: "c".repeat(128),
          channelListingId: "l".repeat(128),
          listingRevision: Number.MAX_SAFE_INTEGER,
        }),
      ),
    ).not.toThrow();
  });

  it("rejects maximum-plus-one strings and arrays at every bounded location", () => {
    const invalidDrafts = [
      createValidDraft({ channelListingId: "l".repeat(129) }),
      createValidDraft({ title: "t".repeat(4_097) }),
      createValidDraft({ description: "d".repeat(100_001) }),
      createValidDraft({ categoryKey: "c".repeat(257) }),
      createValidDraft({ conditionKey: "n".repeat(257) }),
      createValidDraft({ attributes: [{ key: "k".repeat(257), value: "" }] }),
      createValidDraft({ attributes: [{ key: "k", value: "v".repeat(4_097) }] }),
      createValidDraft({
        attributes: Array.from({ length: 201 }, (_, index) => ({ key: `fixture-key-${index}`, value: "" })),
      }),
    ];
    for (const draft of invalidDrafts) expectInvalid(() => assertPublishListingInput(createPublishInput({ draft })));
    for (const input of [
      createPublishInput({ operationId: "o".repeat(129) }),
      createPublishInput({ connectionId: "c".repeat(129) }),
    ]) {
      expectInvalid(() => assertPublishListingInput(input));
    }
    for (const input of [
      createUpdateInput({ operationId: "o".repeat(129) }),
      createUpdateInput({ connectionId: "c".repeat(129) }),
      createUpdateInput({ channelListingId: "l".repeat(129) }),
    ]) {
      expectInvalid(() => assertUpdatePriceQuantityInput(input));
    }
    for (const input of [
      createDelistInput({ operationId: "o".repeat(129) }),
      createDelistInput({ connectionId: "c".repeat(129) }),
      createDelistInput({ channelListingId: "l".repeat(129) }),
    ]) {
      expectInvalid(() => assertDelistListingInput(input));
    }
  });

  it("rejects empty required strings, malformed Unicode scalars, currency, and duplicate exact keys", () => {
    for (const draft of [
      createValidDraft({ channelListingId: "" }),
      createValidDraft({ title: "" }),
      createValidDraft({ categoryKey: "" }),
      createValidDraft({ conditionKey: "" }),
      createValidDraft({ title: "\ud800" }),
      createValidDraft({ price: { amountMinor: 1, currency: "usd" } }),
      createValidDraft({ price: { amountMinor: 1, currency: "US" } }),
      createValidDraft({
        attributes: [
          { key: "duplicate", value: "a" },
          { key: "duplicate", value: "b" },
        ],
      }),
    ]) {
      expectInvalid(() => assertPublishListingInput(createPublishInput({ draft })));
    }
    expectInvalid(() => assertPublishListingInput(createPublishInput({ operationId: "" })));
    expectInvalid(() => assertUpdatePriceQuantityInput(createUpdateInput({ connectionId: "" })));
    expectInvalid(() => assertDelistListingInput(createDelistInput({ channelListingId: "" })));

    const exactSequenceDistinct = createValidDraft({
      attributes: [
        { key: "Fixture", value: "case" },
        { key: "fixture", value: "case-distinct" },
        { key: "é", value: "composed" },
        { key: "e\u0301", value: "decomposed" },
      ],
    });
    expect(() => assertPublishListingInput(createPublishInput({ draft: exactSequenceDistinct }))).not.toThrow();
  });

  it("rejects unsafe, negative, fractional, and out-of-range numbers", () => {
    const invalidSafeIntegers = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1];
    for (const value of invalidSafeIntegers) {
      expectInvalid(() =>
        assertPublishListingInput(createPublishInput({ draft: createValidDraft({ listingRevision: value }) })),
      );
      expectInvalid(() =>
        assertPublishListingInput(
          createPublishInput({ draft: createValidDraft({ price: { amountMinor: value, currency: "USD" } }) }),
        ),
      );
      expectInvalid(() => assertUpdatePriceQuantityInput(createUpdateInput({ listingRevision: value })));
      expectInvalid(() =>
        assertUpdatePriceQuantityInput(createUpdateInput({ price: { amountMinor: value, currency: "USD" } })),
      );
      expectInvalid(() => assertDelistListingInput(createDelistInput({ listingRevision: value })));
    }
    for (const value of [-1, 1.5, 1_000_001, Number.MAX_SAFE_INTEGER + 1]) {
      expectInvalid(() =>
        assertPublishListingInput(createPublishInput({ draft: createValidDraft({ quantity: value }) })),
      );
      expectInvalid(() => assertUpdatePriceQuantityInput(createUpdateInput({ quantity: value })));
    }
  });

  it("rejects unknown fields recursively in every input shape", () => {
    expectInvalid(() =>
      assertPublishListingInput({
        ...createPublishInput(),
        extra: true,
      }),
    );
    expectInvalid(() =>
      assertPublishListingInput(
        createPublishInput({
          draft: { ...createValidDraft(), extra: true },
        }),
      ),
    );
    expectInvalid(() =>
      assertPublishListingInput(
        createPublishInput({
          draft: createValidDraft({ price: { amountMinor: 1, currency: "USD", extra: true } }),
        }),
      ),
    );
    expectInvalid(() =>
      assertPublishListingInput(
        createPublishInput({
          draft: createValidDraft({ attributes: [{ key: "fixture-key", value: "fixture-value", extra: true }] }),
        }),
      ),
    );
    expectInvalid(() => assertUpdatePriceQuantityInput({ ...createUpdateInput(), extra: true }));
    expectInvalid(() =>
      assertUpdatePriceQuantityInput({
        ...createUpdateInput(),
        price: { amountMinor: 1, currency: "USD", extra: true },
      }),
    );
    expectInvalid(() => assertDelistListingInput({ ...createDelistInput(), extra: true }));
  });

  it("accepts every closed result arm and rejects provider text, unknown codes, and bounded-field violations", () => {
    for (const code of channelPublicationRejectionCodes) {
      const result = { kind: "rejected", code } as const;
      expect(() => assertChannelPublicationResult(result)).not.toThrow();
      expect(disposition(code)).toBe(code);
    }
    const success = {
      kind: "succeeded",
      externalListingId: "l".repeat(512),
      externalOfferId: "o".repeat(512),
      providerRevision: "r".repeat(512),
    } as const;
    expect(() => assertChannelPublicationResult(success)).not.toThrow();

    for (const result of [
      { kind: "succeeded", externalListingId: "" },
      { kind: "succeeded", externalListingId: "l".repeat(513) },
      { kind: "succeeded", externalListingId: "fixture", externalOfferId: "" },
      { kind: "succeeded", externalListingId: "fixture", providerRevision: "r".repeat(513) },
      { kind: "succeeded", externalListingId: "fixture", message: "fixture provider text" },
      { kind: "rejected", code: "validation", message: "fixture provider text" },
      { kind: "rejected", code: "fixture-unknown-code" },
      { kind: "fixture-unknown-kind" },
      { kind: "succeeded", externalListingId: "fixture", externalOfferId: undefined },
    ]) {
      expectInvalid(() => assertChannelPublicationResult(result));
    }
  });
});

function expectInvalid(action: () => void): void {
  expect(action).toThrow(expect.objectContaining({ code: "invalid-input" }));
}

function disposition(code: ChannelPublicationRejectionCode): string {
  switch (code) {
    case "validation":
    case "authorization":
    case "rate-limited":
    case "provider-unavailable":
    case "conflict":
    case "not-found":
      return code;
    default:
      return assertNever(code);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled rejection code: ${String(value)}`);
}
