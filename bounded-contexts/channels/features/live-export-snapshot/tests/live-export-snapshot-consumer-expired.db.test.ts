import { expect, it } from "vitest";
import { connectorPolicyDefaults } from "../../connector-feed/domain/policy";
import { createConnectorInboundReader } from "../../connector-feed/read-model/inbound";
import { consumerMutant } from "./mutants";
import {
  admitExport,
  connectionId,
  consumerProgress,
  describeDb,
  expirePayload,
  liveExport,
  liveExportDatabase,
  liveExportRuntime,
  snapshotEffects,
} from "./test-support";

describeDb("live-export-snapshot-consumer-expired", () => {
  const h = liveExportDatabase("live_export_snapshot_expired");
  const payload = liveExport("2026-10-10T11:00:00.000Z");

  it("expired advances the cursor without persisting or relabeling an older snapshot", async () => {
    await admitExport(h.db, "older", payload);
    await liveExportRuntime(h.db).consumeConnection(connectionId);
    const before = await snapshotEffects(h.db);
    const progress = await consumerProgress(h.db);
    const id = await admitExport(h.db, "expired", payload);
    await expirePayload(h.db, id);
    expect(await liveExportRuntime(h.db).consumeConnection(connectionId)).toBe(0);
    expect(await snapshotEffects(h.db)).toEqual(before);
    expect((await consumerProgress(h.db))?.cursor).not.toEqual(progress?.cursor);
    const after = await consumerProgress(h.db);
    await liveExportRuntime(h.db).consumeConnection(connectionId);
    expect(await consumerProgress(h.db)).toEqual(after);
  });

  it("expired-as-available bypass is caught by the no-snapshot assertion", async () => {
    const id = await admitExport(h.db, "expired", payload);
    await expirePayload(h.db, id);
    const before = await snapshotEffects(h.db);
    const mutant = consumerMutant(
      'if (event.content.state === "expired") return { kind: "expired" };',
      `if (event.content.state === "expired") return { kind: "snapshot", snapshotId: liveExportSnapshotId(event.providerEventId), payload: ${JSON.stringify(payload)} };`,
    );
    expect(await liveExportRuntime(h.db, {}, mutant).consumeConnection(connectionId)).toBe(1);
    expect(await snapshotEffects(h.db)).not.toEqual(before);
  });

  it("effective-policy re-assertion refuses the available payload and advances past it", async () => {
    await admitExport(
      h.db,
      "refused",
      liveExport(payload.capturedAt, [
        { productId: "1", quantity: "1", price: "1.00", condition: "Near Mint" },
        { productId: "2", quantity: "1", price: "1.00", condition: "Near Mint" },
      ]),
    );
    const before = await snapshotEffects(h.db);
    const policy = { resolveConnectorPolicy: async () => ({ ...connectorPolicyDefaults, maxIngestRecords: 1 }) };
    expect(await liveExportRuntime(h.db, policy).consumeConnection(connectionId)).toBe(0);
    expect(await snapshotEffects(h.db)).toEqual(before);
    const cursor = (await consumerProgress(h.db))?.cursor;
    expect(cursor).toBeTruthy();
    // Relaxing policy on a later tick does not resurrect an event already passed as invalid.
    expect(await liveExportRuntime(h.db).consumeConnection(connectionId)).toBe(0);
    expect(await snapshotEffects(h.db)).toEqual(before);
    await h.db.query("UPDATE channel_live_export_consumer SET cursor=NULL");
    const mutant = consumerMutant('return { kind: "refused" };', 'throw new Error("refused-holds-cursor");');
    await expect(liveExportRuntime(h.db, policy, mutant).consumeConnection(connectionId)).rejects.toThrow(
      "refused-holds-cursor",
    );
    expect((await consumerProgress(h.db))?.cursor).toBeNull();
  });

  it("incomplete page holds all state; bypassing completeness persists a forbidden snapshot", async () => {
    await admitExport(h.db, "incomplete", payload);
    const read = createConnectorInboundReader(h.db);
    const incomplete = {
      readAdmittedConnectorInboundEvents: async (input: Parameters<typeof read>[0]) => ({
        ...(await read(input)),
        completeness: { kind: "bounded-incomplete" as const, reason: "identity-count-mismatch" as const },
      }),
    };
    const before = await snapshotEffects(h.db);
    expect(await liveExportRuntime(h.db, incomplete).consumeConnection(connectionId)).toBe(0);
    expect(await consumerProgress(h.db)).toBeUndefined();
    expect(await snapshotEffects(h.db)).toEqual(before);
    const mutant = consumerMutant('if (page.completeness.kind !== "complete") return 0;', "/* completeness bypass */");
    expect(await liveExportRuntime(h.db, incomplete, mutant).consumeConnection(connectionId)).toBe(1);
    expect(await snapshotEffects(h.db)).not.toEqual(before);
  });
});
