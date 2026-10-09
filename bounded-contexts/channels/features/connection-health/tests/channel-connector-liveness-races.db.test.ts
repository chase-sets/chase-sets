import { expect, it, vi } from "vitest";
import {
  loadProjectionGroupGeneration,
  resetProjectionGroup,
  syncProjectionGroup,
} from "@chase-sets/bounded-context-runtime";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { buildChannelConnectionProjectionHandlers } from "../../connections/read-model/projection";
import { channelHealthPolicy } from "../domain/policy";
import {
  barrier,
  describeDb,
  livenessDatabase,
  seller,
  target,
  transportContext,
} from "./connector-liveness-test-support";

describeDb("channel-connector-liveness-races", () => {
  const f = livenessDatabase("liveness_races_7933");

  it("policy projection waits when the complete admitted snapshot owns the policy share lock", async () => {
    await f.poll();
    const locked = barrier();
    const release = barrier();
    const original = f.dependencies.resolvePolicy;
    let reads = 0;
    vi.spyOn(f.dependencies, "resolvePolicy").mockImplementation(async (db, at) => {
      const policy = await original(db, at);
      if (++reads === 2) {
        locked.release();
        await release.promise;
      }
      return policy;
    });
    const sweep = f.sweep();
    let writer: Promise<unknown> | undefined;
    try {
      await locked.promise;
      writer = f.h.policy({ ...channelHealthPolicy.defaultValue, failureBudgetCount: 7 });
      await expect
        .poll(
          async () =>
            (
              await f.h.db.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%platform_policy_documents%' AND pid<>pg_backend_pid()",
              )
            ).rows.length,
        )
        .toBeGreaterThan(0);
      release.release();
      expect((await sweep).accepted).toBe(1);
      await writer;
      const before = await f.effects();
      expect((await f.sweep()).accepted).toBe(0);
      expect(await f.effects()).toEqual(before);
    } finally {
      release.release();
      await sweep;
      if (writer) await writer;
    }
  });

  it.each(["heartbeat", "re-pair", "unpair", "policy", "paused", "disconnected"] as const)(
    "writer-first %s invalidates the complete unlocked failure snapshot",
    async (operation) => {
      await f.poll();
      const read = barrier();
      const release = barrier();
      const original = f.h.services.connectorFeed.listConnectorLivenessCandidates;
      vi.spyOn(f.h.services.connectorFeed, "listConnectorLivenessCandidates").mockImplementationOnce(async (query) => {
        const page = await original(query);
        read.release();
        await release.promise;
        return page;
      });
      const sweep = f.sweep();
      try {
        await read.promise;
        if (operation === "heartbeat") await f.poll();
        if (operation === "re-pair") await f.h.services.connectorFeed.createPairingCode(target, seller);
        if (operation === "unpair") await f.h.services.connectorFeed.unpair(target, f.h.pairingId, 2, seller);
        if (operation === "policy") await f.h.policy({ ...channelHealthPolicy.defaultValue, failureBudgetCount: 7 });
        if (operation === "paused") await f.h.pause();
        if (operation === "disconnected") {
          await f.h.services.connections.disconnectChannelConnection(target, transportContext);
          await f.h.projectConnection();
        }
        const before = await f.effects();
        release.release();
        expect((await sweep).accepted).toBe(0);
        expect(await f.effects()).toEqual(before);
        if (operation === "policy") expect((await f.sweep()).accepted).toBe(1);
        else expect((await f.sweep()).accepted).toBe(0);
      } finally {
        release.release();
        await sweep;
      }
    },
  );

  it.each(["heartbeat", "re-pair", "unpair", "policy"] as const)(
    "sweep-first %s waits behind admission and the next sweep has the correct terminal ordinal",
    async (operation) => {
      await f.poll();
      const locked = barrier();
      const release = barrier();
      const original = f.h.services.connectorFeed.readConnectorLivenessAuthorityInTransaction;
      vi.spyOn(f.h.services.connectorFeed, "readConnectorLivenessAuthorityInTransaction").mockImplementationOnce(
        async (db, query) => {
          const authority = await original(db, query);
          locked.release();
          await release.promise;
          return authority;
        },
      );
      const sweep = f.sweep();
      let writer: Promise<unknown> | undefined;
      try {
        await locked.promise;
        writer =
          operation === "heartbeat"
            ? f.h.request("claim")
            : operation === "re-pair"
              ? f.h.services.connectorFeed.createPairingCode(target, seller)
              : operation === "unpair"
                ? f.h.services.connectorFeed.unpair(target, f.h.pairingId, 2, seller)
                : f.h.policy({ ...channelHealthPolicy.defaultValue, failureBudgetCount: 7 });
        // Health policy is locked later than authority; when it wins there, the sweep must refuse.
        if (operation === "policy") {
          await writer;
          release.release();
          expect((await sweep).accepted).toBe(0);
          expect((await f.sweep()).accepted).toBe(1);
        } else {
          await expect
            .poll(
              async () =>
                (
                  await f.h.db.query(
                    "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()",
                  )
                ).rows.length,
            )
            .toBeGreaterThan(0);
          release.release();
          expect((await sweep).accepted).toBe(1);
          await writer;
          expect((await f.sweep()).accepted).toBe(1);
          expect(await f.observations()).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                outcome: "success",
                resultOrdinal: operation === "heartbeat" ? 2 : operation === "re-pair" ? 3 : 4,
              }),
            ]),
          );
          expect(await f.open()).toBeUndefined();
        }
      } finally {
        release.release();
        await sweep;
        if (writer) await writer;
      }
    },
  );

  it.each(["writer-first", "sweep-first"] as const)(
    "null pairing is a locked value, not a token: %s re-pair",
    async (order) => {
      await f.poll();
      await f.sweep();
      await f.h.services.connectorFeed.unpair(target, f.h.pairingId, 2, seller);
      const read = barrier();
      const release = barrier();
      if (order === "writer-first") {
        const original = f.h.services.connectorFeed.readConnectorLivenessAuthority;
        vi.spyOn(f.h.services.connectorFeed, "readConnectorLivenessAuthority").mockImplementationOnce(async (query) => {
          const authority = await original(query);
          read.release();
          await release.promise;
          return authority;
        });
      } else {
        const original = f.h.services.connectorFeed.readConnectorLivenessAuthorityInTransaction;
        vi.spyOn(f.h.services.connectorFeed, "readConnectorLivenessAuthorityInTransaction").mockImplementationOnce(
          async (db, query) => {
            const authority = await original(db, query);
            read.release();
            await release.promise;
            return authority;
          },
        );
      }
      const sweep = f.sweep();
      let writer: Promise<unknown> | undefined;
      try {
        await read.promise;
        writer = f.h.services.connectorFeed.createPairingCode(target, seller);
        if (order === "writer-first") {
          await writer;
          release.release();
          expect((await sweep).accepted).toBe(0);
          expect((await f.sweep()).accepted).toBe(1);
        } else {
          await expect
            .poll(
              async () =>
                (
                  await f.h.db.query(
                    "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()",
                  )
                ).rows.length,
            )
            .toBeGreaterThan(0);
          release.release();
          expect((await sweep).accepted).toBe(1);
          await writer;
          expect((await f.sweep()).accepted).toBe(0);
        }
        expect(await f.observations()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ outcome: "success", resultOrdinal: order === "writer-first" ? 3 : 4 }),
          ]),
        );
        const stable = await f.effects();
        await f.sweep();
        expect(await f.effects()).toEqual(stable);
      } finally {
        release.release();
        await sweep;
        if (writer) await writer;
      }
    },
  );

  it.each([
    { status: "paused", closing: false },
    { status: "paused", closing: true },
    { status: "disconnected", closing: false },
    { status: "disconnected", closing: true },
  ] as const)(
    "the real $status projector UPDATE cannot pass locked admission, closing=$closing",
    async ({ status, closing }) => {
      await f.poll();
      if (closing) await f.sweep();
      const open = await f.open();
      if (closing) await f.poll();
      const snapshot = barrier();
      const continueCandidate = barrier();
      if (closing) {
        const read = f.h.services.connectorFeed.readConnectorLivenessAuthority;
        vi.spyOn(f.h.services.connectorFeed, "readConnectorLivenessAuthority").mockImplementationOnce(async (query) => {
          const authority = await read(query);
          snapshot.release();
          await continueCandidate.promise;
          return authority;
        });
      } else {
        const read = f.h.services.connectorFeed.listConnectorLivenessCandidates;
        vi.spyOn(f.h.services.connectorFeed, "listConnectorLivenessCandidates").mockImplementationOnce(
          async (query) => {
            const page = await read(query);
            snapshot.release();
            await continueCandidate.promise;
            return page;
          },
        );
      }
      const locked = barrier();
      const release = barrier();
      const original = f.h.services.connectorFeed.readConnectorLivenessAuthorityInTransaction;
      vi.spyOn(f.h.services.connectorFeed, "readConnectorLivenessAuthorityInTransaction").mockImplementationOnce(
        async (db, query) => {
          const authority = await original(db, query);
          locked.release();
          await release.promise;
          return authority;
        },
      );
      const sweep = f.sweep();
      await snapshot.promise;
      if (status === "paused") await f.h.services.connections.pauseChannelConnection(target, transportContext);
      else await f.h.services.connections.disconnectChannelConnection(target, transportContext);
      const events = await createPostgresEventStore({ pool: f.h.db }).readStream({
        streamId: `channels.connection-${target.connectionId}`,
      });
      const event = events.filter((entry) => entry.eventType === `channels.connection.${status}`).at(-1)!;
      const handlers = buildChannelConnectionProjectionHandlers(f.h.db);
      continueCandidate.release();
      let writer: Promise<void> | undefined;
      try {
        await locked.promise;
        writer = handlers[event.eventType](toTransportEvent(event));
        await expect
          .poll(
            async () =>
              (
                await f.h.db.query(
                  "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%UPDATE channel_connections%' AND pid<>pg_backend_pid()",
                )
              ).rows.length,
          )
          .toBeGreaterThan(0);
        release.release();
        // The landed intake also freezes on canonical lifecycle history, before its projection catches up.
        expect((await sweep).accepted).toBe(0);
        await writer;
        expect(await f.open()).toEqual(open);
        const stable = await f.effects();
        await f.sweep();
        expect(await f.effects()).toEqual(stable);
      } finally {
        release.release();
        await sweep;
        if (writer) await writer;
      }
    },
  );

  it("real reset blocks due failures and closes while its marker is rebuilding, even with an active row", async () => {
    await f.poll();
    await resetProjectionGroup(f.group);
    await f.h.projectConnection();
    expect(
      await loadProjectionGroupGeneration(f.h.db, {
        targetContextName: "channels",
        projectionName: "channel-connection-projection",
      }),
    ).toMatchObject({ state: "rebuilding" });
    const before = await f.effects();
    expect((await f.sweep()).refusals).toEqual([
      { connectionId: target.connectionId, reason: "connection-projection-rebuilding" },
    ]);
    expect(await f.effects()).toEqual(before);
    await syncProjectionGroup(f.group);
    expect((await f.sweep()).accepted).toBe(1);
    await f.poll();
    await resetProjectionGroup(f.group);
    await f.h.projectConnection();
    const open = await f.effects();
    expect((await f.sweep()).accepted).toBe(0);
    expect(await f.effects()).toEqual(open);
    await syncProjectionGroup(f.group);
    expect((await f.sweep()).accepted).toBe(1);
  });

  it("missing authority under an open reason refuses; recovery cannot clear other reasons or seller pause", async () => {
    await f.poll();
    await f.sweep();
    await f.h.observation(target.connectionId, "polling", "failure");
    const other = (await f.health.listOpenReasonGenerations(target)).find((reason) => reason.reasonCode === "polling");
    await f.poll();
    await f.sweep();
    expect(
      (await f.health.listOpenReasonGenerations(target)).find((reason) => reason.reasonCode === "polling"),
    ).toEqual(other);
    await f.sweep("2026-10-07T12:02:00.000Z");
    await f.h.db.query("DELETE FROM channel_connector_liveness_authority");
    const before = await f.effects();
    expect((await f.sweep("2026-10-07T12:02:00.000Z")).refusals).toEqual([
      { connectionId: target.connectionId, reason: "authority-missing" },
    ]);
    expect(await f.effects()).toEqual(before);
    await f.h.pause();
    const paused = await f.effects();
    await f.sweep();
    expect(await f.effects()).toEqual(paused);
  });
});
