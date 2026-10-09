import { expect, it, vi } from "vitest";
import { channelProviderRegistry } from "@chase-sets/channels";
import { createChannelsReconciliationRunners } from "../src/channels-reconciliation-runners";
import {
  describeDb,
  livenessWorkerDatabase,
  syntheticInlineRegistry,
  target,
  transportContext,
} from "./channels-liveness-test-support";

describeDb("channel-connector-liveness-hold-path", () => {
  const f = livenessWorkerDatabase("worker_liveness_hold_7934");

  async function prepare() {
    await f.poll();
    // A timely pass is inert, including its health stream and observations.
    const steady = await f.livenessRows();
    expect((await f.sweep("2026-10-07T12:00:01.000Z")).processed).toBe(0);
    expect(await f.livenessRows()).toEqual(steady);
    await f.h.enqueue("inline_liveness");
    await f.h.enqueue("claimed_liveness");
    const pending = await f.operations();
    expect(pending).toHaveLength(2);
    expect(pending).toEqual(pending.map((operation) => ({ ...operation, status: "pending", attempt_count: 0 })));
    const lifecycle = () =>
      f.h.db.query(
        "SELECT event_type,stream_version FROM event_store_events WHERE stream_id=$1 ORDER BY stream_version",
        [`channels.connection-${target.connectionId}`],
      );
    const sellerHistory = await lifecycle();
    expect((await f.sweep()).processed).toBe(1);
    expect(await lifecycle()).toEqual(sellerHistory);
    expect(await f.h.services.connectionHealth.readConnectionHealth(target)).toMatchObject({
      connection: { status: "active" },
      health: { state: "failing" },
      systemPaused: true,
    });
    return pending;
  }

  function reserve() {
    return f.h.services.outboundSync.reserveClaimedOutboundOperations({
      registry: channelProviderRegistry,
      connectionId: target.connectionId,
      claimant: { claimantKind: "connector", claimantId: f.h.pairingId },
      maxOperations: 1,
      leaseMs: 60_000,
    });
  }

  async function reconcile(provider: ReturnType<typeof syntheticInlineRegistry>) {
    await f.h.db.query(
      "UPDATE platform_scheduled_runners SET next_run_at=now()-interval '1 minute' WHERE runner_name='channels-drift-reconciliation'",
    );
    await f.h.db.query("UPDATE channel_reconciliation_state SET next_due_at=$1", [new Date().toISOString()]);
    const runner = createChannelsReconciliationRunners({
      services: f.h.services,
      controlPlane: f.controlPlane(),
      registry: provider.registry,
    })[0]!;
    await runner.runOnce();
  }

  async function held(pending: Awaited<ReturnType<typeof f.operations>>, paused = false) {
    const provider = syntheticInlineRegistry();
    expect(
      await f.h.services.outboundSync.processNextInlineOperation({
        registry: provider.registry,
        claimOwnerId: "synthetic-liveness",
      }),
    ).toBe(0);
    expect((await f.poll()).reservation).toBeNull();
    if (paused) await expect(reserve()).rejects.toMatchObject({ code: "connection-not-active" });
    else expect(await reserve()).toBeNull();
    await reconcile(provider);
    expect(provider.write).not.toHaveBeenCalled();
    expect(provider.fetchChannelState).not.toHaveBeenCalled();
    expect(provider.fetchSales).not.toHaveBeenCalled();
    expect(await f.operations()).toEqual(pending);
  }

  const inbound = {
    inboundKind: "order",
    externalReference: "synthetic-liveness-inbound",
    payload: { version: 1, records: [{ order: "synthetic", revision: 1 }] },
  };

  it.each(["inline", "claimed", "reconciliation", "inbound"] as const)(
    "holds every admission without consuming work and kills the %s omission mutant",
    async (omission) => {
      const pending = await prepare();
      await held(pending);
      expect((await f.h.request("ingest", inbound)).status).toBe(202);
      expect(
        (
          await f.h.services.connectorFeed.readAdmittedConnectorInboundEvents({
            connectionId: target.connectionId,
            inboundKind: "order",
          })
        ).events,
      ).toHaveLength(1);
      expect(await f.status(target.connectionId)).toBe("active");
      f.h.restart(omission !== "inbound");
      if (omission === "inbound")
        vi.spyOn(f.h.services.connectorFeed, "ingest").mockRejectedValue(new Error("synthetic-inbound-rejected"));
      const provider = syntheticInlineRegistry();
      if (omission === "inline") {
        expect(
          await f.h.services.outboundSync.processNextInlineOperation({
            registry: provider.registry,
            claimOwnerId: "synthetic-mutant",
          }),
        ).toBeGreaterThan(0);
        expect(provider.write).toHaveBeenCalled();
        expect(await f.operations()).not.toEqual(pending);
      } else if (omission === "claimed") {
        expect(await reserve()).not.toBeNull();
        expect((await f.poll()).reservation).not.toBeNull();
        expect(
          (await f.operations()).every(
            (operation) => operation.status === "in-flight" && operation.attempt_count === 1,
          ),
        ).toBe(true);
      } else if (omission === "reconciliation") {
        await reconcile(provider);
        expect(provider.fetchChannelState).toHaveBeenCalledTimes(1);
        expect(provider.fetchSales).toHaveBeenCalledTimes(1);
      } else {
        expect(
          (await f.h.request("ingest", { ...inbound, externalReference: "synthetic-inbound-mutant" })).status,
        ).not.toBe(202);
      }
      expect(await f.status(target.connectionId)).toBe("active");
    },
  );

  it("one heartbeat and one registered pass resume the retained operations, then remain inert", async () => {
    await prepare();
    expect((await f.poll()).reservation).toBeNull();
    expect((await f.sweep()).processed).toBe(1);
    expect(await f.h.services.connectionHealth.readConnectionHealth(target)).toMatchObject({
      health: { state: "healthy" },
      systemPaused: false,
    });
    const stable = await f.livenessRows();
    expect((await f.sweep()).processed).toBe(0);
    expect(await f.livenessRows()).toEqual(stable);
    const claim = await reserve();
    expect(claim?.operations).toHaveLength(1);
    if (!claim) throw new Error("missing-recovered-reservation");
    const provider = syntheticInlineRegistry();
    expect(
      await f.h.services.outboundSync.processNextInlineOperation({
        registry: provider.registry,
        claimOwnerId: "synthetic-recovery",
      }),
    ).toBe(1);
    expect(provider.write).toHaveBeenCalledTimes(1);
    const reported = await f.h.request("report", {
      reservationId: claim.reservationId,
      outcomes: claim.operations.map(
        (operation: {
          operationId: string;
          attemptId: string;
          claimGeneration: number;
          desiredStateSequence: number;
        }) => ({
          operationId: operation.operationId,
          attemptId: operation.attemptId,
          claimGeneration: operation.claimGeneration,
          desiredStateSequence: operation.desiredStateSequence,
          outcome: { kind: "applied", result: { kind: "succeeded", externalListingId: "synthetic-claimed-recovery" } },
        }),
      ),
    });
    expect(reported.status).toBe(200);
    expect(
      (await f.operations()).every((operation) => operation.status === "succeeded" && operation.attempt_count === 1),
    ).toBe(true);
    expect(await f.status(target.connectionId)).toBe("active");
  });

  it.each(["other-reason", "seller-pause"] as const)("recovery retains %s and kills unsafe resume", async (hold) => {
    const pending = await prepare();
    if (hold === "other-reason") {
      for (const attempt of [1, 2, 3]) await f.h.observation(target.connectionId, "drift", "failure", attempt);
    } else {
      await f.h.services.connections.pauseChannelConnection(target, transportContext);
      await f.h.projectConnection();
    }
    const before = await f.h.services.connectionHealth.listOpenReasonGenerations(target);
    await f.poll();
    expect((await f.sweep()).processed).toBe(hold === "other-reason" ? 1 : 0);
    const after = await f.h.services.connectionHealth.listOpenReasonGenerations(target);
    if (hold === "other-reason") {
      expect(after).toEqual(before.filter((reason) => reason.reasonCode !== "connector-liveness"));
      expect(after.find((reason) => reason.reasonCode === "drift")?.state).toBe("failing");
    } else expect(after).toEqual(before);
    await held(pending, hold === "seller-pause");
    const rows = await f.livenessRows();
    expect((await f.sweep()).processed).toBe(0);
    expect(await f.livenessRows()).toEqual(rows);
    f.h.restart(true, hold === "seller-pause");
    const provider = syntheticInlineRegistry();
    expect(
      await f.h.services.outboundSync.processNextInlineOperation({
        registry: provider.registry,
        claimOwnerId: "synthetic-unsafe-resume",
      }),
    ).toBeGreaterThan(0);
    expect(provider.write).toHaveBeenCalled();
    expect(await f.operations()).not.toEqual(pending);
    expect(await f.status(target.connectionId)).toBe(hold === "seller-pause" ? "paused" : "active");
  });
});
