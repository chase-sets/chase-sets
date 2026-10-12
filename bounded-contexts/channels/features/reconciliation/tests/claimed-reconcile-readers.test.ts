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
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("channel_order_lines") ? commits : records }));
  return { query } as unknown as PgQueryable;
}

describe("claimed-reconcile-missed-sale owned facts and pair accounting", () => {
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
          ? []
          : failure === "expired"
            ? [{ record: null }]
            : failure === "conflicting"
              ? [{ record: order }, { record: { ...order, soldAt: from } }]
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
