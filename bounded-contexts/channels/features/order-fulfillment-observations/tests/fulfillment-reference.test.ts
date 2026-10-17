import { createHash } from "node:crypto";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { composeChannelOrderFulfillmentReference as browserCompose } from "@chase-sets/channels/client";
import { composeChannelOrderFulfillmentReference as serverCompose } from "@chase-sets/channels/server";
import { assertConnectorInbound } from "../../connector-feed/domain/transport";
import { connectorPolicyDefaults } from "../../connector-feed/domain/policy";
import { admitConnectorInbound } from "../../connector-feed/read-model/inbound";

// Synthetic internal encoding vectors, not evidence of provider revision guarantees.
const vectors = [
  {
    name: "synthetic-ascii",
    order: "synthetic-order-8609",
    revision: "synthetic-revision-1",
    canonical: '["channel-order-fulfillment/v1","synthetic-order-8609","synthetic-revision-1"]',
    reference: "tcf.v1:aa40b9bacff65b8acdf8b3212b43ba2a7a0c6ce514fe7d0c84c6278d9d0fc811",
  },
  {
    name: "synthetic-unicode",
    order: "synthetic-\u6ce8\u6587-\u96ea",
    revision: "r\u00e9vision-\ud83d\ude00",
    canonical: '["channel-order-fulfillment/v1","synthetic-\u6ce8\u6587-\u96ea","r\u00e9vision-\ud83d\ude00"]',
    reference: "tcf.v1:8867653ae6f8ed039b60c1b7b60d4f7968e7b6f1e5e5fbe0bea12219bc28af7b",
  },
  {
    name: "synthetic-exact",
    order: " Synthetic-Order ",
    revision: "Revision:A",
    canonical: '["channel-order-fulfillment/v1"," Synthetic-Order ","Revision:A"]',
    reference: "tcf.v1:7b0623ccacac86dd33898c9e16bf484a45f474e77595cb267cbada3d48809e98",
  },
  {
    name: "synthetic-escaping",
    order: 'synthetic-"order\\line',
    revision: "revision\n2",
    canonical: '["channel-order-fulfillment/v1","synthetic-\\"order\\\\line","revision\\n2"]',
    reference: "tcf.v1:874279f5fb56c80e3ad9f38cf79c268175e7dcbf0b7db3e0cbf422e3b17ffbe9",
  },
];

afterEach(() => vi.unstubAllGlobals());

describe("channel-order-fulfillment-reference-bytes", () => {
  it.each(vectors)("pins browser/server bytes for $name", async ({ order, revision, canonical, reference }) => {
    expect(`tcf.v1:${createHash("sha256").update(canonical, "utf8").digest("hex")}`).toBe(reference);
    expect(await serverCompose(order, revision)).toBe(reference);
    // The browser entrypoint must need only WebCrypto/TextEncoder, not Node globals.
    vi.stubGlobal("Buffer", undefined);
    expect(await browserCompose(order, revision)).toBe(reference);
    expect(reference).toMatch(/^tcf\.v1:[a-f0-9]{64}$/);
    expect(() =>
      assertConnectorInbound(
        { inboundKind: "order", externalReference: reference, payload: { version: 1, records: [{}] } },
        connectorPolicyDefaults,
      ),
    ).not.toThrow();
  });

  it("distinguishes raw tuple, bare order and pull-qualified sale wire spellings", async () => {
    const { order, revision, canonical, reference } = vectors[0]!;
    expect(await browserCompose(order, revision)).toBe(reference);
    for (const wrong of [canonical, order, `${order}:synthetic-pull-1`]) {
      expect(wrong).not.toMatch(/^tcf\.v1:[a-f0-9]{64}$/);
      expect(wrong).not.toBe(reference);
    }
    // Generic transport admits other kinds of order reference; only the raw tuple violates its grammar.
    expect(() =>
      assertConnectorInbound(
        { inboundKind: "order", externalReference: canonical, payload: { version: 1, records: [{}] } },
        connectorPolicyDefaults,
      ),
    ).toThrow();
  });

  it("refuses empty and non-string arguments without coercing nested values", async () => {
    for (const invalid of ["", null, undefined, 1, true, [], {}, { revision: { at: "2026-10-08" } }]) {
      await expect(Reflect.apply(browserCompose, undefined, [invalid, "synthetic-revision"])).rejects.toThrow(
        "externalOrderReference must be a nonempty string.",
      );
      await expect(Reflect.apply(serverCompose, undefined, ["synthetic-order", invalid])).rejects.toThrow(
        "providerObservedRevisionOrDigest must be a nonempty string.",
      );
    }
  });

  it("preserves case, whitespace, Unicode spelling and tuple order", async () => {
    const reference = await browserCompose(" Order-\u00e9 ", "Revision-A");
    for (const [order, revision] of [
      ["Order-\u00e9", "Revision-A"],
      [" order-\u00e9 ", "Revision-A"],
      [" Order-e\u0301 ", "Revision-A"],
      [" Order-\u00e9 ", "revision-a"],
      ["Revision-A", " Order-\u00e9 "],
    ] as const) {
      expect(await browserCompose(order, revision)).not.toBe(reference);
    }
  });
});

describe("channel-order-fulfillment-reference-revision", () => {
  it("keeps a supplied revision across pulls and distinguishes changed status/content/variant digests", async () => {
    // Opaque synthetic digest inputs: #7795, not this codec, owns observation normalization and hashing.
    const pulls = [
      { pullId: "synthetic-pull-1", capturedAt: "2026-10-08T10:00:00Z", digest: "synthetic-full-unshipped-lines-a" },
      { pullId: "synthetic-pull-2", capturedAt: "2026-10-08T11:00:00Z", digest: "synthetic-full-unshipped-lines-a" },
    ];
    const first = await browserCompose("synthetic-order", pulls[0]!.digest);
    expect(await serverCompose("synthetic-order", pulls[1]!.digest)).toBe(first);
    for (const changedDigest of [
      "synthetic-full-shipped-lines-a",
      "synthetic-full-unshipped-lines-b",
      "synthetic-status-only-unshipped",
    ]) {
      expect(await serverCompose("synthetic-order", changedDigest)).not.toBe(first);
    }
    const pullQualifiedMutant = (pull: (typeof pulls)[number]) =>
      browserCompose("synthetic-order", `${pull.digest}:${pull.pullId}`);
    expect(await pullQualifiedMutant(pulls[0]!)).not.toBe(first);
    expect(await pullQualifiedMutant(pulls[1]!)).not.toBe(await pullQualifiedMutant(pulls[0]!));
  });

  it("passes the composed reference into the existing connection/kind admission key unchanged", async () => {
    const reference = await browserCompose("synthetic-order", "synthetic-revision");
    for (const connectionId of ["synthetic-connection-a", "synthetic-connection-b"]) {
      const query = vi
        .fn<PgQueryable["query"]>()
        .mockResolvedValue({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await admitConnectorInbound(
        { query },
        connectionId,
        { inboundKind: "order", externalReference: reference, payload: { version: 1, records: [{}] } },
        "2026-10-08T10:00:00Z",
      );
      const key = JSON.stringify([connectionId, "order", reference]);
      expect(query.mock.calls[1]?.[1]).toEqual([key]);
      expect(query.mock.calls[2]?.[1]).toEqual([key, "channel-connector", "order", reference, "2026-10-08T10:00:00Z"]);
    }
  });
});

it("channel-order-fulfillment-reference-callers: exports one typed implementation through both public entrypoints", () => {
  expect(browserCompose).toBe(serverCompose);
  expectTypeOf(browserCompose).parameters.toEqualTypeOf<[string, string]>();
  expectTypeOf(browserCompose).returns.toEqualTypeOf<Promise<string>>();
  expectTypeOf(serverCompose).toEqualTypeOf<typeof browserCompose>();
});
