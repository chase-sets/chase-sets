import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitScheduleRoles, prepareScheduleSnapshot, reconstructScheduleBridge } from "./c1-schedule-bridge.mjs";
import { sha256 } from "./census-terminal-evidence.mjs";

const hash = (value) => sha256(JSON.stringify(value));
const before = "2030-01-01T00:00:00.000Z";
const d = "2030-01-01T01:00:00.000Z";
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(resolve(root).startsWith(`${resolve(tmpdir())}${sep}synthetic-c1-schedule-`)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "synthetic-c1-schedule-"));
  roots.push(root);
  const plan = {
    root,
    oneFreshArm: { consumed: false, dispatch: null },
    roles: Object.fromEntries(
      ["timestamp", "schedule", "executor"].map((role) => [
        role,
        {
          identity: `synthetic-${role}`,
          capabilityHash: hash(role),
        },
      ]),
    ),
    original: { custodian: "synthetic-original", destination: join(root, "original") },
    backup: { custodian: "synthetic-backup", destination: join(root, "backup") },
    observationBinding: { sourceHash: hash("source"), capabilityHash: hash("capability") },
    histories: Object.fromEntries(
      ["opportunity", "oneFreshArm", "sizingWindows", "lifetimeAttempts", "consumedHeads", "blockingRounds"].map(
        (key) => [key, hash(key)],
      ),
    ),
    validFrom: before,
    expiresAt: "2030-01-02T00:00:00.000Z",
  };
  const authority = { approvedPlanHash: hash(plan) };
  const ready = Object.fromEntries(
    Object.entries(plan.roles).map(([role, value]) => [
      role,
      {
        ...value,
        acknowledge: ({ planHash }) => ({ ...value, planHash, at: before, expiresAt: plan.expiresAt }),
      },
    ]),
  );
  const custody = Object.fromEntries(
    ["original", "backup"].map((key) => [
      key,
      {
        ...plan[key],
        acknowledge: ({ planHash }) => ({ ...plan[key], planHash, at: before, expiresAt: plan.expiresAt }),
      },
    ]),
  );
  const options = { root, plan, authority };
  return {
    root,
    plan,
    authority,
    ready,
    custody,
    options,
    admit: () => admitScheduleRoles(options, { roles: ready, custody, now: () => before }),
    prepare: () =>
      prepareScheduleSnapshot(
        { root, authority, binding: { synthetic: true }, seal: { synthetic: true }, rawD: d },
        { now: () => d },
      ),
  };
}

describe("ready role admission", () => {
  it("binds three actual capability acknowledgements and two lawful destinations before bracket", async () => {
    const f = fixture();
    expect((await f.admit()).state).toBe("READY");
    const persisted = JSON.parse(readFileSync(join(f.root, "readiness.json")));
    expect(persisted.plan).toEqual(f.plan);
    expect(Object.keys(persisted.acknowledgements)).toHaveLength(5);
    expect((await f.admit()).state).toBe("READY");
  });
  it.each(["timestamp", "schedule", "executor"])(
    "refuses missing capability %s, names are insufficient",
    async (role) => {
      const f = fixture();
      delete f.ready[role];
      expect((await f.admit()).state).toBe("STOP");
    },
  );
  it.each(["timestamp", "schedule", "executor"])("refuses stale acknowledgement %s", async (role) => {
    const f = fixture();
    f.ready[role].acknowledge = ({ planHash }) => ({ ...f.plan.roles[role], planHash, at: before, expiresAt: before });
    expect((await f.admit()).state).toBe("STOP");
  });
  it.each(["timestamp", "schedule", "executor"])("refuses shared identity involving %s", async (role) => {
    const f = fixture();
    f.plan.roles[role].identity = f.plan.roles[role === "timestamp" ? "executor" : "timestamp"].identity;
    f.authority.approvedPlanHash = hash(f.plan);
    expect((await f.admit()).state).toBe("STOP");
  });
  it("refuses unavailable backup and unrelated authority", async () => {
    const f = fixture();
    delete f.custody.backup;
    expect((await f.admit()).state).toBe("STOP");
    f.authority.approvedPlanHash = hash("unrelated");
    expect((await f.admit()).state).toBe("STOP");
  });
  it.each(["consumed", "dispatch", "missing"])("requires explicit host-approved unconsumed arm: %s", async (attack) => {
    const f = fixture();
    if (attack === "consumed") f.plan.oneFreshArm.consumed = true;
    if (attack === "dispatch") f.plan.oneFreshArm.dispatch = { runId: 900000000000999, attempt: 1 };
    if (attack === "missing") delete f.plan.oneFreshArm;
    f.authority.approvedPlanHash = hash(f.plan);
    expect((await f.admit()).state).toBe("STOP");
  });
  it("binds the approved root and persists initial histories before D exists", async () => {
    const f = fixture();
    expect((await f.admit()).state).toBe("READY");
    const initial = JSON.parse(readFileSync(join(f.root, "initial-snapshot.json")));
    expect(initial).toMatchObject({
      at: before,
      histories: f.plan.histories,
      oneFreshArm: { consumed: false },
      armDispatch: null,
    });
    const impostor = fixture();
    expect(
      (
        await admitScheduleRoles(
          { ...f.options, root: impostor.root },
          { roles: f.ready, custody: f.custody, now: () => before },
        )
      ).reasons,
    ).toEqual(["STOP_ROOT_BINDING"]);
  });
  it.each(["opportunity", "oneFreshArm", "sizingWindows", "lifetimeAttempts", "consumedHeads", "blockingRounds"])(
    "refuses omission of independent history %s",
    async (key) => {
      const f = fixture();
      delete f.plan.histories[key];
      f.authority.approvedPlanHash = hash(f.plan);
      expect((await f.admit()).state).toBe("STOP");
    },
  );
});

describe("snapshot transition bridge", () => {
  it("create-new competing claims cannot replace approved readiness", async () => {
    const f = fixture();
    const results = await Promise.all([f.admit(), f.admit()]);
    expect(results.every((r) => r.state === "READY")).toBe(true);
    expect((await f.prepare()).state).toBe("PREPARED");
    expect((await f.prepare()).state).toBe("PREPARED");
    expect(reconstructScheduleBridge({ root: f.root, authority: f.authority }).state).toBe("NOT_STARTED");
  });
  it("will not repair a crashed partial create-new snapshot", async () => {
    const f = fixture();
    await f.admit();
    writeFileSync(join(f.root, "snapshot.json"), "{partial");
    expect((await f.prepare()).state).toBe("STOP");
    expect(readFileSync(join(f.root, "snapshot.json"), "utf8")).toBe("{partial");
  });
  it("refuses late readiness and snapshot mutation without resetting history", async () => {
    const f = fixture();
    await f.admit();
    await f.prepare();
    const path = join(f.root, "snapshot.json");
    const snapshot = JSON.parse(readFileSync(path));
    snapshot.histories.opportunity = hash("reset");
    writeFileSync(path, JSON.stringify(snapshot));
    expect(reconstructScheduleBridge({ root: f.root, authority: f.authority }).state).toBe("STOP");
  });
});
