import { expect, it } from "vitest";
import { Hono } from "hono";
import { createPostgresEventStore, withPgTransaction } from "@chase-sets/event-core-postgres";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { module as channelsModule } from "../../../index";
import { tcgplayerStagedImportDispatchPolicy } from "../api/staged-import-dispatch-policy";
import { decodeStagedImportDispatchPolicyResponse } from "../domain/staged-import-dispatch-policy";
import { connectorAuditRoutes } from "../domain/contracts";
import { connectorFeedSchemaMigrations } from "../read-model/schema";
import { describeDb, seller, target, transportContext, transportDatabase } from "./transport-test-support";

describeDb("staged-import-floor-policy-production", () => {
  const h = transportDatabase("staged_import_floor_8049");
  async function activate() {
    const eventStore = createPostgresEventStore({ pool: h.db });
    const result = await createPolicyRuntime({ eventStore, db: h.db }).createPolicyDocument(
      tcgplayerStagedImportDispatchPolicy,
      {
        status: "active",
        value: { minimumRequestStartIntervalSeconds: 60 },
        effectiveFrom: "2026-01-01T00:00:00Z",
        effectiveUntil: null,
        actorUserId: seller.userId,
      },
      transportContext,
    );
    const handlers = h.services.projectors.find(
      (row) => row.projectionName === "platform-policy-document-projection",
    )?.handlers;
    if (!handlers) throw new Error("missing-policy-producer");
    for (const event of await eventStore.readStream({ streamId: `platform-policy.document-${result.documentId}` }))
      await handlers[event.eventType]?.(toTransportEvent(event));
    return result.documentId;
  }
  async function reserve() {
    await h.enqueue("staged-floor-synthetic");
    const response = await h.request("claim");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reservation).not.toBeNull();
    return body.reservation.reservationId as string;
  }
  function read(reservationId: string, query = "", token = h.token) {
    const mount = channelsModule.buildApis(h.services).find((row) => row.mountPath === "/channel-connector/oauth");
    if (!(mount?.router instanceof Hono)) throw new Error("missing-credential-mount");
    return mount.router.request(
      `/tcgplayer-staged-import-dispatch-policy?reservationId=${reservationId}&requestNonce=${"a".repeat(32)}${query}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  }
  it("serves the real v1 producer with one audit, no heartbeat/reservation/report/ingest effects and content-only revisions", async () => {
    const documentId = await activate();
    const reservationId = await reserve();
    const before = await h.effects();
    const response = await read(reservationId);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const first = decodeStagedImportDispatchPolicyResponse(await response.json());
    expect(first).toMatchObject({
      schemaVersion: 1,
      connectionId: target.connectionId,
      pairingId: h.pairingId,
      reservationId,
      policy: { documentId, value: { minimumRequestStartIntervalSeconds: 60 } },
    });
    const after = await h.effects();
    expect(after.e1).toEqual(before.e1);
    expect(after.e2).toEqual(before.e2);
    expect(after.e3).toHaveLength(before.e3.length + 1);
    await h.db.query("UPDATE platform_policy_documents SET value=$2::jsonb WHERE document_id=$1", [
      documentId,
      JSON.stringify({ minimumRequestStartIntervalSeconds: 61 }),
    ]);
    const second = decodeStagedImportDispatchPolicyResponse(await (await read(reservationId)).json());
    expect(second.policy.revision).not.toBe(first.policy.revision);
    expect(second.policy.value.minimumRequestStartIntervalSeconds).toBe(61);
    expect(second.policy.documentId).toBe(first.policy.documentId);
  });
  it("never serves the compiled default, missing history or malformed active values", async () => {
    const reservationId = await reserve();
    expect(await (await read(reservationId)).json()).toEqual({ code: "staged-import-policy-unavailable" });
    const documentId = await activate();
    for (const value of [
      { minimumRequestStartIntervalSeconds: 59 },
      { minimumRequestStartIntervalSeconds: 60, extra: true },
      { minimumRequestStartIntervalSeconds: "60" },
    ]) {
      await h.db.query("UPDATE platform_policy_documents SET value=$2::jsonb WHERE document_id=$1", [
        documentId,
        JSON.stringify(value),
      ]);
      expect((await read(reservationId)).status).toBe(503);
    }
    await h.db.query("UPDATE platform_policy_documents SET value=$2::jsonb WHERE document_id=$1", [
      documentId,
      JSON.stringify({ minimumRequestStartIntervalSeconds: 60 }),
    ]);
    await h.db.query("DELETE FROM platform_policy_document_history WHERE document_id=$1", [documentId]);
    expect((await read(reservationId)).status).toBe(503);
  });
  it("refuses extra/duplicate query fields, foreign/missing reservations, missing credentials and current membership loss", async () => {
    await activate();
    const reservationId = await reserve();
    for (const query of ["&extra=1", "&requestNonce=bbbb", "&connectionId=foreign"])
      expect((await read(reservationId, query)).status).toBe(400);
    expect((await read("missing")).status).toBe(403);
    expect((await read(reservationId, "", "synthetic-invalid")).status).toBe(403);
    await h.membership(false);
    expect((await read(reservationId)).status).toBe(403);
    await h.membership(true);
    await h.pause();
    expect((await read(reservationId)).status).toBe(403);
  });
  it("refuses revoked grants and cannot transfer reservation authority to a replacement pairing", async () => {
    await activate();
    const reservationId = await reserve();
    await h.revokeAuthGrant();
    expect((await read(reservationId)).status).toBe(403);
    const replacement = await h.pair();
    expect((await read(reservationId, "", replacement.token)).status).toBe(403);
  });
  it("upgrades the existing audit constraint without changing retained rows or weakening route closure", async () => {
    await activate();
    const reservationId = await reserve();
    const existingRoutes = connectorAuditRoutes.filter((route) => route !== "tcgplayer-staged-import-dispatch-policy");
    await withPgTransaction(h.db, async (db) => {
      await db.query("ALTER TABLE channel_connector_audit DROP CONSTRAINT channel_connector_audit_route_check");
      await db.query(
        `ALTER TABLE channel_connector_audit ADD CONSTRAINT channel_connector_audit_route_check CHECK (route IN (${existingRoutes.map((route) => `'${route}'`).join(",")}))`,
      );
    });
    expect((await read(reservationId)).status).toBe(503);
    const before = await h.db.query("SELECT * FROM channel_connector_audit ORDER BY request_id");
    const migration = connectorFeedSchemaMigrations.find(
      (row) => row.migrationId === "20261010_channels_staged_import_policy_audit_route",
    );
    if (!migration) throw new Error("missing-audit-route-migration");
    await withPgTransaction(h.db, async (db) => {
      for (const sql of migration.statements) await db.query(sql);
    });
    expect((await h.db.query("SELECT * FROM channel_connector_audit ORDER BY request_id")).rows).toEqual(before.rows);
    expect((await read(reservationId)).status).toBe(200);
    await expect(
      h.db.query(
        "INSERT INTO channel_connector_audit VALUES ('synthetic-invalid',NULL,NULL,'unknown','refused','unavailable',now())",
      ),
    ).rejects.toThrow();
  });
});
