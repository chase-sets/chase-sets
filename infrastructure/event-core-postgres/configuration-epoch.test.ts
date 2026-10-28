import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ConfigurationEpochGrant } from "@chase-sets/event-core/configuration-epoch";
import { validateConfigurationGrantVectorInTransaction } from "./configuration-epoch";
import type { PgQueryable } from "./types";

const grant: ConfigurationEpochGrant = {
  key: "owner/key",
  sourceIncarnation: "source-1",
  keyCreationEpoch: 3,
  epoch: 3,
  consumer: { storeId: "consumer", incarnation: "consumer-1" },
  topologyRevision: 1,
};
const empty = {
  isolation: "read committed",
  held: true,
  identities: [{ store_id: "consumer", incarnation: "consumer-1" }],
  heads: [],
  records: [],
  now: "2026-01-01T00:00:00Z",
};

describe("consumer-local configuration validation read envelope", () => {
  it("validates the maximum 32-key vector in one read per key", async () => {
    const query = vi.fn<PgQueryable["query"]>().mockResolvedValue({ rows: [empty] });
    const grants = Array.from({ length: 32 }, (_, index) => ({ ...grant, key: `owner/${index}` }));
    await validateConfigurationGrantVectorInTransaction({ query }, grants);
    expect(query).toHaveBeenCalledTimes(32);
    expect(query.mock.calls.every(([, values]) => values?.length === 1)).toBe(true);
  });

  it.each([
    ["missing lock", { held: false }, "held guard lock"],
    ["old snapshot", { isolation: "repeatable read" }, "READ COMMITTED"],
    ["old incarnation", { identities: [{ store_id: "consumer", incarnation: "old" }] }, "incarnation"],
    ["missing identity", { identities: [] }, "incarnation"],
    ["partial history", { heads: [{ sequence: "1", digest: "bad" }] }, "partial journal"],
    ["invalid clock", { now: "invalid" }, "clock"],
  ])("refuses %s in the same consumer-local read", async (_name, state, message) => {
    const query = vi.fn<PgQueryable["query"]>().mockResolvedValue({ rows: [{ ...empty, ...state }] });
    await expect(validateConfigurationGrantVectorInTransaction({ query }, [grant])).rejects.toThrow(message);
    expect(query).toHaveBeenCalledOnce();
  });

  it("replays the canonical closed-through journal instead of admitting an old epoch", async () => {
    const record = {
      kind: "CLOSED_THROUGH",
      guard: { sourceIncarnation: "source-1", keyCreationEpoch: 3, closedThroughEpoch: 3, topologyRevision: 1 },
    };
    const digest = createHash("sha256").update("0".repeat(64)).update(JSON.stringify(record)).digest("hex");
    const query = vi.fn<PgQueryable["query"]>().mockResolvedValue({
      rows: [{ ...empty, heads: [{ sequence: "1", digest }], records: [{ sequence: "1", digest, record }] }],
    });
    await expect(validateConfigurationGrantVectorInTransaction({ query }, [grant])).rejects.toThrow("closed-through");
    await expect(
      validateConfigurationGrantVectorInTransaction({ query }, [{ ...grant, epoch: 4 }]),
    ).resolves.toBeUndefined();
  });
});
