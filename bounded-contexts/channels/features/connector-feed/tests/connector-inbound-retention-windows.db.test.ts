import { expect, it, vi } from "vitest";
import type { BcRetentionSweep } from "@chase-sets/bounded-context-module";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createRetentionSweepRunner } from "@chase-sets/platform-runtime/retention-sweep";
import { describeDb, target, transportDatabase } from "./transport-test-support";
import {
  admit,
  ageAdmission,
  drain,
  exportInbound,
  frozenAt,
  inRolledBackTransaction,
  inventorySnapshotSweep,
  mutant,
  orderInbound,
  orderObservationSweep,
  payloadIds,
  placeAdmission,
  identityRows,
} from "./retention-test-support";

const HOUR = 3_600;
const ZONES = ["UTC", "America/Chicago"] as const;
const UNPAIRED = "connection_retention_unpaired";

describeDb("connector-inbound-retention-windows", () => {
  const h = transportDatabase("connector_retention_windows_8592");

  async function survivors(
    sweep: BcRetentionSweep,
    timeZone: string,
    ages: ReadonlyMap<string, number>,
  ): Promise<string[]> {
    return inRolledBackTransaction(h.db, timeZone, async (db: PgQueryable) => {
      expect((await db.query<{ zone: string }>("SELECT current_setting('TimeZone') AS zone")).rows[0]?.zone).toBe(
        timeZone,
      );
      for (const [id, secondsAgo] of ages) await ageAdmission(db, id, secondsAgo);
      await drain(db, sweep);
      return payloadIds(db);
    });
  }

  // Admits a boundary set for one class, then moves the connection through
  // pause, membership loss and grant revocation: eligibility ignores all of it.
  async function boundaryMatrix(windowSeconds: number, kind: "export" | "order") {
    const inbound = kind === "export" ? exportInbound : orderInbound;
    const other = kind === "export" ? orderInbound : exportInbound;
    const ids = {
      minus: await admit(h.db, target.connectionId, inbound(`${kind}.deadline-minus-1s`)),
      at: await admit(h.db, target.connectionId, inbound(`${kind}.deadline-exact`)),
      plus: await admit(h.db, target.connectionId, inbound(`${kind}.deadline-plus-1s`)),
      unpairedPlus: await admit(h.db, UNPAIRED, inbound(`${kind}.unpaired-plus-1s`)),
      otherClassPlus: await admit(h.db, target.connectionId, other(`${kind}.other-class-plus-1s`)),
    };
    await h.pause();
    await h.membership(false);
    await h.revokeAuthGrant();
    const ages = new Map([
      [ids.minus, windowSeconds - 1],
      [ids.at, windowSeconds],
      [ids.plus, windowSeconds + 1],
      [ids.unpairedPlus, windowSeconds + 1],
      [ids.otherClassPlus, windowSeconds + 1],
    ]);
    const expected = [ids.minus, ids.at, ids.otherClassPlus].sort();
    return { ids, ages, expected };
  }

  it.each([
    ["inventory-snapshot", inventorySnapshotSweep, 604_800, "export"],
    ["order-observation", orderObservationSweep, 7_776_000, "order"],
  ] as const)(
    "%s retains at deadline-1s and exactly the deadline, deletes at +1s in every state and session zone",
    async (_class, sweep, windowSeconds, kind) => {
      const { ages, expected } = await boundaryMatrix(windowSeconds, kind);
      const identitiesBefore = await identityRows(h.db);
      for (const zone of ZONES) expect(await survivors(sweep, zone, ages)).toEqual(expected);
      const mutants = {
        early: mutant(sweep, `secs => ${windowSeconds})`, `secs => ${windowSeconds - 1})`),
        late: mutant(sweep, `secs => ${windowSeconds})`, `secs => ${windowSeconds + 1})`),
        inclusive: mutant(sweep, "candidate.received_at <", "candidate.received_at <="),
      };
      for (const [name, candidate] of Object.entries(mutants))
        expect({ name, survivors: await survivors(candidate, "UTC", ages) }).not.toEqual({ name, survivors: expected });
      expect(await identityRows(h.db)).toEqual(identitiesBefore);
    },
  );

  it("keeps a 6.5-day inventory snapshot through a committed production-runner pass that expires the 7-day+1h one", async () => {
    const control = await admit(h.db, target.connectionId, exportInbound("export.six-and-a-half-days"));
    const expired = await admit(h.db, target.connectionId, exportInbound("export.seven-days-plus-1s"));
    const fresh = await admit(h.db, target.connectionId, orderInbound("order.fresh"));
    // Ages are anchored to one statement's clock; the runner's later DELETE clock only moves forward,
    // so a 12-hour margin keeps the control strictly inside its window.
    await ageAdmission(h.db, control, 561_600);
    await ageAdmission(h.db, expired, 604_800 + HOUR);
    await ageAdmission(h.db, fresh, HOUR);
    const runner = createRetentionSweepRunner({
      controlPlane: {
        claimScheduledRunner: vi.fn().mockResolvedValue(true),
        recordScheduledRunnerCompleted: vi.fn().mockResolvedValue(undefined),
      },
      targets: [inventorySnapshotSweep, orderObservationSweep].map((sweep) => ({
        contextName: "channels",
        db: h.db,
        sweep,
      })),
    });
    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 1 });
    expect(await payloadIds(h.db)).toEqual([control, fresh].sort());
    const page = await h.services.connectorFeed.readAdmittedConnectorInboundEvents({
      connectionId: target.connectionId,
      inboundKind: "export",
    });
    expect(page.completeness).toEqual({ kind: "complete", total: 2 });
    expect(page.events.map((event) => [event.externalReference, event.content.state])).toEqual([
      ["export.six-and-a-half-days", "available"],
      ["export.seven-days-plus-1s", "expired"],
    ]);
  });

  it("measures elapsed seconds across the spring 2026 DST change in UTC and America/Chicago; calendar-day mutants fail", async () => {
    // 2026-03-08 02:00 America/Chicago springs forward; seven local days before
    // 2026-03-12 12:00 CDT is only 167 elapsed hours, and ninety local days
    // before 2026-05-01 12:00 CDT is only 2159 elapsed hours.
    const cases = [
      { sweep: inventorySnapshotSweep, now: "2026-03-12T17:00:00Z", windowHours: 168, days: 7, kind: "export" },
      { sweep: orderObservationSweep, now: "2026-05-01T17:00:00Z", windowHours: 2_160, days: 90, kind: "order" },
    ] as const;
    for (const { sweep, now, windowHours, days, kind } of cases) {
      const inbound = kind === "export" ? exportInbound : orderInbound;
      const instant = (secondsBefore: number) => new Date(Date.parse(now) - secondsBefore * 1_000).toISOString();
      const rows = {
        calendarDeadline: [
          await admit(h.db, target.connectionId, inbound(`${kind}.dst-calendar`)),
          (windowHours - 1) * HOUR,
        ],
        betweenDeadlines: [
          await admit(h.db, target.connectionId, inbound(`${kind}.dst-between`)),
          (windowHours - 1) * HOUR + 1_800,
        ],
        elapsedDeadline: [await admit(h.db, target.connectionId, inbound(`${kind}.dst-elapsed`)), windowHours * HOUR],
        afterDeadline: [await admit(h.db, target.connectionId, inbound(`${kind}.dst-after`)), windowHours * HOUR + 1],
      } as const;
      const expected = [rows.calendarDeadline[0], rows.betweenDeadlines[0], rows.elapsedDeadline[0]].sort();
      const run = (candidate: BcRetentionSweep, zone: string) =>
        inRolledBackTransaction(h.db, zone, async (db) => {
          for (const [id, secondsBefore] of Object.values(rows)) await placeAdmission(db, id, instant(secondsBefore));
          await drain(db, frozenAt(candidate, now));
          return (await payloadIds(db)).filter((id) => id.includes(".dst-"));
        });
      for (const zone of ZONES) expect(await run(sweep, zone)).toEqual(expected);
      const calendar = mutant(sweep, /make_interval\(secs => \d+\)/, `interval '${days} days'`);
      expect(await run(calendar, "UTC")).toEqual(expected);
      expect(await run(calendar, "America/Chicago")).not.toEqual(expected);
      expect(await run(calendar, "America/Chicago")).not.toContain(rows.betweenDeadlines[0]);
      await h.db.query("DELETE FROM channel_connector_inbound_payloads WHERE provider_event_id LIKE '%.dst-%'");
    }
  });
});
