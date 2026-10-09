import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import { module as channelsModule } from "../../../index";
import { channelProviderRegistry } from "../../publication-port/api/registry";
import type { ConnectorTransportServices } from "../../connector-feed/api/transport";
import { connectorPolicyDefaults } from "../../connector-feed/domain/policy";
import {
  describeDb,
  target,
  transportContext,
  transportDatabase,
} from "../../connector-feed/tests/transport-test-support";
import { createOutboundSyncRuntime } from "../api/runtime";
import type {
  ClaimedOperationOutcome,
  ClaimedOperationReservation,
  ClaimedOrderPullOperation,
  ClaimedSubjectOperation,
  ClaimedOutboundOperation,
} from "../domain/contracts";
import { deriveOrderPullId, orderPullFitsLease, type ClaimedOrderPullOutcome } from "../domain/order-pull";
import { outboundSyncSchemaMigrations } from "../read-model/schema";
import { syntheticAuthority, syntheticPage, syntheticPayload, syntheticProgress } from "./order-pull-fixtures";
import { advanceOrderPullTraversal } from "../domain/order-pull-progress";
import { orderPullProviderReady } from "../domain/order-pull";
import {
  composeChannelOrderFulfillmentInbound,
  type ChannelOrderFulfillmentObservation,
} from "../../order-fulfillment-observations/domain/contracts";
import { readAcceptedReadyToShipMembership } from "../../order-fulfillment-observations/api/runtime";
import { seedOrderPullSale } from "./order-pull-owner-fixtures";
import * as ownerReader from "../../order-fulfillment-observations/api/runtime";
import * as pullCoordinator from "../api/order-pull";
import { readOrderPullWork } from "../api/order-pull-progress";

const capable = { capabilities: ["tcgplayer-order-pull"] };
const startedAt = Date.parse("2026-10-07T12:00:00.000Z");

let authority: unknown = syntheticAuthority;
let held = false;
let heldConnections = new Set<string>();

describeDb("order-pull-scheduler-and-claim / order-pull-subject-feed-contract", () => {
  const h = transportDatabase("order_pull_8610", {
    resolveTcgplayerOrderPullAuthority: async () => authority,
    readChannelHealthHold: async (connectionId) => held || heldConnections.has(connectionId),
  });
  beforeEach(() => {
    authority = syntheticAuthority;
    held = false;
    heldConnections = new Set();
  });
  const tick = () => h.services.outboundSync.scheduleDueOrderPulls({ registry: channelProviderRegistry });
  const at = (offsetMs: number) => vi.setSystemTime(new Date(startedAt + offsetMs));
  async function pullState() {
    return {
      operations: (
        await h.db.query("SELECT row_to_json(t) AS row FROM channel_order_pull_operations t ORDER BY operation_id")
      ).rows,
      schedules: (
        await h.db.query("SELECT row_to_json(t) AS row FROM channel_order_pull_schedules t ORDER BY connection_id")
      ).rows,
    };
  }
  async function claim(body: unknown = capable) {
    const response = await h.request("claim", body);
    expect(response.status).toBe(200);
    const value: Awaited<ReturnType<ConnectorTransportServices["claim"]>> = await response.json();
    return value.reservation;
  }
  function pullMember(reservation: ClaimedOperationReservation<ClaimedSubjectOperation> | null) {
    const member = reservation?.operations.find(
      (operation): operation is ClaimedOrderPullOperation => operation.operationKind === "tcgplayer-order-pull",
    );
    if (!member) throw new Error("missing-pull-member");
    return member;
  }
  function pullReport(
    member: ClaimedOrderPullOperation,
    outcome: ClaimedOrderPullOutcome["outcome"],
  ): ClaimedOrderPullOutcome {
    return {
      operationKind: member.operationKind,
      operationId: member.operationId,
      attemptId: member.attemptId,
      claimGeneration: member.claimGeneration,
      pullId: member.pullId,
      payloadDigest: member.payloadDigest,
      outcome,
    };
  }
  function complete(
    member: ClaimedOrderPullOperation,
  ): Exclude<ClaimedOrderPullOutcome["outcome"], { kind: "order-pull-unknown" | "abandoned" }> {
    return {
      kind: "order-pull-complete",
      lawVersion: member.payload.lawVersion,
      selector: member.payload.selector,
      admissionCounts: { readyToShipMembers: 0, followUpReads: 0, admitted: 0 },
      progress: syntheticProgress(member.payload),
    };
  }
  function listingReport(operation: ClaimedOutboundOperation): ClaimedOperationOutcome {
    return {
      operationId: operation.operationId,
      attemptId: operation.attemptId,
      claimGeneration: operation.claimGeneration,
      desiredStateSequence: operation.desiredStateSequence,
      outcome: { kind: "applied", result: { kind: "succeeded", externalListingId: `external_${operation.listingId}` } },
    };
  }
  async function settlePull() {
    const reservation = await claim();
    const member = pullMember(reservation);
    const response = await h.request("report", {
      reservationId: reservation!.reservationId,
      outcomes: [pullReport(member, complete(member))],
    });
    expect(response.status).toBe(200);
  }
  it("connector-settlement-refusal-replay: pull plus settlement refuses, then unbound pull settles without one", async () => {
    await tick();
    const reservation = await claim();
    const member = pullMember(reservation);
    const body = { reservationId: reservation!.reservationId, outcomes: [pullReport(member, complete(member))] };
    const before = await pullState();
    const refused = await h.request("report", {
      ...body,
      runSettlement: {
        runId: "not-a-pull-run",
        expectedRunRevision: 0,
        fromState: "composed",
        toState: "abandoned",
        verificationSnapshotId: null,
        verificationSnapshotGeneration: null,
        uploadAttemptedAt: null,
        uploadFileName: null,
        importSummary: null,
      },
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ code: "report-refused", reason: "invalid-input" });
    expect(await pullState()).toEqual(before);
    expect((await h.request("report", body)).status).toBe(200);
    const settled = await pullState();
    expect((await h.request("report", body)).status).toBe(200);
    expect(await pullState()).toEqual(settled);
  });
  async function schedule(connectionId = target.connectionId) {
    const result = await h.db.query<{
      generation: string;
      next_due_at: Date | string;
      last_scheduled_at: Date | string;
    }>("SELECT generation, next_due_at, last_scheduled_at FROM channel_order_pull_schedules WHERE connection_id=$1", [
      connectionId,
    ]);
    const row = result.rows[0]!;
    // Offsets from the fixture start keep the cadence-grid assertions readable.
    return {
      generation: Number(row.generation),
      nextDueAt: new Date(row.next_due_at).getTime() - startedAt,
      lastScheduledAt: new Date(row.last_scheduled_at).getTime() - startedAt,
    };
  }
  async function listingEffects() {
    const effects = await h.effects();
    return {
      links: effects.e1.channels_channel_listing_links,
      events: effects.e1.event_store_events,
      lanes: effects.e1.channel_outbound_lanes,
      operations: effects.e1.channel_outbound_operations,
    };
  }

  async function admitOwner(observation: ChannelOrderFulfillmentObservation, accept = true) {
    const response = await h.request("ingest", await composeChannelOrderFulfillmentInbound(observation));
    expect(response.status).toBe(202);
    if (accept) await h.services.fulfillmentObservations.interpretConnection(target.connectionId);
  }

  it("AC3/4 discovery commits exactly one claimable successor; report/claim loss, pause and restart preserve it", async () => {
    await tick();
    const firstReservation = await claim();
    const first = pullMember(firstReservation);
    const body = {
      reservationId: firstReservation!.reservationId,
      outcomes: [
        pullReport(first, {
          ...complete(first),
          kind: "continuation-required",
          progress: syntheticProgress(first.payload, { pages: [syntheticPage(["ORDER-A", "ORDER-B"])] }),
        }),
      ],
    };
    const results = await Promise.all([h.request("report", body), h.request("report", body)]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    const committed = await pullState();
    h.restart();
    expect((await h.request("report", body)).status).toBe(200);
    expect(await pullState()).toEqual(committed);
    expect(await tick()).toBe(0);
    const operations = await h.services.outboundSync.readOrderPullOperations(target);
    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({
      status: "pending",
      payload: {
        checkpoint: {
          burstId: first.payload.checkpoint.burstId,
          traversal: { exhausted: true, discovered: 2 },
          drained: false,
        },
        predecessor: {
          operationId: first.operationId,
          attemptId: first.attemptId,
          claimGeneration: first.claimGeneration,
        },
        work: { references: ["ORDER-A", "ORDER-B"], acceptedReferences: [] },
      },
    });
    await h.pause();
    expect(await claim()).toBeNull();
    await h.services.connections.resumeChannelConnection(target, transportContext);
    await h.projectConnection();
    const secondReservation = await claim(); // SAME commit instant; no 60-second wait.
    const second = pullMember(secondReservation);
    expect(second.operationId).toBe(operations[0]!.operationId);
    expect(orderPullProviderReady(second.payload, new Date().toISOString())).toBe(false);
    expect(orderPullProviderReady(second.payload, new Date(startedAt + 10_000).toISOString())).toBe(true);
    // Lost claim response: recover the same successor, with fresh lease/generation, never another row.
    at(1_800_001);
    await h.services.outboundSync.recoverExpiredClaimedOperations();
    h.restart();
    const recovered = pullMember(await claim());
    expect(recovered).toMatchObject({ operationId: second.operationId, pullId: second.pullId, claimGeneration: 2 });
    const stale = await h.request("report", {
      reservationId: secondReservation!.reservationId,
      outcomes: [pullReport(second, { kind: "order-pull-unknown", reason: "session-lost" })],
    });
    expect(stale.status).toBe(409);
    expect(await h.services.outboundSync.readOrderPullOperations(target)).toHaveLength(2);
  });

  it("AC3 owner-only membership refreshes at claim; 202/partial/foreign facts never count and latest non-RTS removes it", async () => {
    const observation = await seedOrderPullSale(h.db, target.connectionId, target.accountId, "ORDER-A");
    await admitOwner(observation, false);
    expect(
      await readAcceptedReadyToShipMembership(h.db, {
        connectionId: target.connectionId,
        orderReferences: ["ORDER-A"],
      }),
    ).toEqual([]);
    await tick();
    const reservation = await claim();
    const first = pullMember(reservation);
    expect(
      (
        await h.request("report", {
          reservationId: reservation!.reservationId,
          outcomes: [
            pullReport(first, {
              ...complete(first),
              kind: "continuation-required",
              progress: syntheticProgress(first.payload, { pages: [syntheticPage(["ORDER-A", "ORDER-B"])] }),
            }),
          ],
        })
      ).status,
    ).toBe(200);
    await h.services.fulfillmentObservations.interpretConnection(target.connectionId);
    expect(
      await readAcceptedReadyToShipMembership(h.db, {
        connectionId: target.connectionId,
        orderReferences: ["ORDER-A", "ORDER-B"],
      }),
    ).toEqual(["ORDER-A"]);
    expect(
      await readAcceptedReadyToShipMembership(h.db, { connectionId: "foreign", orderReferences: ["ORDER-A"] }),
    ).toEqual([]);
    const positive = await readOrderPullWork(h.db, target.connectionId, first.payload.checkpoint.burstId);
    expect(positive.acceptedReferences).toEqual(["ORDER-A"]);
    const omitted = vi.spyOn(ownerReader, "readAcceptedReadyToShipMembership").mockResolvedValue([]);
    try {
      const sourceOmission = await readOrderPullWork(h.db, target.connectionId, first.payload.checkpoint.burstId);
      expect(sourceOmission.acceptedReferences).toEqual([]);
      expect(sourceOmission.acceptedReferences).not.toEqual(positive.acceptedReferences);
    } finally {
      omitted.mockRestore();
    }
    const scheduledDigest = (await h.services.outboundSync.readOrderPullOperations(target))[0]!.payloadDigest;
    const secondReservation = await claim();
    const second = pullMember(secondReservation);
    expect(second.payload.work.acceptedReferences).toEqual(["ORDER-A"]);
    expect(second.payloadDigest).not.toBe(scheduledDigest);
    expect(
      (
        await h.request("report", {
          reservationId: secondReservation!.reservationId,
          outcomes: [pullReport(second, { kind: "abandoned", reason: "released" })],
        })
      ).status,
    ).toBe(200);
    await admitOwner({
      version: 1,
      variant: "status-only",
      providerKey: "tcgplayer",
      externalOrderReference: "ORDER-A",
      providerOrderStatus: { surface: "list", value: "Shipped - In Transit" },
      revision: "synthetic-shipped",
    });
    h.restart();
    const third = pullMember(await claim());
    expect(third.operationId).toBe(second.operationId);
    expect(third.payload.work.acceptedReferences).toEqual([]);
    expect(third.payloadDigest).not.toBe(second.payloadDigest);
  });

  it("AC4 owner-delayed posts remain pending at idle cadence, never falsely complete or mint no-progress successors", async () => {
    const observation = await seedOrderPullSale(h.db, target.connectionId, target.accountId, "ORDER-PENDING");
    await admitOwner(observation, false);
    await tick();
    const reservation = await claim();
    const first = pullMember(reservation);
    const outcome = {
      ...complete(first),
      kind: "order-pull-pending" as const,
      admissionCounts: { readyToShipMembers: 1, followUpReads: 0, admitted: 1 },
      progress: syntheticProgress(first.payload, {
        pages: [syntheticPage(["ORDER-PENDING"])],
        postedReferences: ["ORDER-PENDING"],
      }),
    };
    expect(
      (
        await h.request("report", {
          reservationId: reservation!.reservationId,
          outcomes: [pullReport(first, { ...outcome, kind: "order-pull-complete" })],
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.request("report", { reservationId: reservation!.reservationId, outcomes: [pullReport(first, outcome)] }))
        .status,
    ).toBe(200);
    expect(await claim()).toBeNull();
    expect(await tick()).toBe(0);
    at(60_000);
    h.restart();
    expect(await tick()).toBe(1);
    const recheckReservation = await claim();
    const recheck = pullMember(recheckReservation);
    expect(recheck.payload.work).toMatchObject({
      references: ["ORDER-PENDING"],
      postedReferences: ["ORDER-PENDING"],
      acceptedReferences: [],
    });
    expect(recheck.payload.checkpoint.drained).toBe(false);
    // Acceptance races a conservative pending report. Exact-byte retries still succeed, with no spurious continuation.
    await h.services.fulfillmentObservations.interpretConnection(target.connectionId);
    const body = {
      reservationId: recheckReservation!.reservationId,
      outcomes: [
        pullReport(recheck, {
          ...complete(recheck),
          kind: "order-pull-pending",
          progress: syntheticProgress(recheck.payload, { pages: [] }),
        }),
      ],
    };
    expect((await h.request("report", body)).status).toBe(200);
    expect((await h.request("report", body)).status).toBe(200);
    expect(await claim()).toBeNull();
    const operations = await h.services.outboundSync.readOrderPullOperations(target);
    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({ status: "succeeded", outcome: { kind: "order-pull-complete" } });
  });

  it("AC3 checkpoint/chunk/successor roll back on a losing generation, then report-only recovery commits once", async () => {
    await tick();
    const reservation = await claim();
    const first = pullMember(reservation);
    const body = {
      reservationId: reservation!.reservationId,
      outcomes: [
        pullReport(first, {
          ...complete(first),
          kind: "continuation-required",
          progress: syntheticProgress(first.payload, { pages: [syntheticPage(["TAIL"])] }),
        }),
      ],
    };
    // Synthetic concurrent-newer-write control; it does not fabricate an accepted owner fact.
    await h.db.query("UPDATE channel_order_pull_schedules SET generation=generation+1 WHERE connection_id=$1", [
      target.connectionId,
    ]);
    const before = await pullState();
    expect((await h.request("report", body)).status).toBe(409);
    expect(await pullState()).toEqual(before);
    expect((await h.db.query("SELECT chunk_id FROM channel_order_pull_chunks")).rows).toEqual([]);
    await h.db.query("UPDATE channel_order_pull_schedules SET generation=generation-1 WHERE connection_id=$1", [
      target.connectionId,
    ]);
    await h.db.query(`CREATE FUNCTION synthetic_refuse_successor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.schedule_generation > 1 THEN RAISE EXCEPTION 'synthetic crash before successor commit'; END IF; RETURN NEW; END $$`);
    await h.db.query(
      "CREATE TRIGGER synthetic_successor_crash BEFORE INSERT ON channel_order_pull_operations FOR EACH ROW EXECUTE FUNCTION synthetic_refuse_successor()",
    );
    expect((await h.request("report", body)).status).toBe(503);
    expect((await h.db.query("SELECT chunk_id FROM channel_order_pull_chunks")).rows).toEqual([]);
    expect(await h.services.outboundSync.readOrderPullOperations(target)).toHaveLength(1);
    await h.db.query("DROP TRIGGER synthetic_successor_crash ON channel_order_pull_operations");
    h.restart();
    expect((await h.request("report", body)).status).toBe(200);
    expect(await h.services.outboundSync.readOrderPullOperations(target)).toHaveLength(2);
  });

  it("AC2/3 largest bounded chunk reaches claim without truncation; cap+1, bytes, cursor and cross-page duplicates refuse", async () => {
    authority = { ...syntheticAuthority, selector: { ...syntheticAuthority.selector, pageSize: 1000 } };
    await tick();
    const reservation = await claim();
    const first = pullMember(reservation);
    const references = Array.from({ length: 1000 }, (_, i) => `ORDER-${i}`);
    const page = syntheticPage(references, { totalOrders: 1001, nextCursor: "tail" });
    const outcome = {
      ...complete(first),
      kind: "continuation-required" as const,
      progress: syntheticProgress(first.payload, { pages: [page] }),
    };
    const before = await pullState();
    for (const progress of [
      { ...outcome.progress, previousDigest: "0".repeat(64) },
      { ...outcome.progress, pages: [{ ...page, orderReferences: [...references, "EXTRA"] }] },
      {
        ...outcome.progress,
        pages: [{ ...page, orderReferences: references.map((ref) => ref + "\u4e00".repeat(110)) }],
      },
      { ...outcome.progress, pages: [{ ...page, orderReferences: ["duplicate", "duplicate"] }] },
      { ...outcome.progress, pages: [{ ...page, cursor: "wrong" }] },
    ]) {
      expect(
        (
          await h.request("report", {
            reservationId: reservation!.reservationId,
            outcomes: [pullReport(first, { ...outcome, progress })],
          })
        ).status,
      ).toBe(400);
      expect(await pullState()).toEqual(before);
    }
    expect(
      (await h.request("report", { reservationId: reservation!.reservationId, outcomes: [pullReport(first, outcome)] }))
        .status,
    ).toBe(200);
    const secondReservation = await claim();
    const second = pullMember(secondReservation);
    expect(second.payload.work.references).toEqual(references);
    expect(second.payload.work.acceptedReferences).toEqual([]);
    const committed = await pullState();
    expect(
      (
        await h.request("report", {
          reservationId: secondReservation!.reservationId,
          outcomes: [
            pullReport(second, {
              ...complete(second),
              kind: "continuation-required",
              progress: syntheticProgress(second.payload, {
                pages: [syntheticPage([references[0]!], { cursor: "tail", totalOrders: 1001 })],
              }),
            }),
          ],
        })
      ).status,
    ).toBe(400);
    expect(await pullState()).toEqual(committed);
  });

  it("AC4 due follow-up tail uses the same atomic successor seam even with certified empty intake", async () => {
    await tick();
    const reservation = await claim();
    const first = pullMember(reservation);
    expect(
      (
        await h.request("report", {
          reservationId: reservation!.reservationId,
          outcomes: [
            pullReport(first, {
              ...complete(first),
              kind: "continuation-required",
              progress: syntheticProgress(first.payload, { followUpTail: true }),
            }),
          ],
        })
      ).status,
    ).toBe(200);
    const second = pullMember(await claim());
    expect(second.payload.checkpoint).toMatchObject({
      traversal: { exhausted: true, discovered: 0 },
      followUpTail: true,
      drained: false,
    });
    expect(second.payload.predecessor?.operationId).toBe(first.operationId);
  });

  it.each(["attemptId", "claimGeneration", "payloadDigest"] as const)(
    "AC3 frozen %s fence bypass admits a report the candidate refuses",
    async (field) => {
      await tick();
      const reservation = await claim();
      const member = pullMember(reservation);
      const report = pullReport(member, { kind: "order-pull-unknown", reason: "session-lost" });
      const bad = {
        ...report,
        [field]:
          field === "claimGeneration"
            ? report.claimGeneration + 1
            : field === "payloadDigest"
              ? "0".repeat(64)
              : "synthetic-wrong-attempt",
      };
      const body = { reservationId: reservation!.reservationId, outcomes: [bad] };
      const before = await pullState();
      expect((await h.request("report", body)).status).toBe(409);
      expect(await pullState()).toEqual(before);
      const original = pullCoordinator.assertOrderPullReportFence;
      // Freeze DB, claimant, receipt and all other predicates. Mask exactly this comparison in memory.
      const bypass = vi
        .spyOn(pullCoordinator, "assertOrderPullReportFence")
        .mockImplementation((stored, incoming, claimant) => {
          original({ ...stored, [field]: incoming[field] }, incoming, claimant);
        });
      try {
        expect((await h.request("report", body)).status).toBe(200);
        expect((await h.services.outboundSync.readOrderPullOperations(target))[0]!.status).toBe("failed");
      } finally {
        bypass.mockRestore();
      }
    },
  );

  it("AC1 schedules one connection pull; racing, repeated, restarted and not-due ticks stay one with zero writes", async () => {
    const listingBefore = await h.effects();
    const minted = await Promise.all(Array.from({ length: 3 }, () => tick()));
    expect(minted.reduce((sum, count) => sum + count, 0)).toBe(1);
    const scheduled = await h.services.outboundSync.readOrderPullOperations({ connectionId: target.connectionId });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      subject: { kind: "connection", connectionId: target.connectionId },
      operationKind: "tcgplayer-order-pull",
      status: "pending",
      scheduleGeneration: 1,
      pullId: deriveOrderPullId(target.connectionId, 1),
      payload: {
        kind: "order-pull",
        version: 2,
        connectionId: target.connectionId,
        pullId: deriveOrderPullId(target.connectionId, 1),
        policyRevision: 3,
        lawVersion: "ready-to-ship-intake/v2",
        selector: syntheticAuthority.selector,
        bounds: syntheticPayload().bounds,
        followUpReferences: [],
      },
    });
    expect(Object.keys(scheduled[0]!.payload).sort()).not.toContain("listingId");
    const [schedule] = (await pullState()).schedules as { row: { generation: number; next_due_at: string } }[];
    expect(schedule?.row.generation).toBe(1);
    expect(Date.parse(schedule!.row.next_due_at)).toBe(startedAt + 60_000);
    // The producer writes only its own tables; listing state is untouched.
    expect(await h.effects()).toEqual(listingBefore);

    const snapshot = await pullState();
    expect(await tick()).toBe(0);
    h.restart();
    expect(await tick()).toBe(0);
    at(61_000);
    // Due again, but the connection already has a live pull: zero writes.
    expect(await Promise.all([tick(), tick()])).toEqual([0, 0]);
    expect(await pullState()).toEqual(snapshot);
  });

  it("AC1 a poll-window increase fences the persisted boundary across racing and restarted ticks; a decrease keeps the promised fence", async () => {
    expect(await tick()).toBe(1);
    expect(await schedule()).toEqual({ generation: 1, nextDueAt: 60_000, lastScheduledAt: 0 });
    await settlePull();
    const policyId = await h.connectorPolicy({ ...connectorPolicyDefaults, pollWindowSeconds: 300 });
    h.restart();
    const settled = await pullState();
    for (const offset of [60_000, 240_000, 299_999]) {
      at(offset);
      expect(await Promise.all([tick(), tick(), tick()])).toEqual([0, 0, 0]);
      h.restart();
      expect(await tick()).toBe(0);
    }
    expect(await pullState()).toEqual(settled);
    at(300_000);
    const minted = await Promise.all([tick(), tick(), tick()]);
    expect(minted.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await schedule()).toEqual({ generation: 2, nextDueAt: 600_000, lastScheduledAt: 300_000 });

    await settlePull();
    await h.db.query("UPDATE platform_policy_documents SET value=$1::jsonb WHERE document_id=$2", [
      JSON.stringify({ ...connectorPolicyDefaults, pollWindowSeconds: 60 }),
      policyId,
    ]);
    h.restart();
    at(360_000);
    expect(await tick()).toBe(0);
    // A late tick mints one pull on the effective grid from the persisted boundary, never a backlog.
    at(845_000);
    expect(await Promise.all([tick(), tick()])).toEqual(expect.arrayContaining([0, 1]));
    expect(await schedule()).toEqual({ generation: 3, nextDueAt: 900_000, lastScheduledAt: 840_000 });
    const pulls = await h.services.outboundSync.readOrderPullOperations({ connectionId: target.connectionId });
    expect(pulls.map((pull) => [pull.scheduleGeneration, pull.status])).toEqual([
      [3, "pending"],
      [2, "succeeded"],
      [1, "succeeded"],
    ]);
  });

  it("AC1 a held prefix of 100 connections cannot starve a later eligible one and is never written", async () => {
    const heldIds = Array.from({ length: 100 }, (_, index) => `connection_held_${String(index).padStart(3, "0")}`);
    // Synthetic connections copy the fixture's provider, environment and pairing; only their identities differ.
    await h.db.query(
      `INSERT INTO channel_connections
       (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version)
       SELECT 'connection_held_' || lpad(i::text, 3, '0'), account_id, provider_key, environment, status, created_at,
         created_at_instant, bindings, projection_updated_at, last_stream_version
       FROM channel_connections, generate_series(0, 99) AS i WHERE connection_id = $1`,
      [target.connectionId],
    );
    await h.db.query(
      `INSERT INTO channel_connector_pairings
       (pairing_id,connection_id,account_id,user_id,state,revision,code_expires_at,grant_id,created_at)
       SELECT 'pairing_held_' || lpad(i::text, 3, '0'), 'connection_held_' || lpad(i::text, 3, '0'), account_id,
         user_id, 'paired', 1, code_expires_at, 'grant_held_' || lpad(i::text, 3, '0'), created_at
       FROM channel_connector_pairings, generate_series(0, 99) AS i WHERE pairing_id = $1`,
      [h.pairingId],
    );
    heldConnections = new Set(heldIds);
    const empty = await pullState();
    // Concurrent ticks all examine the held prefix; none writes, and none moves the scan backwards.
    expect(await Promise.all([tick(), tick(), tick()])).toEqual([0, 0, 0]);
    expect(await pullState()).toEqual(empty);
    expect(await tick()).toBe(1);
    const scheduledIds = async () =>
      (
        await h.db.query<{ connection_id: string }>(
          "SELECT connection_id FROM channel_order_pull_operations ORDER BY connection_id",
        )
      ).rows.map((row) => row.connection_id);
    expect(await scheduledIds()).toEqual([target.connectionId]);
    // The exhausted scan wrapped: a newly released earlier connection is reached on the next lap.
    heldConnections.delete(heldIds[5]!);
    expect(await tick()).toBe(1);
    expect(await scheduledIds()).toEqual([heldIds[5], target.connectionId]);
    const scheduled = await pullState();
    // A restart begins a new scan; the live-pull fence keeps every racing mint unique.
    h.restart();
    expect(await Promise.all([tick(), tick(), tick()])).toEqual([0, 0, 0]);
    expect(await pullState()).toEqual(scheduled);
  });

  it("AC1 denies unknown, over-budget and absent-bound authority and held connections with zero writes and zero provider calls", async () => {
    const providerCalls: string[] = [];
    const empty = await pullState();
    for (const denied of [
      null,
      { ...syntheticAuthority, reportTimeoutMs: 600_000 },
      { ...syntheticAuthority, nIntakeReadMax: undefined },
      { ...syntheticAuthority, selector: { ...syntheticAuthority.selector, qualifiedAt: "x" } },
    ]) {
      authority = denied;
      expect(await tick()).toBe(0);
      expect(await pullState()).toEqual(empty);
    }
    authority = syntheticAuthority;
    held = true;
    expect(await tick()).toBe(0);
    expect(await pullState()).toEqual(empty);
    held = false;
    // Omitted producer: a capable claim receives nothing, so an executor would make no provider call.
    const reservation = await claim();
    for (const operation of reservation?.operations ?? []) providerCalls.push(operation.operationId);
    expect(reservation).toBeNull();
    expect(providerCalls).toEqual([]);
  });

  it("AC1 paused and revoked connections write zero", async () => {
    await h.pause();
    expect(await tick()).toBe(0);
    expect(await pullState()).toEqual({ operations: [], schedules: [] });
    await h.services.connections.resumeChannelConnection(target, transportContext);
    await h.projectConnection();
    await h.services.connectorFeed.revoke(h.token);
    expect(await tick()).toBe(0);
    expect(await pullState()).toEqual({ operations: [], schedules: [] });
  });

  it("AC2 capable claim -> executor -> complete settles the pull with no listing writes; day-after mints a new pull", async () => {
    expect(await tick()).toBe(1);
    // Incapable connector and manual claimers exclude the kind before reserve.
    expect(await claim({})).toBeNull();
    expect(
      await h.services.outboundSync.reserveClaimedOutboundOperations({
        registry: channelProviderRegistry,
        connectionId: target.connectionId,
        claimant: { claimantKind: "manual", claimantId: "manual_8610" },
        maxOperations: 10,
        leaseMs: 1_800_000,
      }),
    ).toBeNull();
    expect(
      await h.services.outboundSync.processNextInlineOperation({
        registry: channelProviderRegistry,
        claimOwnerId: "inline_8610",
      }),
    ).toBe(0);
    const [pending] = await h.services.outboundSync.readOrderPullOperations({ connectionId: target.connectionId });
    expect(pending).toMatchObject({ status: "pending", claimGeneration: 0, attemptCount: 0 });

    const reservation = await claim();
    const member = pullMember(reservation);
    expect(reservation?.operations).toHaveLength(1);
    expect(member).toMatchObject({
      operationId: pending!.operationId,
      claimGeneration: 1,
      connectionId: target.connectionId,
      subject: { kind: "connection", connectionId: target.connectionId },
      pullId: pending!.pullId,
      scheduleGeneration: 1,
      payload: pending!.payload,
      payloadDigest: pending!.payloadDigest,
    });
    expect(member).not.toHaveProperty("listingId");
    expect(member).not.toHaveProperty("desiredStateSequence");

    // Synthetic empty traversal, not a provider qualification or admission-as-acceptance claim.
    expect(
      orderPullFitsLease({
        budgetMs: member.payload.bounds.budgetMs,
        at: new Date().toISOString(),
        leaseExpiresAt: reservation!.leaseExpiresAt,
      }),
    ).toBe(true);
    expect(advanceOrderPullTraversal(member.payload.selector, null, syntheticPage())).toMatchObject({
      discovered: 0,
      exhausted: true,
    });

    const listingBefore = await listingEffects();
    const body = { reservationId: reservation!.reservationId, outcomes: [pullReport(member, complete(member))] };
    const first = await h.request("report", body);
    expect(first.status).toBe(200);
    const [settled] = await h.services.outboundSync.readOrderPullOperations({ connectionId: target.connectionId });
    expect(settled).toMatchObject({ status: "succeeded", outcome: complete(member) });
    expect(await listingEffects()).toEqual(listingBefore);
    const settledState = await pullState();
    const repeat = await h.request("report", body);
    expect(repeat.status).toBe(200);
    expect(await pullState()).toEqual(settledState);

    // Day-after: the next boundary mints a NEW pull; the completed one is never relabelled.
    at(30_000);
    expect(await tick()).toBe(0);
    at(125_000);
    expect(await tick()).toBe(1);
    const pulls = await h.services.outboundSync.readOrderPullOperations({ connectionId: target.connectionId });
    expect(pulls.map((pull) => [pull.scheduleGeneration, pull.status, pull.pullId])).toEqual([
      [2, "pending", deriveOrderPullId(target.connectionId, 2)],
      [1, "succeeded", pending!.pullId],
    ]);
    const [schedule] = (await pullState()).schedules as { row: { next_due_at: string } }[];
    // The persisted boundary advances on the cadence grid, not from the claim or report instant.
    expect(Date.parse(schedule!.row.next_due_at)).toBe(startedAt + 180_000);
  });

  it("AC2 mixed reservation: partial, stale and subject-bypass reports refuse atomically; unknown settles without Link writes", async () => {
    await h.enqueue("pull_mix");
    expect(await tick()).toBe(1);
    const reservation = await claim();
    expect(reservation?.operations).toHaveLength(2);
    const member = pullMember(reservation);
    const listing = reservation!.operations.find(
      (operation): operation is ClaimedOutboundOperation => operation.operationKind !== "tcgplayer-order-pull",
    )!;
    const unknown = pullReport(member, { kind: "order-pull-unknown", reason: "completeness-unproven" });
    const before = { pulls: await pullState(), listing: await listingEffects() };
    for (const refused of [
      { reservationId: reservation!.reservationId, outcomes: [listingReport(listing)] },
      {
        reservationId: reservation!.reservationId,
        outcomes: [listingReport(listing), { ...unknown, claimGeneration: unknown.claimGeneration + 1 }],
      },
      {
        reservationId: reservation!.reservationId,
        outcomes: [listingReport(listing), { ...unknown, payloadDigest: "0".repeat(64) }],
      },
      {
        reservationId: reservation!.reservationId,
        outcomes: [
          listingReport(listing),
          {
            operationId: member.operationId,
            attemptId: member.attemptId,
            claimGeneration: member.claimGeneration,
            desiredStateSequence: 1,
            outcome: { kind: "outcome-unknown" },
          },
        ],
      },
      {
        reservationId: reservation!.reservationId,
        outcomes: [
          listingReport(listing),
          pullReport(member, {
            ...complete(member),
            admissionCounts: { readyToShipMembers: 61, followUpReads: 0, admitted: 1 },
          }),
        ],
      },
    ]) {
      const response = await h.request("report", refused);
      expect([400, 409]).toContain(response.status);
      expect({ pulls: await pullState(), listing: await listingEffects() }).toEqual(before);
    }
    const accepted = await h.request("report", {
      reservationId: reservation!.reservationId,
      outcomes: [listingReport(listing), unknown],
    });
    expect(accepted.status).toBe(200);
    const [pull] = await h.services.outboundSync.readOrderPullOperations({ connectionId: target.connectionId });
    expect(pull).toMatchObject({
      status: "failed",
      outcome: { kind: "order-pull-unknown", reason: "completeness-unproven" },
    });
    // The listing member settled through its own Link owner exactly once; the pull added no listing event.
    const publications = await h.db.query(
      "SELECT count(*)::integer AS count FROM event_store_events WHERE event_type='channels.channel-listing.publication-recorded'",
    );
    expect(publications.rows[0]).toEqual({ count: 1 });
  });

  it("AC2 abandoned and lease-expired attempts return the same pull for a new generation; the old report is refused", async () => {
    expect(await tick()).toBe(1);
    const firstReservation = await claim();
    const first = pullMember(firstReservation);
    const released = await h.request("report", {
      reservationId: firstReservation!.reservationId,
      outcomes: [pullReport(first, { kind: "abandoned", reason: "released" })],
    });
    expect(released.status).toBe(200);
    const second = await claim();
    const secondMember = pullMember(second);
    expect(secondMember).toMatchObject({ pullId: first.pullId, claimGeneration: 2 });
    at(1_800_001);
    expect(await h.services.outboundSync.recoverExpiredClaimedOperations()).toBeGreaterThanOrEqual(1);
    const stale = await h.request("report", {
      reservationId: second!.reservationId,
      outcomes: [pullReport(secondMember, complete(secondMember))],
    });
    expect(stale.status).toBe(409);
    const third = pullMember(await claim());
    expect(third).toMatchObject({ pullId: first.pullId, claimGeneration: 3 });
    expect(await tick()).toBe(0);
  });
});

describeDb("order-pull-producer-schema-and-profiles", () => {
  let pools: Readonly<Record<"channels", PgTransactionalPool>>;
  beforeAll(async () => {
    const baseUrl = process.env.TEST_DATABASE_URL!;
    const urls = createMultiContextTestDatabaseUrls(baseUrl, ["channels"], "order_pull_schema_8610");
    await ensureMultiContextTestDatabases(baseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("AC4 the ledgered migration adds the producer tables to a retained queue without touching pending listing operations", async () => {
    const migrationId = "20261009_channels_order_pull_progress";
    const migration = outboundSyncSchemaMigrations.find((entry) => entry.migrationId === migrationId)!;
    const predecessor = {
      ...channelsModule,
      schemaSql: migration.statements.reduce(
        (sql, statement) => sql.replace(`${statement};`, ""),
        channelsModule.schemaSql,
      ),
      schemaMigrations: channelsModule.schemaMigrations!.filter((entry) => entry.migrationId !== migrationId),
    };
    expect(predecessor.schemaSql).not.toContain("channel_order_pull_chunks");
    await bootstrapContextDatabase(predecessor, pools.channels);
    expect(await producerTables()).toEqual(["channel_order_pull_operations", "channel_order_pull_schedules"]);
    await pools.channels.query(
      `INSERT INTO channel_connections
       (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version)
       VALUES ('connection-retained','account-retained','tcgplayer','sandbox','active',now(),now(),'[]'::jsonb,now(),1)`,
    );
    const runtime = createOutboundSyncRuntime(
      {
        db: pools.channels,
        recordOutcome: async () => "applied",
        readAdditionalOutboundHold: async () => ({ held: false, sources: [] }),
      },
      { assertDelistDirective: () => undefined },
    );
    await runtime.enqueueDesiredState({
      connectionId: "connection-retained",
      channelListingId: "channel-retained",
      listingId: "listing-retained",
      operationKind: "publish",
      listingRevision: 1,
      desiredStateSequence: 1,
      desiredStateHash: "a".repeat(64),
      payload: {
        kind: "draft",
        draft: {
          channelListingId: "channel-retained",
          listingRevision: 1,
          title: "Retained",
          description: "Retained",
          categoryKey: "retained",
          conditionKey: "retained",
          price: { amountMinor: 100, currency: "USD" },
          quantity: 1,
          attributes: [],
        },
      },
      envelope: {
        sourceEventId: "event-retained",
        sourceStreamId: "channels.channel-listing-channel-retained",
        sourceStreamVersion: 1,
        sourceGlobalPosition: parseGlobalPosition("1"),
        sourceOccurredAt: "2026-10-07T12:00:00.000Z",
      },
    });
    const retained = await pools.channels.query("SELECT * FROM channel_outbound_operations ORDER BY operation_id");
    expect(retained.rows).toHaveLength(1);

    // Ledger-only upgrade: boot DDL is omitted, so only the real migration can create the producer tables.
    await bootstrapContextDatabase({ ...channelsModule, schemaSql: "" }, pools.channels);
    expect(await producerTables()).toEqual([
      "channel_order_pull_chunks",
      "channel_order_pull_operations",
      "channel_order_pull_schedules",
    ]);
    expect(
      (await pools.channels.query("SELECT * FROM channel_outbound_operations ORDER BY operation_id")).rows,
    ).toEqual(retained.rows);
    const upgradedIndexes = await producerIndexes();
    expect(upgradedIndexes).toEqual([
      "channel_order_pull_chunks_pending_idx",
      "channel_order_pull_chunks_references_idx",
      "channel_order_pull_operations_expiry_idx",
      "channel_order_pull_operations_one_live_uidx",
      "channel_order_pull_operations_reservation_idx",
      "channel_order_pull_schedules_due_idx",
    ]);
    // Boot after migration and a repeated boot are idempotent and keep the retained listing queue.
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(
      (await pools.channels.query("SELECT * FROM channel_outbound_operations ORDER BY operation_id")).rows,
    ).toEqual(retained.rows);
    expect(
      (
        await pools.channels.query(
          "SELECT count(*)::integer AS count FROM bounded_context_schema_migrations WHERE migration_id=$1",
          [migrationId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    // Fresh-boot parity.
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(await producerIndexes()).toEqual(upgradedIndexes);
  });

  it("excludes lookalike interpretation tables and their indexes from the producer census", async () => {
    await pools.channels.query("CREATE TABLE channel_order_pulls (pull_id text NOT NULL)");
    await pools.channels.query("CREATE INDEX channel_order_pulls_lookup_idx ON channel_order_pulls (pull_id)");
    expect(await producerTables()).toEqual([]);
    expect(await producerIndexes()).toEqual([]);
  });

  async function producerTables(): Promise<string[]> {
    const result = await pools.channels.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND starts_with(table_name, 'channel_order_pull_') ORDER BY table_name`,
    );
    return result.rows.map((row) => row.table_name);
  }
  async function producerIndexes(): Promise<string[]> {
    const result = await pools.channels.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND starts_with(tablename, 'channel_order_pull_') AND indexname NOT LIKE '%_pkey'
         AND indexname NOT LIKE '%_key' ORDER BY indexname`,
    );
    return result.rows.map((row) => row.indexname);
  }
});
