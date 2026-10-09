import { expect, it, vi } from "vitest";
import type {
  ClaimedOperationOutcome,
  ClaimedOperationReservation,
  ClaimedOutboundOperation,
} from "../../outbound-sync/domain/contracts";
import type { ConnectorTransportServices } from "../api/transport";
import type { ConnectorReport } from "../domain/transport";
import { describeDb, target, transportContext, transportDatabase } from "./transport-test-support";
import { deriveClaimedOperationOutcomes } from "../../tcgplayer-csv/domain/lifecycle";
import { connectorPolicyDefaults } from "../domain/policy";
import { prepareConnectorBoundSettlement, failConnectorSettlementAt } from "./settlement-test-support";
import { createOutboundSyncRuntime } from "../../outbound-sync/api/runtime";
import { mutatedOutboundRuntime } from "../../outbound-sync/tests/runtime-mutation-support";
import { createTcgplayerClaimedReservationRunSettlementPort } from "../../tcgplayer-csv/integrations/outbound-sync-settlement";
import { createChannelListingPublicationOutcomeRecorder } from "../../outbound-sync/integrations/listing-composition";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";

function report(
  reservation: ClaimedOperationReservation,
): Readonly<{ reservationId: string; outcomes: readonly ClaimedOperationOutcome[] }> {
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
  async function claim(): Promise<ClaimedOperationReservation | null> {
    const response = await h.request("claim");
    expect(response.status).toBe(200);
    const value: Awaited<ReturnType<ConnectorTransportServices["claim"]>> = await response.json();
    if (!value.reservation) return null;
    // An incapable claim never receives a connection-subject order-pull member.
    const operations = value.reservation.operations.filter(
      (operation): operation is ClaimedOutboundOperation => operation.operationKind !== "tcgplayer-order-pull",
    );
    expect(operations).toHaveLength(value.reservation.operations.length);
    return { ...value.reservation, operations };
  }
  async function stagedBasis() {
    await h.db.query(
      `INSERT INTO channels_listing_publication_facts
      (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,
       selected_options,selected_option_key,listing_status,updated_at,listing_stream_version)
      VALUES ('manual',$1,'item_manual','catalog_manual','1.00','USD',10,'[]','','active',now(),7)`,
      [target.accountId],
    );
    await h.db.query(
      `INSERT INTO channels_external_product_reference_facts VALUES ('tcgplayer','sku:2001','catalog_manual','[]','','linked',now(),1)`,
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
    const reserve = vi.spyOn(h.services.outboundSync, "reserveConnectorClaimedOperations");
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
    await h.enqueue("poison", undefined, "update");
    await h.enqueue("neighbor", undefined, "update");
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

describeDb("connector-settlement-refusal-replay", () => {
  const h = transportDatabase("connector_settlement_9158");
  const prepare = () =>
    prepareConnectorBoundSettlement(h.db, h.services, {
      ...target,
      pairingId: h.pairingId,
      context: transportContext,
    });
  it.each(["omission-guard", "receipt-identity", "transaction-split", "runSettlement-removed"] as const)(
    "kills the %s bypass with the same real Postgres fixture and report oracle",
    async (mutant) => {
      const body = await prepare();
      let posted: unknown = body;
      if (mutant === "receipt-identity") {
        expect((await h.request("report", body)).status).toBe(200);
        posted = { ...body, runSettlement: { ...body.runSettlement!, uploadFileName: "changed.csv" } };
      } else if (mutant === "omission-guard") {
        posted = { reservationId: body.reservationId, outcomes: body.outcomes };
      }
      const release = mutant === "transaction-split" ? await failConnectorSettlementAt(h.db, "run-append") : null;
      const before = await h.effects();
      let observedStatus = 0;
      const oracle = async () => {
        const response = await h.request("report", posted);
        observedStatus = response.status;
        expect(response.status).toBe(
          mutant === "runSettlement-removed" ? 200 : mutant === "transaction-split" ? 503 : 409,
        );
        if (mutant !== "runSettlement-removed") expect((await h.effects()).e1).toEqual(before.e1);
      };
      // For the removal control, run the bypass before the successful control so
      // the fixture is still nonterminal; a retained receipt must not mask it.
      if (mutant === "runSettlement-removed") {
        const original = h.services.outboundSync.reportClaimedOperationOutcomes;
        const spy = vi
          .spyOn(h.services.outboundSync, "reportClaimedOperationOutcomes")
          .mockImplementation(({ runSettlement: _removed, ...input }) => original(input));
        await expect(oracle()).rejects.toThrow();
        expect(observedStatus).toBe(409);
        spy.mockRestore();
        expect((await h.effects()).e1).toEqual(before.e1);
        await oracle();
      } else {
        await oracle();
        const runtime = mutatedOutboundRuntime(mutant)(
          {
            db: h.db,
            clock: { now: () => new Date() },
            recordOutcome: createChannelListingPublicationOutcomeRecorder(h.services.listingComposition),
            claimedReservationRunSettlement: createTcgplayerClaimedReservationRunSettlementPort(
              createPostgresEventStore({ pool: h.db }),
            ),
            readAdditionalOutboundHold: async () => ({ held: false, sources: [] }),
          },
          { assertDelistDirective: () => undefined },
        );
        const spy = vi
          .spyOn(h.services.outboundSync, "reportClaimedOperationOutcomes")
          .mockImplementation(runtime.reportClaimedOperationOutcomes);
        await expect(oracle()).rejects.toThrow();
        expect(observedStatus).toBe(mutant === "transaction-split" ? 503 : 200);
        if (mutant === "transaction-split") expect((await h.effects()).e1).not.toEqual(before.e1);
        spy.mockRestore();
      }
      await release?.();
    },
  );
  it("refuses omitted settlement on a nonterminal bound run, stale fences and incomplete membership before E1/E2", async () => {
    const body = await prepare();
    const settlement = body.runSettlement!;
    const first = body.outcomes[0]!;
    const before = await h.effects();
    for (const invalid of [
      { reservationId: body.reservationId, outcomes: body.outcomes },
      { ...body, runSettlement: { ...settlement, runId: "foreign" } },
      { ...body, runSettlement: { ...settlement, expectedRunRevision: settlement.expectedRunRevision + 1 } },
      { ...body, runSettlement: { ...settlement, fromState: "claimed" } },
      { ...body, outcomes: body.outcomes.slice(1) },
      { ...body, outcomes: [first, first] },
      { ...body, outcomes: body.outcomes.map((o) => ({ ...o, operationId: "foreign" })) },
      { ...body, outcomes: body.outcomes.map((o) => ({ ...o, attemptId: "foreign" })) },
      { ...body, outcomes: body.outcomes.map((o) => ({ ...o, claimGeneration: o.claimGeneration + 1 })) },
      { ...body, outcomes: body.outcomes.map((o) => ({ ...o, desiredStateSequence: 99 })) },
    ]) {
      const response = await h.request("report", invalid);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("report-refused");
      const after = await h.effects();
      expect(after.e1).toEqual(before.e1);
      expect(after.e2).toEqual(before.e2);
    }
    expect((await h.request("report", body)).status).toBe(200);
  });
  it("settles competing reports once and returns identical public bytes and headers after restart/response loss", async () => {
    const body = await prepare();
    const before = await h.effects();
    const responses = await Promise.all([h.request("report", body), h.request("report", body)]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("{}");
      expect([...response.headers]).toEqual([...responses[0]!.headers]);
    }
    const settled = await h.effects();
    expect(settled.e2).toEqual(before.e2);
    expect((await h.db.query("SELECT * FROM channel_outbound_reservation_settlements")).rows).toHaveLength(1);
    expect(
      (await h.db.query("SELECT * FROM event_store_events WHERE event_type='channels.tcgplayer-sync-run.transitioned'"))
        .rows,
    ).toHaveLength(1);
    h.restart();
    const replay = await h.request("report", body);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe("{}");
    expect([...replay.headers]).toEqual([...responses[0]!.headers]);
    for (const changed of [
      { reservationId: body.reservationId, outcomes: body.outcomes },
      { ...body, runSettlement: { ...body.runSettlement!, uploadFileName: "changed.csv" } },
      { ...body, outcomes: body.outcomes.map((o) => ({ ...o, attemptId: "changed" })) },
    ])
      expect((await h.request("report", changed)).status).toBe(409);
    const after = await h.effects();
    expect(after.e1).toEqual(settled.e1);
    expect(after.e2).toEqual(settled.e2);
  });
  it("pins missing origin to 503 unavailable and zero E1/E2", async () => {
    const body = await prepare();
    await h.db.query(
      "DELETE FROM event_store_events WHERE stream_id=$1 AND event_type='channels.tcgplayer-sync-run.composed'",
      [`channels.tcgplayer-sync-run-${body.runSettlement!.runId}`],
    );
    const before = await h.effects();
    const response = await h.request("report", body);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "unavailable" });
    const after = await h.effects();
    expect(after.e1).toEqual(before.e1);
    expect(after.e2).toEqual(before.e2);
  });
  it("refuses a bound omission even in a test runtime without the production-installed run port", async () => {
    const body = await prepare();
    const recordOutcome = vi.fn(async () => "applied" as const);
    const runtime = createOutboundSyncRuntime(
      { db: h.db, recordOutcome, readAdditionalOutboundHold: async () => ({ held: false, sources: [] }) },
      { assertDelistDirective: () => undefined },
    );
    const before = await h.effects();
    await expect(
      runtime.reportClaimedOperationOutcomes({
        reservationId: body.reservationId,
        outcomes: body.outcomes,
        claimant: { claimantKind: "connector", claimantId: h.pairingId },
      }),
    ).rejects.toMatchObject({ code: "run-settlement-unavailable" });
    expect(recordOutcome).not.toHaveBeenCalled();
    expect((await h.effects()).e1).toEqual(before.e1);
  });
  it("refuses withheld/revoked grants, lost membership and foreign connection/account before settlement", async () => {
    const body = await prepare();
    await h.connection("connection_same_account");
    await h.services.connections.connectChannel(
      { accountId: "acc_foreign", connectionId: "connection_foreign_account", providerKey: "tcgplayer" },
      { deploymentEnvironment: "test" },
      { ...transportContext, audit: { ...transportContext.audit, forAccountId: "acc_foreign" } },
    );
    const before = await h.effects();
    expect((await h.request("report", body, { token: "" })).status).toBe(403);
    expect((await h.request("report", body, { connectionId: "foreign" })).status).toBe(403);
    for (const connectionId of ["connection_same_account", "connection_foreign_account"]) {
      expect((await h.request("report", body, { connectionId })).status).toBe(403);
    }
    await h.membership(false);
    expect((await h.request("report", body)).status).toBe(403);
    await h.membership(true);
    await h.revokeAuthGrant();
    expect((await h.request("report", body)).status).toBe(403);
    const after = await h.effects();
    expect(after.e1).toEqual(before.e1);
    expect(after.e2).toEqual(before.e2);
    expect(after.e3.length - before.e3.length).toBe(6);
  });
  it("retains the receipt when E3 audit fails after E1 commits, then replays without false rollback", async () => {
    const body = await prepare();
    const release = await failConnectorSettlementAt(h.db, "audit");
    const response = await h.request("report", body);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "unavailable" });
    await release();
    expect((await h.services.tcgplayerCsv.readRun(body.runSettlement!.runId))?.state).toBe("abandoned");
    const committed = await h.effects();
    h.restart();
    const retry = await h.request("report", body);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe("{}");
    const after = await h.effects();
    expect(after.e1).toEqual(committed.e1);
    expect(after.e2).toEqual(committed.e2);
    expect(after.e3.length).toBe(committed.e3.length + 1);
  });
});
