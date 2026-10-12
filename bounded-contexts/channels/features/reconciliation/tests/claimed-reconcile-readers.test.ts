import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { readPersistedClaimedState } from "../read-model/claimed";
import { accountSnapshotPair } from "../domain/pair-accounting";
import { syntheticLiveRow } from "./fixtures/material.test-data";
import { readRecordedTcgplayerSaleFacts } from "../../tcgplayer-orders/read-model/recorded-facts";
import { composeTcgplayerOrderObservation } from "../../tcgplayer-orders/domain/detail";
import { tcgplayerSaleKey } from "../../tcgplayer-orders/domain/contracts";
import { channelSaleFingerprint } from "../api/sale-recorder";
import { hashChannelDesiredState } from "../../listing-composition/domain/canonical";
import { retainDriftGeneration, decodeRetainedDriftGeneration } from "../domain/generation";
import { mapChannelDriftToHealthObservation } from "../domain/health";
import { reconciliationIsClean } from "../domain/settlement";

const previous = { ...syntheticLiveRow("10.00", 8) };
const current = { ...previous, snapshotId: "SYN-current", totalQuantity: 3 };
const from = "2026-09-10T00:00:00.000Z";
const to = "2026-09-12T04:00:00.000Z";
const order = composeTcgplayerOrderObservation("SYN-pull", {
  orderNumber: "SYN-order",
  createdAt: to,
  status: "ReadyToShip",
  products: [{ productId: 90000002, skuId: 90000001, quantity: 5, unitPrice: 10 }],
});
const line = order.lines[0]!;
const key = channelSaleFingerprint(tcgplayerSaleKey("account-1", "connection-1", order.orderNumber, line));
const committed = {
  sale_key_fingerprint: key,
  facts_fingerprint: hashChannelDesiredState({ ...line, soldAt: to, currencyCode: "USD" }),
};
function database(commits: unknown[] = [committed], records: unknown[] = [{ record: order }]) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("channel_order_lines")
      ? commits
      : records.map((row) => ({
          state: "completed",
          order_reference: null,
          ...(row as object),
        })),
  }));
  return { query } as unknown as PgQueryable;
}

function intervalDatabase(
  commits: (typeof committed)[],
  records: Array<{ record: typeof order; received_at: string; sequence: number }>,
) {
  return {
    query: vi.fn(async (sql: string, values: unknown[]) => ({
      rows: sql.includes("channel_order_lines")
        ? commits
            .filter((row) => !Array.isArray(values[1]) || (values[1] as string[]).includes(row.sale_key_fingerprint))
            .slice(0, Number(values.at(-1)))
        : records
            .filter((row) => typeof values[1] !== "string" || Date.parse(row.received_at) > Date.parse(values[1]))
            .sort((a, b) => a.received_at.localeCompare(b.received_at) || a.sequence - b.sequence)
            .slice(0, Number(values.at(-1))),
    })),
  } as unknown as PgQueryable;
}

describe("claimed-reconcile-missed-sale owned facts and pair accounting", () => {
  it.each(["replays", "commits", "conflict"])("F1 ignores pre-interval lifetime %s", async (history) => {
    const oldOrder = { ...order, soldAt: "2026-01-01T00:00:00Z" };
    const oldRecords = Array.from({ length: history === "replays" ? 5001 : 2 }, (_, sequence) => ({
      record: sequence === 1 && history === "conflict" ? { ...oldOrder, soldAt: "2026-01-02T00:00:00Z" } : oldOrder,
      received_at: "2026-01-03T00:00:00Z",
      sequence,
    }));
    const oldCommits =
      history === "commits"
        ? Array.from({ length: 5000 }, (_, index) => ({ ...committed, sale_key_fingerprint: `SYN-old-${index}` }))
        : [];
    const facts = await readRecordedTcgplayerSaleFacts(
      intervalDatabase([...oldCommits, committed], [...oldRecords, { record: order, received_at: to, sequence: 6000 }]),
      { connectionId: "connection-1", accountId: "account-1", from, to, maxLines: 5000 },
    );
    expect(facts).toEqual({ kind: "known", quantities: [{ skuId: "90000001", quantity: 5 }] });
    expect(accountSnapshotPair([previous], [current], facts)).toEqual({ kind: "known", drops: [] });
  });
  it("F1 still refuses capped in-window replays", async () => {
    const facts = await readRecordedTcgplayerSaleFacts(
      intervalDatabase(
        [committed],
        Array.from({ length: 5001 }, (_, sequence) => ({ record: order, received_at: to, sequence })),
      ),
      { connectionId: "connection-1", accountId: "account-1", from, to, maxLines: 5000 },
    );
    expect(facts).toEqual({ kind: "unknown" });
  });
  it("uses original soldAt and requested quantities, deduplicated across replay, not receipt/applied quantities", async () => {
    const facts = await readRecordedTcgplayerSaleFacts(database([committed], [{ record: order }, { record: order }]), {
      connectionId: "connection-1",
      accountId: "account-1",
      from,
      to,
      maxLines: 10,
    });
    expect(facts).toEqual({ kind: "known", quantities: [{ skuId: "90000001", quantity: 5 }] });
    expect(accountSnapshotPair([previous], [current], facts)).toEqual({ kind: "known", drops: [] });
  });
  it("uses the full pair interval with an open lower and closed upper bound", async () => {
    const read = (start: string, end: string) =>
      readRecordedTcgplayerSaleFacts(database(), {
        connectionId: "connection-1",
        accountId: "account-1",
        from: start,
        to: end,
        maxLines: 10,
      });
    expect(await read(from, to)).toMatchObject({ quantities: [{ quantity: 5 }] });
    expect(await read(to, "2026-09-13T00:00:00Z")).toEqual({ kind: "known", quantities: [] });
  });
  it.each(["missing", "conflicting", "expired", "cap", "cross-connection"])(
    "fails closed on %s facts",
    async (failure) => {
      const records =
        failure === "missing"
          ? [{ record: null, order_reference: order.orderNumber }]
          : failure === "expired"
            ? [{ record: null, state: "expired", order_reference: order.orderNumber }]
            : failure === "conflicting"
              ? [{ record: order }, { record: { ...order, lines: [{ ...line, quantity: 6 }] } }]
              : [{ record: order }];
      const facts = await readRecordedTcgplayerSaleFacts(
        database(failure === "cap" ? [committed, committed] : [committed], records),
        {
          connectionId: failure === "cross-connection" ? "another-connection" : "connection-1",
          accountId: "account-1",
          from,
          to,
          maxLines: failure === "cap" ? 1 : 10,
        },
      );
      expect(facts.kind).toBe("unknown");
    },
  );
  it("uncommitted lines supply no quantity and pending delta never explains a drop", async () => {
    const facts = await readRecordedTcgplayerSaleFacts(database([], [{ record: order }]), {
      connectionId: "connection-1",
      accountId: "account-1",
      from,
      to,
      maxLines: 10,
    });
    expect(accountSnapshotPair([previous], [{ ...current, pendingQuantityDelta: -5 }], facts)).toEqual({
      kind: "known",
      drops: [{ identity: "tcgplayer:16:product:90000001:9:Near Mint", quantity: 5 }],
    });
  });
  it("uncommitted order errors are not reconciliation facts or connection failures", async () => {
    const read = (db: PgQueryable) =>
      readRecordedTcgplayerSaleFacts(db, {
        connectionId: "connection-1",
        accountId: "account-1",
        from,
        to,
        maxLines: 10,
      });
    expect(await read(database([], [{ record: { kind: "invalid-order" } }]))).toEqual({
      kind: "known",
      quantities: [],
    });
    expect(await read(database([committed], [{ record: order }, { record: { kind: "invalid-order" } }]))).toEqual({
      kind: "known",
      quantities: [{ skuId: "90000001", quantity: 5 }],
    });
  });
  it("no first/absent drop; surplus quantities and ambiguous SKU conditions do not invent drift", () => {
    expect(accountSnapshotPair([], [current], { kind: "known", quantities: [] })).toEqual({ kind: "known", drops: [] });
    expect(accountSnapshotPair([previous], [], { kind: "known", quantities: [] })).toEqual({
      kind: "known",
      drops: [],
    });
    expect(
      accountSnapshotPair([previous], [current], { kind: "known", quantities: [{ skuId: "90000001", quantity: 9 }] }),
    ).toEqual({ kind: "known", drops: [] });
    expect(
      accountSnapshotPair([previous, { ...previous, conditionText: "Lightly Played" }], [current], {
        kind: "known",
        quantities: [{ skuId: "90000001", quantity: 5 }],
      }).kind,
    ).toBe("unknown");
  });
});

describe("claimed-reconcile-production-day-after", () => {
  it("missing bound snapshots never reads a moving latest row or treats absence as zero", async () => {
    const db = database();
    const source = await readPersistedClaimedState(db, {
      connectionId: "connection-1",
      snapshots: [],
      freshness: "unknown",
      maxListings: 10,
    });
    expect(source.sourceAuthority.kind).toBe("declared-incomplete");
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("claimed-reconcile-fallback-b", () => {
  it("clean-on-equality prohibition is independent of every other clean input; inline complete-sales stays positive", () => {
    for (const salesAuthorityComplete of [false, true]) {
      expect(reconciliationIsClean({ listingOnly: true, listingSettled: true, salesAuthorityComplete })).toBe(false);
    }
    expect(reconciliationIsClean({ listingOnly: false, listingSettled: true, salesAuthorityComplete: true })).toBe(
      true,
    );
    expect(reconciliationIsClean({ listingOnly: false, listingSettled: true, salesAuthorityComplete: false })).toBe(
      false,
    );
  });
  it("sales coverage never remains a member or blocks listing-settled closure, even after restart", () => {
    expect(
      retainDriftGeneration(
        null,
        [
          {
            identity: "source:sales",
            kind: "source-unavailable",
            expectedFingerprint: null,
            observedFingerprint: null,
            settlement: "open",
            decisionRevision: 0,
            recoveryRequested: false,
          },
        ],
        true,
        true,
      ),
    ).toBeNull();
    const previous = retainDriftGeneration(
      null,
      [
        {
          identity: "source:sales",
          kind: "source-unavailable",
          expectedFingerprint: null,
          observedFingerprint: null,
          settlement: "open",
          decisionRevision: 0,
          recoveryRequested: false,
        },
      ],
      false,
    )!;
    const resolved = retainDriftGeneration(previous, [], true, true)!;
    expect(resolved.members).toEqual([]);
    expect(resolved.resolution).toBe("recovered-automatically");
    expect(resolved.generation).toBe(previous.generation);
    expect(decodeRetainedDriftGeneration(resolved)).toEqual(resolved);
    expect(retainDriftGeneration(resolved, [], true, true)).toEqual(resolved);
  });
  it("listing-settled means drift-health success, not connection in-sync authority", () => {
    const input = {
      connectionId: "connection-1",
      runGeneration: 1,
      sourceAttempt: 1,
      resultOrdinal: 1,
      policyRevision: "a".repeat(64),
      evaluationGeneration: 1,
      classification: "source-unavailable" as const,
      sourceAuthority: { kind: "present-rows" as const, collectedCount: 1, snapshotRowTotal: 1 },
      materialFingerprint: "b".repeat(64),
      occurredAt: to,
    };
    expect(mapChannelDriftToHealthObservation({ ...input, listingSettled: true })?.outcome).toBe("success");
    expect(mapChannelDriftToHealthObservation({ ...input, listingSettled: false })?.outcome).toBe("failure");
    expect(mapChannelDriftToHealthObservation({ ...input, classification: "in-sync" })?.outcome).toBe("success");
  });
});
