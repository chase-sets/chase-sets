import { beforeEach, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { module as channelsModule } from "../../../index";
import { channelProviderRegistry } from "../../publication-port/api/registry";
import { connectorPolicyDefaults } from "../../connector-feed/domain/policy";
import {
  describeDb,
  target,
  transportContext,
  transportDatabase,
} from "../../connector-feed/tests/transport-test-support";
import type { ConnectorTransportServices } from "../../connector-feed/api/transport";
import type { ClaimedLiveExportOperation } from "../domain/contracts";
import type { ClaimedLiveExportOutcome } from "../domain/live-export-codec";
import { deriveLiveExportId } from "../api/live-export-payload";
import { syntheticAuthority } from "./order-pull-fixtures";
import { outboundSyncSchemaMigrations } from "../read-model/schema";
import { capabilityIgnoredStore } from "./live-export-capability-mutant";
import { createOutboundOperationStore } from "../api/store";
import { assertChannelListingDelistDirective } from "../../listing-composition/domain/codecs";

const capable = { capabilities: ["tcgplayer-live-export", "tcgplayer-order-pull"] };
const start = Date.parse("2026-10-07T12:00:00Z");
const interval = connectorPolicyDefaults.liveExportIntervalSeconds * 1000;

describeDb("live-export-producer", () => {
  let held = false;
  const h = transportDatabase("live_export_9285", {
    resolveTcgplayerOrderPullAuthority: async () => syntheticAuthority,
    readChannelHealthHold: async () => held,
  });
  beforeEach(() => {
    held = false;
  });
  const tick = () => h.services.outboundSync.scheduleDueLiveExports({ registry: channelProviderRegistry });
  const at = (offset: number) => vi.setSystemTime(new Date(start + offset));
  async function claim(body: unknown = capable) {
    const response = await h.request("claim", body);
    expect(response.status).toBe(200);
    const result: Awaited<ReturnType<ConnectorTransportServices["claim"]>> = await response.json();
    return result.reservation;
  }
  async function claimed() {
    const reservation = await claim();
    expect(reservation?.operations).toHaveLength(1);
    const member = reservation!.operations[0]!;
    if (member.operationKind !== "tcgplayer-live-export") throw new Error("missing-live-export");
    return { reservation: reservation!, member };
  }
  function report(
    member: ClaimedLiveExportOperation,
    kind: "complete" | "unknown" | "abandoned" = "complete",
  ): ClaimedLiveExportOutcome {
    return {
      operationKind: member.operationKind,
      operationId: member.operationId,
      attemptId: member.attemptId,
      claimGeneration: member.claimGeneration,
      exportId: member.exportId,
      payloadDigest: member.payloadDigest,
      outcome:
        kind === "complete"
          ? {
              kind: "live-export-complete",
              exportId: member.exportId,
              fileSha256: "a".repeat(64),
              capturedAt: new Date().toISOString(),
              parsedRowCount: 0,
              externalReference: "synthetic-export",
            }
          : kind === "unknown"
            ? { kind: "live-export-unknown", exportId: member.exportId, reason: "raw-unreadable" }
            : { kind: "abandoned", reason: "claimant-cancelled" },
    };
  }
  async function state() {
    return {
      operations: (
        await h.db.query("SELECT row_to_json(t) AS row FROM channel_live_export_operations t ORDER BY operation_id")
      ).rows,
      schedules: (
        await h.db.query("SELECT row_to_json(t) AS row FROM channel_live_export_schedules t ORDER BY connection_id")
      ).rows,
    };
  }

  it("live-export-schedule-due-boundary: overlapping ticks and an unsettled operation mint only once", async () => {
    at(0);
    expect((await Promise.all([tick(), tick()])).sort()).toEqual([0, 1]);
    const initial = await state();
    at(interval * 4);
    expect(await tick()).toBe(0);
    expect(await state()).toEqual(initial);
    const { member } = await claimed();
    expect(member.scheduleGeneration).toBe(1);
    expect(member.payload.limits).toEqual({
      maxBytes: connectorPolicyDefaults.maxIngestBytes,
      maxRecords: connectorPolicyDefaults.maxIngestRecords,
    });
    expect(await tick()).toBe(0);
  });

  it.each(["complete", "unknown", "abandoned"] as const)(
    "live-export-report-settlement: %s is terminal, identical repeat inert, next boundary new",
    async (kind) => {
      at(0);
      expect(await tick()).toBe(1);
      at(30_000);
      const { reservation, member } = await claimed();
      const body = { reservationId: reservation.reservationId, outcomes: [report(member, kind)] };
      expect((await h.request("report", body)).status).toBe(200);
      const settled = await state();
      expect((await h.request("report", body)).status).toBe(200);
      expect(await state()).toEqual(settled);
      expect(await claim()).toBeNull();
      at(interval - 1);
      expect(await tick()).toBe(0);
      at(interval + 1234);
      expect((await Promise.all([tick(), tick()])).sort()).toEqual([0, 1]);
      const next = await claimed();
      expect(next.member.exportId).toBe(deriveLiveExportId(target.connectionId, 2));
      expect(next.member.exportId).not.toBe(member.exportId);
      const schedule = await h.db.query<{ next_due_at: Date; last_scheduled_at: Date }>(
        "SELECT next_due_at,last_scheduled_at FROM channel_live_export_schedules",
      );
      expect(schedule.rows[0]!.last_scheduled_at.toISOString()).toBe(new Date(start + interval).toISOString());
      expect(schedule.rows[0]!.next_due_at.toISOString()).toBe(new Date(start + interval * 2).toISOString());
    },
  );

  it("live-export-report-settlement: concurrent duplicate reports settle once; wrong exportId, digest, attempt and generation refuse", async () => {
    at(0);
    await tick();
    const { reservation, member } = await claimed();
    const outcome = report(member);
    const before = await state();
    for (const changed of [
      { ...outcome, payloadDigest: "f".repeat(64) },
      { ...outcome, attemptId: "wrong-attempt" },
      { ...outcome, claimGeneration: outcome.claimGeneration + 1 },
      {
        ...outcome,
        exportId: deriveLiveExportId(target.connectionId, 2),
        outcome: { ...outcome.outcome, exportId: deriveLiveExportId(target.connectionId, 2) },
      },
    ]) {
      expect(
        (await h.request("report", { reservationId: reservation.reservationId, outcomes: [changed] })).status,
      ).toBe(409);
      expect(await state()).toEqual(before);
    }
    const body = { reservationId: reservation.reservationId, outcomes: [outcome] };
    expect(
      (await Promise.all([h.request("report", body), h.request("report", body)])).map((result) => result.status),
    ).toEqual([200, 200]);
    expect(
      (await h.request("report", { ...body, outcomes: [{ ...outcome, payloadDigest: "f".repeat(64) }] })).status,
    ).toBe(409);
  });

  it("live-export-claim-capability: incapable and manual claims exclude exports; capable claims reserve alone ahead of pull/listing work", async () => {
    at(0);
    await tick();
    expect(await claim({})).toBeNull();
    expect(await claim({ capabilities: ["tcgplayer-order-pull"] })).toBeNull();
    expect(
      await h.services.outboundSync.reserveClaimedOutboundOperations({
        registry: channelProviderRegistry,
        connectionId: target.connectionId,
        claimant: { claimantKind: "manual", claimantId: "manual-synthetic" },
        maxOperations: 100,
        leaseMs: connectorPolicyDefaults.leaseMs,
      }),
    ).toBeNull();
    await h.services.outboundSync.scheduleDueOrderPulls({ registry: channelProviderRegistry });
    await h.enqueue("live_export_mix");
    const { reservation } = await claimed();
    expect(reservation.operations.map((member) => member.operationKind)).toEqual(["tcgplayer-live-export"]);
    const existing = await claim();
    expect(existing?.operations.map((member) => member.operationKind).sort()).toEqual([
      "publish",
      "tcgplayer-order-pull",
    ]);
  });

  it("live-export-claim-capability: expired lease recovers exactly once and rejects the stale report, then the next boundary is new", async () => {
    at(0);
    await tick();
    const first = await claimed();
    at(connectorPolicyDefaults.leaseMs);
    expect(
      (
        await Promise.all([
          h.services.outboundSync.recoverExpiredClaimedOperations(),
          h.services.outboundSync.recoverExpiredClaimedOperations(),
        ])
      ).sort(),
    ).toEqual([0, 1]);
    expect(await tick()).toBe(0);
    const second = await claimed();
    expect(second.member.exportId).toBe(first.member.exportId);
    expect(second.member.attemptId).not.toBe(first.member.attemptId);
    expect(second.member.claimGeneration).toBe(first.member.claimGeneration + 1);
    expect(
      (await h.request("report", { reservationId: first.reservation.reservationId, outcomes: [report(first.member)] }))
        .status,
    ).toBe(409);
    expect(
      (
        await h.request("report", {
          reservationId: second.reservation.reservationId,
          outcomes: [report(second.member, "unknown")],
        })
      ).status,
    ).toBe(200);
    at(interval);
    expect(await tick()).toBe(1);
    expect((await claimed()).member.exportId).not.toBe(first.member.exportId);
  });

  it("live-export-claim-capability: the same exclusion invariant passes candidate and rejects capability-ignored mutant", async () => {
    await tick();
    const verifyExclusion = async (factory: typeof createOutboundOperationStore) => {
      const store = factory(
        { db: h.db, readAdditionalOutboundHold: async () => ({ held: false, sources: [] }) },
        { assertDelistDirective: assertChannelListingDelistDirective },
      );
      const reservation = await store.reserveConnectorClaimedOperations({
        registry: channelProviderRegistry,
        connectionId: target.connectionId,
        claimant: { claimantKind: "connector", claimantId: h.pairingId },
        capabilities: [],
        maxOperations: 100,
        leaseMs: connectorPolicyDefaults.leaseMs,
      });
      if (reservation !== null) throw new Error("incapable-connector-received-live-export");
    };
    await expect(verifyExclusion(createOutboundOperationStore)).resolves.toBeUndefined();
    await expect(verifyExclusion(capabilityIgnoredStore())).rejects.toThrow("incapable-connector-received-live-export");
  });

  it("live-export-schedule-due-boundary: stale listing facts cannot override paused, held, revoked or unpaired admission", async () => {
    at(0);
    held = true;
    expect(await tick()).toBe(0);
    held = false;
    await h.pause();
    // Synthetic stale listing-publication facts cannot override the connection admission row.
    await h.db.query("UPDATE channels_connection_facts SET status='active' WHERE connection_id=$1", [
      target.connectionId,
    ]);
    expect(await tick()).toBe(0);
    await h.services.connections.resumeChannelConnection(target, transportContext);
    await h.projectConnection();
    await h.services.connectorFeed.revoke(h.token);
    expect(await tick()).toBe(0);
    await h.connection("connection_manual_only");
    expect(await tick()).toBe(0);
    expect((await state()).operations).toEqual([]);
  });

  it("live-export-schedule-due-boundary: retained cadence and limits are policy-bound, not claim-bound", async () => {
    at(0);
    await h.connectorPolicy({
      ...connectorPolicyDefaults,
      liveExportIntervalSeconds: 60,
      maxIngestBytes: 1_048_576,
      maxIngestRecords: 10,
    });
    await tick();
    const { member, reservation } = await claimed();
    expect(member.payload.limits).toEqual({ maxBytes: 1_048_576, maxRecords: 10 });
    expect(
      (await h.request("report", { reservationId: reservation.reservationId, outcomes: [report(member)] })).status,
    ).toBe(200);
    h.restart();
    at(125_000);
    expect(await tick()).toBe(1);
    const schedule = await h.db.query<{ next_due_at: Date }>("SELECT next_due_at FROM channel_live_export_schedules");
    expect(schedule.rows[0]!.next_due_at.toISOString()).toBe(new Date(start + 180_000).toISOString());
  });

  it("channels-bootstrap-and-migrations: ledger-only upgrade and repeated boot preserve retained queues", async () => {
    await h.enqueue("live_export_upgrade");
    const listings = (
      await h.db.query("SELECT operation_id,status FROM channel_outbound_operations ORDER BY operation_id")
    ).rows;
    const migrationId = "20261010_channels_live_export_producer";
    expect(outboundSyncSchemaMigrations.find((entry) => entry.migrationId === migrationId)?.statements).toHaveLength(6);
    await h.db.query("DROP TABLE channel_live_export_operations, channel_live_export_schedules");
    await h.db.query("DELETE FROM bounded_context_schema_migrations WHERE migration_id=$1", [migrationId]);
    await bootstrapContextDatabase({ ...channelsModule, schemaSql: "" }, h.db);
    expect(await tick()).toBe(1);
    const retained = await state();
    await bootstrapContextDatabase(channelsModule, h.db);
    await bootstrapContextDatabase(channelsModule, h.db);
    expect(await state()).toEqual(retained);
    expect(
      (await h.db.query("SELECT operation_id,status FROM channel_outbound_operations ORDER BY operation_id")).rows,
    ).toEqual(listings);
    expect(
      (
        await h.db.query("SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id=$1", [
          migrationId,
        ])
      ).rows,
    ).toHaveLength(1);
  });
});
