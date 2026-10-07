import { expect, it, vi } from "vitest";
import type { ClaimedOperationReservation } from "../../outbound-sync/domain/contracts";
import type { ConnectorTransportServices } from "../api/transport";
import type { ConnectorReport } from "../domain/transport";
import { describeDb, target, transportContext, transportDatabase } from "./transport-test-support";
import { deriveClaimedOperationOutcomes } from "../../tcgplayer-csv/domain/lifecycle";
import { connectorPolicyDefaults } from "../domain/policy";

function report(reservation: ClaimedOperationReservation): ConnectorReport {
  return {
    reservationId: reservation.reservationId,
    outcomes: reservation.operations.map((operation) => ({
      operationId: operation.operationId,
      attemptId: operation.attemptId,
      claimGeneration: operation.claimGeneration,
      desiredStateSequence: operation.desiredStateSequence,
      outcome: { kind: "applied", result: { kind: "succeeded", externalListingId: `external_${operation.listingId}` } },
    })),
  };
}
describeDb("connector-feed-round-trip / connector-feed-lease-redelivery / connector-feed-claim-interleavings", () => {
  const h = transportDatabase("connector_producer_7994");
  async function claim() {
    const response = await h.request("claim");
    expect(response.status).toBe(200);
    const value: Awaited<ReturnType<ConnectorTransportServices["claim"]>> = await response.json();
    return value.reservation;
  }
  async function stagedBasis() {
    await h.db.query(
      `INSERT INTO channels_listing_publication_facts
      (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,
       selected_options,selected_option_key,listing_status,updated_at,listing_stream_version)
      VALUES ('manual',$1,'item_manual','catalog_manual','1.00','USD',10,'[]','none','active',now(),7)`,
      [target.accountId],
    );
    await h.db.query(
      `INSERT INTO channels_external_product_reference_facts VALUES ('tcgplayer','sku:2001','catalog_manual','[]','none','linked',now(),1)`,
    );
    await h.db.query(
      `INSERT INTO channels_external_catalog_item_reference_facts VALUES ('tcgplayer','product:1001','catalog_manual','linked',now(),1)`,
    );
    const at = new Date().toISOString();
    const staged = await h.services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
      snapshotId: "snapshot_manual",
      connectionId: target.connectionId,
      surface: "staged",
      csv: "TCGplayer Id,Total Quantity,Add to Quantity,TCG Marketplace Price\n1001,0,0,1.00",
      limits: { maxRecords: 1 },
      ingestedAt: at,
      capturedAt: at,
      capturedAtSource: "operator-declared",
    });
    expect(staged.kind).toBe("parsed");
  }
  it("passes the complete runSettlement through the producer and returns an identical inert repeat", async () => {
    await stagedBasis();
    await h.enqueue("manual");
    const composed = await h.services.tcgplayerCsv.composeTcgplayerSyncRun(
      {
        runId: "run_connector",
        connectionId: target.connectionId,
        claimant: { claimantKind: "connector", claimantId: h.pairingId },
        leaseMs: 1_800_000,
        manualClaimLeasePolicySnapshot: null,
        resolvedPolicy: { maxRowsPerBatch: 100 },
        composedAt: new Date().toISOString(),
      },
      transportContext,
    );
    if (!composed) throw new Error("missing-connector-run");
    const run = composed.run;
    const body: ConnectorReport = {
      reservationId: run.reservationId,
      outcomes: deriveClaimedOperationOutcomes({ ...run, state: "abandoned" }),
      runSettlement: {
        runId: run.runId,
        expectedRunRevision: run.revision,
        fromState: "composed",
        toState: "abandoned",
        verificationSnapshotId: null,
        verificationSnapshotGeneration: null,
        uploadAttemptedAt: null,
        uploadFileName: null,
        importSummary: null,
        context: transportContext,
      },
    };
    const first = await h.request("report", body);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("{}");
    expect((await h.services.tcgplayerCsv.readRun(run.runId))?.state).toBe("abandoned");
    const before = await h.effects();
    h.restart();
    const repeat = await h.request("report", body);
    expect(repeat.status).toBe(200);
    expect(await repeat.text()).toBe("{}");
    expect([...repeat.headers]).toEqual([...first.headers]);
    expect((await h.effects()).e1).toEqual(before.e1);
    expect((await h.effects()).e2).toEqual(before.e2);
  });
  it("settles publish/update/delist only through the producer and Link owner, retaining sequence and identical replay", async () => {
    for (const [index, kind] of (["publish", "update", "delist"] as const).entries()) {
      const sequence = index * 2 + 1;
      const source = await h.enqueue("round_trip", sequence, kind);
      const reservation = await claim();
      if (!reservation) throw new Error("missing-fixture-reservation");
      expect(reservation.operations).toHaveLength(1);
      expect(reservation.operations[0]).toMatchObject({
        operationKind: kind,
        desiredStateSequence: source.desiredStateSequence,
        listingRevision: source.listingRevision,
        payload: source.payload,
      });
      const before = await h.effects();
      const response = await h.request("report", report(reservation));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("{}");
      const publications = await h.db.query<{
        payload: { reportedDesiredStateSequence: number; reportedListingRevision: number; outcome: { kind: string } };
      }>(
        "SELECT payload FROM event_store_events WHERE stream_id=$1 AND event_type='channels.channel-listing.publication-recorded' ORDER BY stream_version",
        [`channels.channel-listing-channel_round_trip`],
      );
      expect(publications.rows).toHaveLength(index + 1);
      expect(publications.rows.at(-1)?.payload).toMatchObject({
        reportedDesiredStateSequence: sequence,
        reportedListingRevision: 7,
        outcome: { kind: "succeeded" },
      });
      await h.projectListing("round_trip");
      expect(
        (
          await h.db.query(
            "SELECT external_listing_id,publish_state FROM channels_channel_listing_links WHERE channel_listing_id='channel_round_trip'",
          )
        ).rows,
      ).toEqual([
        { external_listing_id: "external_round_trip", publish_state: kind === "delist" ? "delisted" : "published" },
      ]);
      const settled = await h.effects();
      expect(settled.e2).toEqual(before.e2);
      h.restart();
      const repeat = await h.request("report", report(reservation));
      expect(repeat.status).toBe(200);
      expect(await repeat.text()).toBe("{}");
      expect([...repeat.headers]).toEqual([...response.headers]);
      expect((await h.effects()).e1).toEqual(settled.e1);
      expect((await h.effects()).e2).toEqual(before.e2);
      const different = report(reservation);
      const changed = await h.request("report", {
        ...different,
        outcomes: different.outcomes.map((member) => ({
          ...member,
          outcome: { kind: "abandoned", reason: "claimant-cancelled" },
        })),
      });
      expect(changed.status).toBe(409);
      expect((await changed.json()).code).toBe("report-refused");
      expect((await h.effects()).e1).toEqual(settled.e1);
    }
    const completed = await h.effects();
    expect(await claim()).toBeNull();
    expect((await h.effects()).e1).toEqual(completed.e1);
  });
  it("settles an existing reservation while seller-paused without reserving again or writing E2", async () => {
    await h.enqueue("paused_report");
    const reservation = await claim();
    if (!reservation) throw new Error("missing-fixture-reservation");
    await h.pause();
    const reserve = vi.spyOn(h.services.outboundSync, "reserveClaimedOutboundOperations");
    const before = await h.effects();
    const response = await h.request("report", report(reservation));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{}");
    const settled = await h.effects();
    expect(settled.e2).toEqual(before.e2);
    expect((await h.request("report", report(reservation))).status).toBe(200);
    expect((await h.effects()).e1).toEqual(settled.e1);
    expect(reserve).not.toHaveBeenCalled();
  });
  it("refuses partial, repeated, extra, stale and foreign report members without settling any member", async () => {
    await h.enqueue("report_a");
    await h.enqueue("report_b");
    const reservation = await claim();
    if (!reservation) throw new Error("missing-fixture-reservation");
    const valid = report(reservation);
    const first = valid.outcomes[0];
    if (!first) throw new Error("missing-fixture-member");
    const invalid = [
      { ...valid, outcomes: valid.outcomes.slice(0, 1) },
      { ...valid, outcomes: [first, first] },
      { ...valid, outcomes: [...valid.outcomes, { ...first, operationId: "cop_extra" }] },
      {
        ...valid,
        outcomes: valid.outcomes.map((member) => ({ ...member, claimGeneration: member.claimGeneration + 1 })),
      },
      {
        ...valid,
        outcomes: valid.outcomes.map((member) => ({
          ...member,
          desiredStateSequence: member.desiredStateSequence + 1,
        })),
      },
    ];
    const before = await h.effects();
    for (const body of invalid) {
      const response = await h.request("report", body);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("report-refused");
      expect((await h.effects()).e1).toEqual(before.e1);
    }
    await h.connection("connection_foreign");
    const foreign = await h.pair("connection_foreign");
    const response = await h.request("report", valid, { connectionId: "connection_foreign", token: foreign.token });
    expect(response.status).toBe(409);
    expect((await h.db.query("SELECT * FROM channel_outbound_reservation_settlements")).rows).toEqual([]);
    expect((await h.request("report", valid)).status).toBe(200);
  });
  it("redelivers only through producer expiry with stable operation and fresh attempt/generation", async () => {
    await h.enqueue("redelivery");
    const first = await claim();
    if (!first) throw new Error("missing-fixture-reservation");
    vi.setSystemTime(new Date(Date.parse(first.leaseExpiresAt) + 1));
    expect((await h.request("report", report(first))).status).toBe(409);
    expect(await h.services.outboundSync.recoverExpiredClaimedOperations()).toBe(1);
    const next = await claim();
    if (!next) throw new Error("missing-redelivery");
    expect(next.operations[0]?.operationId).toBe(first.operations[0]?.operationId);
    expect(next.operations[0]?.attemptId).not.toBe(first.operations[0]?.attemptId);
    expect(next.operations[0]?.claimGeneration).toBe((first.operations[0]?.claimGeneration ?? 0) + 1);
    expect((await h.db.query("SELECT * FROM channel_outbound_operations WHERE status='in-flight'")).rows).toHaveLength(
      1,
    );
    expect((await h.request("report", report(first))).status).toBe(409);
    expect((await h.request("report", report(next))).status).toBe(200);
    const settled = await h.effects();
    expect((await h.request("report", report(next))).status).toBe(200);
    expect((await h.effects()).e1).toEqual(settled.e1);
  });
  it("connector-feed-paging-complete: keeps concurrent reservations disjoint and reconciles a multi-poll drain with an independent total", async () => {
    await h.connectorPolicy({ ...connectorPolicyDefaults, maxOperationsPerClaim: 2 });
    for (let index = 0; index < 7; index++) await h.enqueue(`drain_${index}`);
    const total = await h.db.query<{ total: number }>(
      "SELECT COUNT(*)::integer AS total FROM channel_outbound_operations WHERE connection_id=$1",
      [target.connectionId],
    );
    const claims = await Promise.all([claim(), claim(), claim()]);
    const reservations = claims.filter((value): value is ClaimedOperationReservation => value !== null);
    for (let remaining = 0; remaining < 8; remaining++) {
      const reservation = await claim();
      if (!reservation) break;
      reservations.push(reservation);
    }
    expect(reservations.map((reservation) => reservation.operations.length).sort()).toEqual([1, 2, 2, 2]);
    const ids = reservations.flatMap((reservation) => reservation.operations.map((operation) => operation.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(total.rows[0]?.total ?? -1);
    for (const reservation of reservations) expect((await h.request("report", report(reservation))).status).toBe(200);
    const before = await h.effects();
    expect(await claim()).toBeNull();
    expect((await h.effects()).e1).toEqual(before.e1);
    expect(
      (
        await h.db.query<{ total: number }>(
          "SELECT COUNT(*)::integer AS total FROM channel_outbound_operations WHERE status='succeeded'",
        )
      ).rows[0]?.total,
    ).toBe(total.rows[0]?.total);
    const first = await h.services.outboundSync.readOutboundOperationLog({ ...target, limit: 2 });
    expect(first.completeness).toEqual({ kind: "complete", total: 7 });
    if (!first.nextCursor) throw new Error("missing-producer-log-cursor");
    await h.enqueue("drain_late");
    const changed = await h.services.outboundSync.readOutboundOperationLog({
      ...target,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(changed.completeness).toEqual({ kind: "bounded-incomplete", reason: "authoritative-total-changed" });
  });
  it("parks a poison listing without blocking a neighbor", async () => {
    await h.enqueue("poison");
    await h.enqueue("neighbor");
    const reservation = await claim();
    if (!reservation) throw new Error("missing-fixture-reservation");
    const outcomes = report(reservation).outcomes.map((member) => ({
      ...member,
      outcome:
        reservation.operations.find((operation) => operation.operationId === member.operationId)?.listingId === "poison"
          ? { kind: "outcome-unknown" as const }
          : member.outcome,
    }));
    expect((await h.request("report", { reservationId: reservation.reservationId, outcomes })).status).toBe(200);
    await h.enqueue("poison", 3, "update");
    await h.enqueue("neighbor", 3, "update");
    const next = await claim();
    expect(next?.operations.map((operation) => operation.listingId)).toEqual(["neighbor"]);
  });
  it.each(["manual-first", "connector-first"] as const)(
    "keeps manual compose and claimAndDownload disjoint from connector claims: %s",
    async (schedule) => {
      await stagedBasis();
      async function compose() {
        await h.enqueue("manual");
        const panel = await h.services.manualSync.compose(target, transportContext);
        if (!panel.run) throw new Error("missing-manual-run");
        expect(panel.run.members).toHaveLength(1);
        expect(panel.run.members[0]?.memberKind).toBe("composed");
        return panel.run;
      }
      async function connector() {
        await h.enqueue("connector");
        const reservation = await claim();
        if (!reservation) throw new Error("missing-connector-reservation");
        return reservation;
      }
      const result =
        schedule === "manual-first"
          ? { manual: await compose(), connector: await connector() }
          : await (async () => {
              const reservation = await connector();
              return { manual: await compose(), connector: reservation };
            })();
      const beforeDownload = await h.db.query(
        "SELECT operation_id,reservation_id FROM channel_outbound_operations ORDER BY operation_id",
      );
      const downloaded = await h.services.manualSync.claimAndDownload(
        { ...target, runId: result.manual.runId, expectedRevision: result.manual.revision },
        transportContext,
      );
      expect(downloaded.run.state).toBe("claimed");
      expect(downloaded.batch.rows).toHaveLength(1);
      expect(result.manual.reservationId).not.toBe(result.connector.reservationId);
      expect(
        result.manual.members
          .map((member) => member.operationId)
          .filter((id) => result.connector.operations.some((operation) => operation.operationId === id)),
      ).toEqual([]);
      expect(
        (await h.db.query("SELECT operation_id,reservation_id FROM channel_outbound_operations ORDER BY operation_id"))
          .rows,
      ).toEqual(beforeDownload.rows);
    },
  );
});
